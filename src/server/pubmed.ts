/**
 * PubMed journal subscriptions through NCBI E-utilities.
 *
 * PubMed's journal RSS addresses now answer programs with a proof-of-work
 * bot check. FeedLantern never tries to solve or bypass it; it reads the
 * same journal through NCBI's official E-utilities instead (esearch for the
 * newest PMIDs, efetch for the records), following NCBI's usage rules: one
 * shared queue, at most 3 requests per second without an API key and 10
 * with one, and `tool` / `email` on every request.
 *
 * Item keys are the ones PubMed's RSS produced (the guid `pubmed:<PMID>`),
 * so stored articles and their translations carry over unchanged.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import sanitizeHtml from 'sanitize-html';
import type { NetworkPolicy } from './network.js';
import { digest, fetchRaw, fetchSource, safeHtml, type RawResponse, type SourceFetcher, type SourceItem, type SourceOptions, type SourceResult } from './rss-source.js';
import { looksLikeHtml, NcbiError, sourceMessages } from './fetch-errors.js';
import { LocalizedError, msg } from './i18n.js';
import { pubmedJournalSource, type PubmedJournalSource } from '../shared/pubmed.js';

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
  /** Moves every later slot back by at least `ms`, after NCBI answered 429. */
  pause(ms: number): void { this.nextAt = Math.max(this.nextAt, this.now() + ms); }
}

export interface NcbiContext {
  limiter: NcbiRateLimiter;
  settings: () => NcbiSettings;
  /** Test-only replacement for the E-utilities base address. */
  endpoint?: string;
}

/** Routes PubMed journal RSS addresses to E-utilities and every other address to the RSS fetcher. */
export function sourceFetcher(policy: () => NetworkPolicy, ncbi: NcbiContext): SourceFetcher {
  return (url, options) => {
    const journal = pubmedJournalSource(url);
    return journal ? fetchPubmedJournal(journal, url, policy(), ncbi, options) : fetchSource(url, policy(), options);
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

/** The PMIDs esearch returned, newest publication date first. */
export function parseEsearch(body: string, nlmId: string): string[] {
  let data: any;
  try { data = JSON.parse(body); } catch { throw new NcbiError(sourceMessages.pubmed.unreadable); }
  if (typeof data?.error === 'string') throw serviceError(data.error);
  const result = data?.esearchresult;
  if (!result || typeof result !== 'object') throw new NcbiError(sourceMessages.pubmed.unreadable);
  if (typeof result.ERROR === 'string') throw serviceError(result.ERROR);
  if (!Array.isArray(result.idlist)) throw new NcbiError(sourceMessages.pubmed.unreadable);
  const ids = result.idlist.map(String).filter((id: string) => /^\d{1,10}$/.test(id));
  // An unknown journal ID is reported as a phrase that was not found.
  if (!ids.length && Array.isArray(result.errorlist?.phrasesnotfound) && result.errorlist.phrasesnotfound.length) throw new NcbiError(sourceMessages.pubmed.journalNotFound(nlmId));
  return ids;
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
function articleHtml(pmid: string, record: any): { html: string; journal: string } {
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
  return { html, journal: abbreviation };
}

/** efetch's own DTD references are the only declarations accepted; it is removed before parsing and never loaded. */
const PUBMED_DOCTYPE = /<!DOCTYPE\s+(?:PubmedArticleSet|eEfetchResult)\s+PUBLIC\s+"[^"<>[\]]*"\s+"[^"<>[\]]*"\s*>/;

/** Articles from an efetch PubMed XML answer, keyed by PMID. */
export function parseEfetch(xml: string): { items: Map<string, SourceItem>; journal?: string } {
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
  let journal: string | undefined;
  // Book records (PubmedBookArticle) never appear in a journal search and are skipped.
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
    journal ??= built.journal || undefined;
    if (built.html.length > 200_000 || title.length > 20_000) throw new LocalizedError(msg('rss.itemTooLong'));
    const history = record.PubmedData?.History;
    const publishedAt = historyDate(history, 'entrez') ?? historyDate(history, 'pubmed');
    items.set(pmid, { key: pubmedItemKey(pmid), title, link, html: safeHtml(built.html, link), ...(publishedAt ? { publishedAt } : {}) });
  }
  return { items, journal };
}

/** The key parseSource gave a PubMed RSS item: its guid is `pubmed:<PMID>`. */
export const pubmedItemKey = (pmid: string) => digest(`id:pubmed:${pmid}`);

/** The newest articles of one journal, as the journal's PubMed RSS address would have listed them. */
export async function fetchPubmedJournal(source: PubmedJournalSource, raw: string, policy: NetworkPolicy, ctx: NcbiContext, options: SourceOptions = {}): Promise<SourceResult> {
  const search = await eutils(ctx, policy, options, raw, 'esearch', { term: `${source.nlmId}[jid]`, sort: 'pub_date', retmax: String(source.limit), retmode: 'json' }, 'application/json');
  const ids = parseEsearch(search, source.nlmId);
  const fallbackTitle = source.name ?? `PubMed ${source.nlmId}`;
  if (!ids.length) return { title: fallbackTitle, items: [] };
  const records = await eutils(ctx, policy, options, raw, 'efetch', { id: ids.join(','), retmode: 'xml' }, 'application/xml, text/xml', EFETCH_MAX_BYTES);
  const { items, journal } = parseEfetch(records);
  return { title: source.name ?? journal ?? fallbackTitle, items: ids.map(id => items.get(id)).filter((item): item is SourceItem => !!item) };
}
