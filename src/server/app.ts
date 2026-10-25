import { defaultApplicationSettings, errorCodeForStatus, isFeedSource, isTargetLanguage, isTranslationProvider, OUTPUT_LIMIT, translationEnabled, type ApiErrorCode, type TranslationProviderId, type TranslationProvidersInfo } from '../shared/types.js';
import { providerProblem } from './translation-providers.js';
import { fetchSource, probeTarget, type SourceFetcher, type SourceOptions, type SourceResult } from './rss-source.js';
import { checkPubmedRss, fetchPubmedSearch, keyDigest, NcbiRateLimiter, previewPubmed, testNcbiSettings, withPubmedRssHint } from './pubmed.js';
import { checkSignature, jobSnapshot, PubmedCheckRunner } from './pubmed-checks.js';
import { nearestPubmedLimit, pubmedDefaultName, pubmedPmidOf, pubmedRssSource, pubmedSearchUrl } from '../shared/pubmed.js';
import { NetworkPolicy, NetworkPolicyError } from './network.js';
import { networkOptions, parseNetworkProfileInput, type FetchNetworkOptions } from './fetch-options.js';
import { TranslationError, TranslationWorker, type Translator } from './rss-translation.js';
import type { BarkSender } from './bark.js';
import { NotificationWorker, alertTitle, channelsSummary, defaultSenders, ntfySchema, notificationChannelsSchema, telegramSchema, webhookSchema, type ChannelConfigs, type ChannelSender, type NotificationEvent, type NotificationSenders } from './notify.js';
import { applicationSettingsSchema, settingsFromConfig, applyRuntimeSettings, ncbiSettingsSchema } from './settings.js';
import { safeDiagnostic } from './fetch-history.js';
import { isAbortError, NcbiError, NotAFeedError } from './fetch-errors.js';
import { headerLocale, issueText, LocalizedError, lt, msg, rawText, tl, translate, withLocale, type LocalizedText } from './i18n.js';
import { isLocale, isMessageKey, type Locale } from '../shared/i18n.js';
import { TaskPool, siteKey } from './task-pool.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import ipaddr from 'ipaddr.js';
import { openBackup, sealBackup, snapshotSchema } from './backups.js';
import { timingSafeEqual } from 'node:crypto';
import { ImportJobs, normalizeSource } from './import-jobs.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { Cookie } from 'playwright';
import type {
  AuthState,
  ApplicationSettings,
  CredentialSummary,
  NetworkProfileSummary,
  DetectionResult,
  ExtractedItem,
  Feed,
  DashboardPeriod,
  PubmedPreview,
  PubmedRssCheck,
  NcbiKeyTest,
  FetchSource,
  FetchStatus,
  FeedInput,
  FeedSettingsInput,
  FeedFormat,
  FeedItem,
  ItemOutputStatus,
  PaginationReport,
  PaginationRules,
  PickRequest,
  PickResult,
  ScreenFrame,
  SegmentResult,
  SelectionRules,
} from '../shared/types.js';
import { parseCookies, cookiesForUrl, CookieParseError } from './cookies.js';
import {
  AppError,
  LoginRateLimiter,
  authState,
  bearerToken,
  clearSessionCookie,
  issueCsrf,
  requireAuth,
  requireCsrf,
  sessionFromRequest,
  setSessionCookie,
  validatePassword,
  validateUsername,
  specificErrorCode,
} from './auth.js';
import { getConfig, ensureDataDir, hasDist, isAllowedOrigin, type ConfigInput, type ServerConfig } from './config.js';
import { renderAtom, renderJsonFeed, renderRss, rssEtag } from './rss.js';
import { classifyItems, ItemFilterError, parseItemFilter, retentionProblem } from './feed-output.js';
import { etagMatches, renderRssPreview, wantsHtmlPreview } from './rss-preview.js';
import { parseTargetLanguage, parseTranslationMode, parseTranslationProvider, asInteger, describeError, asNonEmptyString, asOptionalString, asRecord, cookieMetadata, frameError, friendlyError, logHiddenError, parseCredentialInput, parseFeedInput, parseHttpUrl, parsePagination, parsePartialRules, parsePubmedQueryText, parsePubmedSearch, parseRules } from './validation.js';
import { reportSummary } from './pagination.js';
import { Store, type CredentialValue } from './store.js';
import { registerRuleHealthRoutes } from './rule-health-routes.js';
import { exportConfigBundles, importConfigBundles, parseConfigBundles, previewConfigBundles, registerBundleRoutes } from './bundle-routes.js';
import { API_TOKEN_LIMIT_PER_USER, API_TOKEN_MAX_DAYS, READ_METHODS, tokenAllowedRoute } from './api-tokens.js';
import { buildOpenApi } from './openapi.js';
import type { TokenIdentity } from './api-token-log.js';
import type { ApiTokenCallFilter } from '../shared/types.js';

export interface RegisteredRoute { method: string; url: string }
const appRoutes = new WeakMap<FastifyInstance, RegisteredRoute[]>();
/** Every route registered by createApp, for checking the OpenAPI document against the router. */
export function registeredRoutes(app: FastifyInstance): RegisteredRoute[] {
  return [...(appRoutes.get(app) ?? [])];
}

export interface BrowserServiceLike {
  discover?(options: { url: string; signal?: AbortSignal; cookies?: Cookie[]; waitMs: number; network?: FetchNetworkOptions }): Promise<{ title: string; detection: DetectionResult }>;
  open(options: { url: string; signal?: AbortSignal; cookies?: Cookie[]; waitMs: number; waitForSelector?: string; network?: FetchNetworkOptions }): Promise<ScreenFrame> | ScreenFrame;
  snapshot(id: string): Promise<ScreenFrame> | ScreenFrame;
  scroll(id: string, deltaY: number, point?: { x: number; y: number }): Promise<ScreenFrame> | ScreenFrame;
  click(id: string, x: number, y: number): Promise<ScreenFrame> | ScreenFrame;
  follow?(id: string, node: number): Promise<ScreenFrame> | ScreenFrame;
  segment?(id: string, top: number): Promise<SegmentResult> | SegmentResult;
  pick(id: string, request: PickRequest): Promise<PickResult> | PickResult;
  extract(id: string, rules: SelectionRules): Promise<ExtractedItem[]> | ExtractedItem[];
  scrape(options: { url: string; signal?: AbortSignal; cookies?: Cookie[]; waitMs: number; waitForSelector?: string; rules: SelectionRules; network?: FetchNetworkOptions; pagination?: PaginationRules | null; isKnown?: (link: string) => boolean; onReport?: (report: PaginationReport, firstPage: ExtractedItem[]) => void }): Promise<ExtractedItem[]> | ExtractedItem[];
  paginate?(id: string, rules: SelectionRules, pagination: PaginationRules): Promise<{ items: ExtractedItem[]; report: PaginationReport }>;
  detect?(id: string): Promise<DetectionResult> | DetectionResult;
  close(id: string): Promise<void> | void;
  closeEditors?(): Promise<void>;
  dispose(): Promise<void> | void;
}

export interface CreateAppOptions extends ConfigInput {
  config?: ServerConfig;
  store?: Store;
  browserService?: BrowserServiceLike;
  startScheduler?: boolean;
  /** Replaces the Bark sender (tests and the e2e backend). */
  barkSender?: BarkSender;
  /** Replaces individual channel senders (tests and the e2e backend). */
  notificationSenders?: Partial<NotificationSenders>;
  rssFetcher?: SourceFetcher;
  /** Replaces the Google channel only; DeepL and OpenAI-compatible services always use their real clients. */
  translator?: Translator;
  translationIntervalMs?: number;
  /** Test-only replacement for DeepL's fixed API endpoints. */
  deeplEndpoints?: { free: string; pro: string };
  /** Test-only replacement for the NCBI E-utilities base address (PubMed search subscriptions). */
  ncbiEndpoint?: string;
  /** Test-only: where the PubMed conversion check reads `https://pubmed.ncbi.nlm.nih.gov/rss/…` addresses from. */
  pubmedRssBase?: string;
}

/** How long an identical PubMed preview is answered from memory. */
const PUBMED_PREVIEW_CACHE_MS = 60_000;
/** A preview that would wait longer than this for its NCBI slot is refused (429) instead of queued. */
const PUBMED_PREVIEW_MAX_WAIT_MS = 10_000;

function authHeaders(request: FastifyRequest): { marker: boolean; csrf?: string } {
  const marker = request.headers['x-feedlantern'];
  const csrf = request.headers['x-csrf-token'];
  return { marker: marker === '1', csrf: Array.isArray(csrf) ? csrf[0] : csrf };
}

/** Judged by the matched route too: an encoded path such as `/%61pi/feeds` still routes to `/api/feeds`. */
function isApiRequest(request: FastifyRequest): boolean {
  return request.url.startsWith('/api/') || !!request.routeOptions.url?.startsWith('/api/');
}

function feedUrl(config: ServerConfig, store: Store, id: string): string {
  const token = store.getFeedToken(id);
  if (!token) throw new AppError(404, 'error.feedNotFound');
  return `${config.publicOrigin}/feeds/${encodeURIComponent(id)}/${encodeURIComponent(token.token)}.xml`;
}

async function makeBrowserService(config: ServerConfig, injected?: BrowserServiceLike): Promise<BrowserServiceLike> {
  if (injected) return injected;
  const module = await import('./browser.js');
  const BrowserService = module.BrowserService as new (options: { allowedHosts?: string[]; dnsOverHttps?: boolean; executablePath?: string; backgroundConcurrency?: number }) => BrowserServiceLike;
  return new BrowserService({ allowedHosts: config.allowedHosts, dnsOverHttps: config.dnsOverHttps, backgroundConcurrency: config.backgroundConcurrency, executablePath: config.browserExecutablePath });
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? getConfig(options);
  await ensureDataDir(config.dataDir);
  const store = options.store ?? new Store(config);
  store.initializeSettings(settingsFromConfig(config));
  applyRuntimeSettings(config, store.getSettings());
  let browser = await makeBrowserService(config, options.browserService);
  store.history.recover();
  const notifyPolicy = () => new NetworkPolicy({ allowedHosts: config.allowedHosts, dnsOverHttps: config.dnsOverHttps });
  const panelUrl = (feedId: string | null, event: NotificationEvent) => feedId
    ? `${config.publicOrigin}/#/feed/${encodeURIComponent(feedId)}${event === 'fetch.failed' ? '/logs' : ''}` : `${config.publicOrigin}/#/settings`;
  const barkSender = options.barkSender;
  const senders: NotificationSenders = {
    ...defaultSenders,
    ...(barkSender ? { bark: (channel, message, context) => barkSender(channel.url, message.body, context.signal, message.title) } satisfies Partial<NotificationSenders> : {}),
    ...options.notificationSenders,
  };
  const notifier = new NotificationWorker(store.history, { target: id => store.notificationTarget(id), senders, network: notifyPolicy, panelUrl });
  const app = Fastify({ logger: false, bodyLimit: 2_500_000, trustProxy: address => {
    try {
      const peer = ipaddr.process(address);
      return (config.trustedProxies ?? []).some(raw => {
        const [network, bits] = raw.includes('/') ? ipaddr.parseCIDR(raw) : [ipaddr.parse(raw), raw.includes(':') ? 128 : 32] as const;
        return peer.kind() === network.kind() && peer.match(network, bits);
      });
    } catch { return false; }
  } });
  // Fastify captures the error handler when a route is registered.
  // Install it before plugins/routes so errors share the frontend contract.
  // Errors carry a stable `code` and `message` in the reader's language
  // (`error` repeats the message for clients written before codes existed).
  // Errors: `code` is the stable, documented reason (scripts, the CLI and MCP branch on it);
  // `message` is in the reader's language (`error` repeats it for older clients);
  // `messageKey` and `params` identify the text, so an interface can show it in its own language.
  const sendError = (reply: FastifyReply, status: number, text: LocalizedText, code?: ApiErrorCode) => {
    const message = lt(text);
    return reply.code(status).send({ code: code ?? specificErrorCode(text.key) ?? errorCodeForStatus(status), message, error: message, messageKey: text.key, ...(text.params ? { params: text.params } : {}) });
  };
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) return sendError(reply, error.statusCode, error.text, error.code);
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 400 || status === 413 || status === 415) return sendError(reply, status, msg('error.badRequest'));
    console.error(`Unhandled server error ${request.method} ${request.routeOptions.url ?? ''}: ${describeError(error)}`);
    return sendError(reply, 500, msg('error.internal'));
  });
  const routes: RegisteredRoute[] = [];
  appRoutes.set(app, routes);
  app.addHook('onRoute', route => {
    for (const method of [route.method].flat()) routes.push({ method, url: route.url });
  });
  await app.register(cookie);
  const allowedApiHosts = new Set([
    new URL(config.publicOrigin).host.toLowerCase(),
    ...config.viteOrigins.map((origin) => {
      try { return new URL(origin).host.toLowerCase(); } catch { return ''; }
    }).filter(Boolean),
  ]);

  /**
   * The reader's language: the signed-in account's choice, else the
   * browser's Accept-Language (the web UI sends its current language),
   * else English. Requests run in it, so errors and stored text use it.
   */
  const requestLocales = new WeakMap<FastifyRequest, Locale>();
  const requestLocale = (request: FastifyRequest): Locale => {
    const cached = requestLocales.get(request);
    if (cached) return cached;
    let chosen: Locale | null = null;
    try { const session = sessionFromRequest(request, store, config); if (session) chosen = store.userLocale(session.userId); } catch { /* fall back to the header */ }
    const locale = chosen ?? headerLocale(request.headers['accept-language']);
    // Cookies are parsed by a later hook; decide for good only once they are.
    if (request.cookies) requestLocales.set(request, locale);
    return locale;
  };
  app.addHook('onRequest', (request, _reply, done) => withLocale(() => requestLocale(request), done));

  let warnedSharedProxyIp = false;
  const requestConfigs = new AsyncLocalStorage<ServerConfig>();
  const currentConfig = () => requestConfigs.getStore() ?? config;
  // The default published port is loopback-only. Forwarding headers are accepted
  // only from a local proxy (including the Docker bridge), never a public peer.
  app.addHook('onRequest', (request, _reply, done) => {
    const forwardedHost = request.headers['x-forwarded-host'];
    const forwardedProto = request.headers['x-forwarded-proto'];
    let localPeer = false;
    try { localPeer = ['loopback', 'private', 'uniqueLocal'].includes(ipaddr.process(request.socket.remoteAddress ?? '').range()); } catch {}
    if (!localPeer || forwardedHost === undefined) return requestConfigs.run(config, done);
    if (!warnedSharedProxyIp && !(config.trustedProxies ?? []).length) {
      warnedSharedProxyIp = true;
      console.warn('Requests arrive through a reverse proxy, but TRUSTED_PROXIES is not set: login rate limiting treats every user as one client, so 8 failures lock everyone out for 15 minutes. Set TRUSTED_PROXIES to the proxy address.');
    }
    try {
      if (typeof forwardedHost !== 'string' || !/^[a-zA-Z0-9.:[\]-]+$/.test(forwardedHost) || !['http', 'https'].includes(String(forwardedProto))) throw Error();
      const origin = new URL(`${forwardedProto}://${forwardedHost}`).origin;
      if (new URL(origin).host.toLowerCase() !== forwardedHost.toLowerCase()) throw Error();
      requestConfigs.run({ ...config, publicOrigin: origin, cookieSecure: config.cookieSecure || forwardedProto === 'https' }, done);
    } catch { done(new AppError(400, 'error.forwardedHeadersInvalid')); }
  });

  const limiter = new LoginRateLimiter();
  // Failed bearer tokens are limited per client address, separately from logins.
  const tokenLimiter = new LoginRateLimiter(20);
  let schedulerRunning = false;
  let scheduler: NodeJS.Timeout | undefined;
  let closing = false;
  let maintenance = false;
  const pool = new TaskPool(config.backgroundConcurrency);
  const translationSettings = () => {
    const settings = store.getSettings().translation;
    return options.translationIntervalMs === undefined ? settings : { ...settings, requestIntervalMs: options.translationIntervalMs };
  };
  const translationNetwork = { policy: () => new NetworkPolicy({ allowedHosts: config.allowedHosts, dnsOverHttps: config.dnsOverHttps }), deeplEndpoints: options.deeplEndpoints };
  const translations = new TranslationWorker(store.translations, options.translator, translationSettings, (feedId, error) => {
    try {
      const feed = store.getFeed(feedId); if (!feed) return;
      if (error) store.history.translationFailed(feed, error);
      else store.history.translationRecovered(feedId);
      notifier.wake();
    } catch { console.error('Failed to queue a translation alert'); }
  }, translationNetwork);
  const fetchPolicy = () => new NetworkPolicy({ allowedHosts: config.allowedHosts, dnsOverHttps: config.dnsOverHttps });
  // RSS addresses are fetched as given; a PubMed journal RSS address blocked by NCBI gets an explanation.
  const getRss: SourceFetcher = withPubmedRssHint(options.rssFetcher ?? ((url, fetchOptions) => fetchSource(url, fetchPolicy(), fetchOptions)));
  // Every request to NCBI (all PubMed search subscriptions and previews) shares one queue.
  const ncbi = { limiter: new NcbiRateLimiter(), settings: () => store.getSettings().ncbi, endpoint: options.ncbiEndpoint };
  const getPubmed = (feed: Feed, fetchOptions: SourceOptions): Promise<SourceResult> => {
    if (!feed.pubmed) throw new LocalizedError(msg('error.pubmedFeedInvalid'));
    return fetchPubmedSearch(feed.pubmed, fetchPolicy(), ncbi, fetchOptions);
  };
  const refreshInFlight = new Map<string, { promise: Promise<Feed | null>; force: boolean }>();

  // Unkeyed mutations form barriers; independent captures share bounded slots.
  const enqueueRefresh = <T,>(operation: () => Promise<T> | T, keys?: string[] | (() => string[])): Promise<T> => {
    if (closing || maintenance) return Promise.reject(new AppError(503, 'error.shuttingDown'));
    return pool.enqueue(operation, keys);
  };
  const refreshKeys = (id: string) => {
    const feed = store.getFeed(id);
    return [`feed:${id}`, ...(feed ? [siteKey(feed.url)] : [])];
  };

  const currentSession = (request: FastifyRequest): ReturnType<typeof sessionFromRequest> => sessionFromRequest(request, store, config);
  const authenticated = (request: FastifyRequest): ReturnType<typeof requireAuth> => requireAuth(request, store, config);

  const cookiesForTarget = (credential: CredentialValue, targetUrl: string): Cookie[] => {
    if (typeof credential.value !== 'string') throw new AppError(400, 'error.credentialValueInvalid');
    try {
      // Parse against the credential's declared binding first. Rebinding a
      // pasted header to the requested page would otherwise turn a credential
      // for one host into a credential for an arbitrary host.
      const parsed = parseCookies(credential.value, credential.format, credential.url);
      const filtered = cookiesForUrl(parsed, targetUrl);
      if (filtered.length === 0) throw new AppError(400, 'error.credentialDomainMismatch');
      return filtered;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(400, friendlyError(error, msg('error.credentialUnparsable')));
    }
  };

  const credentialsForFeed = (feed: Feed): Cookie[] => {
    if (!feed.credentialId) return [];
    const credential = store.getCredentialValue(feed.credentialId);
    if (!credential) throw new AppError(400, 'error.feedCredentialMissing');
    return cookiesForTarget(credential, feed.url);
  };

  /**
   * The one place a feed's network profile becomes fetch options. Editor
   * preview, batch discovery and background refresh all call it, so the three
   * paths always use the same proxy, User-Agent, Referer and headers.
   */
  const networkFor = (profileId: string | null | undefined, ownerId?: string): FetchNetworkOptions | undefined => {
    if (!profileId) return undefined;
    const profile = store.getNetworkProfile(profileId);
    if (!profile || (ownerId !== undefined && profile.ownerId !== ownerId)) throw new AppError(400, 'error.feedNetworkProfileMissing');
    return networkOptions(profile);
  };

  const refreshOnce = async (id: string, source: FetchSource, actorSignal?: AbortSignal): Promise<Feed | null> => {
    const feed = store.getFeed(id);
    if (!feed || !store.isUserActive(feed.ownerId)) return null;
    const generation = store.userGeneration(feed.ownerId);
    const stillActive = () => !actorSignal?.aborted && !!store.getFeed(id) && store.userGeneration(feed.ownerId) === generation;
    const nextFetchAt = new Date(Date.now() + feed.intervalMinutes * 60_000).toISOString();
    const started = performance.now();
    const runId = store.transaction(() => {
      store.markFetchStart(feed.id, nextFetchAt);
      return store.history.start(feed.id, source);
    });
    try {
      // The same profile applies to every page of a multi-page collection (one browser context).
      const network = networkFor(feed.networkProfileId, feed.ownerId);
      const fetchSignal = AbortSignal.any([store.userSignal(feed.ownerId), ...(actorSignal ? [actorSignal] : [])]);
      const rss = feed.sourceType === 'rss' ? await getRss(feed.url, { ...store.translations.sourceState(feed.id), signal: fetchSignal, ...(network ? { network } : {}) })
        : feed.sourceType === 'pubmed' ? await getPubmed(feed, { signal: fetchSignal, ...(network ? { network } : {}) }) : undefined;
      let pages: PaginationReport | undefined;
      // Rule health compares page 1 only: how many pages a run reads changes with
      // the incremental stop and the page limit, which must not look like a broken rule.
      let firstPage: ExtractedItem[] | undefined;
      const multiPage = !rss && !!feed.pagination && feed.pagination.maxPages > 1;
      const items = rss ? [] : await browser.scrape({
        url: feed.url, signal: AbortSignal.any([store.userSignal(feed.ownerId), ...(actorSignal ? [actorSignal] : [])]), cookies: credentialsForFeed(feed), waitMs: feed.waitMs, waitForSelector: feed.waitForSelector, rules: feed.rules, ...(network ? { network } : {}),
        ...(multiPage ? { pagination: feed.pagination, isKnown: store.knownLinks(feed), onReport: (report: PaginationReport, first: ExtractedItem[]) => { pages = report; firstPage = first; } } : {}),
      });
      if (!rss && !items.length) throw new LocalizedError(msg('fetch.noItems'));
      if (!stillActive()) { store.history.interrupt(runId); return null; }
      const result = store.transaction(() => {
        const counts = { itemCount: 0, newItemCount: 0 };
        if (rss) {
          if (!rss.unchanged) {
            Object.assign(counts, store.translations.upsert(feed, store.translations.incoming(feed.id, rss.items)));
            store.translations.saveSource(feed.id, rss);
          } else counts.itemCount = feed.itemCount;
        } else {
          store.upsertItems(feed, items, counts);
          if (!counts.itemCount) throw new LocalizedError(msg('fetch.noItemsShort'));
        }
        const updated = store.markFetchSuccess(feed.id, nextFetchAt);
        store.history.succeed(runId, feed.id, performance.now() - started, counts, pages ? { pages: pages.pages.filter(page => !page.error).length, note: reportSummary(pages) } : undefined);
        return updated;
      });
      let checked = result;
      // Health statistics never change the fetch outcome or the stored items.
      if (!rss) try { store.transaction(() => store.ruleHealth.record(feed, runId, firstPage ?? items)); checked = store.getFeed(feed.id) ?? result; } catch (error) { logHiddenError(`Rule health statistics of feed ${feed.id}`, error, rawText('')); }
      notifier.wake();
      translations.wake();
      return checked;
    } catch (error) {
      // A cancel or a stopping service is an interruption, never a failure (or a timeout) to alert on.
      if (!stillActive() || closing && isAbortError(error)) { store.history.interrupt(runId); return null; }
      const shown = friendlyError(error, msg('fetch.failedKept'));
      logHiddenError(`Background fetch of feed ${feed.id}`, error, shown);
      const message = safeDiagnostic(lt(shown));
      store.transaction(() => {
        store.markFetchFailure(feed.id, message, nextFetchAt);
        store.history.fail(runId, feed, source, performance.now() - started, message, store.getSettings().bark.enabled);
      });
      notifier.wake();
      return store.getFeed(feed.id);
    }
  };

  const doRefresh = (id: string, dueOnly = false, source: FetchSource = dueOnly ? 'scheduled' : 'manual', authorize?: () => AbortSignal): Promise<Feed | null> => {
    const active = refreshInFlight.get(id);
    if (active) { if (!dueOnly) active.force = true; return active.promise; }
    const job = { force: !dueOnly, promise: Promise.resolve<Feed | null>(null) };
    job.promise = enqueueRefresh(() => {
      const actorSignal = authorize?.();
      const current = store.getFeed(id);
      if (!current || !store.isUserActive(current.ownerId)) return null;
      // Errors and alerts of a refresh are written in the feed owner's language.
      if (job.force || current.enabled && current.nextFetchAt <= new Date().toISOString()) return withLocale(() => store.ownerLocale(current.ownerId), () => refreshOnce(id, source, actorSignal));
      return current;
    }, () => refreshKeys(id)).finally(() => refreshInFlight.delete(id));
    refreshInFlight.set(id, job);
    return job.promise;
  };

  const refreshDue = async (): Promise<void> => {
    if (schedulerRunning || closing) return;
    schedulerRunning = true;
    try {
      const due = store.dueFeeds();
      await Promise.all(Array.from({ length: config.backgroundConcurrency }, async () => {
        while (!closing && !maintenance) {
          const feed = due.shift();
          if (!feed) break;
          // Recheck deadlines at execution; manual refreshes share this job.
          await doRefresh(feed.id, true);
        }
      }));
    } finally {
      schedulerRunning = false;
    }
  };

  const jobs = new ImportJobs(store, enqueueRefresh, async (entry, signal) => {
    if (!browser.discover) throw new AppError(501, 'error.discoverUnsupported');
    const credential = entry.credentialId ? store.getCredentialValue(entry.credentialId) : null;
    if (entry.credentialId && !credential) throw new AppError(400, 'error.credentialNotFound');
    // Ownership of the profile was checked when the job was created.
    const network = networkFor(entry.networkProfileId);
    return browser.discover({ signal, url: entry.url, waitMs: 1000, cookies: credential ? cookiesForTarget(credential, entry.url) : [], ...(network ? { network } : {}) });
  }, async (input, signal) => {
    const credential = input.credentialId ? store.getCredentialValue(input.credentialId) : null;
    if (input.credentialId && !credential) throw new AppError(400, 'error.credentialNotFound');
    const network = networkFor(input.networkProfileId);
    return browser.scrape({ ...input, signal, cookies: credential ? cookiesForTarget(credential, input.url) : [], ...(network ? { network } : {}) });
  }, error => lt(friendlyError(error, msg('error.detectFailed'))), config.backgroundConcurrency, (entry, signal) => { const network = networkFor(entry.networkProfileId); return getRss(entry.url, { signal, ...(network ? { network } : {}) }); }, () => translations.wake());

  // Requests made with a token, for its call log. Browser (cookie) sessions are not logged.
  const tokenCalls = new WeakMap<FastifyRequest, TokenIdentity>();
  app.addHook('onRequest', async (request, reply) => {
    if (maintenance) throw new AppError(503, 'error.maintenance');
    if (!isApiRequest(request)) return;
    const bearer = bearerToken(request);
    if (bearer !== undefined) {
      // Token requests skip the browser checks below (Host, Origin, X-FeedLantern
      // and CSRF): those only defend cookies a browser attaches by itself.
      if (!tokenLimiter.allowed(request.ip)) {
        const known = store.tokens.identify(bearer);
        if (known) tokenCalls.set(request, known);
        throw new AppError(429, 'error.tooManyTokenFailures');
      }
      const owner = store.tokens.find(bearer);
      if (owner) tokenCalls.set(request, { tokenId: owner.tokenId, userId: owner.userId, name: owner.name, prefix: owner.prefix });
      if (!owner) {
        // An expired token still shows the rejected call in its own log.
        const known = store.tokens.identify(bearer);
        if (known) tokenCalls.set(request, known);
        tokenLimiter.registerFailure(request.ip);
        reply.header('WWW-Authenticate', 'Bearer error="invalid_token"');
        throw new AppError(401, 'error.tokenInvalid');
      }
      const route = request.routeOptions.url;
      if (route && !tokenAllowedRoute(request.method, route)) throw new AppError(403, 'error.tokenRouteForbidden');
      if (owner.scope === 'read' && !READ_METHODS.has(request.method)) throw new AppError(403, 'error.readOnlyToken');
      return;
    }
    const requestHost = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
    if (!requestHost || !allowedApiHosts.has(requestHost.toLowerCase()) && requestHost.toLowerCase() !== new URL(currentConfig().publicOrigin).host.toLowerCase()) throw new AppError(403, 'error.hostForbidden');
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    if (!isAllowedOrigin(origin, currentConfig())) throw new AppError(403, 'error.originForbidden');
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS' && !authHeaders(request).marker) {
      throw new AppError(400, 'error.markerHeaderRequired');
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    const identity = tokenCalls.get(request);
    if (!identity) return;
    const durationMs = reply.elapsedTime;
    // Only the route template is kept, never the raw path or query string.
    store.tokenLog.record({ ...identity, at: new Date(Date.now() - durationMs).toISOString(), method: request.method, route: request.routeOptions.url ?? null, status: reply.statusCode, durationMs, ip: request.ip || null });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (isApiRequest(request)) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Content-Type-Options', 'nosniff');
    } else if (!request.url.startsWith('/feeds/')) {
      // The web UI must never be framed by another site.
      reply.header('X-Frame-Options', 'DENY');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Referrer-Policy', 'no-referrer');
    }
    return payload;
  });

  /** Accounts without a chosen language get alerts in the language their browser asks for. */
  const noteBrowserLocale = (request: FastifyRequest, userId: string) => {
    if (!store.userLocale(userId) && request.headers['accept-language']) store.noteDetectedLocale(userId, headerLocale(request.headers['accept-language']));
  };
  app.get('/api/auth/status', async (request): Promise<AuthState> => {
    const session = currentSession(request);
    const context = session;
    const csrf = context && !context.token ? issueCsrf(store, context) : undefined;
    if (context && !context.token) noteBrowserLocale(request, context.userId);
    return authState(store, config, context, csrf);
  });
  /** The signed-in account's interface language; `null` follows the browser. */
  app.put('/api/auth/locale', async (request): Promise<AuthState> => {
    const context = authenticated(request);
    requireCsrf(request, store, context);
    const locale = asRecord(request.body).locale;
    if (locale !== null && !isLocale(locale)) throw new AppError(400, 'error.localeInvalid');
    store.setUserLocale(context.userId, locale);
    if (locale === null) noteBrowserLocale(request, context.userId);
    requestLocales.delete(request);
    return authState(store, config, context, context.token ? undefined : issueCsrf(store, context));
  });

  // Public: the document describes the API shape only, as the source does, so
  // scripts and agents can read it before they are given a token.
  app.get('/api/openapi.json', async () => buildOpenApi(currentConfig().publicOrigin, config.version));

  app.post('/api/auth/setup', async (request, reply) => {
    if (store.hasAdmin()) throw new AppError(409, 'error.alreadySetUp');
    if (!limiter.allowed(request.ip)) throw new AppError(429, 'error.tooManySetups');
    const body = asRecord(request.body);
    const token = asNonEmptyString(body.setupToken, 'setupToken', 200);
    const username = body.username;
    const password = body.password;
    if (!validateUsername(username)) throw new AppError(400, 'error.usernameInvalid');
    if (!validatePassword(password)) throw new AppError(400, 'error.passwordLength');
    if (!store.consumeSetupToken(token)) {
      limiter.registerFailure(request.ip);
      throw new AppError(401, 'error.setupTokenInvalid');
    }
    limiter.clear(request.ip);
    try { store.createAdmin(username, password); } catch { throw new AppError(409, 'error.alreadySetUp'); }
    const session = store.createSession(username, config.sessionTtlMs);
    setSessionCookie(reply, currentConfig(), session.id);
    noteBrowserLocale(request, session.userId);
    return authState(store, config, { ...session, sessionId: session.id }, session.csrfToken);
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = asRecord(request.body);
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const key = request.ip;
    if (!limiter.allowed(key)) throw new AppError(429, 'error.tooManyLogins');
    if (!validateUsername(username) || !validatePassword(password) || !store.authenticate(username, password)) {
      limiter.registerFailure(key);
      throw new AppError(401, 'error.badCredentials');
    }
    limiter.clear(key);
    const session = store.createSession(username, config.sessionTtlMs);
    setSessionCookie(reply, currentConfig(), session.id);
    noteBrowserLocale(request, session.userId);
    return authState(store, config, { ...session, sessionId: session.id }, session.csrfToken);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const context = authenticated(request);
    requireCsrf(request, store, context);
    store.destroySession(context.sessionId);
    clearSessionCookie(reply, currentConfig());
    return authState(store, config, null);
  });

  app.post('/api/auth/password', async (request, reply) => {
    const context = authenticated(request);
    requireCsrf(request, store, context);
    const body = asRecord(request.body);
    const currentPassword = body.currentPassword;
    const newPassword = body.newPassword;
    if (typeof currentPassword !== 'string' || !store.authenticate(context.username, currentPassword)) throw new AppError(400, 'error.currentPasswordWrong');
    if (!validatePassword(newPassword)) throw new AppError(400, 'error.newPasswordLength');
    store.changePassword(newPassword, context.userId);
    await closeUserEditors(context.userId);
    clearSessionCookie(reply, currentConfig());
    return authState(store, config, null);
  });

  const browserOwners = new Map<string, { userId: string; actorId: string; touchedAt: number }>();
  const workspace = (request: FastifyRequest, active = false) => {
    const actor = authenticated(request);
    const header = request.headers['x-feedlantern-user'];
    if (header !== undefined && (typeof header !== 'string' || !header)) throw new AppError(400, 'error.workspaceUserInvalid');
    const id = header ?? actor.userId;
    if (id !== actor.userId && actor.role !== 'admin') throw new AppError(403, 'error.adminOnlyUsers');
    const user = store.getUser(id);
    if (!user) throw new AppError(404, 'error.userNotFound');
    if (active && !user.enabled) throw new AppError(409, 'error.userDisabled');
    return { ...actor, actorId: actor.userId, userId: id, target: user };
  };
  const operationSignal = (request: FastifyRequest) => {
    const context = workspace(request, true);
    return AbortSignal.any([store.userSignal(context.actorId), store.userSignal(context.userId)]);
  };
  const closeUserEditors = async (id: string) => {
    await Promise.allSettled([...browserOwners].filter(([, owner]) => owner.userId === id || owner.actorId === id).map(async ([sessionId]) => {
      browserOwners.delete(sessionId); await browser.close(sessionId);
    }));
  };
  const requireOwned = (request: FastifyRequest, table: 'feeds' | 'credentials' | 'import_jobs' | 'network_profiles', id: string) => {
    const context = workspace(request);
    if (!store.owns(table, id, context.userId)) throw new AppError(404, table === 'feeds' ? 'error.feedNotFound' : table === 'credentials' ? 'error.credentialNotFound' : table === 'network_profiles' ? 'error.networkProfileNotFound' : 'error.importJobNotFound');
    return context;
  };
  const resourceGuard = (request: FastifyRequest, table?: 'feeds' | 'credentials' | 'import_jobs' | 'network_profiles') => {
    const context = authenticated(request);
    // The request hook already enforces this; repeated here so no route depends on that alone.
    if (context.token && !tokenAllowedRoute(request.method, request.routeOptions.url ?? '')) throw new AppError(403, 'error.tokenRouteForbidden');
    if (request.method !== 'GET' && request.method !== 'HEAD') requireCsrf(request, store, context);
    const id = asRecord(request.params).id;
    if (table && typeof id === 'string') requireOwned(request, table, id);
    return context;
  };
  const adminGuard = (request: FastifyRequest) => {
    const context = resourceGuard(request);
    if (context.role !== 'admin') throw new AppError(403, 'error.adminOnly');
    return context;
  };
  const checkCredential = (request: FastifyRequest, id: unknown) => {
    if (id !== undefined && id !== null && id !== '') {
      if (typeof id !== 'string') throw new AppError(400, 'error.credentialIdInvalid');
      requireOwned(request, 'credentials', id);
    }
  };
  const checkNetworkProfile = (request: FastifyRequest, id: unknown) => {
    if (id !== undefined && id !== null && id !== '') {
      if (typeof id !== 'string') throw new AppError(400, 'error.networkProfileIdInvalid');
      requireOwned(request, 'network_profiles', id);
    }
  };
  const credentialsGuard = (request: FastifyRequest) => { const actor = resourceGuard(request, 'credentials'); workspace(request, request.method === 'POST'); return actor; };

  // Token management needs the browser session: a token can never mint or revoke tokens.
  const sessionGuard = (request: FastifyRequest) => {
    const context = resourceGuard(request);
    if (context.token) throw new AppError(403, 'error.tokenRouteForbidden');
    return context;
  };
  // An administrator can read another account's tokens and their call logs in
  // that account's workspace, but can only create or revoke their own.
  const tokenWorkspace = (request: FastifyRequest) => { sessionGuard(request); return workspace(request).userId; };
  const ownTokens = (request: FastifyRequest) => {
    const context = sessionGuard(request);
    if (workspace(request).userId !== context.userId) throw new AppError(403, 'error.ownTokensOnly');
    return context;
  };
  app.get('/api/tokens', async request => {
    const userId = tokenWorkspace(request);
    const usage = store.tokenLog.usage(userId, Date.now() - 86_400_000);
    return store.tokens.list(userId).map(token => ({ ...token, usage24h: usage.get(token.id) ?? { calls: 0, failures: 0 } }));
  });
  const tokenCallLog = (request: FastifyRequest, userId: string, tokenId: string) => {
    const query = asRecord(request.query);
    if (query.status !== undefined && !['success', 'denied', 'error'].includes(String(query.status))) throw new AppError(400, 'error.callStatusInvalid');
    const integer = (value: unknown, fallback: number, max: number): number => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new AppError(400, 'error.logCursorInvalid');
      return Number(value);
    };
    const limit = integer(query.limit, 20, 100);
    const cursor = query.cursor === undefined ? undefined : integer(query.cursor, 0, Number.MAX_SAFE_INTEGER);
    return store.tokenLog.list(userId, tokenId, query.status as ApiTokenCallFilter | undefined, cursor, limit);
  };
  app.get('/api/tokens/:id/logs', async request => {
    const userId = tokenWorkspace(request);
    const id = String(asRecord(request.params).id);
    if (!store.tokens.exists(userId, id)) throw new AppError(404, 'error.tokenNotFound');
    return tokenCallLog(request, userId, id);
  });
  // A token may read its own summary and call log (never another token's), so
  // scripts and agents can check what they are allowed to do and what they did.
  const presentedToken = (request: FastifyRequest) => {
    const context = resourceGuard(request);
    if (!context.token) throw new AppError(400, 'error.tokenOnly');
    return { userId: context.userId, id: context.token.id };
  };
  app.get('/api/tokens/current', async request => {
    const { userId, id } = presentedToken(request);
    const token = store.tokens.list(userId).find(entry => entry.id === id);
    if (!token) throw new AppError(404, 'error.tokenNotFound');
    return { ...token, usage24h: store.tokenLog.usage(userId, Date.now() - 86_400_000).get(id) ?? { calls: 0, failures: 0 } };
  });
  app.get('/api/tokens/current/logs', async request => {
    const { userId, id } = presentedToken(request);
    return tokenCallLog(request, userId, id);
  });
  app.post('/api/tokens', async request => {
    const { userId } = ownTokens(request);
    const body = asRecord(request.body);
    const name = asNonEmptyString(typeof body.name === 'string' ? body.name.trim() : body.name, msg('label.tokenName'), 100);
    if (body.scope !== 'read' && body.scope !== 'write') throw new AppError(400, 'error.tokenScopeInvalid');
    const days = body.expiresInDays === undefined || body.expiresInDays === null ? null : body.expiresInDays;
    if (days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > API_TOKEN_MAX_DAYS)) throw new AppError(400, msg('error.tokenDays', { max: API_TOKEN_MAX_DAYS }));
    if (store.tokens.count(userId) >= API_TOKEN_LIMIT_PER_USER) throw new AppError(409, msg('error.tokenLimit', { max: API_TOKEN_LIMIT_PER_USER }));
    return store.tokens.create(userId, { name, scope: body.scope, expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString() });
  });
  app.delete('/api/tokens/:id', async request => {
    const { userId } = ownTokens(request);
    if (!store.tokens.revoke(userId, String(asRecord(request.params).id))) throw new AppError(404, 'error.tokenNotFound');
    return { ok: true };
  });

  app.get('/api/users', async request => { adminGuard(request); return store.listUsersWithStats(); });
  app.post('/api/users', async request => {
    adminGuard(request);
    const { username, password } = asRecord(request.body);
    if (!validateUsername(username)) throw new AppError(400, 'error.usernameInvalid');
    if (!validatePassword(password)) throw new AppError(400, 'error.passwordLength');
    if (store.listUsers().some(u => u.username === username)) throw new AppError(409, 'error.usernameTaken');
    return store.createUser(username, password);
  });
  app.patch('/api/users/:id', async request => {
    const actor = adminGuard(request), id = String(asRecord(request.params).id), body = asRecord(request.body);
    if (!Object.keys(body).length || Object.keys(body).some(k => !['username','enabled','role'].includes(k))) throw new AppError(400, 'error.userPatchInvalid');
    if (body.username !== undefined && !validateUsername(body.username)) throw new AppError(400, 'error.usernameInvalid');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new AppError(400, 'error.enabledRequired');
    if (body.role !== undefined && !['admin','user'].includes(String(body.role))) throw new AppError(400, 'error.roleInvalid');
    const user = store.updateUser(actor.userId, id, body);
    await closeUserEditors(id); jobs.wake(); translations.wake(); notifier.wake();
    if (user.enabled && options.startScheduler !== false) void refreshDue().catch(() => {});
    return user;
  });
  app.post('/api/users/:id/password', async request => {
    const actor = adminGuard(request);
    const id = String(asRecord(request.params).id), { password } = asRecord(request.body);
    if (!store.getUser(id)) throw new AppError(404, 'error.userNotFound');
    if (actor.userId === id) throw new AppError(403, 'error.useOwnPassword');
    if (!validatePassword(password)) throw new AppError(400, 'error.passwordLength');
    store.changePassword(password, id); await closeUserEditors(id); jobs.wake(); notifier.wake();
    return { ok: true };
  });
  app.get('/api/users/:id/deletion-preview', async request => { adminGuard(request); return store.deletionPreview(String(asRecord(request.params).id)); });
  app.delete('/api/users/:id', async request => {
    const actor = adminGuard(request), id = String(asRecord(request.params).id);
    store.deleteUser(actor.userId, id, asNonEmptyString(asRecord(request.body).username, msg('label.confirmUsername'), 100));
    await closeUserEditors(id); jobs.wake(); notifier.wake();
    return { ok: true };
  });
  const barkSummary = (id: string) => {
    const { url, ...value } = store.getBark(id);
    return { ...value, configured: !!url, maskedUrl: url ? `${new URL(url).origin}/••••••` : '' };
  };
  const parseBark = (id: string, input: unknown, test = false) => {
    const body = asRecord(input);
    const result = applicationSettingsSchema.shape.bark.safeParse({ ...store.getBark(id), ...body, ...(test || body.url === '' ? { enabled: false } : {}) });
    if (!result.success) throw new AppError(400, 'error.barkSettingsInvalid');
    return result.data;
  };
  const notificationSummary = (id: string) => {
    const { bark: { enabled: _enabled, url: _url, ...policy }, channels } = store.getNotifications(id);
    return { ...policy, channels: channelsSummary(store.getBark(id), channels) };
  };
  /** The first custom (message key) issue of a zod error, else `fallback`. */
  const issueMessage = (error: { issues: Array<{ message: string; code: string; params?: Record<string, unknown> }> }, fallback: LocalizedText) => {
    const issue = error.issues.find(entry => entry.code === 'custom');
    return issueText(issue?.message, issue?.params) ?? fallback;
  };
  const optionalObject = (value: unknown, label: LocalizedText) => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, msg('error.formatInvalid', { label }));
    return value as Record<string, unknown>;
  };
  /**
   * Merge a NotificationUpdate into saved settings. Omitted fields keep their
   * value, so secrets never have to round-trip through the browser; clearing
   * a required field turns that channel off, as clearing the Bark address does.
   */
  const parseNotifications = (id: string, input: unknown) => {
    const body = asRecord(input);
    const previous = store.getNotifications(id);
    const patch = optionalObject(body.channels, msg('label.notificationChannels')) ?? {};
    for (const key of Object.keys(patch)) if (!['bark', 'webhook', 'ntfy', 'telegram'].includes(key)) throw new AppError(400, 'error.notificationChannelInvalid');
    const { channels: _channels, ...policyPatch } = body;
    for (const key of Object.keys(policyPatch)) if (!['failureThreshold', 'timeoutSeconds', 'maxAttempts', 'retryDelaySeconds', 'laterRetryDelaySeconds', 'cooldownMinutes', 'ruleHealthAlerts'].includes(key)) throw new AppError(400, 'error.notificationSettingsInvalid');
    const barkPatch = optionalObject(patch.bark, msg('label.channelSettings', { channel: 'Bark' })) ?? {};
    for (const key of Object.keys(barkPatch)) if (!['enabled', 'url'].includes(key)) throw new AppError(400, 'error.barkInvalid');
    const bark = applicationSettingsSchema.shape.bark.safeParse({ ...previous.bark, ...policyPatch, ...barkPatch, ...(barkPatch.url === '' ? { enabled: false } : {}) });
    if (!bark.success) throw new AppError(400, issueMessage(bark.error, msg('error.notificationSettingsCheck')));
    const webhook = optionalObject(patch.webhook, msg('label.channelSettings', { channel: 'Webhook' })) ?? {}, ntfy = optionalObject(patch.ntfy, msg('label.channelSettings', { channel: 'ntfy' })) ?? {}, telegram = optionalObject(patch.telegram, msg('label.channelSettings', { channel: 'Telegram' })) ?? {};
    const channels = notificationChannelsSchema.safeParse({
      webhook: { ...previous.channels.webhook, ...webhook, ...(webhook.url === '' ? { enabled: false } : {}) },
      ntfy: { ...previous.channels.ntfy, ...ntfy, ...(ntfy.topic === '' || ntfy.server === '' ? { enabled: false } : {}) },
      telegram: { ...previous.channels.telegram, ...telegram, ...(telegram.botToken === '' || telegram.chatId === '' ? { enabled: false } : {}) },
    });
    if (!channels.success) throw new AppError(400, issueMessage(channels.error, msg('error.channelSettingsInvalid')));
    return { bark: bark.data, channels: channels.data };
  };
  const sendTest = async (channel: keyof ChannelConfigs, config: ChannelConfigs[keyof ChannelConfigs], timeoutSeconds: number, username: string, signal?: AbortSignal) => {
    const send = senders[channel] as ChannelSender<typeof channel>;
    const message = { event: 'test' as const, title: alertTitle('test'), body: tl('notify.testBody', { username }), feedId: null, feedName: null, error: null, time: new Date().toISOString(), panelUrl: panelUrl(null, 'test') };
    try {
      await send(config as never, message, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutSeconds * 1000)]), policy: notifyPolicy() });
    } catch (error) {
      if (error instanceof NetworkPolicyError) throw new AppError(400, 'error.pushBlocked');
      throw new AppError(502, msg('error.testFailed', { what: msg(`channel.check.${channel}`) }));
    }
  };
  app.get('/api/notifications', async request => { resourceGuard(request); return notificationSummary(workspace(request).userId); });
  app.put('/api/notifications', async request => {
    resourceGuard(request); const { userId } = workspace(request);
    store.setNotifications(userId, parseNotifications(userId, request.body)); notifier.wake();
    return notificationSummary(userId);
  });
  app.post('/api/notifications/test', async request => {
    resourceGuard(request); const { userId, target } = workspace(request, true);
    const body = asRecord(request.body), channel = body.channel;
    if (channel !== 'bark' && channel !== 'webhook' && channel !== 'ntfy' && channel !== 'telegram') throw new AppError(400, 'error.notificationChannelInvalid');
    const { channel: _channel, ...fields } = body;
    // Unsaved fields are tested as typed; nothing is saved and `enabled` is ignored.
    const value = parseNotifications(userId, { channels: { [channel]: { ...fields, enabled: false } } });
    const config = channel === 'bark' ? (value.bark.url ? { url: value.bark.url } : undefined)
      : channel === 'webhook' ? (value.channels.webhook.url ? value.channels.webhook : undefined)
      : channel === 'ntfy' ? (value.channels.ntfy.server && value.channels.ntfy.topic ? value.channels.ntfy : undefined)
      : value.channels.telegram.botToken && value.channels.telegram.chatId ? value.channels.telegram : undefined;
    if (!config) throw new AppError(400, ({ bark: 'error.barkUrlRequired', webhook: 'error.webhookUrlMissing', ntfy: 'error.ntfyMissing', telegram: 'error.telegramMissing' } as const)[channel]);
    await sendTest(channel, config, value.bark.timeoutSeconds, target.username, operationSignal(request));
    return { ok: true };
  });
  // Bark-only endpoints kept for existing API clients.
  app.get('/api/notifications/bark', async request => { resourceGuard(request); return barkSummary(workspace(request).userId); });
  app.put('/api/notifications/bark', async request => {
    resourceGuard(request); const { userId } = workspace(request);
    store.setBark(userId, parseBark(userId, request.body)); notifier.wake();
    return barkSummary(userId);
  });
  app.post('/api/notifications/bark/test', async request => {
    resourceGuard(request); const { userId, target } = workspace(request, true);
    const value = parseBark(userId, request.body, true);
    if (!value.url) throw new AppError(400, 'error.barkUrlRequired');
    await sendTest('bark', { url: value.url }, value.timeoutSeconds, target.username, operationSignal(request));
    return { ok: true };
  });

  app.get('/api/credentials', async (request): Promise<CredentialSummary[]> => { credentialsGuard(request); return store.listCredentialSummaries(workspace(request).userId); });
  app.post('/api/credentials', async (request) => {
    credentialsGuard(request);
    const input = parseCredentialInput(request.body);
    let cookies: Cookie[];
    try { cookies = parseCookies(String(input.value), input.format, input.url); } catch (error) { throw new AppError(400, friendlyError(error, msg('error.credentialUnparsable'))); }
    return store.createCredential(input, cookieMetadata(cookies, input.url), workspace(request).userId);
  });
  app.put('/api/credentials/:id', async (request) => {
    credentialsGuard(request);
    const input = parseCredentialInput(request.body);
    let cookies: Cookie[];
    try { cookies = parseCookies(String(input.value), input.format, input.url); } catch (error) { throw new AppError(400, friendlyError(error, msg('error.credentialUnparsable'))); }
    const result = store.updateCredential(String((request.params as { id: string }).id), input, cookieMetadata(cookies, input.url));
    if (!result) throw new AppError(404, 'error.credentialNotFound');
    return result;
  });
  app.delete('/api/credentials/:id', async (request) => {
    credentialsGuard(request);
    const id = String((request.params as { id: string }).id);
    if (!store.getCredentialSummary(id)) throw new AppError(404, 'error.credentialNotFound');
    if (store.isCredentialReferenced(id)) throw new AppError(409, 'error.credentialInUse');
    store.deleteCredential(id);
    return { ok: true };
  });

  const profilesGuard = (request: FastifyRequest) => { const actor = resourceGuard(request, 'network_profiles'); workspace(request, request.method === 'POST'); return actor; };
  const policyFor = () => new NetworkPolicy({ allowedHosts: config.allowedHosts, dnsOverHttps: config.dnsOverHttps });
  const parseProfile = async (body: unknown, existingId?: string) => {
    const existing = existingId ? store.getNetworkProfile(existingId) : null;
    const value = parseNetworkProfileInput(asRecord(body), existing ?? undefined);
    // Reject a loopback, private or metadata proxy now, not on the first refresh.
    if (value.proxy) {
      try { await policyFor().resolveProxy(value.proxy); } catch (error) { if (error instanceof NetworkPolicyError) throw new AppError(400, error.text); throw error; }
    }
    return value;
  };
  app.get('/api/network-profiles', async (request): Promise<NetworkProfileSummary[]> => { profilesGuard(request); return store.listNetworkProfiles(workspace(request).userId); });
  app.post('/api/network-profiles', async request => {
    profilesGuard(request);
    return store.createNetworkProfile(await parseProfile(request.body), workspace(request).userId);
  });
  app.put('/api/network-profiles/:id', async request => {
    profilesGuard(request);
    const id = String(asRecord(request.params).id);
    const value = await parseProfile(request.body, id);
    // Running refreshes keep the settings they started with; the next one uses these.
    const result = store.updateNetworkProfile(id, value);
    if (!result) throw new AppError(404, 'error.networkProfileNotFound');
    return result;
  });
  app.delete('/api/network-profiles/:id', async request => {
    profilesGuard(request);
    const id = String(asRecord(request.params).id);
    if (store.isNetworkProfileReferenced(id)) throw new AppError(409, 'error.networkProfileInUse');
    if (!store.deleteNetworkProfile(id)) throw new AppError(404, 'error.networkProfileNotFound');
    return { ok: true };
  });
  app.post('/api/network-profiles/:id/test', async request => {
    profilesGuard(request);
    const id = String(asRecord(request.params).id);
    const url = parseHttpUrl(asRecord(request.body).url, msg('label.testUrl'));
    try {
      const { status } = await probeTarget(url, policyFor(), networkFor(id, workspace(request).userId), operationSignal(request));
      return { ok: true, status };
    } catch (error) {
      const shown = friendlyError(error, msg('error.connectionTestFailed'));
      logHiddenError('Network profile connection test', error, shown);
      throw new AppError(400, shown);
    }
  });

  const feedsGuard = (request: FastifyRequest) => {
    const table = request.routeOptions.url?.startsWith('/api/import-jobs') ? 'import_jobs' : 'feeds';
    const context = resourceGuard(request, table);
    const route = request.routeOptions.url ?? '';
    const body = asRecord(request.body);
    const active = request.method === 'POST' && (!route.includes('/bulk') || ['resume','refresh'].includes(String(body.action))) && !route.endsWith('/cancel') && !route.endsWith('/rotate-token');
    workspace(request, active);
    checkCredential(request, body.credentialId);
    checkCredential(request, asRecord(body.input).credentialId);
    checkNetworkProfile(request, body.networkProfileId);
    checkNetworkProfile(request, asRecord(body.input).networkProfileId);
    if (Array.isArray(body.entries)) for (const entry of body.entries) { checkCredential(request, asRecord(entry).credentialId); checkNetworkProfile(request, asRecord(entry).networkProfileId); }
    return context;
  };

  const feedPayload = (feed: Feed): { feed: Feed; feedUrl: string } => ({ feed, feedUrl: feedUrl(currentConfig(), store, feed.id) });
  app.get('/api/dashboard', async request => {
    feedsGuard(request);
    const days = Number(asRecord(request.query).days ?? 30);
    if (![7, 30, 90].includes(days)) throw new AppError(400, 'error.dashboardPeriodInvalid');
    return store.activity.read(workspace(request).userId, days as DashboardPeriod);
  });
  app.get('/api/feeds', async (request): Promise<Feed[]> => { feedsGuard(request); return store.listFeeds(workspace(request).userId); });
  const backupGuard = (request: FastifyRequest, allowSetup = false) => {
    const body = asRecord(request.body);
    if (!limiter.allowed(request.ip)) throw new AppError(429, 'error.tooManyVerifications');
    if (!store.hasAdmin() && allowSetup) {
      const expected = Buffer.from(store.getSetupToken() ?? '');
      const actual = Buffer.from(typeof body.setupToken === 'string' ? body.setupToken : '');
      if (!expected.length || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        limiter.registerFailure(request.ip); throw new AppError(403, 'error.setupCodeInvalid');
      }
    } else {
      adminGuard(request);
      if (!store.authenticate(authenticated(request).username, asNonEmptyString(body.currentPassword, msg('label.adminPassword'), 1024))) {
        limiter.registerFailure(request.ip); throw new AppError(403, 'error.adminPasswordInvalid');
      }
    }
  };
  const security = () => ({ allowedHosts: config.allowedHosts, dnsOverHttps: config.dnsOverHttps ?? false });
  const parseSettings = (value: unknown): ApplicationSettings => {
    const parsed = applicationSettingsSchema.safeParse(value);
    if (!parsed.success) throw new AppError(400, 'error.settingsInvalid');
    return parsed.data;
  };
  /** API keys are write-only: responses carry `apiKeyConfigured` instead. */
  const maskKeys = (value: ApplicationSettings): ApplicationSettings => ({ ...value, ncbi: { ...value.ncbi, apiKey: '', apiKeyConfigured: !!value.ncbi.apiKey }, translation: { ...value.translation,
    deepl: { ...value.translation.deepl, apiKey: '', apiKeyConfigured: !!value.translation.deepl.apiKey },
    openai: { ...value.translation.openai, apiKey: '', apiKeyConfigured: !!value.translation.openai.apiKey } } });
  /** An empty key in an update or imported file keeps the key already saved here. */
  const keepKeys = (next: ApplicationSettings, previous: ApplicationSettings): ApplicationSettings => ({ ...next, ncbi: { ...next.ncbi, apiKey: next.ncbi.apiKey || previous.ncbi.apiKey }, translation: { ...next.translation,
    deepl: { ...next.translation.deepl, apiKey: next.translation.deepl.apiKey || previous.translation.deepl.apiKey },
    openai: { ...next.translation.openai, apiKey: next.translation.openai.apiKey || previous.translation.openai.apiKey } } });
  /** Server and network fields in the order of the settings page, for the restore preview. */
  const serverFields: Array<keyof ApplicationSettings['server']> = ['backgroundConcurrency', 'allowedHosts', 'dnsOverHttps', 'trustedProxies', 'publicOrigin', 'cookieSecure', 'sessionTtlDays', 'host', 'port'];
  const serverChanges = (current: ApplicationSettings['server'], backup: ApplicationSettings['server']) =>
    serverFields
      .filter(key => JSON.stringify(current[key]) !== JSON.stringify(backup[key]))
      .map(key => ({ key, label: tl(`serverField.${key}`), current: current[key], backup: backup[key] }));
  const settingsPreview = (value: ApplicationSettings) => ({ ...maskKeys(value), bark: { ...value.bark, url: undefined, configured: !!value.bark.url } });
  /** Config archives carry the importing admin's other channels; previews only say what is configured. */
  const channelsPreview = (value: ReturnType<typeof notificationChannelsSchema.parse>) => {
    const { bark: _bark, ...summary } = channelsSummary({ enabled: false, url: '' }, value);
    return summary;
  };
  const applySettings = async (next: ApplicationSettings, write: () => void = () => store.setSettings(next)): Promise<void> => {
    const previous = store.getSettings();
    const captureChanged = previous.server.backgroundConcurrency !== next.server.backgroundConcurrency
      || previous.server.dnsOverHttps !== next.server.dnsOverHttps
      || JSON.stringify(previous.server.allowedHosts) !== JSON.stringify(next.server.allowedHosts);
    const nextConfig = { ...config }; applyRuntimeSettings(nextConfig, next);
    const replacement = captureChanged ? await makeBrowserService(nextConfig, options.browserService) : browser;
    const wasMaintenance = maintenance;
    maintenance = true;
    await notifier.stop();
    await translations.stop();
    try {
      store.transaction(() => {
        write();

      });
      if (replacement !== browser) { await browser.dispose(); browser = replacement; }
      applyRuntimeSettings(config, next);
      pool.setConcurrency(next.server.backgroundConcurrency);
      jobs.setConcurrency(next.server.backgroundConcurrency);
      store.history.prune();
    } finally { maintenance = wasMaintenance; notifier.start(); translations.start(); }
  };
  app.post('/api/backups/export', async request => {
    backupGuard(request);
    const password = asNonEmptyString(asRecord(request.body).password, msg('label.backupPassword'), 1024);
    if (password.length < 12) throw new AppError(400, 'error.backupPasswordLength');
    const snapshot = snapshotSchema.safeParse({ format: 'feedlantern-backup', version: 3, appVersion: config.version, createdAt: new Date().toISOString(), security: security(), tables: store.exportTables() });
    if (!snapshot.success) {
      const where = describeError(snapshot.error);
      console.error(`Backup export validation failed: ${where}`);
      throw new AppError(500, msg('error.backupInvalid', { detail: where }));
    }
    return sealBackup(snapshot.data, password);
  });
  for (const action of ['preview', 'restore'] as const) app.post(`/api/backups/${action}`, { bodyLimit: 100_000_000 }, async request => {
    backupGuard(request, true);
    const body = asRecord(request.body);
    let snapshot;
    try {
      snapshot = openBackup(body.archive, asNonEmptyString(body.password, msg('label.backupPassword'), 1024));
      for (const row of snapshot.tables.feeds) if (row.item_filter_json) parseItemFilter(JSON.parse(row.item_filter_json));
      for (const row of snapshot.tables.feeds) parseFeedInput({ pagination: row.pagination_json ? JSON.parse(row.pagination_json) : null, sourceType: row.source_type, translationMode: row.translation_mode, name: row.name, url: row.url, rules: JSON.parse(row.rules_json), ruleOrigins: row.rule_origins_json ? JSON.parse(row.rule_origins_json) : undefined, intervalMinutes: row.interval_minutes, waitMs: row.wait_ms, waitForSelector: row.wait_for_selector });
      for (const row of snapshot.tables.credentials) {
        const metadata = cookieMetadata(parseCookies(JSON.parse(row.encrypted_value), row.format, row.url), row.url);
        row.domains_json = JSON.stringify(metadata.domains); row.cookie_count = metadata.count; row.expires_at = metadata.expiresAt;
      }
      const ids = new Set(snapshot.tables.feeds.map(f => f.id));
      const creds = new Set(snapshot.tables.credentials.map(c => c.id));
      const itemFeeds = new Map(snapshot.tables.feed_items.map(i => [i.id, i.feed_id]));
      if (snapshot.tables.rss_sources.some(s => !ids.has(s.feed_id)) || snapshot.tables.translations.some(t => itemFeeds.get(t.item_id) !== t.feed_id)) throw Error();
      if (snapshot.tables.feed_items.some(i => !ids.has(i.feed_id)) || snapshot.tables.feeds.some(f => f.credential_id && !creds.has(f.credential_id))) throw Error();
    } catch { limiter.registerFailure(request.ip); throw new AppError(400, 'error.backupUnreadable'); }
    if (action === 'preview') {
      const saved = snapshot.tables.settings.find(row => row.key === 'application');
      const backupSettings = saved ? parseSettings(JSON.parse(saved.value)) : null;
      // Server settings are listed as a difference instead: by default this instance keeps its own.
      const { server: _server, ...settings } = backupSettings ? settingsPreview(backupSettings) : { server: undefined };
      return { appVersion: snapshot.appVersion, createdAt: snapshot.createdAt, feeds: snapshot.tables.feeds.length, bundles: snapshot.tables.bundles.length, items: snapshot.tables.feed_items.length, credentials: snapshot.tables.credentials.length, username: snapshot.tables.users.find(u => u.role === 'admin')!.username, sourceSecurity: snapshot.security, targetSecurity: security(),
        settings: backupSettings ? settings : null, serverSettingsIncluded: !!backupSettings, serverChanges: backupSettings ? serverChanges(store.getSettings().server, backupSettings.server) : [] };
    }
    if (body.confirm !== true) throw new AppError(400, 'error.restoreConfirm');
    if (body.restoreServerSettings !== undefined && typeof body.restoreServerSettings !== 'boolean') throw new AppError(400, 'error.restoreServerInvalid');
    const restoreServer = body.restoreServerSettings === true;
    maintenance = true; jobs.stop();
    try {
      await pool.drain();
      await notifier.stop();
      await translations.stop();
      await browser.closeEditors?.();
      browserOwners.clear();
      store.restoreTables(snapshot.tables, { restoreServer });
      const restoredSettings = store.getSettings();
      const nextConfig = { ...config }; applyRuntimeSettings(nextConfig, restoredSettings);
      const replacement = await makeBrowserService(nextConfig, options.browserService);
      if (replacement !== browser) { await browser.dispose(); browser = replacement; }
      applyRuntimeSettings(config, restoredSettings);
      pool.setConcurrency(restoredSettings.server.backgroundConcurrency);
      jobs.setConcurrency(restoredSettings.server.backgroundConcurrency);
      return { ok: true, serverSettingsRestored: restoreServer };
    } finally { maintenance = false; jobs.recover(); notifier.start(); translations.start(); }
  });
  app.get('/api/backups/config', async request => {
    adminGuard(request);
    const profiles = new Map(store.listNetworkProfiles(authenticated(request).userId).map(p => [p.id, p]));
    // Only the non-secret part of a network profile is exported. A profile
    // with a proxy login or header values has to be bound again after import.
    const profileExport = (id: string | null | undefined) => {
      const profile = id ? profiles.get(id) : undefined;
      if (!profile) return {};
      if (profile.proxy?.authenticated || profile.headerNames.length) return { requiresNetworkProfile: true };
      return { networkProfile: { name: profile.name, proxyUrl: profile.proxy?.url ?? null, userAgent: profile.userAgent, referer: profile.referer } };
    };
    // The configuration file is not encrypted, so translation API keys stay out of it.
    const settings = maskKeys(store.getSettings());
    for (const service of ['deepl', 'openai'] as const) delete settings.translation[service].apiKeyConfigured;
    delete settings.ncbi.apiKeyConfigured;
    const notifications = store.getNotifications(authenticated(request).userId);
    const feeds = store.listFeeds(authenticated(request).userId);
    return { format: 'feedlantern-config', version: 2, settings: { ...settings, bark: notifications.bark }, notificationChannels: notifications.channels, bundles: exportConfigBundles(store, authenticated(request).userId, feeds.map(f => f.id)), feeds: feeds.map(f => ({ sourceType: f.sourceType, translationMode: f.translationMode, targetLanguage: f.targetLanguage, translationProvider: f.translationProvider, name: f.name, channelTitle: f.channelTitle, url: f.url, rules: f.rules, ruleOrigins: f.ruleOrigins, ...(f.pagination ? { pagination: f.pagination } : {}), intervalMinutes: f.intervalMinutes, waitMs: f.waitMs, waitForSelector: f.waitForSelector, enabled: f.enabled, requiresCredential: !!f.credentialId, ...profileExport(f.networkProfileId), ...(f.itemFilter ? { itemFilter: f.itemFilter } : {}), outputLimit: f.outputLimit, ...(f.retentionLimit ? { retentionLimit: f.retentionLimit } : {}) })) };
  });
  app.post('/api/backups/config', { bodyLimit: 10_000_000 }, async request => {
    adminGuard(request);
    const body = asRecord(request.body), archive = asRecord(body.archive);
    if (archive.format !== 'feedlantern-config' || ![1, 2].includes(Number(archive.version)) || !Array.isArray(archive.feeds) || archive.feeds.length > 10000) throw new AppError(400, 'error.configInvalid');
    if (archive.version === 2 && archive.settings === undefined) throw new AppError(400, 'error.configMissingSettings');
    const importedSettings = archive.settings === undefined ? undefined : keepKeys(parseSettings(archive.settings), store.getSettings());
    // Optional: archives exported before notification channels existed omit it and keep the current channels.
    const importedChannels = archive.notificationChannels === undefined ? undefined : notificationChannelsSchema.safeParse(archive.notificationChannels);
    if (importedChannels && !importedChannels.success) throw new AppError(400, msg('error.configChannels', { detail: issueMessage(importedChannels.error, msg('error.checkAddresses')) }));
    const entries = archive.feeds.map(raw => {
      const value = asRecord(raw);
      const profile = value.networkProfile === undefined || value.networkProfile === null ? undefined : parseNetworkProfileInput({ ...asRecord(value.networkProfile), headers: [] });
      const output = parseFeedSettings({ ...(value.itemFilter !== undefined ? { itemFilter: value.itemFilter } : {}), ...(value.outputLimit !== undefined ? { outputLimit: value.outputLimit } : {}), ...(value.retentionLimit !== undefined ? { retentionLimit: value.retentionLimit } : {}) }, true);
      if (output.retentionLimit !== undefined && output.retentionLimit !== null) {
        const problem = retentionProblem(output.retentionLimit, output.outputLimit);
        if (problem) throw new AppError(400, msg('error.configFeed', { name: String(value.name ?? '').slice(0, 100), problem }));
      }
      return { input: parseFeedInput({ ...value, credentialId: null, networkProfileId: null }), output, title: asOptionalString(value.channelTitle, msg('label.channelTitle'), 200), enabled: value.enabled !== false, needsCookie: value.requiresCredential === true, needsNetwork: value.requiresNetworkProfile === true, profile };
    });
    const bundles = parseConfigBundles(archive.bundles, entries.length);
    const signature = (f: FeedInput) => JSON.stringify([f.sourceType ?? 'website', f.translationMode ?? 'bilingual', ...(f.targetLanguage && f.targetLanguage !== 'zh-CN' ? [f.targetLanguage] : []), normalizeSource(f.url), ...['item', 'title', 'link', 'description', 'image', 'date'].map(k => f.rules[k as keyof SelectionRules] ?? '')]);
    if (body.confirm !== true) {
      const seen = new Set(store.listFeeds(authenticated(request).userId).map(signature));
      return { settings: importedSettings ? { ...settingsPreview(importedSettings), ...(importedChannels ? { notificationChannels: channelsPreview(importedChannels.data) } : {}) } : null, entries: entries.map(e => { const duplicate = seen.has(signature(e.input)); seen.add(signature(e.input)); return { name: e.input.name, url: e.input.url, duplicate, needsCookie: e.needsCookie, needsNetwork: e.needsNetwork }; }), ...(bundles.length ? { bundles: previewConfigBundles(store, authenticated(request).userId, bundles) } : {}) };
    }
    return enqueueRefresh(async () => {
      adminGuard(request);
      let result: { created: number; skipped: number; bundles?: { created: number; skipped: number } } = { created: 0, skipped: 0 };
      const write = () => store.transaction(() => {
      const seen = new Set(store.listFeeds(authenticated(request).userId).map(signature));
      // Imported secret-free profiles are reused by identical settings.
      const profileKey = (p: { name: string; proxy: { type: string; host: string; port: number } | null; userAgent?: string | null; referer?: string | null }) => JSON.stringify([p.name, p.proxy && [p.proxy.type, p.proxy.host, p.proxy.port], p.userAgent ?? null, p.referer ?? null]);
      const reusable = new Map(store.listNetworkProfiles(authenticated(request).userId).filter(p => !p.proxy?.authenticated && !p.headerNames.length).map(p => [profileKey(p), p.id]));
      // Bundles refer to config entries; a skipped duplicate maps to the feed already there.
      const existing = new Map(store.listFeeds(authenticated(request).userId).map(f => [signature(f), f.id])), entryIds: Array<string | undefined> = [];
      let created = 0, skipped = 0;
      for (const entry of entries) {
        const key = signature(entry.input);
        entryIds.push(existing.get(key));
        if (seen.has(key)) { skipped++; continue; }
        let networkProfileId: string | null = null;
        if (entry.profile) {
          const profileId = reusable.get(profileKey(entry.profile)) ?? store.createNetworkProfile(entry.profile, authenticated(request).userId).id;
          reusable.set(profileKey(entry.profile), profileId);
          networkProfileId = profileId;
        }
        const { feed } = store.createFeed({ ...entry.input, networkProfileId }, authenticated(request).userId);
        if (entry.title) store.setChannelTitle(feed.id, entry.title);
        if (Object.keys(entry.output).length) store.updateFeedSettings(feed.id, entry.output);
        if (!entry.enabled || entry.needsCookie || entry.needsNetwork) store.toggleFeed(feed.id);
        if (entry.needsCookie) store.markFetchFailure(feed.id, translate(store.ownerLocale(feed.ownerId), 'fetch.needsCookie'), feed.nextFetchAt);
        else if (entry.needsNetwork) store.markFetchFailure(feed.id, translate(store.ownerLocale(feed.ownerId), 'fetch.needsNetwork'), feed.nextFetchAt);
        seen.add(key); existing.set(key, feed.id); entryIds[entryIds.length - 1] = feed.id; created++;
      }
      if (importedSettings) { const originalBark = store.getBark('admin'); store.setSettings({ ...importedSettings, bark: originalBark }); store.setBark(authenticated(request).userId, importedSettings.bark); }
      if (importedChannels) store.setNotificationChannels(authenticated(request).userId, importedChannels.data);
      result = { created, skipped, ...(bundles.length ? { bundles: importConfigBundles(store, authenticated(request).userId, bundles, entryIds) } : {}) };
      });
      if (importedSettings) await applySettings(importedSettings, write); else write();
      return result;
    });
  });
  app.get('/api/import-jobs', async request => { feedsGuard(request); return store.listImportJobs(workspace(request).userId); });
  app.post('/api/import-jobs', async request => {
    feedsGuard(request);
    const body = asRecord(request.body);
    if (body.sourceType !== undefined && !['website', 'rss'].includes(String(body.sourceType))) throw new AppError(400, 'error.sourceTypeInvalid');
    const mode = parseTranslationMode(body.translationMode);
    if (mode === 'original') throw new AppError(400, 'error.translationModeInvalid');
    const sourceType = body.sourceType === 'rss' ? 'rss' as const : 'website' as const;
    const translationMode = mode ?? 'bilingual';
    const targetLanguage = parseTargetLanguage(body.targetLanguage) ?? 'zh-CN';
    const translationProvider = parseTranslationProvider(body.translationProvider) ?? null;
    if (!Array.isArray(body.entries) || !body.entries.length || body.entries.length > 100) throw new AppError(400, 'error.batchSize');
    const entries = body.entries.map(raw => {
      const entry = asRecord(raw);
      const url = normalizeSource(parseHttpUrl(entry.url, msg('label.url')));
      const credentialId = entry.credentialId ? asNonEmptyString(entry.credentialId, 'credentialId', 200) : null;
      if (sourceType === 'rss' && credentialId) throw new AppError(400, 'error.rssNoCookies');
      const networkProfileId = entry.networkProfileId ? asNonEmptyString(entry.networkProfileId, 'networkProfileId', 200) : null;
      if (credentialId) {
        const credential = store.getCredentialValue(credentialId);
        if (!credential) throw new AppError(400, 'error.credentialNotFound');
        cookiesForTarget(credential, url);
      }
      return { url, credentialId, networkProfileId, sourceType, translationMode, targetLanguage, translationProvider, intervalMinutes: asInteger(body.intervalMinutes, msg('label.interval'), 5, 1440, 60) };
    });
    return jobs.create(entries, workspace(request, true).userId, authenticated(request).userId);
  });
  app.post('/api/import-jobs/:id/:action', async request => {
    feedsGuard(request);
    const { id, action } = request.params as { id: string; action: string };
    const body = asRecord(request.body);
    if (action === 'confirm') {
      const feed = await jobs.confirm(id, asNonEmptyString(body.entryId, 'entryId', 200), parseFeedInput(body.input), () => feedsGuard(request), authenticated(request).userId);
      if (!feed) throw new AppError(404, 'error.feedDeleted');
      return feedPayload(feed);
    }
    if (action !== 'cancel' && action !== 'retry') throw new AppError(400, 'error.jobActionInvalid');
    return jobs.update(id, action, asOptionalString(body.entryId, 'entryId', 200), authenticated(request).userId);
  });
  app.post('/api/settings/bark/test', async request => {
    adminGuard(request);
    const input = asRecord(request.body);
    const settings = parseSettings({ ...store.getSettings(), bark: { ...store.getBark(authenticated(request).userId), ...input, enabled: false } });
    if (!settings.bark.url) throw new AppError(400, 'error.barkUrlRequired');
    await sendTest('bark', { url: settings.bark.url }, settings.bark.timeoutSeconds, authenticated(request).username);
    return { ok: true };
  });
  const globalSettings = () => ({ ...maskKeys(store.getSettings()), bark: structuredClone(defaultApplicationSettings.bark) });
  app.get('/api/settings', async request => { adminGuard(request); return globalSettings(); });
  app.put('/api/settings', async request => {
    adminGuard(request);
    const body = asRecord(request.body);
    if (!Object.keys(body).length || body.bark !== undefined && (typeof body.bark !== 'object' || body.bark === null || Array.isArray(body.bark))
      || body.translation !== undefined && (typeof body.translation !== 'object' || body.translation === null || Array.isArray(body.translation))
      || body.server !== undefined && (typeof body.server !== 'object' || body.server === null || Array.isArray(body.server))
      || body.ncbi !== undefined && (typeof body.ncbi !== 'object' || body.ncbi === null || Array.isArray(body.ncbi))) throw new AppError(400, 'error.settingsFormatInvalid');
    return enqueueRefresh(async () => {
      adminGuard(request);
      const previous = store.getSettings();
      const personal = body.bark === undefined ? undefined : parseBark(authenticated(request).userId, body.bark);
      const translation = asRecord(body.translation);
      const service = (name: 'deepl' | 'openai') => {
        const patch = asRecord(translation[name]);
        // Omitted or empty keeps the saved key; `null` removes it.
        return { ...previous.translation[name], ...patch, apiKey: patch.apiKey === null ? '' : patch.apiKey || previous.translation[name].apiKey };
      };
      const ncbiPatch = asRecord(body.ncbi);
      // Like the translation keys: omitted or empty keeps the saved NCBI key, `null` removes it.
      const ncbiSettings = { ...previous.ncbi, ...ncbiPatch, apiKey: ncbiPatch.apiKey === null ? '' : typeof ncbiPatch.apiKey === 'string' ? ncbiPatch.apiKey.trim() || previous.ncbi.apiKey : ncbiPatch.apiKey ?? previous.ncbi.apiKey };
      const ncbiChecked = ncbiSettingsSchema.safeParse(ncbiSettings);
      if (!ncbiChecked.success) {
        // The schema's own messages are message keys; zod's built-in ones (a too-long key) get the general text.
        const issue = ncbiChecked.error.issues.find(entry => isMessageKey(entry.message));
        throw new AppError(400, issue ? issueText(issue.message) ?? msg('error.ncbiSettingsInvalid') : msg('error.ncbiSettingsInvalid'));
      }
      const next = parseSettings({ ...previous, ...body, ncbi: ncbiSettings, translation: { ...previous.translation, ...translation, deepl: service('deepl'), openai: service('openai') }, bark: { ...previous.bark, ...asRecord(body.bark) }, server: { ...previous.server, ...asRecord(body.server) } });
      next.bark = previous.bark;
      const problem = providerProblem(next.translation, next.translation.defaultProvider);
      if (problem) throw new AppError(400, msg('error.defaultProviderUnavailable', { problem }));
      await applySettings(next);
      if (personal) store.setBark(authenticated(request).userId, personal);
      notifier.wake(); return globalSettings();
    });
  });
  function parseFeedSettings(body: Record<string, unknown>, allowEmpty = false): FeedSettingsInput {
    const input: FeedSettingsInput = {};
    if ('itemFilter' in body) {
      try { input.itemFilter = parseItemFilter(body.itemFilter); }
      catch (error) { if (error instanceof ItemFilterError) throw new AppError(400, error.text); throw error; }
    }
    if ('outputLimit' in body) {
      if (typeof body.outputLimit !== 'number' || !Number.isInteger(body.outputLimit) || body.outputLimit < OUTPUT_LIMIT.min || body.outputLimit > OUTPUT_LIMIT.max) {
        throw new AppError(400, msg('error.outputLimitRange', { min: OUTPUT_LIMIT.min, max: OUTPUT_LIMIT.max }));
      }
      input.outputLimit = body.outputLimit;
    }
    if ('retentionLimit' in body) {
      // `null` (or an empty value from a form) means automatic; the output limit is checked against the saved feed in the store.
      const value = body.retentionLimit === '' || body.retentionLimit === undefined ? null : body.retentionLimit;
      const problem = retentionProblem(value, OUTPUT_LIMIT.min);
      if (problem) throw new AppError(400, problem);
      input.retentionLimit = value as number | null;
    }
    if ('translationMode' in body) input.translationMode = parseTranslationMode(body.translationMode ?? '');
    if ('targetLanguage' in body) input.targetLanguage = parseTargetLanguage(body.targetLanguage ?? '');
    if ('translationProvider' in body) input.translationProvider = parseTranslationProvider(body.translationProvider);
    if ('channelTitle' in body) input.channelTitle = asNonEmptyString(body.channelTitle, msg('label.feedName'), 200);
    if ('intervalMinutes' in body) {
      if (typeof body.intervalMinutes !== 'number' || !Number.isInteger(body.intervalMinutes) || body.intervalMinutes < 5 || body.intervalMinutes > 1440) {
        throw new AppError(400, 'error.intervalRange');
      }
      input.intervalMinutes = body.intervalMinutes;
    }
    if ('networkProfileId' in body) {
      // Ownership is checked by feedsGuard.
      if (body.networkProfileId !== null && body.networkProfileId !== '' && typeof body.networkProfileId !== 'string') throw new AppError(400, 'error.networkProfileIdInvalid');
      input.networkProfileId = body.networkProfileId ? String(body.networkProfileId) : null;
    }
    if (!allowEmpty && !Object.keys(input).length) throw new AppError(400, 'error.feedSettingsEmpty');
    return input;
  }
  /** Reject a regex filter that already runs out of time on the feed's stored items. */
  function checkFilterBudget(feed: Feed, items: FeedItem[], input: FeedSettingsInput): void {
    if (!input.itemFilter?.regex) return;
    if (classifyItems(feed, items, { itemFilter: input.itemFilter }).timedOut) throw new AppError(400, 'error.regexTimeout');
  }
  const outputStatus = (feed: Feed, items: FeedItem[], override?: Parameters<typeof classifyItems>[2]) => {
    const { statuses, timedOut } = classifyItems(feed, items, override);
    return { outputStatus: Object.fromEntries(items.map((item, index) => [item.id, statuses[index]])) as Record<string, ItemOutputStatus>, ...(timedOut ? { filterTimedOut: true } : {}) };
  };
  app.patch('/api/feeds/:id', async request => {
    feedsGuard(request);
    const input = parseFeedSettings(asRecord(request.body));
    return enqueueRefresh(() => {
      feedsGuard(request);
      const id = String((request.params as { id: string }).id);
      const current = store.getFeed(id);
      if (!current) throw new AppError(404, 'error.feedNotFound');
      checkFilterBudget(current, store.getItems(id), input);
      const feed = store.updateFeedSettings(id, input);
      if (!feed) throw new AppError(404, 'error.feedNotFound');
      translations.wake();
      return feedPayload(feed);
    });
  });
  app.post('/api/feeds/:id/output-preview', async request => {
    feedsGuard(request);
    const feed = store.getFeed(String((request.params as { id: string }).id));
    if (!feed) throw new AppError(404, 'error.feedNotFound');
    const body = asRecord(request.body);
    const input = parseFeedSettings({ ...('itemFilter' in body ? { itemFilter: body.itemFilter } : {}), ...('outputLimit' in body ? { outputLimit: body.outputLimit } : {}) }, true);
    return outputStatus(feed, store.getItems(feed.id), input);
  });
  app.post('/api/feeds/bulk', async request => {
    feedsGuard(request);
    const body = asRecord(request.body);
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 200 || !body.ids.every(id => typeof id === 'string')) throw new AppError(400, 'error.selectFeeds');
    const action = body.action;
    if (!['copy', 'pause', 'resume', 'refresh', 'delete', 'settings'].includes(String(action))) throw new AppError(400, 'error.actionInvalid');
    const settingsBody = asRecord(body.settings);
    if (action === 'settings' && Object.keys(settingsBody).some(key => !['translationMode', 'targetLanguage', 'translationProvider', 'intervalMinutes', 'outputLimit', 'retentionLimit', 'itemFilter'].includes(key))) throw new AppError(400, 'error.bulkSettingsInvalid');
    const settingsInput = action === 'settings' ? parseFeedSettings(settingsBody) : undefined;
    if (action === 'refresh') {
      const results = await Promise.all([...new Set(body.ids as string[])].map(async id => {
        try {
          requireOwned(request, 'feeds', id);
          const feed = await doRefresh(id, false, 'manual', () => { requireOwned(request, 'feeds', id); return operationSignal(request); });
          if (!feed) return { id, ok: false, error: tl('error.feedNotFound') };
          return feed.lastError ? { id, ok: false, error: feed.lastError } : { id, ok: true };
        } catch (error) { return { id, ok: false, error: lt(friendlyError(error, msg('error.actionFailed'))) }; }
      }));
      return { results };
    }
    const results = [];
    for (const id of new Set(body.ids as string[])) {
      try {
        const result = await enqueueRefresh(async () => {
          requireOwned(request, 'feeds', id);
          const feed = store.getFeed(id);
          if (!feed) throw new AppError(404, 'error.feedNotFound');
          if (action === 'copy') return { id, ok: true, feedUrl: feedUrl(currentConfig(), store, id) };
          if (settingsInput) {
            checkFilterBudget(feed, store.getItems(id), settingsInput);
            store.transaction(() => store.updateFeedSettings(id, settingsInput));
            translations.wake();
          }
          if (action === 'delete') { store.deleteFeed(id); notifier.wake(); }
          if (action === 'pause' && feed.enabled || action === 'resume' && !feed.enabled) store.toggleFeed(id);
          return { id, ok: true };
        });
        results.push(result);
      } catch (error) { results.push({ id, ok: false, error: lt(friendlyError(error, msg('error.actionFailed'))) }); }
    }
    return { results };
  });
  app.post('/api/rss/preview', async request => {
    feedsGuard(request);
    const url = parseHttpUrl(asRecord(request.body).url, msg('label.rssUrl'));
    const profileId = asOptionalString(asRecord(request.body).networkProfileId, 'networkProfileId', 200);
    return enqueueRefresh(async () => {
      feedsGuard(request);
      try { const signal = operationSignal(request); const network = networkFor(profileId, workspace(request).userId); const result = await getRss(url, { signal, ...(network ? { network } : {}) }); feedsGuard(request); if (signal.aborted) throw new AppError(409, 'error.canceled'); return { title: result.title, items: result.items.slice(0, 3).map(item => ({ title: item.title, link: item.link, contentHtml: item.html })) }; }
      catch (error) {
        // Scripts tell a page served instead of a feed apart from a bad address.
        const code = error instanceof NotAFeedError ? 'source_not_feed' : undefined;
        const shown = friendlyError(error, msg('error.rssFetchFailed'));
        throw new AppError(400, shown.key === 'error.raw' ? rawText(safeDiagnostic(lt(shown))) : shown, code);
      }
    }, [siteKey(url)]);
  });
  // Identical previews within a minute (typing back and forth, a second tab) reuse the answer instead of asking NCBI again.
  const pubmedPreviews = new Map<string, { at: number; value: PubmedPreview }>();
  app.post('/api/pubmed/preview', async request => {
    feedsGuard(request);
    const body = asRecord(request.body);
    const query = parsePubmedQueryText(body.query);
    const profileId = asOptionalString(body.networkProfileId, 'networkProfileId', 200);
    const network = networkFor(profileId, workspace(request).userId);
    const key = JSON.stringify([profileId ?? '', query]);
    const cached = pubmedPreviews.get(key);
    if (cached && Date.now() - cached.at < PUBMED_PREVIEW_CACHE_MS) return cached.value;
    // Previews never push scheduled PubMed refreshes far back in the shared NCBI queue.
    if (ncbi.limiter.backlog() > PUBMED_PREVIEW_MAX_WAIT_MS) throw new AppError(429, 'error.pubmedBusy');
    try {
      const signal = operationSignal(request);
      const value = await previewPubmed(query, fetchPolicy(), ncbi, { signal, ...(network ? { network } : {}) });
      feedsGuard(request);
      if (signal.aborted) throw new AppError(409, 'error.canceled');
      pubmedPreviews.delete(key);
      pubmedPreviews.set(key, { at: Date.now(), value });
      for (const old of pubmedPreviews.keys()) { if (pubmedPreviews.size <= 100) break; pubmedPreviews.delete(old); }
      return value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const shown = friendlyError(error, msg('error.pubmedPreviewFailed'));
      const limited = error instanceof NcbiError && error.status === 429;
      throw new AppError(limited ? 429 : 502, shown.key === 'error.raw' ? rawText(safeDiagnostic(lt(shown))) : shown, limited ? 'rate_limited' : 'upstream_error');
    }
  });
  /** A PubMed RSS feed of the caller's workspace, or 404/400. */
  const pubmedRssFeed = (request: FastifyRequest): Feed => {
    const feed = store.getFeed(String((request.params as { id: string }).id));
    if (!feed) throw new AppError(404, 'error.feedNotFound');
    if (feed.sourceType !== 'rss' || !pubmedRssSource(feed.url)) throw new AppError(400, 'error.notPubmedRss');
    return feed;
  };
  const describeFailure = (error: unknown) => safeDiagnostic(lt(friendlyError(error, msg('error.rssFetchFailed'))));
  /** One conversion check with the feed's network profile; requests go through the shared NCBI limiter. */
  const checkFeed = async (feed: Feed, signal: AbortSignal) => {
    const network = networkFor(feed.networkProfileId, feed.ownerId);
    const target = (url: string) => options.pubmedRssBase ? `${options.pubmedRssBase}${new URL(url).pathname}${new URL(url).search}` : url;
    // Checks run in the feed owner's language, wherever they were started from.
    return withLocale(() => store.ownerLocale(feed.ownerId), () => checkPubmedRss(feed, {
      fetchRss: url => getRss(target(url), { signal, ...(network ? { network } : {}) }),
      storedPmids: store.getItems(feed.id, 100).map(item => pubmedPmidOf(item.link)).filter((id): id is string => !!id),
      policy: fetchPolicy(), ctx: ncbi, options: { signal, ...(network ? { network } : {}) }, describe: describeFailure,
    }));
  };
  const pubmedJobs = new PubmedCheckRunner({
    store: store.pubmedChecks, getFeed: id => store.getFeed(id),
    check: async (feed, signal) => ({ ...await checkFeed(feed as Feed, signal), feedId: feed.id, name: feed.name }), keyConfigured: () => !!store.getSettings().ncbi.apiKey,
    ownerSignal: id => store.userSignal(id), describe: (error, ownerId) => withLocale(() => store.ownerLocale(ownerId), () => describeFailure(error)),
  });
  /**
   * Turns a PubMed RSS feed into a PubMed search with this query; everything
   * else about the feed stays. Converting a feed that already is this search
   * succeeds without changes, so a batch can be retried.
   */
  const convertToPubmed = async (id: string, query: unknown, limit: unknown, guard: () => void, rename = false): Promise<Feed> => {
    const feed = store.getFeed(id);
    if (!feed) throw new AppError(404, 'error.feedNotFound');
    const rss = feed.sourceType === 'rss' ? pubmedRssSource(feed.url) : null;
    const pubmed = parsePubmedSearch({ query, limit: limit ?? (rss ? nearestPubmedLimit(rss.limit) : feed.pubmed?.limit) }, undefined);
    if (feed.sourceType === 'pubmed' && feed.pubmed?.query === pubmed.query && (limit === undefined || feed.pubmed.limit === pubmed.limit) && (!rename || feed.name === pubmedDefaultName(pubmed.query))) return feed;
    if (feed.sourceType === 'pubmed' && feed.pubmed?.query === pubmed.query && rename) return store.setChannelTitle(id, pubmedDefaultName(pubmed.query)) ?? feed;
    if (!rss) throw new AppError(400, 'error.notPubmedRss');
    // Only this feed is held: other PubMed feeds' refreshes (same site) don't make a batch wait.
    const updated = await enqueueRefresh(() => {
      guard();
      const current = store.getFeed(id);
      if (!current || current.sourceType !== 'rss') throw new AppError(409, 'error.notPubmedRss');
      return store.updateFeed(current.id, {
        // The feed keeps its own name unless the user asked for the query's default name.
        sourceType: 'pubmed', pubmed, url: pubmedSearchUrl(pubmed), name: rename ? pubmedDefaultName(pubmed.query) : current.name,
        translationMode: current.translationMode, targetLanguage: current.targetLanguage, translationProvider: current.translationProvider ?? null,
        rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: current.intervalMinutes, waitMs: 0,
      });
    }, [`feed:${id}`]);
    if (!updated) throw new AppError(404, 'error.feedNotFound');
    // The first E-utilities fetch runs in the background (through the NCBI limiter), so conversions return at once.
    if (store.isFeedActive(updated.id)) void doRefresh(updated.id, false, 'edit').catch(() => {});
    return updated;
  };
  // Checks one feed now (the panel's button); the result is also saved for batch checks.
  app.post('/api/feeds/:id/pubmed-check', async (request): Promise<PubmedRssCheck> => {
    feedsGuard(request);
    const feed = pubmedRssFeed(request);
    const check = await checkFeed(feed, operationSignal(request));
    store.pubmedChecks.save(feed.id, checkSignature(feed), { ...check, feedId: feed.id, name: feed.name });
    feedsGuard(request);
    return { ...check, feedId: feed.id, name: feed.name, ncbiKeyConfigured: !!store.getSettings().ncbi.apiKey };
  });
  app.post('/api/feeds/:id/pubmed-convert', async request => {
    feedsGuard(request);
    const body = asRecord(request.body);
    const feed = await convertToPubmed(String((request.params as { id: string }).id), body.query, body.limit, () => feedsGuard(request), body.rename === true);
    return feedPayload(feed);
  });

  // Background check jobs for many PubMed RSS feeds.
  const pubmedJob = (request: FastifyRequest) => {
    const job = store.pubmedChecks.job(String((request.params as { jobId: string }).jobId));
    if (!job || job.ownerId !== workspace(request).userId) throw new AppError(404, 'error.pubmedJobNotFound');
    return job;
  };
  const jobView = (job: Parameters<typeof jobSnapshot>[0]) => jobSnapshot(job, !!store.getSettings().ncbi.apiKey, pubmedJobs.concurrency);
  app.post('/api/pubmed-checks', async request => {
    feedsGuard(request);
    const body = asRecord(request.body);
    const context = workspace(request, true);
    const owned = store.listFeeds(context.userId).filter(feed => feed.sourceType === 'rss' && pubmedRssSource(feed.url));
    if (body.feedIds !== undefined && (!Array.isArray(body.feedIds) || body.feedIds.length > 1000 || !body.feedIds.every(id => typeof id === 'string'))) throw new AppError(400, 'error.selectFeeds');
    const wanted = Array.isArray(body.feedIds) ? new Set(body.feedIds as string[]) : undefined;
    const feeds = wanted ? owned.filter(feed => wanted.has(feed.id)) : owned;
    if (!feeds.length) throw new AppError(400, 'error.noPubmedRssFeeds');
    // Opening the batch again while a job runs shows that job instead of starting over.
    const running = store.pubmedChecks.latestJob(context.userId);
    if (running?.state === 'running' && body.recheck !== true && feeds.every(feed => running.entries.some(entry => entry.feedId === feed.id))) return jobView(running);
    if (running?.state === 'running') pubmedJobs.cancel(running);
    return jobView(pubmedJobs.create(context.userId, context.actorId, feeds, body.recheck === true));
  });
  app.get('/api/pubmed-checks/latest', async request => {
    feedsGuard(request);
    const job = store.pubmedChecks.latestJob(workspace(request).userId);
    return { job: job ? jobView(job) : null };
  });
  app.get('/api/pubmed-checks/:jobId', async request => { feedsGuard(request); return jobView(pubmedJob(request)); });
  app.post('/api/pubmed-checks/:jobId/cancel', async request => { feedsGuard(request); return jobView(pubmedJobs.cancel(pubmedJob(request))); });
  app.post('/api/pubmed-checks/:jobId/retry', async request => { feedsGuard(request); return jobView(pubmedJobs.retry(pubmedJob(request))); });
  // Converts the job's verified feeds (or the listed ones among them), one after another; already converted ones succeed again.
  app.post('/api/pubmed-checks/:jobId/convert', async request => {
    feedsGuard(request);
    const body = asRecord(request.body);
    if (body.feedIds !== undefined && (!Array.isArray(body.feedIds) || !body.feedIds.every(id => typeof id === 'string'))) throw new AppError(400, 'error.selectFeeds');
    const wanted = Array.isArray(body.feedIds) ? new Set(body.feedIds as string[]) : undefined;
    const job = pubmedJob(request);
    const results: Array<{ feedId: string; ok: boolean; error?: string }> = [];
    for (const entry of job.entries) {
      if (wanted && !wanted.has(entry.feedId)) continue;
      if (!entry.check || entry.check.status !== 'verified' || !(entry.state === 'done' || entry.state === 'converted')) { if (wanted) results.push({ feedId: entry.feedId, ok: false, error: tl('pubmedConvert.needsReview') }); continue; }
      try {
        await convertToPubmed(entry.feedId, entry.check.query, entry.check.limit, () => feedsGuard(request), body.rename === true);
        results.push({ feedId: entry.feedId, ok: true });
        const current = store.pubmedChecks.job(job.id)!;
        const row = current.entries.find(item => item.feedId === entry.feedId);
        if (row) { row.state = 'converted'; store.pubmedChecks.updateJob(current); }
      } catch (error) { results.push({ feedId: entry.feedId, ok: false, error: lt(friendlyError(error, msg('error.actionFailed'))) }); }
    }
    return { results, job: jobView(store.pubmedChecks.job(job.id)!) };
  });

  // Tests NCBI settings as typed (not saved yet) with a tiny esearch; the key is never returned.
  app.post('/api/settings/ncbi/test', async (request): Promise<NcbiKeyTest> => {
    adminGuard(request);
    const body = asRecord(request.body);
    const saved = store.getSettings().ncbi;
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : body.apiKey === null ? '' : saved.apiKey;
    const email = typeof body.email === 'string' ? body.email.trim() : saved.email;
    if (apiKey.length > 200 || email.length > 254) throw new AppError(400, 'error.ncbiSettingsInvalid');
    const test = await testNcbiSettings({ apiKey, email }, fetchPolicy(), ncbi, { signal: operationSignal(request) }, describeFailure);
    if (apiKey) store.pubmedChecks.saveKeyTest(keyDigest(apiKey), test);
    return test;
  });
  app.get('/api/settings/ncbi/status', async request => {
    adminGuard(request);
    const { apiKey } = store.getSettings().ncbi;
    const lastTest = apiKey ? store.pubmedChecks.keyTest(keyDigest(apiKey)) : undefined;
    return { apiKeyConfigured: !!apiKey, ...(lastTest ? { lastTest } : {}) };
  });
  app.get('/api/feeds/:id/translation/progress', async request => {
    feedsGuard(request);
    const id = String((request.params as { id: string }).id);
    const feed = store.getFeed(id);
    if (!feed || !translationEnabled(feed)) throw new AppError(404, 'error.translationFeedNotFound');
    return { ...store.translations.progress(id), worker: translations.status(feed.translationProvider ?? store.getSettings().translation.defaultProvider) };
  });
  app.get('/api/translation/providers', async (request): Promise<TranslationProvidersInfo> => {
    authenticated(request);
    const settings = store.getSettings().translation;
    return { defaultProvider: settings.defaultProvider, providers: (['google', 'deepl', 'openai'] as const).map(id => ({ id, label: tl(`provider.${id}`), configured: !providerProblem(settings, id) })) };
  });
  /** Translates one sample sentence with the given (unsaved) settings, so an administrator can check a key or endpoint. */
  app.post('/api/settings/translation/test', async request => {
    adminGuard(request);
    const body = asRecord(request.body);
    if (!isTranslationProvider(body.provider)) throw new AppError(400, 'error.translationProviderInvalid');
    const provider: TranslationProviderId = body.provider;
    const target = isTargetLanguage(body.targetLanguage) ? body.targetLanguage : 'zh-CN';
    const previous = store.getSettings().translation;
    const patch = provider === 'google' ? {} : asRecord(body.settings);
    const parsed = applicationSettingsSchema.shape.translation.safeParse({ ...previous, ...(provider === 'google' ? {} : { [provider]: { ...previous[provider], ...patch, apiKey: patch.apiKey || previous[provider].apiKey } }) });
    if (!parsed.success) throw new AppError(400, 'error.translationSettingsInvalid');
    const engine = translations.engine(provider, target, parsed.data);
    if (engine.unavailable) throw new AppError(400, engine.unavailable);
    const sample = 'FeedLantern turns web pages into RSS feeds.';
    try {
      const [text] = await engine.translate([sample], AbortSignal.any([operationSignal(request), AbortSignal.timeout(60_000)]));
      return { ok: true, sample, text };
    } catch (error) {
      throw new AppError(502, error instanceof TranslationError ? error.text : msg('translate.connectFailed', { service: engine.label }));
    }
  });
  app.post('/api/feeds/:id/translation/retry', async request => {
    feedsGuard(request);
    const id = String((request.params as { id: string }).id);
    const feed = store.getFeed(id);
    if (!feed || !translationEnabled(feed)) throw new AppError(404, 'error.translationFeedNotFound');
    store.translations.retry(id, authenticated(request).userId); translations.retry();
    return feedPayload(store.getFeed(id)!);
  });
  app.post('/api/feeds', async (request) => {
    feedsGuard(request);
    const input = parseFeedInput(request.body);
    if (input.credentialId && !store.getCredentialSummary(input.credentialId)) throw new AppError(400, 'error.credentialNotFound');
    const created = store.createFeed(input, workspace(request).userId);
    if (isFeedSource(input)) {
      void doRefresh(created.feed.id, false, 'create', () => operationSignal(request)).catch(() => {});
      return feedPayload(created.feed);
    }
    const refreshed = await doRefresh(created.feed.id, false, 'create', () => operationSignal(request));
    return feedPayload(refreshed ?? created.feed);
  });
  app.get('/api/feeds/:id/logs', async request => {
    feedsGuard(request);
    const id = String((request.params as { id: string }).id);
    if (!store.getFeed(id)) throw new AppError(404, 'error.feedNotFound');
    const query = request.query as Record<string, unknown>;
    const status = query.status;
    if (status !== undefined && !['running', 'success', 'failure', 'interrupted'].includes(String(status))) throw new AppError(400, 'error.logStatusInvalid');
    const integer = (value: unknown, fallback: number, max: number): number => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new AppError(400, 'error.logCursorInvalid');
      return Number(value);
    };
    const limit = integer(query.limit, 20, 100);
    const cursor = query.cursor === undefined ? undefined : integer(query.cursor, 0, Number.MAX_SAFE_INTEGER);
    return store.history.list(id, status as FetchStatus | undefined, cursor, limit);
  });
  app.get('/api/feeds/:id', async (request) => {
    feedsGuard(request);
    const feed = store.getFeed(String((request.params as { id: string }).id));
    if (!feed) throw new AppError(404, 'error.feedNotFound');
    const items = store.getItems(feed.id);
    return { ...feedPayload(feed), items, ...outputStatus(feed, items) };
  });
  app.put('/api/feeds/:id', async (request) => {
    feedsGuard(request);
    const id = String((request.params as { id: string }).id);
    const input = parseFeedInput(request.body);
    if (input.credentialId && !store.getCredentialSummary(input.credentialId)) throw new AppError(400, 'error.credentialNotFound');
    return enqueueRefresh(async () => {
      feedsGuard(request);
      const updated = store.updateFeed(id, input);
      if (!updated) throw new AppError(404, 'error.feedNotFound');
      const refreshed = store.isFeedActive(id) ? await refreshOnce(id, 'edit', operationSignal(request)) : updated;
      return feedPayload(refreshed ?? updated);
    });
  });
  app.post('/api/feeds/:id/refresh', async (request) => {
    feedsGuard(request);
    const refreshed = await doRefresh(String((request.params as { id: string }).id), false, 'manual', () => { feedsGuard(request); return operationSignal(request); });
    if (!refreshed) throw new AppError(404, 'error.feedNotFound');
    return feedPayload(refreshed);
  });
  app.post('/api/feeds/:id/toggle', async (request) => {
    feedsGuard(request);
    return enqueueRefresh(async () => {
      feedsGuard(request);
      const toggled = store.toggleFeed(String((request.params as { id: string }).id));
      if (!toggled) throw new AppError(404, 'error.feedNotFound');
      const refreshed = toggled.enabled ? await refreshOnce(toggled.id, 'resume', operationSignal(request)) : toggled;
      return feedPayload(refreshed ?? toggled);
    });
  });
  app.post('/api/feeds/:id/rotate-token', async (request) => {
    feedsGuard(request);
    const rotated = store.rotateFeedToken(String((request.params as { id: string }).id));
    if (!rotated) throw new AppError(404, 'error.feedNotFound');
    return feedPayload(rotated.feed);
  });
  app.delete('/api/feeds/:id', async (request) => {
    feedsGuard(request);
    return enqueueRefresh(() => {
      feedsGuard(request);
      if (!store.deleteFeed(String((request.params as { id: string }).id))) throw new AppError(404, 'error.feedNotFound');
      notifier.wake();
      return { ok: true };
    });
  });
  registerRuleHealthRoutes(app, { store, browser: () => browser, guard: feedsGuard, signal: operationSignal, enqueue: enqueueRefresh, keys: refreshKeys, cookies: credentialsForFeed, network: feed => networkFor(feed.networkProfileId, feed.ownerId), payload: feedPayload });

  const browserGuard = (request: FastifyRequest) => {
    resourceGuard(request);
    const context = workspace(request, true);
    const id = asRecord(request.params).id;
    if (typeof id === 'string' && (browserOwners.get(id)?.userId !== context.userId || browserOwners.get(id)?.actorId !== context.actorId)) throw new AppError(404, 'error.browserSessionNotFound');
    if (typeof id === 'string') browserOwners.set(id, { userId: context.userId, actorId: context.actorId, touchedAt: Date.now() });
    checkCredential(request, asRecord(request.body).credentialId);
    checkNetworkProfile(request, asRecord(request.body).networkProfileId);
    return context;
  };
  app.post('/api/browser', async (request) => {
    browserGuard(request);
    const body = asRecord(request.body);
    const url = parseHttpUrl(body.url, msg('label.targetUrl'));
    const waitMs = asInteger(body.waitMs, 'waitMs', 0, 10_000, 1_000);
    const waitForSelector = asOptionalString(body.waitForSelector, 'waitForSelector', 4_000);
    const credentialId = body.credentialId === undefined || body.credentialId === null || body.credentialId === '' ? null : asNonEmptyString(body.credentialId, 'credentialId', 200);
    let cookies: Cookie[] = [];
    if (credentialId) {
      const credential = store.getCredentialValue(credentialId);
      if (!credential || typeof credential.value !== 'string') throw new AppError(400, 'error.credentialMissingOrInvalid');
      cookies = cookiesForTarget(credential, url);
    }
    try {
      const { userId, actorId } = workspace(request, true), generation = store.userGeneration(userId);
      const network = networkFor(asOptionalString(body.networkProfileId, 'networkProfileId', 200), userId);
      const frame = await browser.open({ url, cookies, waitMs, waitForSelector, signal: operationSignal(request), ...(network ? { network } : {}) });
      try {
        workspace(request, true);
        if (generation !== store.userGeneration(userId)) throw new AppError(401, 'error.accountDisabledSignIn');
      } catch (error) { await browser.close(frame.sessionId); throw error; }
      browserOwners.set(frame.sessionId, { userId, actorId, touchedAt: Date.now() });
      return frame;
    } catch (error) { if (error instanceof AppError) throw error; throw frameError(error, 'Open page'); }
  });
  app.get('/api/browser/:id', async (request) => {
    browserGuard(request);
    try { return await browser.snapshot(String((request.params as { id: string }).id)); } catch (error) { throw frameError(error, 'Capture page'); }
  });
  app.post('/api/browser/:id/scroll', async (request) => {
    browserGuard(request);
    const body = asRecord(request.body);
    const deltaY = Number(body.deltaY);
    let point: { x: number; y: number } | undefined;
    if (body.x !== undefined || body.y !== undefined) {
      if (typeof body.x !== 'number' || typeof body.y !== 'number' || !Number.isFinite(body.x) || !Number.isFinite(body.y)) throw new AppError(400, 'error.scrollPointInvalid');
      point = { x: body.x, y: body.y };
    }
    if (!Number.isFinite(deltaY) || Math.abs(deltaY) > 100_000) throw new AppError(400, 'error.deltaInvalid');
    try { return await browser.scroll(String((request.params as { id: string }).id), deltaY, point); } catch (error) { throw frameError(error, 'Scroll page'); }
  });
  app.post('/api/browser/:id/click', async (request) => {
    browserGuard(request);
    const body = asRecord(request.body);
    const x = Number(body.x); const y = Number(body.y);
    if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x > 100_000 || y > 100_000) throw new AppError(400, 'error.clickInvalid');
    try { return await browser.click(String((request.params as { id: string }).id), x, y); } catch (error) { throw frameError(error, 'Click page'); }
  });
  app.post('/api/browser/:id/pick', async (request) => {
    browserGuard(request);
    const body = asRecord(request.body);
    const target = body.target;
    if (!['item', 'title', 'link', 'description', 'image', 'date', 'next'].includes(String(target))) throw new AppError(400, 'error.pickTargetInvalid');
    const pickRequest: PickRequest = {
      target: target as PickRequest['target'],
      ...(body.node !== undefined ? { node: asInteger(body.node, 'node', 0, 1_000_000, 0) } : { x: Number(body.x), y: Number(body.y) }),
      ...(body.exact === true ? { exact: true } : {}),
      ...(body.itemSelector ? { itemSelector: asNonEmptyString(body.itemSelector, 'itemSelector', 4_000) } : {}),
      ...(body.ancestorLevel !== undefined ? { ancestorLevel: asInteger(body.ancestorLevel, 'ancestorLevel', 0, 20, 0) } : {}),
      ...(body.rules !== undefined ? { rules: parsePartialRules(body.rules) } : {}),
    };
    if (pickRequest.node === undefined && (![pickRequest.x, pickRequest.y].every(Number.isFinite) || pickRequest.x! < 0 || pickRequest.y! < 0)) throw new AppError(400, 'error.pickPointInvalid');
    try { return await browser.pick(String((request.params as { id: string }).id), pickRequest); } catch (error) { throw frameError(error, 'Pick element'); }
  });
  app.post('/api/browser/:id/segment', async (request) => {
    browserGuard(request);
    if (!browser.segment) throw new AppError(501, 'error.segmentUnsupported');
    const body = asRecord(request.body);
    if (body.top === undefined || body.top === null) throw new AppError(400, 'error.segmentRequired');
    const top = asInteger(body.top, 'top', 1, 1_000_000, 1);
    try { return await browser.segment(String((request.params as { id: string }).id), top); } catch (error) { throw frameError(error, 'Load page segment'); }
  });
  app.post('/api/browser/:id/follow', async (request) => {
    browserGuard(request);
    if (!browser.follow) throw new AppError(501, 'error.followUnsupported');
    const body = asRecord(request.body);
    if (body.node === undefined || body.node === null) throw new AppError(400, 'error.linkNodeRequired');
    const node = asInteger(body.node, 'node', 0, 1_000_000, 0);
    try { return await browser.follow(String((request.params as { id: string }).id), node); } catch (error) { throw frameError(error, 'Open link'); }
  });
  app.post('/api/browser/:id/preview', async (request) => {
    browserGuard(request);
    const body = asRecord(request.body);
    const rules = parseRules(body.rules);
    const pagination = parsePagination(body.pagination);
    const id = String((request.params as { id: string }).id);
    if (pagination && pagination.maxPages > 1) {
      if (!browser.paginate) throw new AppError(501, 'error.paginateUnsupported');
      try { const result = await browser.paginate(id, rules, pagination); return { items: result.items, pagination: result.report }; } catch (error) { throw frameError(error, 'Preview pagination'); }
    }
    try { return { items: await browser.extract(id, rules) }; } catch (error) { throw frameError(error, 'Preview rules'); }
  });
  app.post('/api/browser/:id/detect', async (request) => {
    browserGuard(request);
    if (!browser.detect) throw new AppError(501, 'error.detectUnsupported');
    try { return await browser.detect(String((request.params as { id: string }).id)); } catch (error) { throw frameError(error, 'Detect'); }
  });
  app.delete('/api/browser/:id', async (request) => {
    browserGuard(request);
    try { const id = String((request.params as { id: string }).id); await browser.close(id); browserOwners.delete(id); } catch (error) { throw frameError(error, 'Close page session'); }
    return { ok: true };
  });

  const publicFeed = (format: FeedFormat) => async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { id: string; token: string };
    const extension = format === 'rss' ? '.xml' : format === 'atom' ? '.atom' : '.json';
    const token = params.token.endsWith(extension) ? params.token.slice(0, -extension.length) : params.token;
    // One token guards every format, so rotating it revokes all three addresses.
    if (!store.checkFeedToken(params.id, token)) throw new AppError(404, 'error.feedNotFound');
    const feed = store.getFeed(params.id);
    if (!feed) throw new AppError(404, 'error.feedNotFound');
    const items = store.getItems(feed.id);
    const publicUrl = `${currentConfig().publicOrigin}/feeds/${encodeURIComponent(feed.id)}/${encodeURIComponent(token)}${extension}`;
    const query = request.query as Record<string, unknown> | undefined;
    // Only the RSS address has the human-readable browser page.
    const preview = format === 'rss' && wantsHtmlPreview(request.headers, query);
    // The browser page speaks the visitor's language; the feed's own texts the owner's.
    const locale = preview ? headerLocale(request.headers['accept-language']) : store.ownerLocale(feed.ownerId);
    const etag = (preview ? rssEtag(feed, items).replace(/"$/, '-html"') : rssEtag(feed, items, format)).replace(/"$/, `-${locale}"`);
    reply.header('Cache-Control', 'private, max-age=60');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Vary', format === 'rss' ? 'Accept, Accept-Language, Sec-Fetch-Dest, Sec-Fetch-Mode' : 'Sec-Fetch-Dest');
    reply.header('ETag', etag);
    if (etagMatches(request.headers['if-none-match'], etag)) return reply.code(304).send();
    return withLocale(locale, () => sendFeed(reply, request, format, feed, items, publicUrl, preview, query));
  };
  const sendFeed = (reply: FastifyReply, request: FastifyRequest, format: FeedFormat, feed: Feed, items: FeedItem[], publicUrl: string, preview: boolean, query: Record<string, unknown> | undefined) => {
    if (preview) {
      const page = renderRssPreview(feed, items, publicUrl);
      reply.header('Content-Security-Policy', page.csp);
      reply.header('X-Frame-Options', 'DENY');
      return reply.type('text/html; charset=utf-8').send(page.html);
    }
    const document = request.headers['sec-fetch-dest'] === 'document';
    if (format === 'json') {
      // Browsers display application/json instead of downloading the feed type.
      return reply.type(document ? 'application/json; charset=utf-8' : 'application/feed+json; charset=utf-8').send(renderJsonFeed(feed, items, publicUrl));
    }
    if (format === 'atom') return reply.type(document ? 'application/xml; charset=utf-8' : 'application/atom+xml; charset=utf-8').send(renderAtom(feed, items, publicUrl));
    // A browser asking for the raw document gets an XML type it can display instead of downloading.
    const raw = typeof query?.format === 'string' && document;
    return reply.type(raw ? 'application/xml; charset=utf-8' : 'application/rss+xml; charset=utf-8').send(renderRss(feed, items, publicUrl));
  };
  app.get('/feeds/:id/:token.xml', publicFeed('rss'));
  app.get('/feeds/:id/:token.atom', publicFeed('atom'));
  app.get('/feeds/:id/:token.json', publicFeed('json'));

  registerBundleRoutes(app, store, () => currentConfig().publicOrigin, request => { resourceGuard(request); return workspace(request).userId; });

  if (hasDist(config.distDir)) await app.register(fastifyStatic, { root: config.distDir, wildcard: false });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/feeds/') || request.url.startsWith('/bundles/')) return sendError(reply, 404, msg('error.notFound'));
    if (request.method === 'GET' && existsSync(resolve(config.distDir, 'index.html'))) return reply.type('text/html; charset=utf-8').send(await readFile(resolve(config.distDir, 'index.html')));
    return reply.type('text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><title>FeedLantern</title><p>FeedLantern is running. Build or start the web interface first.</p>');
  });


  const cleanup = setInterval(() => {
    for (const [id, owner] of browserOwners) if (Date.now() - owner.touchedAt > 10 * 60_000) browserOwners.delete(id);
    try { store.purgeExpiredSessions(); store.tokens.purgeExpired(); store.tokenLog.prune(); store.history.prune(); store.ruleHealth.prune(); store.translations.prune(); store.activity.prune(); store.compact(); } catch { console.error('Fetch log cleanup failed; it will retry automatically'); }
  }, 60 * 60_000);
  cleanup.unref();
  app.addHook('onReady', async () => { jobs.recover(); notifier.start(); translations.start(); });
  // Check jobs left running when the service stopped continue where they were.
  pubmedJobs.resume();
  if (options.startScheduler !== false) {
    scheduler = setInterval(() => { void refreshDue().catch(() => {}); }, 30_000);
    scheduler.unref();
    app.addHook('onReady', async () => { void refreshDue().catch(() => {}); });
  }
  app.addHook('onClose', async () => {
    pubmedJobs.close();
    jobs.stop();
    closing = true;
    if (scheduler) clearInterval(scheduler);
    clearInterval(cleanup);
    await pool.drain();
    await translations.stop();
    await notifier.stop();
    await browser.dispose();
    store.tokenLog.flush();
    if (!options.store) store.close();
  });
  return app;
}

export { Store } from './store.js';
