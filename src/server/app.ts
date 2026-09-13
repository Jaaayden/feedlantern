import { translationEnabled } from '../shared/types.js';
import { fetchSource, type SourceFetcher } from './rss-source.js';
import { NetworkPolicy } from './network.js';
import { TranslationWorker, type Translator } from './rss-translation.js';
import { BarkWorker, sendBark, type BarkSender } from './bark.js';
import { applicationSettingsSchema, settingsFromConfig, applyRuntimeSettings } from './settings.js';
import { safeDiagnostic } from './fetch-history.js';
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
  DetectionResult,
  ExtractedItem,
  Feed,
  FetchSource,
  FetchStatus,
  FeedInput,
  FeedSettingsInput,
  PickRequest,
  PickResult,
  ScreenFrame,
  SelectionRules,
} from '../shared/types.js';
import { parseCookies, cookiesForUrl, CookieParseError } from './cookies.js';
import {
  AppError,
  LoginRateLimiter,
  authState,
  clearSessionCookie,
  issueCsrf,
  requireAuth,
  requireCsrf,
  sessionFromRequest,
  setSessionCookie,
  validatePassword,
  validateUsername,
} from './auth.js';
import { getConfig, ensureDataDir, hasDist, isAllowedOrigin, type ConfigInput, type ServerConfig } from './config.js';
import { renderRss, rssEtag } from './rss.js';
import { Store, type CredentialValue } from './store.js';

export interface BrowserServiceLike {
  discover?(options: { url: string; cookies?: Cookie[]; waitMs: number }): Promise<{ title: string; detection: DetectionResult }>;
  open(options: { url: string; cookies?: Cookie[]; waitMs: number; waitForSelector?: string }): Promise<ScreenFrame> | ScreenFrame;
  snapshot(id: string): Promise<ScreenFrame> | ScreenFrame;
  scroll(id: string, deltaY: number, point?: { x: number; y: number }): Promise<ScreenFrame> | ScreenFrame;
  click(id: string, x: number, y: number): Promise<ScreenFrame> | ScreenFrame;
  pick(id: string, request: PickRequest): Promise<PickResult> | PickResult;
  extract(id: string, rules: SelectionRules): Promise<ExtractedItem[]> | ExtractedItem[];
  scrape(options: { url: string; cookies?: Cookie[]; waitMs: number; waitForSelector?: string; rules: SelectionRules }): Promise<ExtractedItem[]> | ExtractedItem[];
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
  barkSender?: BarkSender;
  rssFetcher?: SourceFetcher;
  translator?: Translator;
  translationIntervalMs?: number;
}

interface FeedBody {
  sourceType?: unknown;
  translationMode?: unknown;
  name?: unknown;
  url?: unknown;
  rules?: unknown;
  ruleOrigins?: unknown;
  credentialId?: unknown;
  intervalMinutes?: unknown;
  waitMs?: unknown;
  waitForSelector?: unknown;
}

interface CredentialBody {
  name?: unknown;
  url?: unknown;
  format?: unknown;
  value?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asNonEmptyString(value: unknown, label: string, max = 20_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(400, `${label}不能为空且长度不能超过 ${max}`);
  return value.trim();
}

function asOptionalString(value: unknown, label: string, max = 20_000): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return asNonEmptyString(value, label, max);
}

function asOptionalSelector(value: unknown, label: string, max = 4_000): string | undefined {
  // The editor sends an empty string when a user deliberately clears an
  // optional field. Treat it as absent instead of rejecting the whole form.
  if (value === undefined || value === null || value === '') return undefined;
  return asNonEmptyString(value, label, max);
}

function asInteger(value: unknown, label: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new AppError(400, `${label}必须是 ${min} 到 ${max} 之间的整数`);
  return number;
}

function parseHttpUrl(value: unknown, label: string): string {
  const text = asNonEmptyString(value, label, 4_000);
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new AppError(400, `${label}不是有效 URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new AppError(400, `${label}只能使用不带账号密码的 HTTP 或 HTTPS URL`);
  return parsed.toString();
}

function parseRules(value: unknown): SelectionRules {
  const record = asRecord(value);
  return {
    item: asNonEmptyString(record.item, 'item selector', 4_000),
    title: asNonEmptyString(record.title, 'title selector', 4_000),
    link: asNonEmptyString(record.link, 'link selector', 4_000),
    ...(asOptionalSelector(record.description, 'description selector') ? { description: asOptionalSelector(record.description, 'description selector') } : {}),
    ...(asOptionalSelector(record.image, 'image selector') ? { image: asOptionalSelector(record.image, 'image selector') } : {}),
    ...(asOptionalSelector(record.date, 'date selector') ? { date: asOptionalSelector(record.date, 'date selector') } : {}),
  };
}

function parseRuleOrigins(value: unknown): FeedInput['ruleOrigins'] {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  const output: NonNullable<FeedInput['ruleOrigins']> = {};
  for (const key of ['item', 'title', 'link', 'description', 'image', 'date'] as const) {
    if (record[key] === undefined) continue;
    if (record[key] !== 'auto' && record[key] !== 'manual') throw new AppError(400, 'ruleOrigins 只能使用 auto 或 manual');
    output[key] = record[key];
  }
  return output;
}

function parseFeedInput(value: unknown): FeedInput {
  const record = asRecord(value) as FeedBody;
  if (record.sourceType !== undefined && !['website','rss'].includes(String(record.sourceType))) throw new AppError(400, '订阅来源类型无效');
  if (record.translationMode !== undefined && !['original','chinese','bilingual'].includes(String(record.translationMode))) throw new AppError(400, '翻译输出模式无效');
  const rss = record.sourceType === 'rss';
  const credentialId = record.credentialId === undefined || record.credentialId === null || record.credentialId === '' ? null : asNonEmptyString(record.credentialId, 'credentialId', 200);
  return {
    sourceType: rss ? 'rss' : 'website',
    translationMode: record.translationMode === 'original' ? 'original' : record.translationMode === 'chinese' ? 'chinese' : record.translationMode === 'bilingual' || rss ? 'bilingual' : undefined,
    name: asNonEmptyString(record.name, 'feed name', 200),
    url: parseHttpUrl(record.url, 'feed URL'),
    rules: rss ? { item: '', title: '', link: '' } : parseRules(record.rules),
    ruleOrigins: parseRuleOrigins(record.ruleOrigins),
    credentialId: rss ? null : credentialId,
    intervalMinutes: asInteger(record.intervalMinutes, 'intervalMinutes', 5, 1_440, rss ? 30 : 60),
    waitMs: asInteger(record.waitMs, 'waitMs', 0, 10_000, 1_000),
    ...(record.waitForSelector ? { waitForSelector: asNonEmptyString(record.waitForSelector, 'waitForSelector', 4_000) } : {}),
  };
}

function parseCredentialInput(value: unknown): CredentialValue {
  const record = asRecord(value) as CredentialBody;
  if (record.format !== 'header' && record.format !== 'json') throw new AppError(400, 'Cookie 格式必须是 header 或 json');
  const url = parseHttpUrl(record.url, 'Cookie 绑定 URL');
  const name = asNonEmptyString(record.name, 'Cookie 凭据名称', 200);
  const cookieValue = asNonEmptyString(record.value, 'Cookie 内容', 2_000_000);
  return { name, url, format: record.format, value: cookieValue };
}

function friendlyError(error: unknown, fallback: string): string {
  if (error instanceof CookieParseError) return error.message;
  if (error instanceof AppError) return error.message;
  if (error instanceof Error) {
    const message = error.message.replace(/https?:\/\/[^\s)]+/gi, '[目标页面]').replace(/(?:cookie|authorization|set-cookie)\s*[:=][^\n]*/gi, '[敏感请求头已隐藏]');
    if (message && message.length <= 300 && !/\n|stack|at\s+/.test(message)) return message;
  }
  return fallback;
}

function frameError(error: unknown): AppError {
  return new AppError(400, friendlyError(error, '网页操作失败，请检查目标页面和等待条件'));
}

function authHeaders(request: FastifyRequest): { marker: boolean; csrf?: string } {
  const marker = request.headers['x-feedlantern'];
  const csrf = request.headers['x-csrf-token'];
  return { marker: marker === '1', csrf: Array.isArray(csrf) ? csrf[0] : csrf };
}

function feedUrl(config: ServerConfig, store: Store, id: string): string {
  const token = store.getFeedToken(id);
  if (!token) throw new AppError(404, 'Feed 不存在');
  return `${config.publicOrigin}/feeds/${encodeURIComponent(id)}/${encodeURIComponent(token.token)}.xml`;
}

function cookieMetadata(cookies: readonly Cookie[], url: string): { domains: string[]; count: number; expiresAt: string | null } {
  const target = new URL(url);
  const domains = Array.from(new Set(cookies.map((cookie) => cookie.domain || target.hostname).filter(Boolean))).sort();
  const expirations = cookies.map((cookie) => cookie.expires).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  const expiresAt = expirations.length ? new Date(Math.min(...expirations) * 1000).toISOString() : null;
  return { domains, count: cookies.length, expiresAt };
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
  const bark = new BarkWorker(store.history, () => store.getSettings().bark, options.barkSender);
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
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 400 || status === 413 || status === 415) return reply.code(status).send({ error: '请求格式无效或内容过大' });
    return reply.code(500).send({ error: '服务器内部错误' });
  });
  await app.register(cookie);
  const allowedApiHosts = new Set([
    new URL(config.publicOrigin).host.toLowerCase(),
    ...config.viteOrigins.map((origin) => {
      try { return new URL(origin).host.toLowerCase(); } catch { return ''; }
    }).filter(Boolean),
  ]);

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
    try {
      if (typeof forwardedHost !== 'string' || !/^[a-zA-Z0-9.:[\]-]+$/.test(forwardedHost) || !['http', 'https'].includes(String(forwardedProto))) throw Error();
      const origin = new URL(`${forwardedProto}://${forwardedHost}`).origin;
      if (new URL(origin).host.toLowerCase() !== forwardedHost.toLowerCase()) throw Error();
      requestConfigs.run({ ...config, publicOrigin: origin, cookieSecure: config.cookieSecure || forwardedProto === 'https' }, done);
    } catch { done(new AppError(400, '反向代理转发头无效')); }
  });

  const limiter = new LoginRateLimiter();
  let schedulerRunning = false;
  let scheduler: NodeJS.Timeout | undefined;
  let closing = false;
  let maintenance = false;
  const pool = new TaskPool(config.backgroundConcurrency);
  const translations = new TranslationWorker(store.translations, options.translator, options.translationIntervalMs ?? (() => store.getSettings().translation), (feedId, error) => {
    try {
      const feed = store.getFeed(feedId); if (!feed) return;
      if (error) store.history.translationFailed(feed, error);
      else store.history.translationRecovered(feedId);
      bark.wake();
    } catch { console.error('翻译通知入队失败'); }
  });
  const getRss: SourceFetcher = options.rssFetcher ?? ((url, input) => fetchSource(url, new NetworkPolicy({ allowedHosts: config.allowedHosts, dnsOverHttps: config.dnsOverHttps }), input));
  const refreshInFlight = new Map<string, { promise: Promise<Feed | null>; force: boolean }>();

  // Unkeyed mutations form barriers; independent captures share bounded slots.
  const enqueueRefresh = <T,>(operation: () => Promise<T> | T, keys?: string[] | (() => string[])): Promise<T> => {
    if (closing || maintenance) return Promise.reject(new AppError(503, '服务正在关闭'));
    return pool.enqueue(operation, keys);
  };
  const refreshKeys = (id: string) => {
    const feed = store.getFeed(id);
    return [`feed:${id}`, ...(feed ? [siteKey(feed.url)] : [])];
  };

  const currentSession = (request: FastifyRequest): ReturnType<typeof sessionFromRequest> => sessionFromRequest(request, store, config);
  const authenticated = (request: FastifyRequest): ReturnType<typeof requireAuth> => requireAuth(request, store, config);

  const cookiesForTarget = (credential: CredentialValue, targetUrl: string): Cookie[] => {
    if (typeof credential.value !== 'string') throw new AppError(400, 'Cookie 凭据内容无效');
    try {
      // Parse against the credential's declared binding first. Rebinding a
      // pasted header to the requested page would otherwise turn a credential
      // for one host into a credential for an arbitrary host.
      const parsed = parseCookies(credential.value, credential.format, credential.url);
      const filtered = cookiesForUrl(parsed, targetUrl);
      if (filtered.length === 0) throw new AppError(400, 'Cookie 凭据与目标 URL 的域名不匹配');
      return filtered;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(400, friendlyError(error, 'Cookie 凭据无法解析'));
    }
  };

  const credentialsForFeed = (feed: Feed): Cookie[] => {
    if (!feed.credentialId) return [];
    const credential = store.getCredentialValue(feed.credentialId);
    if (!credential) throw new AppError(400, 'Feed 引用的 Cookie 凭据不存在');
    return cookiesForTarget(credential, feed.url);
  };

  const refreshOnce = async (id: string, source: FetchSource): Promise<Feed | null> => {
    const feed = store.getFeed(id);
    if (!feed) return null;
    const nextFetchAt = new Date(Date.now() + feed.intervalMinutes * 60_000).toISOString();
    const started = performance.now();
    const runId = store.transaction(() => {
      store.markFetchStart(feed.id, nextFetchAt);
      return store.history.start(feed.id, source);
    });
    try {
      const rss = feed.sourceType === 'rss' ? await getRss(feed.url, store.translations.sourceState(feed.id)) : undefined;
      const items = rss ? [] : await browser.scrape({ url: feed.url, cookies: credentialsForFeed(feed), waitMs: feed.waitMs, waitForSelector: feed.waitForSelector, rules: feed.rules });
      if (!rss && !items.length) throw new Error('没有抽取到有效条目：可能是页面结构或规则变化，请检查匹配规则、Cookie 或页面渲染');
      const result = store.transaction(() => {
        const counts = { itemCount: 0, newItemCount: 0 };
        if (rss) {
          if (!rss.unchanged) {
            Object.assign(counts, store.translations.upsert(feed, store.translations.incoming(feed.id, rss.items)));
            store.translations.saveSource(feed.id, rss);
          } else counts.itemCount = feed.itemCount;
        } else {
          store.upsertItems(feed, items, counts);
          if (!counts.itemCount) throw new Error('没有抽取到有效条目：可能是页面结构或规则变化');
        }
        const updated = store.markFetchSuccess(feed.id, nextFetchAt);
        store.history.succeed(runId, feed.id, performance.now() - started, counts);
        return updated;
      });
      bark.wake();
      translations.wake();
      return result;
    } catch (error) {
      const message = safeDiagnostic(friendlyError(error, '抓取失败，已保留已有条目'));
      store.transaction(() => {
        store.markFetchFailure(feed.id, message, nextFetchAt);
        store.history.fail(runId, feed, source, performance.now() - started, message, store.getSettings().bark.enabled);
      });
      bark.wake();
      return store.getFeed(feed.id);
    }
  };

  const doRefresh = (id: string, dueOnly = false, source: FetchSource = dueOnly ? 'scheduled' : 'manual'): Promise<Feed | null> => {
    const active = refreshInFlight.get(id);
    if (active) { if (!dueOnly) active.force = true; return active.promise; }
    const job = { force: !dueOnly, promise: Promise.resolve<Feed | null>(null) };
    job.promise = enqueueRefresh(() => {
      const current = store.getFeed(id);
      if (!current) return null;
      if (job.force || current.enabled && current.nextFetchAt <= new Date().toISOString()) return refreshOnce(id, source);
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

  const jobs = new ImportJobs(store, enqueueRefresh, async entry => {
    if (!browser.discover) throw new AppError(501, '当前浏览器不支持批量识别');
    const credential = entry.credentialId ? store.getCredentialValue(entry.credentialId) : null;
    if (entry.credentialId && !credential) throw new AppError(400, 'Cookie 凭据不存在');
    return browser.discover({ url: entry.url, waitMs: 1000, cookies: credential ? cookiesForTarget(credential, entry.url) : [] });
  }, async input => {
    const credential = input.credentialId ? store.getCredentialValue(input.credentialId) : null;
    if (input.credentialId && !credential) throw new AppError(400, 'Cookie 凭据不存在');
    return browser.scrape({ ...input, cookies: credential ? cookiesForTarget(credential, input.url) : [] });
  }, error => friendlyError(error, '识别失败：请检查网址、网络或 Cookie，然后重试或手动调整。'), config.backgroundConcurrency, entry => getRss(entry.url), () => translations.wake());

  app.addHook('onRequest', async (request) => {
    if (maintenance) throw new AppError(503, '服务维护中，请稍后重试');
    if (!request.url.startsWith('/api/')) return;
    const requestHost = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
    if (!requestHost || !allowedApiHosts.has(requestHost.toLowerCase()) && requestHost.toLowerCase() !== new URL(currentConfig().publicOrigin).host.toLowerCase()) throw new AppError(403, '请求主机不被允许');
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    if (!isAllowedOrigin(origin, currentConfig())) throw new AppError(403, '请求来源不被允许');
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS' && !authHeaders(request).marker) {
      throw new AppError(400, '缺少 X-FeedLantern: 1 请求头');
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Content-Type-Options', 'nosniff');
    }
    return payload;
  });

  app.get('/api/auth/status', async (request): Promise<AuthState> => {
    const session = currentSession(request);
    const context = session ? { sessionId: request.cookies[config.cookieName]!, username: session.username, expiresAt: session.expiresAt } : null;
    const csrf = context ? issueCsrf(store, context) : undefined;
    return authState(store, config, context, csrf);
  });

  app.post('/api/auth/setup', async (request, reply) => {
    if (store.hasAdmin()) throw new AppError(409, '管理员已经完成初始化');
    if (!limiter.allowed(request.ip)) throw new AppError(429, '初始化尝试过于频繁，请稍后再试');
    const body = asRecord(request.body);
    const token = asNonEmptyString(body.setupToken, 'setupToken', 200);
    const username = body.username;
    const password = body.password;
    if (!validateUsername(username)) throw new AppError(400, '用户名格式无效');
    if (!validatePassword(password)) throw new AppError(400, '密码长度必须为 8 到 1024 个字符');
    if (!store.consumeSetupToken(token)) {
      limiter.registerFailure(request.ip);
      throw new AppError(401, '初始化令牌无效或已使用');
    }
    limiter.clear(request.ip);
    try { store.createAdmin(username, password); } catch { throw new AppError(409, '管理员已经完成初始化'); }
    const session = store.createSession(username, config.sessionTtlMs);
    setSessionCookie(reply, currentConfig(), session.id);
    return authState(store, config, { sessionId: session.id, username, expiresAt: session.expiresAt }, session.csrfToken);
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = asRecord(request.body);
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const key = request.ip;
    if (!limiter.allowed(key)) throw new AppError(429, '登录尝试过于频繁，请稍后再试');
    if (!validateUsername(username) || !validatePassword(password) || !store.authenticate(username, password)) {
      limiter.registerFailure(key);
      throw new AppError(401, '用户名或密码错误');
    }
    limiter.clear(key);
    const session = store.createSession(username, config.sessionTtlMs);
    setSessionCookie(reply, currentConfig(), session.id);
    return authState(store, config, { sessionId: session.id, username, expiresAt: session.expiresAt }, session.csrfToken);
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
    if (typeof currentPassword !== 'string' || !store.authenticate(context.username, currentPassword)) throw new AppError(400, '当前密码错误');
    if (!validatePassword(newPassword)) throw new AppError(400, '新密码长度必须为 8 到 1024 个字符');
    store.changePassword(newPassword);
    clearSessionCookie(reply, currentConfig());
    return authState(store, config, null);
  });

  const credentialsGuard = (request: FastifyRequest): void => {
    const context = authenticated(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') requireCsrf(request, store, context);
  };

  app.get('/api/credentials', async (request): Promise<CredentialSummary[]> => { credentialsGuard(request); return store.listCredentialSummaries(); });
  app.post('/api/credentials', async (request) => {
    credentialsGuard(request);
    const input = parseCredentialInput(request.body);
    let cookies: Cookie[];
    try { cookies = parseCookies(String(input.value), input.format, input.url); } catch (error) { throw new AppError(400, friendlyError(error, 'Cookie 凭据无法解析')); }
    return store.createCredential(input, cookieMetadata(cookies, input.url));
  });
  app.put('/api/credentials/:id', async (request) => {
    credentialsGuard(request);
    const input = parseCredentialInput(request.body);
    let cookies: Cookie[];
    try { cookies = parseCookies(String(input.value), input.format, input.url); } catch (error) { throw new AppError(400, friendlyError(error, 'Cookie 凭据无法解析')); }
    const result = store.updateCredential(String((request.params as { id: string }).id), input, cookieMetadata(cookies, input.url));
    if (!result) throw new AppError(404, 'Cookie 凭据不存在');
    return result;
  });
  app.delete('/api/credentials/:id', async (request) => {
    credentialsGuard(request);
    const id = String((request.params as { id: string }).id);
    if (!store.getCredentialSummary(id)) throw new AppError(404, 'Cookie 凭据不存在');
    if (store.isCredentialReferenced(id)) throw new AppError(409, '该 Cookie 凭据仍被 Feed 使用');
    store.deleteCredential(id);
    return { ok: true };
  });

  const feedsGuard = (request: FastifyRequest): void => {
    const context = authenticated(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') requireCsrf(request, store, context);
  };

  const feedPayload = (feed: Feed): { feed: Feed; feedUrl: string } => ({ feed, feedUrl: feedUrl(currentConfig(), store, feed.id) });
  app.get('/api/feeds', async (request): Promise<Feed[]> => { feedsGuard(request); return store.listFeeds(); });
  const backupGuard = (request: FastifyRequest, allowSetup = false) => {
    const body = asRecord(request.body);
    if (!limiter.allowed(request.ip)) throw new AppError(429, '验证尝试过于频繁');
    if (!store.hasAdmin() && allowSetup) {
      const expected = Buffer.from(store.getSetupToken() ?? '');
      const actual = Buffer.from(typeof body.setupToken === 'string' ? body.setupToken : '');
      if (!expected.length || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        limiter.registerFailure(request.ip); throw new AppError(403, '一次性设置码无效');
      }
    } else {
      feedsGuard(request);
      if (!store.authenticate(store.getAdmin()!.username, asNonEmptyString(body.currentPassword, '管理员密码', 1024))) {
        limiter.registerFailure(request.ip); throw new AppError(403, '管理员密码无效');
      }
    }
  };
  const security = () => ({ allowedHosts: config.allowedHosts, dnsOverHttps: config.dnsOverHttps ?? false });
  const parseSettings = (value: unknown): ApplicationSettings => {
    const parsed = applicationSettingsSchema.safeParse(value);
    if (!parsed.success) throw new AppError(400, '设置无效，请检查 Bark 地址、服务器地址和数值范围');
    return parsed.data;
  };
  const settingsPreview = (value: ApplicationSettings) => ({ ...value, bark: { ...value.bark, url: undefined, configured: !!value.bark.url } });
  const applySettings = async (next: ApplicationSettings, write: () => void = () => store.setSettings(next)): Promise<void> => {
    const previous = store.getSettings();
    const captureChanged = previous.server.backgroundConcurrency !== next.server.backgroundConcurrency
      || previous.server.dnsOverHttps !== next.server.dnsOverHttps
      || JSON.stringify(previous.server.allowedHosts) !== JSON.stringify(next.server.allowedHosts);
    const nextConfig = { ...config }; applyRuntimeSettings(nextConfig, next);
    const replacement = captureChanged ? await makeBrowserService(nextConfig, options.browserService) : browser;
    const wasMaintenance = maintenance;
    maintenance = true;
    await bark.stop();
    await translations.stop();
    try {
      store.transaction(() => {
        write();
        if (previous.bark.enabled !== next.bark.enabled || previous.bark.url !== next.bark.url) store.history.resetNotifications();
      });
      if (replacement !== browser) { await browser.dispose(); browser = replacement; }
      applyRuntimeSettings(config, next);
      pool.setConcurrency(next.server.backgroundConcurrency);
      jobs.setConcurrency(next.server.backgroundConcurrency);
      store.history.prune();
    } finally { maintenance = wasMaintenance; bark.start(); translations.start(); }
  };
  app.post('/api/backups/export', async request => {
    backupGuard(request);
    const password = asNonEmptyString(asRecord(request.body).password, '备份密码', 1024);
    if (password.length < 12) throw new AppError(400, '备份密码至少 12 个字符');
    return sealBackup(snapshotSchema.parse({ format: 'feedlantern-backup', version: 1, appVersion: config.version, createdAt: new Date().toISOString(), security: security(), tables: store.exportTables() }), password);
  });
  for (const action of ['preview', 'restore'] as const) app.post(`/api/backups/${action}`, { bodyLimit: 100_000_000 }, async request => {
    backupGuard(request, true);
    const body = asRecord(request.body);
    let snapshot;
    try {
      snapshot = openBackup(body.archive, asNonEmptyString(body.password, '备份密码', 1024));
      for (const row of snapshot.tables.feeds) parseFeedInput({ sourceType: row.source_type, translationMode: row.translation_mode, name: row.name, url: row.url, rules: JSON.parse(row.rules_json), ruleOrigins: row.rule_origins_json ? JSON.parse(row.rule_origins_json) : undefined, intervalMinutes: row.interval_minutes, waitMs: row.wait_ms, waitForSelector: row.wait_for_selector });
      for (const row of snapshot.tables.credentials) {
        const metadata = cookieMetadata(parseCookies(JSON.parse(row.encrypted_value), row.format, row.url), row.url);
        row.domains_json = JSON.stringify(metadata.domains); row.cookie_count = metadata.count; row.expires_at = metadata.expiresAt;
      }
      const ids = new Set(snapshot.tables.feeds.map(f => f.id));
      const creds = new Set(snapshot.tables.credentials.map(c => c.id));
      const itemFeeds = new Map(snapshot.tables.feed_items.map(i => [i.id, i.feed_id]));
      if (snapshot.tables.rss_sources.some(s => !ids.has(s.feed_id)) || snapshot.tables.translations.some(t => itemFeeds.get(t.item_id) !== t.feed_id)) throw Error();
      if (snapshot.tables.feed_items.some(i => !ids.has(i.feed_id)) || snapshot.tables.feeds.some(f => f.credential_id && !creds.has(f.credential_id))) throw Error();
    } catch { limiter.registerFailure(request.ip); throw new AppError(400, '备份密码错误、文件损坏或格式不受支持'); }
    if (action === 'preview') return { appVersion: snapshot.appVersion, createdAt: snapshot.createdAt, feeds: snapshot.tables.feeds.length, items: snapshot.tables.feed_items.length, credentials: snapshot.tables.credentials.length, username: snapshot.tables.admin[0].username, sourceSecurity: snapshot.security, targetSecurity: security(), settings: snapshot.tables.settings.some(row => row.key === 'application') ? settingsPreview(parseSettings(JSON.parse(snapshot.tables.settings.find(row => row.key === 'application')!.value))) : null };
    if (body.confirm !== true) throw new AppError(400, '请先预览并确认覆盖恢复');
    maintenance = true; jobs.stop();
    try {
      await pool.drain();
      await bark.stop();
      await translations.stop();
      await browser.closeEditors?.();
      store.restoreTables(snapshot.tables);
      const restoredSettings = store.getSettings();
      const nextConfig = { ...config }; applyRuntimeSettings(nextConfig, restoredSettings);
      const replacement = await makeBrowserService(nextConfig, options.browserService);
      if (replacement !== browser) { await browser.dispose(); browser = replacement; }
      applyRuntimeSettings(config, restoredSettings);
      pool.setConcurrency(restoredSettings.server.backgroundConcurrency);
      jobs.setConcurrency(restoredSettings.server.backgroundConcurrency);
      return { ok: true };
    } finally { maintenance = false; jobs.recover(); bark.start(); translations.start(); }
  });
  app.get('/api/backups/config', async request => {
    feedsGuard(request);
    return { format: 'feedlantern-config', version: 2, settings: store.getSettings(), feeds: store.listFeeds().map(f => ({ sourceType: f.sourceType, translationMode: f.translationMode, name: f.name, channelTitle: f.channelTitle, url: f.url, rules: f.rules, ruleOrigins: f.ruleOrigins, intervalMinutes: f.intervalMinutes, waitMs: f.waitMs, waitForSelector: f.waitForSelector, enabled: f.enabled, requiresCredential: !!f.credentialId })) };
  });
  app.post('/api/backups/config', { bodyLimit: 10_000_000 }, async request => {
    feedsGuard(request);
    const body = asRecord(request.body), archive = asRecord(body.archive);
    if (archive.format !== 'feedlantern-config' || ![1, 2].includes(Number(archive.version)) || !Array.isArray(archive.feeds) || archive.feeds.length > 10000) throw new AppError(400, '配置格式无效');
    if (archive.version === 2 && archive.settings === undefined) throw new AppError(400, '配置文件缺少应用设置');
    const importedSettings = archive.settings === undefined ? undefined : parseSettings(archive.settings);
    const entries = archive.feeds.map(raw => {
      const value = asRecord(raw);
      return { input: parseFeedInput({ ...value, credentialId: null }), title: asOptionalString(value.channelTitle, '频道名称', 200), enabled: value.enabled !== false, needsCookie: value.requiresCredential === true };
    });
    const signature = (f: FeedInput) => JSON.stringify([f.sourceType ?? 'website', f.translationMode ?? 'bilingual', normalizeSource(f.url), ...['item', 'title', 'link', 'description', 'image', 'date'].map(k => f.rules[k as keyof SelectionRules] ?? '')]);
    if (body.confirm !== true) {
      const seen = new Set(store.listFeeds().map(signature));
      return { settings: importedSettings ? settingsPreview(importedSettings) : null, entries: entries.map(e => { const duplicate = seen.has(signature(e.input)); seen.add(signature(e.input)); return { name: e.input.name, url: e.input.url, duplicate, needsCookie: e.needsCookie }; }) };
    }
    return enqueueRefresh(async () => {
      let result = { created: 0, skipped: 0 };
      const write = () => store.transaction(() => {
      const seen = new Set(store.listFeeds().map(signature));
      let created = 0, skipped = 0;
      for (const entry of entries) {
        const key = signature(entry.input);
        if (seen.has(key)) { skipped++; continue; }
        const { feed } = store.createFeed(entry.input);
        if (entry.title) store.setChannelTitle(feed.id, entry.title);
        if (!entry.enabled || entry.needsCookie) store.toggleFeed(feed.id);
        if (entry.needsCookie) store.markFetchFailure(feed.id, '请绑定 Cookie 凭据后恢复订阅', feed.nextFetchAt);
        seen.add(key); created++;
      }
      if (importedSettings) store.setSettings(importedSettings);
      result = { created, skipped };
      });
      if (importedSettings) await applySettings(importedSettings, write); else write();
      return result;
    });
  });
  app.get('/api/import-jobs', async request => { feedsGuard(request); return store.listImportJobs(); });
  app.post('/api/import-jobs', async request => {
    feedsGuard(request);
    const body = asRecord(request.body);
    if (body.sourceType !== undefined && !['website', 'rss'].includes(String(body.sourceType))) throw new AppError(400, '订阅类型无效');
    if (body.translationMode !== undefined && !['chinese', 'bilingual'].includes(String(body.translationMode))) throw new AppError(400, '翻译输出模式无效');
    const sourceType = body.sourceType === 'rss' ? 'rss' as const : 'website' as const;
    const translationMode = body.translationMode === 'chinese' ? 'chinese' as const : 'bilingual' as const;
    if (!Array.isArray(body.entries) || !body.entries.length || body.entries.length > 100) throw new AppError(400, '每批支持 1–100 个网址');
    const entries = body.entries.map(raw => {
      const entry = asRecord(raw);
      const url = normalizeSource(parseHttpUrl(entry.url, '网址'));
      const credentialId = entry.credentialId ? asNonEmptyString(entry.credentialId, 'credentialId', 200) : null;
      if (sourceType === 'rss' && credentialId) throw new AppError(400, 'RSS 翻译不支持 Cookie 凭据');
      if (credentialId) {
        const credential = store.getCredentialValue(credentialId);
        if (!credential) throw new AppError(400, 'Cookie 凭据不存在');
        cookiesForTarget(credential, url);
      }
      return { url, credentialId, sourceType, translationMode, intervalMinutes: asInteger(body.intervalMinutes, '刷新间隔', 5, 1440, 60) };
    });
    return jobs.create(entries);
  });
  app.post('/api/import-jobs/:id/:action', async request => {
    feedsGuard(request);
    const { id, action } = request.params as { id: string; action: string };
    const body = asRecord(request.body);
    if (action === 'confirm') {
      const feed = await jobs.confirm(id, asNonEmptyString(body.entryId, 'entryId', 200), parseFeedInput(body.input));
      if (!feed) throw new AppError(404, '订阅已删除');
      return feedPayload(feed);
    }
    if (action !== 'cancel' && action !== 'retry') throw new AppError(400, '任务操作无效');
    return jobs.update(id, action, asOptionalString(body.entryId, 'entryId', 200));
  });
  app.post('/api/settings/bark/test', async request => {
    feedsGuard(request);
    const input = asRecord(request.body);
    const settings = parseSettings({ ...store.getSettings(), bark: { ...store.getSettings().bark, ...input, enabled: false } });
    if (!settings.bark.url) throw new AppError(400, '请先填写 Bark 推送地址');
    try {
      await (options.barkSender ?? sendBark)(settings.bark.url, '这是一条 FeedLantern 测试通知，Bark 推送连接正常。', AbortSignal.timeout(settings.bark.timeoutSeconds * 1000), '订阅灯：测试通知');
      return { ok: true };
    } catch { throw new AppError(502, '测试通知发送失败，请检查 Bark 地址和网络'); }
  });
  app.get('/api/settings', async request => { feedsGuard(request); return store.getSettings(); });
  app.put('/api/settings', async request => {
    feedsGuard(request);
    const body = asRecord(request.body);
    if (!Object.keys(body).length || body.bark !== undefined && (typeof body.bark !== 'object' || body.bark === null || Array.isArray(body.bark))
      || body.translation !== undefined && (typeof body.translation !== 'object' || body.translation === null || Array.isArray(body.translation))
      || body.server !== undefined && (typeof body.server !== 'object' || body.server === null || Array.isArray(body.server))) throw new AppError(400, '设置格式无效');
    return enqueueRefresh(async () => {
      const previous = store.getSettings();
      const next = parseSettings({ ...previous, ...body, translation: { ...previous.translation, ...asRecord(body.translation) }, bark: { ...previous.bark, ...asRecord(body.bark) }, server: { ...previous.server, ...asRecord(body.server) } });
      await applySettings(next);
      return store.getSettings();
    });
  });
  app.patch('/api/feeds/:id', async request => {
    feedsGuard(request);
    const body = asRecord(request.body);
    const input: FeedSettingsInput = {};
    if ('translationMode' in body) {
      if (!['original','chinese','bilingual'].includes(String(body.translationMode))) throw new AppError(400, '翻译输出模式无效');
      input.translationMode = body.translationMode as 'original' | 'chinese' | 'bilingual';
    }
    if ('channelTitle' in body) input.channelTitle = asNonEmptyString(body.channelTitle, '订阅名称', 200);
    if ('intervalMinutes' in body) {
      if (typeof body.intervalMinutes !== 'number' || !Number.isInteger(body.intervalMinutes) || body.intervalMinutes < 5 || body.intervalMinutes > 1440) {
        throw new AppError(400, '刷新间隔必须是 5 到 1440 之间的整数');
      }
      input.intervalMinutes = body.intervalMinutes;
    }
    if (!Object.keys(input).length) throw new AppError(400, '请提供订阅名称或刷新间隔');
    return enqueueRefresh(() => {
      const feed = store.updateFeedSettings(String((request.params as { id: string }).id), input);
      if (!feed) throw new AppError(404, 'Feed 不存在');
      translations.wake();
      return feedPayload(feed);
    });
  });
  app.post('/api/feeds/bulk', async request => {
    feedsGuard(request);
    const body = asRecord(request.body);
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 200 || !body.ids.every(id => typeof id === 'string')) throw new AppError(400, '请选择 1–200 个订阅');
    const action = body.action;
    if (!['copy', 'pause', 'resume', 'refresh', 'delete'].includes(String(action))) throw new AppError(400, '操作无效');
    if (action === 'refresh') {
      const results = await Promise.all([...new Set(body.ids as string[])].map(async id => {
        try {
          const feed = await doRefresh(id);
          if (!feed) return { id, ok: false, error: '订阅不存在' };
          return feed.lastError ? { id, ok: false, error: feed.lastError } : { id, ok: true };
        } catch (error) { return { id, ok: false, error: friendlyError(error, '操作失败') }; }
      }));
      return { results };
    }
    const results = [];
    for (const id of new Set(body.ids as string[])) {
      try {
        const result = await enqueueRefresh(async () => {
          const feed = store.getFeed(id);
          if (!feed) throw new AppError(404, '订阅不存在');
          if (action === 'copy') return { id, ok: true, feedUrl: feedUrl(currentConfig(), store, id) };
          if (action === 'delete') { store.deleteFeed(id); bark.wake(); }
          if (action === 'pause' && feed.enabled || action === 'resume' && !feed.enabled) store.toggleFeed(id);
          return { id, ok: true };
        });
        results.push(result);
      } catch (error) { results.push({ id, ok: false, error: friendlyError(error, '操作失败') }); }
    }
    return { results };
  });
  app.post('/api/rss/preview', async request => {
    feedsGuard(request);
    const url = parseHttpUrl(asRecord(request.body).url, 'RSS 地址');
    return enqueueRefresh(async () => {
      try { const result = await getRss(url); return { title: result.title, items: result.items.slice(0, 3).map(item => ({ title: item.title, link: item.link, contentHtml: item.html })) }; }
      catch (error) { throw new AppError(400, safeDiagnostic(friendlyError(error, 'RSS 获取失败'))); }
    }, [siteKey(url)]);
  });
  app.get('/api/feeds/:id/translation/progress', async request => {
    feedsGuard(request);
    const id = String((request.params as { id: string }).id);
    if (!store.getFeed(id) || !translationEnabled(store.getFeed(id)!)) throw new AppError(404, 'RSS 翻译订阅不存在');
    return { ...store.translations.progress(id), worker: translations.status() };
  });
  app.post('/api/feeds/:id/translation/retry', async request => {
    feedsGuard(request);
    const id = String((request.params as { id: string }).id);
    const feed = store.getFeed(id);
    if (!feed || !translationEnabled(feed)) throw new AppError(404, 'RSS 翻译订阅不存在');
    store.translations.retry(id); translations.retry();
    return feedPayload(store.getFeed(id)!);
  });
  app.post('/api/feeds', async (request) => {
    feedsGuard(request);
    const input = parseFeedInput(request.body);
    if (input.credentialId && !store.getCredentialSummary(input.credentialId)) throw new AppError(400, 'Cookie 凭据不存在');
    const created = store.createFeed(input);
    if (input.sourceType === 'rss') {
      void doRefresh(created.feed.id, false, 'create').catch(() => {});
      return feedPayload(created.feed);
    }
    const refreshed = await doRefresh(created.feed.id, false, 'create');
    return feedPayload(refreshed ?? created.feed);
  });
  app.get('/api/feeds/:id/logs', async request => {
    feedsGuard(request);
    const id = String((request.params as { id: string }).id);
    if (!store.getFeed(id)) throw new AppError(404, 'Feed 不存在');
    const query = request.query as Record<string, unknown>;
    const status = query.status;
    if (status !== undefined && !['running', 'success', 'failure', 'interrupted'].includes(String(status))) throw new AppError(400, '日志状态无效');
    const integer = (value: unknown, fallback: number, max: number): number => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new AppError(400, '日志分页参数无效');
      return Number(value);
    };
    const limit = integer(query.limit, 20, 100);
    const cursor = query.cursor === undefined ? undefined : integer(query.cursor, 0, Number.MAX_SAFE_INTEGER);
    return store.history.list(id, status as FetchStatus | undefined, cursor, limit);
  });
  app.get('/api/feeds/:id', async (request) => {
    feedsGuard(request);
    const feed = store.getFeed(String((request.params as { id: string }).id));
    if (!feed) throw new AppError(404, 'Feed 不存在');
    return { ...feedPayload(feed), items: store.getItems(feed.id, 200) };
  });
  app.put('/api/feeds/:id', async (request) => {
    feedsGuard(request);
    const id = String((request.params as { id: string }).id);
    const input = parseFeedInput(request.body);
    if (input.credentialId && !store.getCredentialSummary(input.credentialId)) throw new AppError(400, 'Cookie 凭据不存在');
    return enqueueRefresh(async () => {
      const updated = store.updateFeed(id, input);
      if (!updated) throw new AppError(404, 'Feed 不存在');
      const refreshed = await refreshOnce(id, 'edit');
      return feedPayload(refreshed ?? updated);
    });
  });
  app.post('/api/feeds/:id/refresh', async (request) => {
    feedsGuard(request);
    const refreshed = await doRefresh(String((request.params as { id: string }).id));
    if (!refreshed) throw new AppError(404, 'Feed 不存在');
    return feedPayload(refreshed);
  });
  app.post('/api/feeds/:id/toggle', async (request) => {
    feedsGuard(request);
    return enqueueRefresh(async () => {
      const toggled = store.toggleFeed(String((request.params as { id: string }).id));
      if (!toggled) throw new AppError(404, 'Feed 不存在');
      const refreshed = toggled.enabled ? await refreshOnce(toggled.id, 'resume') : toggled;
      return feedPayload(refreshed ?? toggled);
    });
  });
  app.post('/api/feeds/:id/rotate-token', async (request) => {
    feedsGuard(request);
    const rotated = store.rotateFeedToken(String((request.params as { id: string }).id));
    if (!rotated) throw new AppError(404, 'Feed 不存在');
    return feedPayload(rotated.feed);
  });
  app.delete('/api/feeds/:id', async (request) => {
    feedsGuard(request);
    return enqueueRefresh(() => {
      if (!store.deleteFeed(String((request.params as { id: string }).id))) throw new AppError(404, 'Feed 不存在');
      bark.wake();
      return { ok: true };
    });
  });

  const browserGuard = (request: FastifyRequest): void => {
    const context = authenticated(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') requireCsrf(request, store, context);
  };
  app.post('/api/browser', async (request) => {
    browserGuard(request);
    const body = asRecord(request.body);
    const url = parseHttpUrl(body.url, '目标 URL');
    const waitMs = asInteger(body.waitMs, 'waitMs', 0, 10_000, 1_000);
    const waitForSelector = asOptionalString(body.waitForSelector, 'waitForSelector', 4_000);
    const credentialId = body.credentialId === undefined || body.credentialId === null || body.credentialId === '' ? null : asNonEmptyString(body.credentialId, 'credentialId', 200);
    let cookies: Cookie[] = [];
    if (credentialId) {
      const credential = store.getCredentialValue(credentialId);
      if (!credential || typeof credential.value !== 'string') throw new AppError(400, 'Cookie 凭据不存在或无效');
      cookies = cookiesForTarget(credential, url);
    }
    try { return await browser.open({ url, cookies, waitMs, waitForSelector }); } catch (error) { throw frameError(error); }
  });
  app.get('/api/browser/:id', async (request) => {
    browserGuard(request);
    try { return await browser.snapshot(String((request.params as { id: string }).id)); } catch (error) { throw frameError(error); }
  });
  app.post('/api/browser/:id/scroll', async (request) => {
    browserGuard(request);
    const body = asRecord(request.body);
    const deltaY = Number(body.deltaY);
    let point: { x: number; y: number } | undefined;
    if (body.x !== undefined || body.y !== undefined) {
      if (typeof body.x !== 'number' || typeof body.y !== 'number' || !Number.isFinite(body.x) || !Number.isFinite(body.y)) throw new AppError(400, '滚动坐标无效');
      point = { x: body.x, y: body.y };
    }
    if (!Number.isFinite(deltaY) || Math.abs(deltaY) > 100_000) throw new AppError(400, 'deltaY 无效');
    try { return await browser.scroll(String((request.params as { id: string }).id), deltaY, point); } catch (error) { throw frameError(error); }
  });
  app.post('/api/browser/:id/click', async (request) => {
    browserGuard(request);
    const body = asRecord(request.body);
    const x = Number(body.x); const y = Number(body.y);
    if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x > 100_000 || y > 100_000) throw new AppError(400, '点击坐标无效');
    try { return await browser.click(String((request.params as { id: string }).id), x, y); } catch (error) { throw frameError(error); }
  });
  app.post('/api/browser/:id/pick', async (request) => {
    browserGuard(request);
    const body = asRecord(request.body);
    const target = body.target;
    if (!['item', 'title', 'link', 'description', 'image', 'date'].includes(String(target))) throw new AppError(400, 'pick target 无效');
    const pickRequest: PickRequest = {
      x: Number(body.x), y: Number(body.y), target: target as PickRequest['target'],
      ...(body.itemSelector ? { itemSelector: asNonEmptyString(body.itemSelector, 'itemSelector', 4_000) } : {}),
      ...(body.ancestorLevel !== undefined ? { ancestorLevel: asInteger(body.ancestorLevel, 'ancestorLevel', 0, 20, 0) } : {}),
    };
    if (![pickRequest.x, pickRequest.y].every(Number.isFinite) || pickRequest.x < 0 || pickRequest.y < 0) throw new AppError(400, 'pick 坐标无效');
    try { return await browser.pick(String((request.params as { id: string }).id), pickRequest); } catch (error) { throw frameError(error); }
  });
  app.post('/api/browser/:id/preview', async (request) => {
    browserGuard(request);
    const rules = parseRules(asRecord(request.body).rules);
    try { return { items: await browser.extract(String((request.params as { id: string }).id), rules) }; } catch (error) { throw frameError(error); }
  });
  app.post('/api/browser/:id/detect', async (request) => {
    browserGuard(request);
    if (!browser.detect) throw new AppError(501, '当前浏览器服务不支持自动识别');
    try { return await browser.detect(String((request.params as { id: string }).id)); } catch (error) { throw frameError(error); }
  });
  app.delete('/api/browser/:id', async (request) => {
    browserGuard(request);
    try { await browser.close(String((request.params as { id: string }).id)); } catch (error) { throw frameError(error); }
    return { ok: true };
  });

  app.get('/feeds/:id/:token.xml', async (request, reply) => {
    const params = request.params as { id: string; token: string };
    const token = params.token.endsWith('.xml') ? params.token.slice(0, -4) : params.token;
    if (!store.checkFeedToken(params.id, token)) throw new AppError(404, 'Feed 不存在');
    const feed = store.getFeed(params.id);
    if (!feed) throw new AppError(404, 'Feed 不存在');
    const items = store.getItems(feed.id, 100);
    const publicUrl = `${currentConfig().publicOrigin}/feeds/${encodeURIComponent(feed.id)}/${encodeURIComponent(token)}.xml`;
    const etag = rssEtag(feed, items);
    reply.header('Cache-Control', 'private, max-age=60');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('ETag', etag);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('application/rss+xml; charset=utf-8').send(renderRss(feed, items, publicUrl));
  });

  if (hasDist(config.distDir)) await app.register(fastifyStatic, { root: config.distDir, wildcard: false });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/feeds/')) return reply.code(404).send({ error: '资源不存在' });
    if (request.method === 'GET' && existsSync(resolve(config.distDir, 'index.html'))) return reply.type('text/html; charset=utf-8').send(await readFile(resolve(config.distDir, 'index.html')));
    return reply.type('text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><title>FeedLantern</title><p>FeedLantern 服务已启动，请先构建或启动前端。</p>');
  });


  const cleanup = setInterval(() => {
    try { store.history.prune(); store.translations.prune(); } catch { console.error('抓取日志清理失败，将自动重试'); }
  }, 60 * 60_000);
  cleanup.unref();
  app.addHook('onReady', async () => { jobs.recover(); bark.start(); translations.start(); });
  if (options.startScheduler !== false) {
    scheduler = setInterval(() => { void refreshDue().catch(() => {}); }, 30_000);
    scheduler.unref();
    app.addHook('onReady', async () => { void refreshDue().catch(() => {}); });
  }
  app.addHook('onClose', async () => {
    jobs.stop();
    closing = true;
    if (scheduler) clearInterval(scheduler);
    clearInterval(cleanup);
    await pool.drain();
    await translations.stop();
    await bark.stop();
    await browser.dispose();
    if (!options.store) store.close();
  });
  return app;
}

export { Store } from './store.js';
