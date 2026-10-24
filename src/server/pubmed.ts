/**
 * PubMed search subscriptions through NCBI E-utilities.
 *
 * A PubMed search feed stores a PubMed query; each fetch asks esearch for the
 * newest matching PMIDs (PubMed's "Most recent" order, newest added first, the
 * order PubMed's RSS used) and efetch for the records. Every request follows
 * NCBI's usage rules: one shared queue, at most 3 requests per second without
 * an API key and 10 with one, and `tool` / `email` on every request.
 * FeedLantern never tries to solve or get past NCBI's bot checks.
 *
 * Item keys are the ones PubMed's RSS produced (the guid `pubmed:<PMID>`), so
 * a PubMed RSS subscription converted to a search keeps its stored articles
 * and their translations.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import sanitizeHtml from 'sanitize-html';
import type { NetworkPolicy } from './network.js';
import { digest, fetchRaw, safeHtml, type RawResponse, type SourceFetcher, type SourceItem, type SourceOptions, type SourceResult } from './rss-source.js';
import { looksLikeHtml, NcbiError, NotAFeedError, sourceMessages } from './fetch-errors.js';
import { LocalizedError, msg } from './i18n.js';
import { pubmedRssSource, pubmedSearchUrl, type PubmedSearch } from '../shared/pubmed.js';
import type { PubmedArticle, PubmedPreview, PubmedWarning } from '../shared/types.js';

export const EUTILS_ENDPOINT = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
export const NCBI_TOOL = 'feedlantern';
/**
 * Spacing between request starts. NCBI allows 3 requests per second without
 * an API key and 10 with one; the spacing is a little wider than 1000/3 and
 * 1000/10 ms so network jitter cannot push four requests into one second.
 */
export const NCBI_INTERVAL_MS = { anonymous: 350, withKey: 110 } as const;

/** Full records carry affiliations and references: 100 of them can pass the 5 MB feed limit. */
const EFETCH_MAX_BYTES = 30_000_000;

export interface NcbiSettings { apiKey: string; email: string }

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
const defaultSleep: Sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/**
 * One queue for every request to NCBI in this process. Slots are handed out
 * in call order, `interval` apart, so a batch refresh waits its turn instead
 * of firing all requests at once.
 */
export class NcbiRateLimiter {
  private nextAt = 0;
  constructor(private readonly now: () => number = Date.now, private readonly sleep: Sleep = defaultSleep) {}
  async acquire(intervalMs: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const now = this.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + intervalMs;
    if (at > now) await this.sleep(at - now, signal);
  }
  /** How long a request queued now would wait for its slot. */
  backlog(): number { return Math.max(0, this.nextAt - this.now()); }
  /** Moves every later slot back by at least `ms`, after NCBI answered 429. */
  pause(ms: number): void { this.nextAt = Math.max(this.nextAt, this.now() + ms); }
}

export interface NcbiContext {
  limiter: NcbiRateLimiter;
  settings: () => NcbiSettings;
  /** Test-only replacement for the E-utilities base address. */
  endpoint?: string;
}

/**
 * The RSS fetcher with a PubMed hint: when a PubMed journal RSS address
 * answers with NCBI's bot check, the error says why and what to use instead.
 * The address itself is fetched like any other feed; nothing is rewritten.
 */
export function withPubmedRssHint(fetcher: SourceFetcher): SourceFetcher {
  return async (url, options) => {
    try { return await fetcher(url, options); } catch (error) {
      const rss = error instanceof NotAFeedError ? pubmedRssSource(url) : null;
      if (rss?.kind === 'journal') throw new NotAFeedError(msg('pubmed.journalRssBlocked', { reason: error instanceof NotAFeedError ? error.text : '' }));
      throw error;
    }
  };
}

/** A short, single-line detail from an NCBI error, without addresses. */
function detail(value: unknown): string {
  return String(value).replace(/https?:\/\/\S+/gi, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** The error an NCBI error text stands for; an API key problem gets its own message. */
function serviceError(text: unknown, status?: number): NcbiError {
  const shown = detail(text);
  if (/api[\s_-]?key/i.test(shown)) return new NcbiError(sourceMessages.pubmed.invalidKey, status);
  if (/rate limit/i.test(shown)) return new NcbiError(sourceMessages.pubmed.rateLimited, status);
  return new NcbiError(shown ? sourceMessages.pubmed.serviceError(shown) : status ? sourceMessages.pubmed.httpError(status) : sourceMessages.pubmed.unreadable, status);
}

/** The `error` text of an NCBI JSON error body or the `<ERROR>` of an XML one. */
function errorText(body: string): string | undefined {
  try { const data = JSON.parse(body); if (typeof data?.error === 'string') return data.error; if (typeof data?.esearchresult?.ERROR === 'string') return data.esearchresult.ERROR; } catch { /* not JSON */ }
  const match = /<ERROR>([\s\S]{1,500}?)<\/ERROR>/.exec(body);
  return match ? match[1] : undefined;
}

function retryDelay(header: string | undefined): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : 1000;
}

/** One E-utilities request through the shared queue. A 429 is retried once after a pause. */
async function eutils(ctx: NcbiContext, policy: NetworkPolicy, options: SourceOptions, scope: string, name: 'esearch' | 'efetch', params: Record<string, string>, accept: string, maxBytes?: number): Promise<string> {
  const settings = ctx.settings();
  const query = new URLSearchParams({ db: 'pubmed', ...params, tool: NCBI_TOOL, ...(settings.email ? { email: settings.email } : {}), ...(settings.apiKey ? { api_key: settings.apiKey } : {}) });
  const url = `${ctx.endpoint ?? EUTILS_ENDPOINT}/${name}.fcgi?${query}`;
  for (let attempt = 0; ; attempt++) {
    await ctx.limiter.acquire(settings.apiKey ? NCBI_INTERVAL_MS.withKey : NCBI_INTERVAL_MS.anonymous, options.signal);
    const response: RawResponse = await fetchRaw(url, policy, { signal: options.signal, network: options.network, timeoutSeconds: options.timeoutSeconds, accept, scope, maxBytes });
    if (response.status === 429) {
      ctx.limiter.pause(retryDelay(response.retryAfter));
      if (attempt === 0) continue;
      throw new NcbiError(sourceMessages.pubmed.rateLimited, 429);
    }
    if (looksLikeHtml(response.body) || /^\s*text\/html\b/i.test(response.contentType ?? '')) throw new NcbiError(sourceMessages.pubmed.htmlPage(response.status), response.status);
    if (response.status !== 200) { const text = errorText(response.body); throw text ? serviceError(text, response.status) : new NcbiError(sourceMessages.pubmed.httpError(response.status), response.status); }
    return response.body;
  }
}

export interface EsearchResult { count: number; ids: string[]; queryTranslation?: string; warnings: PubmedWarning[] }

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').map(entry => detail(entry)).filter(Boolean) : [];

/** The PMIDs esearch returned (newest first), the match count and what NCBI warned about. */
export function parseEsearch(body: string): EsearchResult {
  let data: any;
  try { data = JSON.parse(body); } catch { throw new NcbiError(sourceMessages.pubmed.unreadable); }
  if (typeof data?.error === 'string') throw serviceError(data.error);
  const result = data?.esearchresult;
  if (!result || typeof result !== 'object') throw new NcbiError(sourceMessages.pubmed.unreadable);
  if (typeof result.ERROR === 'string') throw serviceError(result.ERROR);
  if (!Array.isArray(result.idlist)) throw new NcbiError(sourceMessages.pubmed.unreadable);
  const count = Number(result.count);
  if (!Number.isSafeInteger(count) || count < 0) throw new NcbiError(sourceMessages.pubmed.unreadable);
  const ids = result.idlist.map(String).filter((id: string) => /^\d{1,10}$/.test(id));
  const warnings: PubmedWarning[] = [
    ...strings(result.errorlist?.phrasesnotfound).map(text => ({ kind: 'phraseNotFound' as const, text })),
    ...strings(result.errorlist?.fieldsnotfound).map(text => ({ kind: 'fieldNotFound' as const, text })),
    ...strings(result.warninglist?.quotedphrasesnotfound).map(text => ({ kind: 'quotedPhraseNotFound' as const, text })),
    ...strings(result.warninglist?.phrasesignored).map(text => ({ kind: 'phraseIgnored' as const, text })),
    // "No items found." is what the count already says.
    ...strings(result.warninglist?.outputmessages).filter(text => !/^no items found\.?$/i.test(text)).map(text => ({ kind: 'message' as const, text })),
  ].slice(0, 20);
  const translation = typeof result.querytranslation === 'string' ? result.querytranslation.slice(0, 4000) : undefined;
  return { count, ids, ...(translation ? { queryTranslation: translation } : {}), warnings };
}

const list = (value: any): any[] => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
const text = (value: any): string => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : value?.['#text'] !== undefined ? String(value['#text']).trim() : '';
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
/** Markup-free text of a raw XML fragment (titles keep entities and inline tags such as <i>). */
const plain = (raw: string) => sanitizeHtml(raw, { allowedTags: [], allowedAttributes: {} }).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** PubMed's RSS showed no-break and thin spaces as plain spaces. */
const spaces = (value: string) => value.replace(/[\u00a0\u2000-\u200a\u202f]|&#x0*(?:a0|200[0-9a]|202f);|&#0*(?:160|819[2-9]|820[0-2]|8239);|&nbsp;|&thinsp;/gi, ' ');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const month = (value: string) => /^\d{1,2}$/.test(value) ? MONTHS[Number(value) - 1] ?? '' : value;

/** "2026 Sep 28", "2026 Oct", "2026" or a MedlineDate such as "2026 Jul-Aug". */
function citationDate(date: any): string {
  if (!date) return '';
  const medline = text(date.MedlineDate);
  if (medline) return medline;
  const day = text(date.Day);
  return [text(date.Year), month(text(date.Month)) || text(date.Season), /^\d+$/.test(day) ? String(Number(day)) : day].filter(Boolean).join(' ');
}

const easternOffset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' });
/**
 * PubMed's RSS dated each article 06:00 New York time on the day it was
 * added to PubMed (its Entrez date). The same moment keeps stored dates
 * steady when a subscription moves from the RSS address to E-utilities.
 */
export function pubmedRssDate(year: number, monthIndex: number, day: number): string | undefined {
  if (![year, monthIndex, day].every(Number.isInteger) || year < 1800 || monthIndex < 1 || monthIndex > 12 || day < 1 || day > 31) return undefined;
  const noon = new Date(Date.UTC(year, monthIndex - 1, day, 12));
  const name = easternOffset.formatToParts(noon).find(part => part.type === 'timeZoneName')?.value ?? '';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  const offsetMinutes = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : -240;
  return new Date(Date.UTC(year, monthIndex - 1, day, 6) - offsetMinutes * 60_000).toISOString();
}

function historyDate(history: any, status: string): string | undefined {
  const date = list(history?.PubMedPubDate).find(row => row?.['@_PubStatus'] === status);
  return date ? pubmedRssDate(Number(text(date.Year)), Number(text(date.Month)), Number(text(date.Day))) : undefined;
}

function idOf(rows: any[], type: string, attribute: string): string {
  return text(rows.find(row => row?.[attribute] === type));
}

/**
 * The record as PubMed's RSS laid it out: the citation line, the authors,
 * the abstract (labelled sections in one paragraph) and the identifier line.
 */
function articleHtml(pmid: string, record: any): { html: string; journal: string; pubDate: string; authors: string[] } {
  const citation = record.MedlineCitation, article = citation.Article, journal = article.Journal ?? {};
  const issue = journal.JournalIssue ?? {};
  const abbreviation = text(journal.ISOAbbreviation) || text(citation.MedlineJournalInfo?.MedlineTA) || text(journal.Title);
  const locations = list(article.ELocationID);
  const ids = list(record.PubmedData?.ArticleIdList?.ArticleId);
  const doi = idOf(locations, 'doi', '@_EIdType') || idOf(ids, 'doi', '@_IdType');
  const pmc = idOf(ids, 'pmc', '@_IdType');
  const pages = text(article.Pagination?.MedlinePgn) || idOf(locations, 'pii', '@_EIdType');
  const volume = text(issue.Volume), number = text(issue.Issue);
  const electronic = list(article.ArticleDate).find(row => row?.['@_DateType'] === 'Electronic');
  const model = article['@_PubModel'];
  const aheadOfPrint = text(record.PubmedData?.PublicationStatus) === 'aheadofprint';
  // An eCollection article is cited by its electronic date; the collection date follows.
  const eCollection = model === 'Electronic-eCollection' && !!electronic;
  let line = `${abbreviation}. ${citationDate(eCollection ? electronic : issue.PubDate)}${volume ? `;${volume}${number ? `(${number})` : ''}` : number ? `;(${number})` : ''}${pages ? `:${pages}` : ''}.`;
  if (doi) line += ` doi: ${doi}.`;
  if (model === 'Print-Electronic' && electronic && !aheadOfPrint) line += ` Epub ${citationDate(electronic)}.`;
  if (eCollection) line += ` eCollection ${citationDate(issue.PubDate)}.`;
  if (aheadOfPrint) line += ' Online ahead of print.';

  const authors = list(article.AuthorList?.Author).map(author => text(author.CollectiveName) || [text(author.LastName), text(author.Initials)].filter(Boolean).join(' ')).filter(Boolean);
  const authorLine = authors.length > 10 ? `${authors.slice(0, 10).join(', ')}, et al.` : authors.join(', ');

  const sections = list(article.Abstract?.AbstractText).map(part => ({ label: typeof part === 'object' ? String(part['@_Label'] ?? '').trim() : '', body: spaces(text(part)) })).filter(part => part.body);
  // Each section is a paragraph; a labelled one starts with its label, as on PubMed.
  const abstract = sections.map(part => `<p>${part.label ? `${escapeHtml(part.label)}: ` : ''}${part.body}</p>`).join('');

  const link = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
  const idLine = [`PMID:<a href="${link}">${pmid}</a>`,
    ...(pmc ? [`PMC:<a href="https://www.ncbi.nlm.nih.gov/pmc/${escapeHtml(pmc)}/">${escapeHtml(pmc)}</a>`] : []),
    ...(doi ? [`DOI:<a href="https://doi.org/${escapeHtml(doi)}">${escapeHtml(doi)}</a>`] : [])].join(' | ');
  const html = `<div><p>${escapeHtml(line)}</p>${authorLine ? `<p>${escapeHtml(authorLine)}</p>` : ''}${abstract ? `<p><b>ABSTRACT</b></p>${abstract}` : '<p><b>NO ABSTRACT</b></p>'}<p>${idLine}</p></div>`;
  return { html, journal: abbreviation, pubDate: citationDate(eCollection ? electronic : issue.PubDate), authors };
}

/** efetch's own DTD references are the only declarations accepted; it is removed before parsing and never loaded. */
const PUBMED_DOCTYPE = /<!DOCTYPE\s+(?:PubmedArticleSet|eEfetchResult)\s+PUBLIC\s+"[^"<>[\]]*"\s+"[^"<>[\]]*"\s*>/;

/** Articles from an efetch PubMed XML answer, keyed by PMID: the feed item and a short summary for previews. */
export function parseEfetch(xml: string): { items: Map<string, SourceItem>; articles: Map<string, PubmedArticle> } {
  const body = xml.replace(PUBMED_DOCTYPE, '');
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(body) || XMLValidator.validate(body) !== true) throw new NcbiError(sourceMessages.pubmed.unreadable);
  const doc = new XMLParser({
    ignoreAttributes: false, parseTagValue: false, htmlEntities: true,
    // Titles and abstracts keep their inline markup (<i>, <sub>, <sup>), sanitized below.
    stopNodes: ['*.ArticleTitle', '*.VernacularTitle', '*.AbstractText'],
  }).parse(body);
  const error = doc.eFetchResult?.ERROR;
  if (error !== undefined) throw serviceError(text(error));
  const set = doc.PubmedArticleSet;
  if (set === undefined) throw new NcbiError(sourceMessages.pubmed.unreadable);
  const items = new Map<string, SourceItem>();
  const articles = new Map<string, PubmedArticle>();
  // Book records (PubmedBookArticle) have no journal citation and are skipped.
  for (const record of list(typeof set === 'object' ? set.PubmedArticle : undefined)) {
    const pmid = text(record?.MedlineCitation?.PMID);
    const article = record?.MedlineCitation?.Article;
    if (!/^\d{1,10}$/.test(pmid) || !article) continue;
    // PubMed's RSS titles drop the closing period that MEDLINE titles carry.
    // Translated titles are bracketed in MEDLINE ("[...]."); the RSS showed them without brackets.
    const title = spaces(plain(text(article.ArticleTitle)) || plain(text(article.VernacularTitle))).replace(/(?<!\.)\.$/, '').replace(/^\[(.*)\]$/s, '$1').trim();
    if (!title) continue;
    const link = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
    const built = articleHtml(pmid, record);
    if (built.html.length > 200_000 || title.length > 20_000) throw new LocalizedError(msg('rss.itemTooLong'));
    const history = record.PubmedData?.History;
    const publishedAt = historyDate(history, 'entrez') ?? historyDate(history, 'pubmed');
    items.set(pmid, { key: pubmedItemKey(pmid), title, link, html: safeHtml(built.html, link), ...(publishedAt ? { publishedAt } : {}) });
    articles.set(pmid, { pmid, title, link, journal: built.journal, pubDate: built.pubDate, authors: built.authors.slice(0, 50), ...(publishedAt ? { addedAt: publishedAt } : {}) });
  }
  return { items, articles };
}

/** The key parseSource gave a PubMed RSS item: its guid is `pubmed:<PMID>`. */
export const pubmedItemKey = (pmid: string) => digest(`id:pubmed:${pmid}`);

/** esearch and efetch for the newest `limit` matches of a query, in esearch order. */
async function search(query: string, limit: number, policy: NetworkPolicy, ctx: NcbiContext, options: SourceOptions) {
  const scope = pubmedSearchUrl({ query, limit });
  // No `sort`: esearch's default for PubMed is "Most recent" (newest added first). `pub_date` would keep
  // articles with a future issue date on top and hide what was just added.
  const found = parseEsearch(await eutils(ctx, policy, options, scope, 'esearch', { term: query, retmax: String(limit), retmode: 'json' }, 'application/json'));
  if (!found.ids.length) return { found, items: new Map<string, SourceItem>(), articles: new Map<string, PubmedArticle>() };
  const records = parseEfetch(await eutils(ctx, policy, options, scope, 'efetch', { id: found.ids.join(','), retmode: 'xml' }, 'application/xml, text/xml', EFETCH_MAX_BYTES));
  return { found, ...records };
}

/** The newest articles of a PubMed search subscription. A search without matches is a successful fetch with no items. */
export async function fetchPubmedSearch(source: PubmedSearch, policy: NetworkPolicy, ctx: NcbiContext, options: SourceOptions = {}): Promise<SourceResult> {
  const { found, items } = await search(source.query, source.limit, policy, ctx, options);
  return { title: source.query, items: found.ids.map(id => items.get(id)).filter((item): item is SourceItem => !!item) };
}

/** How many articles match, and the newest few, for the search builder. */
export async function previewPubmed(query: string, policy: NetworkPolicy, ctx: NcbiContext, options: SourceOptions = {}, size = 5): Promise<PubmedPreview> {
  const { found, articles } = await search(query, size, policy, ctx, options);
  return {
    count: found.count, ...(found.queryTranslation ? { queryTranslation: found.queryTranslation } : {}), warnings: found.warnings,
    items: found.ids.map(id => articles.get(id)).filter((item): item is PubmedArticle => !!item),
    pubmedUrl: pubmedSearchUrl({ query, limit: 20 }),
  };
}
