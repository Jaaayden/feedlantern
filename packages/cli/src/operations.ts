import { buildPubmedQuery, parsePubmedQuery, pubmedRssSource, pubmedDefaultTerms, pubmedSearchUrl, PUBMED_DEFAULT_LIMIT, type PubmedField, type PubmedFilters, type PubmedOperator } from '../../../src/shared/pubmed.js';
import { feedFormatUrl, type PubmedCheckEntry, type PubmedCheckJob, type ApiTokenCallFilter, type BulkFeedSettingsInput, type ExtractedItem, type Feed, type FeedInput, type FeedSettingsInput, type FetchStatus, type ItemOutputStatus, type PaginationRules, type SelectionRules } from '../../../src/shared/types.js';
import type { BrowserOpenInput, BulkAction, FeedLanternClient, FeedPayload, HttpMethod, ImportJobInput } from './client.js';
import { FeedLanternError, usageError } from './errors.js';
import { t } from './messages.js';
import { CLI_VERSION, compatibleWith } from './version.js';

/**
 * Operations shared by the CLI and the MCP server. Each takes a client and
 * plain parameters and returns plain JSON. In dry-run mode the client records
 * writes instead of sending them; callers then report `client.planned`.
 */

const placeholder = '<sessionId>';

export function dryRunResult(client: FeedLanternClient): { dryRun: true; requests: FeedLanternClient['planned'] } {
  return { dryRun: true, requests: client.planned };
}

const feedUrls = (payload: FeedPayload) => ({ rss: payload.feedUrl, atom: feedFormatUrl(payload.feedUrl, 'atom'), json: feedFormatUrl(payload.feedUrl, 'json') });
const withUrls = (payload: FeedPayload) => payload && ({ ...payload, feedUrls: feedUrls(payload) });

// Meta

export async function whoami(client: FeedLanternClient) {
  if (!client.hasToken) throw new FeedLanternError({ code: 'not_configured', status: 0, message: t('config.noToken') });
  const status = await client.authStatus();
  if (!status.authenticated) throw new FeedLanternError({ code: 'unauthorized', status: 401, message: t('errors.notAuthenticated') });
  let token: Awaited<ReturnType<FeedLanternClient['currentToken']>> | null = null;
  try { token = await client.currentToken(); } catch (error) {
    // Servers before 0.8 have no /api/tokens/current.
    if (!(error instanceof FeedLanternError && error.code === 'not_found')) throw error;
  }
  return {
    url: client.url,
    user: { id: status.userId, username: status.username, role: status.role },
    token: token ?? { scope: status.tokenScope },
    serverVersion: status.version, cliVersion: CLI_VERSION, compatible: compatibleWith(status.version),
  };
}

/**
 * Reachability, version and token validity. With a token the check goes
 * through it, since unauthenticated calls must also match the instance's
 * PUBLIC_ORIGIN host (an internal address such as http://feedlantern:4321 would be refused).
 */
export async function health(client: FeedLanternClient) {
  const started = Date.now();
  let status: Awaited<ReturnType<FeedLanternClient['authStatus']>> | null = null;
  let rejected: FeedLanternError | null = null;
  try { status = client.hasToken ? await client.authStatus() : await client.publicStatus(); } catch (error) {
    if (!(error instanceof FeedLanternError) || error.status !== 401) throw error;
    rejected = error;
  }
  const latencyMs = Date.now() - started;
  // The token was refused: the server is up; read its version without the token if the host allows it.
  status ??= await client.publicStatus().catch(() => null);
  const report = {
    ok: !rejected, url: client.url, serverVersion: status?.version ?? null, cliVersion: CLI_VERSION, compatible: compatibleWith(status?.version),
    setupRequired: status?.setupRequired ?? null, latencyMs,
    token: client.hasToken
      ? { configured: true, valid: !rejected && !!status?.authenticated, scope: rejected ? null : status?.tokenScope ?? null, username: rejected ? null : status?.username ?? null }
      : { configured: false, valid: null, scope: null, username: null },
  };
  if (rejected) throw new FeedLanternError({ code: 'unauthorized', status: 401, message: rejected.message, data: report });
  return report;
}

export function tokenLogs(client: FeedLanternClient, query: { status?: ApiTokenCallFilter; limit?: number; cursor?: string }) {
  return client.tokenLogs(query);
}

// Feeds

export type FeedListFilter = 'active' | 'paused' | 'failing' | 'warning';
const feedFilters: Record<FeedListFilter, (feed: Feed) => boolean> = {
  active: feed => feed.enabled, paused: feed => !feed.enabled, failing: feed => !!feed.lastError, warning: feed => !!feed.ruleHealth,
};
export async function listFeeds(client: FeedLanternClient, filter?: FeedListFilter) {
  const feeds = await client.listFeeds();
  return filter ? feeds.filter(feedFilters[filter]) : feeds;
}

export async function getFeed(client: FeedLanternClient, id: string) {
  const detail = await client.getFeed(id);
  const outputCounts: Partial<Record<ItemOutputStatus, number>> = {};
  for (const status of Object.values(detail.outputStatus ?? {})) outputCounts[status] = (outputCounts[status] ?? 0) + 1;
  return { feed: detail.feed, feedUrl: detail.feedUrl, feedUrls: feedUrls(detail), storedItems: detail.items.length, outputCounts };
}

export async function feedItems(client: FeedLanternClient, id: string, options: { limit?: number; status?: ItemOutputStatus } = {}) {
  const detail = await client.getFeed(id);
  const items = detail.items.map(item => ({ ...item, outputStatus: detail.outputStatus?.[item.id] }))
    .filter(item => !options.status || item.outputStatus === options.status);
  const limit = options.limit ?? 20;
  return { feedId: detail.feed.id, total: items.length, returned: Math.min(limit, items.length), items: items.slice(0, limit) };
}

export function feedLogs(client: FeedLanternClient, id: string, query: { status?: FetchStatus; limit?: number; cursor?: string }) {
  return client.feedLogs(id, query);
}

export async function createFeed(client: FeedLanternClient, input: FeedInput) {
  return withUrls(await client.createFeed(input));
}

/** Fields of the feed definition: changing one replaces the feed (PUT) and refetches it. */
const definitionKeys = ['url', 'rules', 'ruleOrigins', 'credentialId', 'waitMs', 'waitForSelector', 'pagination', 'sourceType', 'pubmed'] as const;
/** Output settings only PATCH can change. */
const settingsOnlyKeys = ['channelTitle', 'itemFilter', 'outputLimit', 'retentionLimit'] as const;
/** Fields both requests accept. */
const sharedKeys = ['name', 'intervalMinutes', 'networkProfileId', 'translationMode', 'targetLanguage', 'translationProvider'] as const;
export type FeedChanges = Omit<Partial<FeedInput>, 'rules'> & Partial<FeedSettingsInput> & { rules?: Partial<SelectionRules> };

/**
 * Applies a partial change. Definition fields (URL, rules, waiting, pages…)
 * are merged into the saved feed and sent with PUT, which refetches the feed;
 * output settings go through PATCH. A rule set to "" is removed.
 */
export async function updateFeed(client: FeedLanternClient, id: string, changes: FeedChanges) {
  const keys = Object.keys(changes).filter(key => changes[key as keyof FeedChanges] !== undefined);
  const known = new Set<string>([...definitionKeys, ...settingsOnlyKeys, ...sharedKeys]);
  const unknown = keys.filter(key => !known.has(key));
  if (unknown.length) throw usageError(t('usage.unknownFields', { fields: unknown.join(', ') }));
  if (!keys.length) throw usageError(t('usage.nothingToUpdate'));
  const pick = (names: readonly string[]) => Object.fromEntries(Object.entries(changes).filter(([key, value]) => names.includes(key) && value !== undefined));
  let result: FeedPayload | undefined;
  if (keys.some(key => (definitionKeys as readonly string[]).includes(key))) {
    const { feed } = await client.getFeed(id);
    const rules = { ...feed.rules, ...changes.rules } as SelectionRules & Record<string, string | undefined>;
    for (const field of Object.keys(rules)) if (rules[field] === '') delete rules[field];
    const input: FeedInput = {
      sourceType: feed.sourceType, translationMode: feed.translationMode, targetLanguage: feed.targetLanguage, translationProvider: feed.translationProvider,
      ...(feed.pubmed ? { pubmed: feed.pubmed } : {}),
      name: feed.name, url: feed.url, ruleOrigins: feed.ruleOrigins, credentialId: feed.credentialId, networkProfileId: feed.networkProfileId,
      intervalMinutes: feed.intervalMinutes, waitMs: feed.waitMs, waitForSelector: feed.waitForSelector, pagination: feed.pagination ?? null,
      ...pick([...definitionKeys, ...sharedKeys]), rules,
      // A new query keeps the saved number of articles unless one is given.
      ...(changes.pubmed ? { pubmed: { ...feed.pubmed, ...changes.pubmed } as FeedInput['pubmed'] } : {}),
    };
    result = await client.replaceFeed(id, input);
    const settings = pick(settingsOnlyKeys);
    if (Object.keys(settings).length) result = await client.updateFeedSettings(id, settings);
  } else {
    const { name, ...settings } = pick([...settingsOnlyKeys, ...sharedKeys]) as FeedSettingsInput & { name?: string };
    result = await client.updateFeedSettings(id, { ...settings, ...(name !== undefined && settings.channelTitle === undefined ? { channelTitle: name } : {}) });
  }
  return client.dryRun ? dryRunResult(client) : withUrls(result!);
}

export async function deleteFeed(client: FeedLanternClient, id: string) {
  return client.deleteFeed(id);
}

/** Pauses or resumes; does nothing (and says so) when the feed is already in that state. Resuming refetches. */
export async function setFeedEnabled(client: FeedLanternClient, id: string, enabled: boolean) {
  const detail = await client.getFeed(id);
  if (detail.feed.enabled === enabled) return { changed: false, feed: detail.feed, feedUrl: detail.feedUrl, feedUrls: feedUrls(detail) };
  const payload = await client.toggleFeed(id);
  return client.dryRun ? dryRunResult(client) : { changed: true, ...withUrls(payload) };
}

export async function refreshFeed(client: FeedLanternClient, id: string) {
  const payload = await client.refreshFeed(id);
  if (client.dryRun) return dryRunResult(client);
  return { ok: !payload.feed.lastError, error: payload.feed.lastError, ...withUrls(payload) };
}

export async function bulk(client: FeedLanternClient, action: BulkAction, ids: string[], settings?: BulkFeedSettingsInput) {
  if (!ids.length) throw usageError(t('usage.needIds'));
  const response = await client.bulk(action, ids, settings);
  if (client.dryRun) return dryRunResult(client);
  const failed = response.results.filter(result => !result.ok).length;
  return { action, succeeded: response.results.length - failed, failed, results: response.results };
}

export function rssPreview(client: FeedLanternClient, url: string, networkProfileId?: string | null) {
  return client.rssPreview(url, networkProfileId);
}

// PubMed searches

/** A PubMed search given as a ready query, or as builder conditions (AND by default) and filters. */
export interface PubmedSearchInput {
  query?: string;
  conditions?: Array<{ field: PubmedField; term: string; op?: PubmedOperator; phrase?: boolean }>;
  filters?: PubmedFilters;
}

/** The query to send: the given one, or the one the conditions build (as the web builder writes it). The server checks its syntax. */
export function pubmedQueryFrom(input: PubmedSearchInput): string {
  const filters = input.filters ?? {};
  const built = !!input.conditions?.length || Object.values(filters).some(value => value !== undefined && value !== false && !(Array.isArray(value) && !value.length));
  if (input.query?.trim() && built) throw usageError(t('usage.pubmedQueryOrConditions'));
  const query = input.query?.trim() || buildPubmedQuery({ rows: (input.conditions ?? []).map(condition => ({ op: condition.op ?? 'AND', field: condition.field, term: condition.term, ...(condition.phrase ? { phrase: true } : {}) })), filters });
  if (!query) throw usageError(t('usage.pubmedNoQuery'));
  return query;
}

/** How many articles match and the newest 5, with the query that was sent. */
export async function pubmedPreview(client: FeedLanternClient, input: PubmedSearchInput, networkProfileId?: string | null) {
  const query = pubmedQueryFrom(input);
  const preview = await client.pubmedPreview(query, networkProfileId);
  return preview ? { query, ...preview } : { query };
}

export interface PubmedFeedInput extends PubmedSearchInput, Pick<FeedInput, 'translationMode' | 'targetLanguage' | 'translationProvider' | 'networkProfileId'> {
  name?: string; limit?: number; intervalMinutes?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const reportRow = (entry: PubmedCheckEntry) => ({
  feedId: entry.feedId, name: entry.name, state: entry.state, status: entry.check?.status ?? null, reason: entry.check?.reason ?? null,
  query: entry.check?.query ?? null, coverage: entry.check?.coverage ? `${entry.check.coverage.matched}/${entry.check.coverage.total}${entry.check.coverage.source === 'stored' ? ' (stored)' : ''}` : null,
  repaired: entry.check?.repaired ?? false, cached: entry.cached ?? false, error: entry.error ?? entry.check?.error ?? null,
});
/** A check job as the CLI and MCP print it: progress, then one row per feed. */
export const jobReport = (job: PubmedCheckJob) => ({ jobId: job.id, state: job.state, progress: job.progress ?? null, ncbiKeyConfigured: job.ncbiKeyConfigured ?? null, feeds: job.entries.map(reportRow) });

/** Waits (up to `waitMs`) for a check job to finish, reading its progress every 1.5 s. */
async function settle(client: FeedLanternClient, job: PubmedCheckJob, waitMs: number): Promise<PubmedCheckJob> {
  const deadline = Date.now() + waitMs;
  while (job.state === 'running' && Date.now() < deadline) { await sleep(Math.min(1500, Math.max(0, deadline - Date.now()))); job = await client.pubmedCheckJob(job.id); }
  return job;
}

/**
 * Checks all (or the listed) PubMed RSS feeds in a background job on the
 * server; it keeps running when this command ends. `waitMs` waits for it.
 */
export async function pubmedChecks(client: FeedLanternClient, input: { feedIds?: string[]; recheck?: boolean; waitMs?: number } = {}) {
  let job = await client.startPubmedChecks(input.feedIds, input.recheck);
  if (input.waitMs) job = await settle(client, job, input.waitMs);
  return { ...jobReport(job), ...(job.state === 'running' ? { hint: t('pubmed.checksRunning') } : {}) };
}

/** A check job's progress and results (the latest one by default); optionally cancels, retries or waits. */
export async function pubmedCheckStatus(client: FeedLanternClient, input: { jobId?: string; cancel?: boolean; retry?: boolean; waitMs?: number } = {}) {
  let job = input.jobId ? await client.pubmedCheckJob(input.jobId) : (await client.latestPubmedChecks()).job;
  if (!job) throw new FeedLanternError({ code: 'not_found', status: 404, message: t('pubmed.noChecks') });
  if (input.cancel) job = await client.cancelPubmedChecks(job.id);
  if (input.retry) job = await client.retryPubmedChecks(job.id);
  if (input.waitMs) job = await settle(client, job, input.waitMs);
  return jobReport(job);
}

/** Converts the verified feeds of a check job (or the listed ones among them). */
export async function pubmedConvertVerified(client: FeedLanternClient, jobId: string, feedIds?: string[]) {
  const response = await client.convertPubmedChecks(jobId, feedIds);
  if (client.dryRun) return dryRunResult(client);
  const failed = response.results.filter(result => !result.ok).length;
  return { converted: response.results.length - failed, failed, results: response.results, ...jobReport(response.job) };
}

/**
 * `pubmed convert`: one feed is checked now and, with `yes`, converted (a
 * feed that needs review only with the reviewed `query`). `allVerified`
 * checks every PubMed RSS feed in a background job, waits for it, reports,
 * and with `yes` converts the verified ones. Without `yes` nothing changes.
 */
export async function pubmedConvert(client: FeedLanternClient, input: { feedId?: string; allVerified?: boolean; yes?: boolean; query?: string; limit?: number; recheck?: boolean; waitMs?: number }) {
  if (!input.feedId === !input.allVerified) throw usageError(t('usage.pubmedConvertTarget'));
  if (input.allVerified && input.query) throw usageError(t('usage.pubmedConvertQueryOne'));
  if (input.allVerified) {
    const job = await settle(client, await client.startPubmedChecks(undefined, input.recheck), input.waitMs ?? 30 * 60_000);
    if (!input.yes) return { ...jobReport(job), converted: 0, hint: t(job.state === 'running' ? 'pubmed.checksRunning' : 'pubmed.convertHint') };
    return pubmedConvertVerified(client, job.id);
  }
  const check = await client.pubmedCheck(input.feedId!);
  const row = { feedId: check.feedId, name: check.name, status: check.status, reason: check.reason ?? null, query: check.query, coverage: check.coverage ? `${check.coverage.matched}/${check.coverage.total}${check.coverage.source === 'stored' ? ' (stored)' : ''}` : null, count: check.count ?? null, limit: check.limit, repaired: check.repaired, error: check.error ?? null };
  if (!input.yes) return { checked: 1, verified: check.status === 'verified' ? 1 : 0, review: check.status === 'review' ? 1 : 0, converted: 0, feeds: [row], hint: t('pubmed.convertHint') };
  const query = input.query ?? (check.status === 'verified' ? check.query : undefined);
  if (!query) throw usageError(t('pubmed.convertNeedsReview'));
  const payload = await client.pubmedConvert(check.feedId, query, input.limit ?? check.limit);
  if (client.dryRun) return { ...dryRunResult(client), feeds: [row] };
  return { converted: 1, feeds: [{ ...row, query }], ...withUrls(payload) };
}

/** Creates a PubMed search feed; the first fetch runs in the background (see feeds logs). */
export async function createPubmedFeed(client: FeedLanternClient, input: PubmedFeedInput) {
  const query = pubmedQueryFrom(input);
  const limit = input.limit ?? PUBMED_DEFAULT_LIMIT;
  const name = (input.name ?? `PubMed: ${pubmedDefaultTerms(parsePubmedQuery(query), query)}`).slice(0, 200);
  return withUrls(await client.createFeed({
    sourceType: 'pubmed', pubmed: { query, limit }, url: pubmedSearchUrl({ query, limit }), name,
    rules: { item: '', title: '', link: '' }, credentialId: null, waitMs: 0, intervalMinutes: input.intervalMinutes ?? 60,
    translationMode: input.translationMode ?? 'original',
    ...(input.targetLanguage ? { targetLanguage: input.targetLanguage } : {}),
    ...(input.translationProvider !== undefined ? { translationProvider: input.translationProvider } : {}),
    ...(input.networkProfileId ? { networkProfileId: input.networkProfileId } : {}),
  }));
}

// Detection and rule previews run in a temporary remote browser session.

async function inBrowser<T>(client: FeedLanternClient, input: BrowserOpenInput, work: (sessionId: string, frame: { url: string; title: string }) => Promise<T>): Promise<T> {
  const frame = await client.openBrowser(input);
  const sessionId = frame?.sessionId ?? placeholder;
  try { return await work(sessionId, frame ?? { url: input.url, title: '' }); }
  finally { await client.closeBrowser(sessionId).catch(() => {}); }
}

export interface PageOptions { waitMs?: number; waitForSelector?: string; credentialId?: string | null; networkProfileId?: string | null }

export async function detect(client: FeedLanternClient, url: string, options: PageOptions & { samples?: number } = {}) {
  const samples = options.samples ?? 3;
  const { samples: _samples, ...page } = options;
  const result = await inBrowser(client, { url, ...page }, async (sessionId, frame) => ({ frame, detection: await client.detect(sessionId) }));
  if (client.dryRun) return dryRunResult(client);
  const { frame, detection } = result;
  const recommended = detection.candidates.find(candidate => candidate.id === detection.recommendedId) ?? null;
  return {
    url, finalUrl: frame.url, title: frame.title, recommendedId: detection.recommendedId, warnings: detection.warnings,
    candidates: detection.candidates.map(candidate => ({
      id: candidate.id, label: candidate.label, confidence: candidate.confidence, score: candidate.score, count: candidate.count,
      rules: candidate.rules, warnings: candidate.warnings, coverage: coverage(candidate.items), samples: candidate.items.slice(0, samples),
    })),
    // Ready to pass to `feeds create` / the feed_create tool.
    suggestion: recommended ? { name: frame.title || new URL(url).hostname, url, rules: recommended.rules, ...(page.waitMs !== undefined ? { waitMs: page.waitMs } : {}), ...(page.waitForSelector ? { waitForSelector: page.waitForSelector } : {}) } : null,
  };
}

/** How many items have each field: the quickest signal that a rule matches the wrong element. */
export function coverage(items: ExtractedItem[]) {
  const links = items.map(item => item.link).filter(Boolean);
  return {
    items: items.length,
    title: items.filter(item => item.title?.trim()).length,
    link: links.length,
    description: items.filter(item => item.description?.trim()).length,
    image: items.filter(item => item.image).length,
    date: items.filter(item => item.publishedAt).length,
    duplicateLinks: links.length - new Set(links).size,
  };
}

export async function previewRules(client: FeedLanternClient, input: PageOptions & { url?: string; feedId?: string; rules: Partial<SelectionRules>; pagination?: PaginationRules | null; limit?: number }) {
  const limit = input.limit ?? 10;
  if (input.feedId) {
    // On a saved feed's page; given rules are merged into the saved ones.
    const { feed } = await client.getFeed(input.feedId);
    const rules = { ...feed.rules, ...input.rules } as SelectionRules & Record<string, string | undefined>;
    for (const field of Object.keys(rules)) if (rules[field] === '') delete rules[field];
    const preview = await client.previewOnFeed(input.feedId, rules);
    if (client.dryRun) return dryRunResult(client);
    return { feedId: input.feedId, url: feed.url, rules, count: preview.count, coverage: coverage(preview.items), ...(preview.error ? { error: preview.error } : {}), items: preview.items.slice(0, limit) };
  }
  if (!input.url) throw usageError(t('usage.previewTarget'));
  const { url, rules, pagination, limit: _limit, feedId: _feedId, ...page } = input;
  const preview = await inBrowser(client, { url, ...page }, sessionId => client.preview(sessionId, rules as SelectionRules, pagination));
  if (client.dryRun) return dryRunResult(client);
  return { url, rules, count: preview.items.length, coverage: coverage(preview.items), ...(preview.pagination ? { pagination: preview.pagination } : {}), items: preview.items.slice(0, limit) };
}

// Bundles

export const listBundles = (client: FeedLanternClient) => client.listBundles();
export const getBundle = (client: FeedLanternClient, id: string) => client.getBundle(id);
export async function createBundle(client: FeedLanternClient, input: { name: string; feedIds: string[]; itemLimit?: number }) {
  const created = await client.createBundle(input);
  return client.dryRun ? dryRunResult(client) : created;
}
export async function updateBundle(client: FeedLanternClient, id: string, changes: { name?: string; feedIds?: string[]; itemLimit?: number; addFeedIds?: string[] }) {
  const { addFeedIds, ...rest } = changes;
  const replace = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
  if (!Object.keys(replace).length && !addFeedIds?.length) throw usageError(t('usage.nothingToUpdate'));
  let result = Object.keys(replace).length ? await client.updateBundle(id, replace) : undefined;
  if (addFeedIds?.length) result = await client.addBundleFeeds(id, addFeedIds);
  return client.dryRun ? dryRunResult(client) : result;
}
export const deleteBundle = (client: FeedLanternClient, id: string) => client.deleteBundle(id);

// Import jobs

export const listImports = (client: FeedLanternClient) => client.listImports();
export async function createImport(client: FeedLanternClient, input: ImportJobInput) {
  if (!input.entries.length) throw usageError(t('usage.needUrls'));
  const job = await client.createImport(input);
  return client.dryRun ? dryRunResult(client) : job;
}
export async function updateImport(client: FeedLanternClient, id: string, action: 'cancel' | 'retry', entryId?: string) {
  const job = await client.updateImport(id, action, entryId);
  return client.dryRun ? dryRunResult(client) : job;
}

/** Any route a token may call, for what the named commands do not cover. */
export async function rawRequest(client: FeedLanternClient, method: HttpMethod, path: string, body?: unknown, query?: Record<string, string>) {
  if (!path.startsWith('/api/')) throw usageError(t('usage.apiPath'));
  const result = await client.request(method, path, { body, query });
  return client.dryRun && method !== 'GET' ? dryRunResult(client) : result;
}
