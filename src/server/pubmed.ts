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
import { setTimeout as sleepTimer } from 'node:timers/promises';
import type { NetworkPolicy } from './network.js';
import { digest, fetchRaw, safeHtml, type RawResponse, type SourceFetcher, type SourceItem, type SourceOptions, type SourceResult } from './rss-source.js';
import { looksLikeHtml, NcbiError, NotAFeedError, sourceMessages } from './fetch-errors.js';
import { LocalizedError, msg, tl } from './i18n.js';
import { buildPubmedQuery, nearestPubmedLimit, pubmedConversion, pubmedCoverage, pubmedPmidOf, pubmedQueryFromRssTitle, pubmedQueryProblem, pubmedRssSource, pubmedSearchUrl, PUBMED_COVERAGE, type PubmedSearch, type RssTitleQuery } from '../shared/pubmed.js';
import type { NcbiKeyTest, PubmedArticle, PubmedCheckReason, PubmedPreview, PubmedRssCheck, PubmedWarning } from '../shared/types.js';

export const EUTILS_ENDPOINT = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
export const NCBI_TOOL = 'feedlantern';
/**
 * Spacing between request starts. NCBI allows 3 requests per second without
 * an API key and 10 with one; the spacing is a little wider than 1000/3 and
 * 1000/10 ms to leave a small margin for network jitter.
 */
export const NCBI_INTERVAL_MS = { anonymous: 350, withKey: 110 } as const;

/** Full records carry affiliations and references: 100 of them can pass the 5 MB feed limit. */
const EFETCH_MAX_BYTES = 30_000_000;

export interface NcbiSettings { apiKey: string; email: string }

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
const defaultSleep: Sleep = async (ms, signal) => {
  try { await sleepTimer(ms, undefined, { signal }); }
  catch (error) { signal?.throwIfAborted(); throw error; }
};

/**
 * One queue for every request to NCBI in this process. Slots are handed out
 * in call order, `interval` apart, so a batch refresh waits its turn instead
 * of firing all requests at once.
 */
export class NcbiRateLimiter {
  private nextAt = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly queued = new Set<{ intervalMs: number }>();
  constructor(private readonly now: () => number = () => performance.now(), private readonly sleep: Sleep = defaultSleep) {}
  async acquire(intervalMs: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const ticket = { intervalMs };
    this.queued.add(ticket);
    const slot = this.tail.then(async () => {
      // Only the first queued request sleeps. After a delayed wakeup, space
      // the next request from this actual grant, never from an expired slot.
      for (;;) {
        signal?.throwIfAborted();
        const delay = this.nextAt - this.now();
        if (delay <= 0) break;
        await this.sleep(delay, signal);
        // A 429 may have moved nextAt while this request was asleep.
      }
      this.nextAt = this.now() + intervalMs;
      this.queued.delete(ticket);
    }).finally(() => { this.queued.delete(ticket); });
    // A canceled caller must not prevent later requests from taking a turn.
    this.tail = slot.catch(() => {});
    if (!signal) return slot;
    return new Promise<void>((resolve, reject) => {
      const abort = () => { this.queued.delete(ticket); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      void slot.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  /** How long a request queued now would wait for its slot. */
  backlog(): number { return Math.max(0, this.nextAt - this.now()) + [...this.queued].reduce((sum, ticket) => sum + ticket.intervalMs, 0); }
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
      if (!(error instanceof NotAFeedError) || pubmedRssSource(url)?.kind !== 'journal') throw error;
      // Short enough for the stored error (300 characters): the status and the bot-check marker, then what to do.
      const { status, marker } = error.text.params ?? {};
      const detail = [status !== undefined ? `HTTP ${String(status)}` : '', marker !== undefined ? String(marker) : ''].filter(Boolean).join(', ') || 'HTML';
      throw new NotAFeedError(msg('pubmed.journalRssBlocked', { detail }));
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

export interface PubmedRssCheckDeps {
  /** Reads the feed's RSS address (the normal RSS fetcher with the feed's network profile). */
  fetchRss: (url: string) => Promise<SourceResult>;
  /** PMIDs of the items the feed already holds, newest first. */
  storedPmids: string[];
  policy: NetworkPolicy;
  ctx: NcbiContext;
  options?: SourceOptions;
  /** A readable reason for a failed RSS read, in the reader's language. */
  describe: (error: unknown) => string;
}

/**
 * Whether a PubMed RSS feed can become a PubMed search without changing what
 * it delivers. The query is recovered from the feed's name (a search RSS
 * feed is named after its channel title, which is the query) or from the
 * journal, run through esearch, and the feed's newest stored items must be
 * among the newest matches. Only when that cannot confirm it is the RSS
 * address read (once, through the shared NCBI queue) for its title and
 * current items. Most feeds therefore need one E-utilities request and no
 * visit to the PubMed website. Nothing is saved.
 */
export async function checkPubmedRss(feed: { url: string; name: string }, deps: PubmedRssCheckDeps): Promise<Omit<PubmedRssCheck, 'feedId' | 'name' | 'ncbiKeyConfigured'>> {
  const rss = pubmedRssSource(feed.url);
  if (!rss) throw new Error('not a PubMed RSS address');
  const limit = nearestPubmedLimit(rss.limit);
  const { ctx, options = {} } = deps;
  const searches = new Map<string, EsearchResult>();
  const esearch = async (query: string) => {
    if (!searches.has(query)) searches.set(query, parseEsearch(await eutils(ctx, deps.policy, options, pubmedSearchUrl({ query, limit }), 'esearch', { term: query, retmax: String(PUBMED_COVERAGE.window), retmode: 'json' }, 'application/json')));
    return searches.get(query)!;
  };
  type Attempt = Omit<PubmedRssCheck, 'feedId' | 'name' | 'ncbiKeyConfigured'>;
  /** Judges one recovered query against one set of items. */
  const attempt = async (recovered: RssTitleQuery, sourceTitle: string | undefined, evidence: { source: 'rss' | 'stored'; ids: string[] } | undefined, error?: string): Promise<Attempt> => {
    const base = { kind: rss.kind, query: recovered.query, repaired: recovered.repaired, truncated: recovered.truncated, limit, ...(sourceTitle !== undefined ? { sourceTitle } : {}), ...(error ? { error } : {}) };
    if (recovered.truncated) return { ...base, status: 'review', reason: 'truncated' };
    if (!recovered.query || pubmedQueryProblem(recovered.query)) return { ...base, status: 'review', reason: 'invalidQuery' };
    let found: EsearchResult;
    try { found = await esearch(recovered.query); } catch (reason) {
      if (options.signal?.aborted) throw reason;
      return { ...base, status: 'review', reason: 'ncbiFailed', error: deps.describe(reason) };
    }
    const coverage = evidence ? { ...pubmedCoverage(evidence.ids, found.ids), source: evidence.source } : undefined;
    const result = { ...base, count: found.count, ...(coverage ? { coverage } : {}) };
    if (!coverage || !coverage.total) return { ...result, status: 'review', reason: error ? 'fetchFailed' : 'noItems' };
    if (coverage.ratio < PUBMED_COVERAGE.threshold) return { ...result, status: 'review', reason: 'lowCoverage' };
    return { ...result, status: 'verified' };
  };
  const stored = deps.storedPmids.length ? { source: 'stored' as const, ids: deps.storedPmids } : undefined;
  // A journal: NCBI blocks its RSS, so only the stored items can be compared.
  if (rss.kind === 'journal') return attempt({ query: buildPubmedQuery(pubmedConversion(rss).builder), repaired: false, truncated: false }, undefined, stored);
  // 1. The feed's name (normally the RSS channel title) against the items already stored: no web request.
  const fromName = pubmedQueryFromRssTitle(feed.name);
  const byName = stored ? await attempt(fromName, feed.name, stored) : undefined;
  if (byName?.status === 'verified') return byName;
  // 2. The RSS itself: its title is the query, its items are the newest ones.
  let fetched: SourceResult | undefined, error: string | undefined;
  try {
    await ctx.limiter.acquire(ctx.settings().apiKey ? NCBI_INTERVAL_MS.withKey : NCBI_INTERVAL_MS.anonymous, options.signal);
    fetched = await deps.fetchRss(feed.url);
  } catch (reason) {
    if (options.signal?.aborted) throw reason;
    error = deps.describe(reason);
  }
  // The RSS couldn't be read either: say so, unless the name already showed a more precise problem.
  if (!fetched) return byName ? { ...byName, error, ...(byName.reason === 'lowCoverage' || byName.reason === 'noItems' ? { reason: 'fetchFailed' as const } : {}) } : attempt(fromName, feed.name, undefined, error);
  const title = fetched.title.trim() || feed.name;
  const rssIds = fetched.items.map(item => pubmedPmidOf(item.link)).filter((id): id is string => !!id);
  return attempt(pubmedQueryFromRssTitle(title), title, rssIds.length ? { source: 'rss', ids: rssIds } : stored);
}

/** A digest of an API key, to remember its last test without keeping the key twice. */
export const keyDigest = (apiKey: string) => digest(`ncbi-key:${apiKey}`);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Tests NCBI settings with the smallest request there is (esearch with
 * `retmax=0`). What NCBI answers, as observed: a working key gets HTTP 200
 * and `X-RateLimit-Limit: 10`; no key gets 200 and a limit of 3; a key NCBI
 * does not accept gets HTTP 400 with `{"error":"API key invalid","type":"invalid"}`,
 * and one that is not shaped like an NCBI key `{"error":"API key not wellformed","type":"api-key-fake"}`.
 * Anything else is reported with NCBI's own message, not guessed at.
 */
export async function testNcbiSettings(settings: NcbiSettings, policy: NetworkPolicy, ctx: NcbiContext, options: SourceOptions, describe: (error: unknown) => string): Promise<NcbiKeyTest> {
  const testedAt = new Date().toISOString();
  const email = !settings.email ? 'missing' as const : EMAIL.test(settings.email) ? 'ok' as const : 'invalid' as const;
  const base = { testedAt, email };
  if (settings.apiKey && !/^[A-Za-z0-9]{1,200}$/.test(settings.apiKey)) return { ...base, result: 'badFormat', detail: tl('error.ncbiApiKeyInvalid') };
  const query = new URLSearchParams({ db: 'pubmed', term: 'pubmed', retmax: '0', retmode: 'json', tool: NCBI_TOOL, ...(email === 'ok' ? { email: settings.email } : {}), ...(settings.apiKey ? { api_key: settings.apiKey } : {}) });
  let response: RawResponse;
  try {
    await ctx.limiter.acquire(settings.apiKey ? NCBI_INTERVAL_MS.withKey : NCBI_INTERVAL_MS.anonymous, options.signal);
    response = await fetchRaw(`${ctx.endpoint ?? EUTILS_ENDPOINT}/esearch.fcgi?${query}`, policy, { signal: options.signal, accept: 'application/json', timeoutSeconds: options.timeoutSeconds ?? 15, maxBytes: 100_000 });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { ...base, result: 'network', detail: describe(error) };
  }
  const limit = Number(response.rateLimit);
  const rateLimit = Number.isInteger(limit) && limit > 0 ? { rateLimit: limit } : {};
  if (response.status === 429) return { ...base, ...rateLimit, result: 'rateLimited' };
  let body: any;
  try { body = JSON.parse(response.body); } catch { /* reported below */ }
  if (response.status === 200 && body?.esearchresult) return { ...base, ...rateLimit, result: settings.apiKey ? 'valid' : 'noKey' };
  const message = typeof body?.error === 'string' ? detail(body.error) : '';
  if (body?.type === 'api-key-fake') return { ...base, ...rateLimit, result: 'badFormat', ...(message ? { detail: message } : {}) };
  if (body?.type === 'invalid' && /api key/i.test(message)) return { ...base, ...rateLimit, result: 'invalidKey', ...(message ? { detail: message } : {}) };
  return { ...base, ...rateLimit, result: 'error', detail: message || `HTTP ${response.status}` };
}
