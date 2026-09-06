import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { Cookie } from 'playwright';
import type {
  AuthState,
  CredentialSummary,
  DetectionResult,
  ExtractedItem,
  Feed,
  FeedInput,
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
  open(options: { url: string; cookies?: Cookie[]; waitMs: number; waitForSelector?: string }): Promise<ScreenFrame> | ScreenFrame;
  snapshot(id: string): Promise<ScreenFrame> | ScreenFrame;
  scroll(id: string, deltaY: number): Promise<ScreenFrame> | ScreenFrame;
  click(id: string, x: number, y: number): Promise<ScreenFrame> | ScreenFrame;
  pick(id: string, request: PickRequest): Promise<PickResult> | PickResult;
  extract(id: string, rules: SelectionRules): Promise<ExtractedItem[]> | ExtractedItem[];
  scrape(options: { url: string; cookies?: Cookie[]; waitMs: number; waitForSelector?: string; rules: SelectionRules }): Promise<ExtractedItem[]> | ExtractedItem[];
  detect?(id: string): Promise<DetectionResult> | DetectionResult;
  close(id: string): Promise<void> | void;
  dispose(): Promise<void> | void;
}

export interface CreateAppOptions extends ConfigInput {
  config?: ServerConfig;
  store?: Store;
  browserService?: BrowserServiceLike;
  startScheduler?: boolean;
}

interface FeedBody {
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
  const credentialId = record.credentialId === undefined || record.credentialId === null || record.credentialId === '' ? null : asNonEmptyString(record.credentialId, 'credentialId', 200);
  return {
    name: asNonEmptyString(record.name, 'feed name', 200),
    url: parseHttpUrl(record.url, 'feed URL'),
    rules: parseRules(record.rules),
    ruleOrigins: parseRuleOrigins(record.ruleOrigins),
    credentialId,
    intervalMinutes: asInteger(record.intervalMinutes, 'intervalMinutes', 5, 1_440, 60),
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
  const BrowserService = module.BrowserService as new (options: { allowedHosts?: string[]; executablePath?: string }) => BrowserServiceLike;
  return new BrowserService({ allowedHosts: config.allowedHosts, executablePath: config.browserExecutablePath });
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? getConfig(options);
  await ensureDataDir(config.dataDir);
  const store = options.store ?? new Store(config);
  const browser = await makeBrowserService(config, options.browserService);
  const app = Fastify({ logger: false, bodyLimit: 2_500_000 });
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

  const limiter = new LoginRateLimiter();
  let schedulerRunning = false;
  let scheduler: NodeJS.Timeout | undefined;
  let closing = false;
  let refreshQueue: Promise<void> = Promise.resolve();
  const refreshInFlight = new Map<string, Promise<Feed | null>>();

  // BrowserService reserves one background browser. Queue both refreshes and
  // feed mutations so an older capture cannot overwrite an edited/deleted feed.
  const enqueueRefresh = <T,>(operation: () => Promise<T> | T): Promise<T> => {
    if (closing) return Promise.reject(new AppError(503, '服务正在关闭'));
    const result = refreshQueue.then(operation);
    refreshQueue = result.then(() => {}, () => {});
    return result;
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

  const refreshOnce = async (id: string): Promise<Feed | null> => {
    const feed = store.getFeed(id);
    if (!feed) return null;
    const nextFetchAt = new Date(Date.now() + feed.intervalMinutes * 60_000).toISOString();
    store.markFetchStart(feed.id, nextFetchAt);
    try {
      const items = await browser.scrape({ url: feed.url, cookies: credentialsForFeed(feed), waitMs: feed.waitMs, waitForSelector: feed.waitForSelector, rules: feed.rules });
      if (!items.length) throw new Error('没有抽取到有效条目：请检查 selector 或页面是否已完成渲染');
      store.upsertItems(feed, items);
      return store.markFetchSuccess(feed.id, nextFetchAt);
    } catch (error) {
      store.markFetchFailure(feed.id, friendlyError(error, '抓取失败，已保留已有条目'), nextFetchAt);
      return store.getFeed(feed.id);
    }
  };

  const doRefresh = (id: string): Promise<Feed | null> => {
    const active = refreshInFlight.get(id);
    if (active) return active;
    const promise = enqueueRefresh(() => refreshOnce(id)).finally(() => refreshInFlight.delete(id));
    refreshInFlight.set(id, promise);
    return promise;
  };

  const refreshDue = async (): Promise<void> => {
    if (schedulerRunning || closing) return;
    schedulerRunning = true;
    try {
      for (const feed of store.dueFeeds()) {
        if (closing) break;
        if (store.getFeed(feed.id)?.enabled) await doRefresh(feed.id);
      }
    } finally {
      schedulerRunning = false;
    }
  };

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return;
    const requestHost = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
    if (!requestHost || !allowedApiHosts.has(requestHost.toLowerCase())) throw new AppError(403, '请求主机不被允许');
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    if (!isAllowedOrigin(origin, config)) throw new AppError(403, '请求来源不被允许');
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
    setSessionCookie(reply, config, session.id);
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
    setSessionCookie(reply, config, session.id);
    return authState(store, config, { sessionId: session.id, username, expiresAt: session.expiresAt }, session.csrfToken);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const context = authenticated(request);
    requireCsrf(request, store, context);
    store.destroySession(context.sessionId);
    clearSessionCookie(reply, config);
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
    clearSessionCookie(reply, config);
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

  const feedPayload = (feed: Feed): { feed: Feed; feedUrl: string } => ({ feed, feedUrl: feedUrl(config, store, feed.id) });
  app.get('/api/feeds', async (request): Promise<Feed[]> => { feedsGuard(request); return store.listFeeds(); });
  app.get('/api/settings', async request => { feedsGuard(request); return store.getSettings(); });
  app.put('/api/settings', async request => {
    feedsGuard(request);
    const view = asRecord(request.body).feedView;
    if (view !== 'list' && view !== 'cards') throw new AppError(400, '视图必须为 list 或 cards');
    store.setFeedView(view);
    return store.getSettings();
  });
  app.patch('/api/feeds/:id', async request => {
    feedsGuard(request);
    const title = asNonEmptyString(asRecord(request.body).channelTitle, '阅读器中的订阅名称', 200);
    const feed = store.setChannelTitle(String((request.params as { id: string }).id), title);
    if (!feed) throw new AppError(404, 'Feed 不存在');
    return feedPayload(feed);
  });
  app.post('/api/feeds/bulk', async request => {
    feedsGuard(request);
    const body = asRecord(request.body);
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 200 || !body.ids.every(id => typeof id === 'string')) throw new AppError(400, '请选择 1–200 个订阅');
    const action = body.action;
    if (!['copy', 'pause', 'resume', 'refresh', 'delete'].includes(String(action))) throw new AppError(400, '操作无效');
    const results = [];
    for (const id of new Set(body.ids as string[])) {
      try {
        const result = await enqueueRefresh(async () => {
          const feed = store.getFeed(id);
          if (!feed) throw new AppError(404, '订阅不存在');
          if (action === 'copy') return { id, ok: true, feedUrl: feedUrl(config, store, id) };
          if (action === 'delete') store.deleteFeed(id);
          if (action === 'pause' && feed.enabled || action === 'resume' && !feed.enabled) store.toggleFeed(id);
          if (action === 'refresh') {
            const refreshed = await refreshOnce(id);
            if (refreshed?.lastError) return { id, ok: false, error: refreshed.lastError };
          }
          return { id, ok: true };
        });
        results.push(result);
      } catch (error) { results.push({ id, ok: false, error: friendlyError(error, '操作失败') }); }
    }
    return { results };
  });
  app.post('/api/feeds', async (request) => {
    feedsGuard(request);
    const input = parseFeedInput(request.body);
    if (input.credentialId && !store.getCredentialSummary(input.credentialId)) throw new AppError(400, 'Cookie 凭据不存在');
    const created = store.createFeed(input);
    const refreshed = await doRefresh(created.feed.id);
    return feedPayload(refreshed ?? created.feed);
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
      const refreshed = await refreshOnce(id);
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
      const refreshed = toggled.enabled ? await refreshOnce(toggled.id) : toggled;
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
    const deltaY = Number(asRecord(request.body).deltaY);
    if (!Number.isFinite(deltaY) || Math.abs(deltaY) > 100_000) throw new AppError(400, 'deltaY 无效');
    try { return await browser.scroll(String((request.params as { id: string }).id), deltaY); } catch (error) { throw frameError(error); }
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
    const publicUrl = `${config.publicOrigin}/feeds/${encodeURIComponent(feed.id)}/${encodeURIComponent(token)}.xml`;
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


  if (options.startScheduler !== false) {
    scheduler = setInterval(() => { void refreshDue().catch(() => {}); }, 30_000);
    scheduler.unref();
    app.addHook('onReady', async () => { void refreshDue().catch(() => {}); });
  }
  app.addHook('onClose', async () => {
    closing = true;
    if (scheduler) clearInterval(scheduler);
    await refreshQueue;
    await browser.dispose();
    if (!options.store) store.close();
  });
  return app;
}

export { Store } from './store.js';
