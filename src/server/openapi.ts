import { API_TOKEN_MAX_DAYS, tokenAllowedRoute } from './api-tokens.js';
import { API_ERROR_CODES, BUNDLE_ITEM_LIMIT, BUNDLE_MAX_FEEDS } from '../shared/types.js';
import { NETWORK_LIMITS } from '../shared/network-rules.js';
import { locales } from '../shared/i18n.js';

/**
 * Hand-written OpenAPI 3.1 description of `/api/*`. tests/openapi.test.ts fails
 * when a route is added to the server without an entry here (or the reverse),
 * so add the operation below whenever you add a route.
 */
type Schema = Record<string, unknown>;
/** public: no login; session: browser session only; auto: a token works too (read scope for GET, write otherwise). */
type Access = 'public' | 'session' | 'auto';
interface Operation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Fastify route syntax, e.g. `/api/feeds/:id`. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  access?: Access;
  admin?: boolean;
  /** Acts on the X-FeedLantern-User workspace (an admin may target another account). */
  workspace?: boolean;
  query?: Array<{ name: string; schema: Schema; description?: string }>;
  params?: Record<string, Schema>;
  body?: Schema;
  response?: Schema;
  bodyLimit?: string;
}

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const array = (items: Schema, extra: Schema = {}): Schema => ({ type: 'array', items, ...extra });
const str = (extra: Schema = {}): Schema => ({ type: 'string', ...extra });
const int = (extra: Schema = {}): Schema => ({ type: 'integer', ...extra });
const bool: Schema = { type: 'boolean' };
const dateTime: Schema = { type: 'string', format: 'date-time' };
const nullable = (schema: Schema): Schema => ({ oneOf: [schema, { type: 'null' }] });
const object = (properties: Record<string, Schema>, required: string[] = [], extra: Schema = {}): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}), ...extra });
const ok = ref('Ok');
const translationMode = str({ enum: ['original', 'translated', 'bilingual'], description: 'translated publishes only the translation (the old name chinese is still accepted)' });
const targetLanguage = str({ enum: ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'], default: 'zh-CN', description: 'Translation target language' });
const translationProvider = nullable(str({ enum: ['google', 'deepl', 'openai'], description: 'Translation service; null follows the instance default' }));
const providerId = str({ enum: ['google', 'deepl', 'openai'] });
const networkProfileId = nullable(str({ description: 'Network profile ID; null means the default network (direct, no extra headers)' }));

const schemas: Record<string, Schema> = {
  Error: object({
    code: str({ enum: [...API_ERROR_CODES], description: 'Stable, machine-readable error code; scripts should branch on it. token_read_only: a read token tried to write; token_not_allowed: a token called an endpoint reserved for browser sessions; source_not_feed: the source returned a web page (often a bot check) or an unusual status instead of RSS/Atom; the rest follow the HTTP status' }),
    message: str({ description: 'Error message for people, in the reader\'s language; may change between versions' }),
    error: str({ description: 'Same as message (kept for older clients)' }),
    messageKey: str({ description: 'Message catalog key of the text, e.g. error.feedNotFound; with params, lets a client show the message in its own language', examples: ['error.feedNotFound'] }),
    params: { type: 'object', description: 'Values filled into the message, when it has any' },
  }, ['code', 'message', 'error']),
  Ok: object({ ok: { const: true } }, ['ok']),
  AuthState: object({
    setupRequired: bool, authenticated: bool, version: str(), userId: str(), username: str(), role: str({ enum: ['admin', 'user'] }),
    locale: nullable(str({ enum: [...locales], description: 'Interface language chosen by the account; null follows the browser' })),
    defaultLocale: str({ enum: [...locales], description: 'The instance\'s fallback language (DEFAULT_LOCALE)' }),
    csrfToken: str({ description: 'Only for browser sessions; cookie-session writes must send it in the X-CSRF-Token header' }),
    tokenScope: str({ enum: ['read', 'write'], description: 'The token\'s scope, when called with an access token' }),
  }, ['setupRequired', 'authenticated', 'version']),
  ApiToken: object({
    id: str(), name: str(), scope: str({ enum: ['read', 'write'] }), prefix: str({ description: 'First characters of the token, to recognize it', examples: ['fl_Ab12Cd34'] }),
    createdAt: dateTime, expiresAt: nullable(dateTime), lastUsedAt: nullable(dateTime),
    usage24h: object({ calls: int(), failures: int({ description: 'Calls with status ≥ 400' }) }, ['calls', 'failures'], { description: 'Calls in the last 24 hours (returned by the list endpoint)' }),
  }, ['id', 'name', 'scope', 'prefix', 'createdAt', 'expiresAt', 'lastUsedAt']),
  ApiTokenCall: object({
    id: int(), tokenId: str(), tokenName: str(), tokenPrefix: str({ description: 'First characters of the token; the full token is never logged' }), at: dateTime,
    method: str(), route: nullable(str({ description: 'Route template such as /api/feeds/:id; the raw path and query are never logged. null when no endpoint matched', examples: ['/api/feeds/:id'] })),
    status: int({ description: 'HTTP status code' }), durationMs: int(), ip: nullable(str({ description: 'Client IP, following TRUSTED_PROXIES' })),
  }, ['id', 'tokenId', 'tokenName', 'tokenPrefix', 'at', 'method', 'route', 'status', 'durationMs', 'ip']),
  ApiTokenCallPage: object({
    calls: array(ref('ApiTokenCall')), nextCursor: nullable(str()), retentionDays: int({ description: 'Retention in days, shared with fetch logs' }), perTokenLimit: int({ description: 'Most records kept per token' }),
  }, ['calls', 'nextCursor', 'retentionDays', 'perTokenLimit']),
  ApiTokenInput: object({
    name: str({ minLength: 1, maxLength: 100 }),
    scope: str({ enum: ['read', 'write'], description: 'read can only call GET; write can call every endpoint open to tokens' }),
    expiresInDays: nullable(int({ minimum: 1, maximum: API_TOKEN_MAX_DAYS, description: 'Omitted or null means the token never expires' })),
  }, ['name', 'scope']),
  ApiTokenCreated: object({ token: ref('ApiToken'), secret: str({ description: 'The full token, returned only this once', pattern: '^fl_[A-Za-z0-9_-]{43}$' }) }, ['token', 'secret']),
  UserSummary: object({
    id: str(), username: str(), role: str({ enum: ['admin', 'user'] }), enabled: bool, createdAt: dateTime, updatedAt: dateTime,
    stats: object({ feeds: int(), failingFeeds: int(), pausedFeeds: int(), credentials: int(), lastSeenAt: nullable(dateTime) }),
  }, ['id', 'username', 'role', 'enabled', 'createdAt', 'updatedAt']),
  SelectionRules: object({ item: str(), title: str(), link: str(), description: str(), image: str(), date: str() }, ['item', 'title', 'link'], { description: 'CSS selectors; title, link and the rest are relative to item' }),
  FeedInput: object({
    sourceType: str({ enum: ['website', 'rss'], default: 'website' }), translationMode, targetLanguage, translationProvider,
    name: str({ minLength: 1 }), url: str({ format: 'uri' }), rules: ref('SelectionRules'),
    ruleOrigins: { type: 'object', additionalProperties: str({ enum: ['auto', 'manual'] }) },
    credentialId: nullable(str()), intervalMinutes: int({ minimum: 5, maximum: 1440 }), waitMs: int({ minimum: 0, maximum: 10000 }), waitForSelector: str(),
    pagination: nullable(ref('PaginationRules')),
    networkProfileId: { ...networkProfileId, description: 'Network profile ID (proxy, User-Agent, Referer, extra headers). Omitted on update keeps it; null switches back to the default network' },
  }, ['name', 'url', 'rules', 'credentialId', 'intervalMinutes', 'waitMs']),
  PaginationRules: object({
    mode: str({ enum: ['next', 'template', 'loadMore'], description: 'next: click a “Next page” link or button; template: put page numbers into a URL template; loadMore: click a “Load more” button' }),
    maxPages: int({ minimum: 1, maximum: 10, default: 3, description: 'Includes page 1 (the source URL)' }), delayMs: int({ minimum: 2000, maximum: 30000, default: 3000, description: 'Pause between pages, plus up to 20% random jitter' }),
    nextSelector: str({ description: 'Required for next / loadMore' }), urlTemplate: str({ description: 'Required for template; must contain {n}' }), start: int({ minimum: 0, default: 2, description: 'The {n} used for page 2' }), step: int({ minimum: 1, default: 1 }),
  }, ['mode'], { description: 'Multi-page collection. Omitted in FeedInput keeps the saved setting; null fetches only the source page' }),
  PaginationReport: object({
    pages: array(object({ page: int(), url: str(), count: int(), added: int(), error: str() }, ['page', 'url', 'count', 'added'])),
    stoppedAt: int(), stop: str({ enum: ['single', 'max', 'end', 'repeat', 'known', 'empty', 'failed', 'blocked', 'budget', 'limit'] }), message: str({ description: 'Where and why collection stopped' }),
  }, ['pages', 'stoppedAt', 'stop', 'message']),
  ItemFilter: object({ include: array(str({ maxLength: 200 }), { maxItems: 30 }), exclude: array(str({ maxLength: 200 }), { maxItems: 30 }), regex: bool }, ['include', 'exclude', 'regex'], { description: 'Item filter: exclusion wins, and a non-empty include list must match; only affects the output' }),
  FeedSettingsInput: object({ translationMode, targetLanguage, translationProvider, channelTitle: str({ minLength: 1, maxLength: 200 }), intervalMinutes: int({ minimum: 5, maximum: 1440 }), itemFilter: nullable(ref('ItemFilter')), outputLimit: int({ minimum: 10, maximum: 500 }), retentionLimit: nullable(int({ minimum: 10, maximum: 1000, description: 'Items kept in the database, at least the output limit; null is automatic (200 for web pages, 100 for RSS)' })), networkProfileId }, [], { description: 'Provide at least one field; itemFilter null removes the filter; networkProfileId null switches back to the default network' }),
  OutputStatus: object({ outputStatus: { type: 'object', additionalProperties: str({ enum: ['published', 'untranslated', 'excluded', 'not-included', 'over-limit'] }), description: 'Item ID → whether it is published, and why not' }, filterTimedOut: bool }, ['outputStatus']),
  NotificationSummary: { type: 'object', description: 'Alert policy (threshold, timeout, retries, cooldown, ruleHealthAlerts) and the state of each channel; never returns secrets', properties: { channels: { type: 'object' } } },
  NotificationUpdate: { type: 'object', description: 'Partial update: omitted fields keep their value, an empty string clears a secret; headers are replaced as a whole', properties: { channels: { type: 'object', properties: { bark: { type: 'object' }, webhook: { type: 'object' }, ntfy: { type: 'object' }, telegram: { type: 'object' } } } } },
  Feed: { allOf: [ref('FeedInput'), object({
    id: str(), ownerId: str(), channelTitle: str(), enabled: bool, createdAt: dateTime, lastFetchedAt: nullable(dateTime), lastSuccessAt: nullable(dateTime),
    nextFetchAt: dateTime, lastError: nullable(str()), itemCount: int(), itemFilter: ref('ItemFilter'), outputLimit: int({ minimum: 10, maximum: 500, default: 100 }), retentionLimit: nullable(int({ minimum: 10, maximum: 1000 })), translation: object({ pending: int(), success: int(), failed: int() }),
    ruleHealth: ref('RuleHealthWarning'),
  }, ['id', 'enabled', 'createdAt', 'lastFetchedAt', 'lastSuccessAt', 'nextFetchAt', 'lastError', 'itemCount'])] },
  FeedItem: object({
    id: str(), title: str(), link: str(), description: str(), image: str(), publishedAt: dateTime, publishedAtSource: str({ enum: ['absolute', 'relative'] }),
    firstSeenAt: dateTime, contentHtml: str(), translationStatus: str({ enum: ['pending', 'success', 'failed'] }), translationError: str(),
    translatedTitle: str({ description: 'When translated: the translated title' }), sourceTitle: str({ description: 'When translated: the original title' }),
  }, ['title', 'link']),
  RuleHealthWarning: object({
    detectedAt: dateTime, checkedAt: dateTime, itemCount: int(), baselineSamples: int({ description: 'Recent healthy fetches compared' }),
    reasons: array(object({
      code: str({ enum: ['item-count', 'field-rate', 'duplicate-links', 'same-link'] }), field: str({ enum: ['title', 'link', 'date', 'image', 'description'] }),
      baseline: { type: 'number' }, current: { type: 'number' }, message: str({ description: 'Explanation for the user, in the feed owner\'s language' }),
    }, ['code', 'baseline', 'current', 'message'])),
  }, ['detectedAt', 'checkedAt', 'itemCount', 'baselineSamples', 'reasons'], { description: 'Only present when the rules may have stopped working; the fetch itself still counts as successful' }),
  RulePreview: object({ count: int(), items: array(ref('ExtractedItem'), { maxItems: 5 }), error: str({ description: 'Why nothing was extracted' }) }, ['count', 'items']),
  RuleRedetectResult: object({ current: ref('RulePreview'), detection: ref('DetectionResult') }, ['current', 'detection']),
  FeedPayload: object({ feed: ref('Feed'), feedUrl: str({ format: 'uri', description: 'RSS address including its secret key' }) }, ['feed', 'feedUrl']),
  Bundle: object({
    id: str(), name: str(), feedIds: array(str(), { description: 'Member feed IDs, in the order added' }),
    itemLimit: int({ minimum: BUNDLE_ITEM_LIMIT.min, maximum: BUNDLE_ITEM_LIMIT.max }), createdAt: dateTime, updatedAt: dateTime,
  }, ['id', 'name', 'feedIds', 'itemLimit', 'createdAt', 'updatedAt']),
  BundleInput: object({
    name: str({ minLength: 1, maxLength: 200 }),
    feedIds: array(str(), { maxItems: BUNDLE_MAX_FEEDS, description: 'Feeds of the same account only; duplicates are removed' }),
    itemLimit: int({ minimum: BUNDLE_ITEM_LIMIT.min, maximum: BUNDLE_ITEM_LIMIT.max, default: BUNDLE_ITEM_LIMIT.default }),
  }, ['name', 'feedIds']),
  BundlePayload: object({ bundle: ref('Bundle'), bundleUrl: str({ format: 'uri', description: 'Bundle RSS address including its secret key; replace .xml with .atom or .json for Atom / JSON Feed' }) }, ['bundle', 'bundleUrl']),
  FeedDetail: { allOf: [ref('FeedPayload'), ref('OutputStatus'), object({ items: array(ref('FeedItem')) }, ['items'])] },
  FetchLogPage: object({ logs: array({ type: 'object' }), nextCursor: nullable(str()), retentionDays: int() }, ['logs', 'nextCursor', 'retentionDays']),
  NetworkProfileInput: object({
    name: str({ minLength: 1, maxLength: NETWORK_LIMITS.name }),
    proxyUrl: nullable(str({ description: 'http://, https:// or socks5:// plus host and port; null or empty means no proxy. Proxy addresses are subject to the private-network block; an administrator must add them to allowedHosts to point inside the network', examples: ['socks5://proxy.example.com:1080'] })),
    proxyUsername: nullable(str({ maxLength: NETWORK_LIMITS.proxyUser, description: 'Omitted on update keeps the saved credentials; null removes them. Required again when the proxy address changes' })),
    proxyPassword: nullable(str({ maxLength: NETWORK_LIMITS.proxyUser })),
    userAgent: nullable(str({ maxLength: NETWORK_LIMITS.userAgent })),
    referer: nullable(str({ format: 'uri', maxLength: NETWORK_LIMITS.referer })),
    headers: array(object({ name: str({ maxLength: NETWORK_LIMITS.headerName }), value: str({ maxLength: NETWORK_LIMITS.headerValue, description: 'Omitted on update keeps the saved value' }) }, ['name']), { maxItems: NETWORK_LIMITS.headers, description: 'Sent only to the feed\'s site and its subdomains. Host, Cookie, Cookie2, Set-Cookie, Connection, Keep-Alive, Transfer-Encoding, TE, Trailer, Upgrade, Content-Length, Content-Encoding, Expect, HTTP2-Settings, Accept-Encoding, User-Agent, Referer and headers starting with Proxy-, Sec- or X-FeedLantern are not allowed' }),
  }, ['name'], { description: 'Set at least a proxy, User-Agent, Referer or one header' }),
  NetworkProfileSummary: object({
    id: str(), name: str(),
    proxy: nullable(object({ type: str({ enum: ['http', 'https', 'socks5'] }), host: str(), port: int(), url: str(), authenticated: bool }, ['type', 'host', 'port', 'url', 'authenticated'])),
    userAgent: nullable(str()), referer: nullable(str()), headerNames: array(str()), feedCount: int(), updatedAt: dateTime,
  }, ['id', 'name', 'proxy', 'userAgent', 'referer', 'headerNames', 'feedCount', 'updatedAt'], { description: 'Without the proxy username, password or header values' }),
  CredentialInput: object({ name: str({ minLength: 1 }), url: str({ format: 'uri' }), format: str({ enum: ['header', 'json'] }), value: { description: 'Cookie header text or cookie JSON' } }, ['name', 'url', 'format', 'value']),
  CredentialSummary: object({ id: str(), name: str(), url: str(), format: str({ enum: ['header', 'json'] }), domains: array(str()), count: int(), updatedAt: dateTime, expiresAt: nullable(dateTime) }, ['id', 'name', 'url', 'format', 'domains', 'count', 'updatedAt', 'expiresAt']),
  BarkSettings: object({
    enabled: bool, url: str(), failureThreshold: int(), timeoutSeconds: int(), maxAttempts: int(), retryDelaySeconds: int(), laterRetryDelaySeconds: int(), cooldownMinutes: int(),
    ruleHealthAlerts: { ...bool, description: 'Notify when rules may have stopped working; default true' },
  }),
  BarkSummary: object({
    enabled: bool, configured: bool, maskedUrl: str(), failureThreshold: int(), timeoutSeconds: int(), maxAttempts: int(), retryDelaySeconds: int(), laterRetryDelaySeconds: int(), cooldownMinutes: int(),
    ruleHealthAlerts: bool,
  }),
  ApplicationSettings: object({
    translation: object({
      concurrency: int({ description: 'Concurrency of the Google channel' }), requestIntervalMs: int({ description: 'Minimum time between Google requests' }), defaultProvider: providerId,
      deepl: object({ apiKey: str({ description: 'Write-only: always an empty string in responses; omitted or empty on update keeps the saved key, null removes it' }), apiKeyConfigured: bool, plan: str({ enum: ['auto', 'free', 'pro'] }), concurrency: int(), requestIntervalMs: int() }),
      openai: object({ baseUrl: str({ description: 'Requests go to baseUrl/chat/completions' }), model: str(), apiKey: str({ description: 'Write-only, like deepl.apiKey' }), apiKeyConfigured: bool, systemPrompt: str({ maxLength: 4000 }), concurrency: int(), requestIntervalMs: int() }),
    }),
    ncbi: object({
      apiKey: str({ description: 'NCBI API key (optional, used by PubMed journal feeds). Write-only, like deepl.apiKey' }), apiKeyConfigured: bool,
      email: str({ description: 'Contact email sent with E-utilities requests; empty sends none' }),
    }),
    feedView: str({ enum: ['list', 'cards'] }), logRetentionDays: int(),
    bark: ref('BarkSettings'), server: { type: 'object', description: 'Server settings such as background concurrency, the target allowlist, proxies and sessions' },
  }),
  ImportJob: object({ id: str(), createdAt: dateTime, ownerId: str(), actorId: str(), entries: array({ type: 'object', description: 'Detection state, result and error of each URL' }) }, ['id', 'createdAt', 'entries']),
  ExtractedItem: object({ title: str(), link: str(), description: str(), image: str(), publishedAt: str(), contentHtml: str() }, ['title', 'link']),
  ElementMap: object({ boxes: array({ type: 'number' }), labels: array(str()), links: { type: 'object', additionalProperties: str() }, truncated: bool, innerScroll: bool }),
  ScreenFrame: object({
    sessionId: str(), image: str({ description: 'JPEG data URL' }), width: int(), height: int(), viewportHeight: int(), documentHeight: int(),
    url: str(), title: str(), map: ref('ElementMap'), truncated: bool,
  }, ['sessionId', 'image', 'width', 'height', 'url', 'title']),
  SegmentResult: object({ top: int(), height: int(), image: str(), documentHeight: int(), map: ref('ElementMap'), truncated: bool }, ['top', 'height', 'image', 'documentHeight', 'map']),
  PickRequest: object({
    target: str({ enum: ['item', 'title', 'link', 'description', 'image', 'date', 'next'], description: 'next: pick the “Next page” or “Load more” control; rules are not previewed' }), node: int(), x: { type: 'number' }, y: { type: 'number' },
    exact: bool, itemSelector: str(), ancestorLevel: int(), rules: { type: 'object' },
  }, ['target']),
  PickResult: object({ selector: str(), rects: array({ type: 'object' }), count: int(), sampleText: str(), warning: str(), node: int(), items: array(ref('ExtractedItem')), previewError: str() }, ['selector', 'rects', 'count', 'sampleText']),
  DetectionResult: object({ candidates: array({ type: 'object' }), recommendedId: nullable(str()), warnings: array(str()) }, ['candidates', 'recommendedId', 'warnings']),
  EncryptedBackup: object({ format: { const: 'feedlantern-encrypted' }, version: { const: 1 }, salt: str(), iv: str(), tag: str(), data: str() }),
  BulkResult: object({ results: array(object({ id: str(), ok: bool, feedUrl: str(), error: str() }, ['id', 'ok'])) }, ['results']),
};

const operations: Operation[] = [
  // Auth
  { method: 'GET', path: '/api/auth/status', tag: 'auth', summary: 'Sign-in status', description: 'Public. With a token, returns the token\'s account and tokenScope, so it can be used to check a token.', access: 'public', response: ref('AuthState') },
  { method: 'POST', path: '/api/auth/setup', tag: 'auth', summary: 'Set up the first administrator', access: 'public', body: object({ setupToken: str(), username: str(), password: str({ minLength: 8 }) }, ['setupToken', 'username', 'password']), response: ref('AuthState') },
  { method: 'POST', path: '/api/auth/login', tag: 'auth', summary: 'Sign in', access: 'public', body: object({ username: str(), password: str() }, ['username', 'password']), response: ref('AuthState') },
  { method: 'POST', path: '/api/auth/logout', tag: 'auth', summary: 'Sign out', response: ref('AuthState') },
  { method: 'POST', path: '/api/auth/password', tag: 'auth', summary: 'Change your own password', description: 'Signs out every session and revokes every access token of this account.', body: object({ currentPassword: str(), newPassword: str({ minLength: 8 }) }, ['currentPassword', 'newPassword']), response: ref('AuthState') },
  { method: 'PUT', path: '/api/auth/locale', tag: 'auth', summary: 'Set your interface language', description: 'Saved per account, so every device shows the same language. null follows the browser again.', body: object({ locale: nullable(str({ enum: [...locales] })) }, ['locale']), response: ref('AuthState') },
  { method: 'GET', path: '/api/openapi.json', tag: 'meta', summary: 'This OpenAPI document', access: 'public', response: { type: 'object' } },
  // Tokens
  { method: 'GET', path: '/api/tokens', tag: 'tokens', summary: 'List access tokens', description: 'Administrators can view another user\'s tokens (read-only) with X-FeedLantern-User.', workspace: true, response: array(ref('ApiToken')) },
  { method: 'GET', path: '/api/tokens/:id/logs', tag: 'tokens', summary: 'Token call log', workspace: true,
    description: 'Only /api/* requests with a Bearer token are logged (including writes and 401/403/429); browser cookie sessions are not. Each record has the time, token name and prefix, method, route template, status, duration and client IP — never the token secret or query parameters. Records follow the log retention days, up to 2000 per token and 20000 per instance.',
    query: [
      { name: 'status', schema: str({ enum: ['success', 'denied', 'error'] }), description: 'success: status < 400; denied: 401, 403, 429; error: any other ≥ 400' },
      { name: 'cursor', schema: str(), description: 'nextCursor of the previous page' },
      { name: 'limit', schema: int({ minimum: 1, maximum: 100, default: 20 }) },
    ], response: ref('ApiTokenCallPage') },
  { method: 'GET', path: '/api/tokens/current', tag: 'tokens', summary: 'Current access token', description: 'Only callable with an access token (a browser session gets 400): returns the calling token\'s name, scope, expiry and number of calls in the last 24 hours.', response: ref('ApiToken') },
  { method: 'GET', path: '/api/tokens/current/logs', tag: 'tokens', summary: 'Call log of the current access token', description: 'Only callable with an access token (a browser session gets 400); returns only this token\'s own records.', query: [
    { name: 'status', schema: str({ enum: ['success', 'denied', 'error'] }), description: 'success: status < 400; denied: 401, 403, 429; error: any other ≥ 400' },
    { name: 'cursor', schema: str(), description: 'nextCursor of the previous page' },
    { name: 'limit', schema: int({ minimum: 1, maximum: 100, default: 20 }) },
  ], response: ref('ApiTokenCallPage') },
  { method: 'POST', path: '/api/tokens', tag: 'tokens', summary: 'Create an access token', description: 'The full token appears only once, in this response; up to 50 per account. You can only create tokens for yourself.', body: ref('ApiTokenInput'), response: ref('ApiTokenCreated') },
  { method: 'DELETE', path: '/api/tokens/:id', tag: 'tokens', summary: 'Revoke an access token', description: 'You can only revoke your own tokens; their call log is deleted too.', response: ok },
  // Users
  { method: 'GET', path: '/api/users', tag: 'users', summary: 'List users with statistics', admin: true, response: array(ref('UserSummary')) },
  { method: 'POST', path: '/api/users', tag: 'users', summary: 'Create a regular user', admin: true, body: object({ username: str(), password: str({ minLength: 8 }) }, ['username', 'password']), response: ref('UserSummary') },
  { method: 'PATCH', path: '/api/users/:id', tag: 'users', summary: 'Change a user\'s name, status or role', description: 'Disabling a user or changing their identity signs out their sessions and revokes their access tokens.', admin: true, body: object({ username: str(), enabled: bool, role: str({ enum: ['admin', 'user'] }) }), response: ref('UserSummary') },
  { method: 'POST', path: '/api/users/:id/password', tag: 'users', summary: 'Reset another user\'s password', admin: true, body: object({ password: str({ minLength: 8 }) }, ['password']), response: ok },
  { method: 'GET', path: '/api/users/:id/deletion-preview', tag: 'users', summary: 'Preview what deleting a user removes', admin: true, response: object({ user: ref('UserSummary'), feeds: int(), bundles: int(), credentials: int(), jobs: int() }) },
  { method: 'DELETE', path: '/api/users/:id', tag: 'users', summary: 'Delete a user and all their data', admin: true, body: object({ username: str({ description: 'Type the user\'s name to confirm' }) }, ['username']), response: ok },
  // Notifications
  { method: 'GET', path: '/api/notifications/bark', tag: 'notifications', summary: 'Personal Bark notification settings', workspace: true, response: ref('BarkSummary') },
  { method: 'PUT', path: '/api/notifications/bark', tag: 'notifications', summary: 'Save personal Bark notification settings', workspace: true, body: ref('BarkSettings'), response: ref('BarkSummary') },
  { method: 'GET', path: '/api/notifications', tag: 'notifications', summary: 'Notification channels and alert policy', workspace: true, response: ref('NotificationSummary') },
  { method: 'PUT', path: '/api/notifications', tag: 'notifications', summary: 'Save notification channels and alert policy', workspace: true, body: ref('NotificationUpdate'), response: ref('NotificationSummary') },
  { method: 'POST', path: '/api/notifications/test', tag: 'notifications', summary: 'Send a test notification through one channel (nothing is saved)', workspace: true, body: object({ channel: str({ enum: ['bark', 'webhook', 'ntfy', 'telegram'] }) }, ['channel'], { additionalProperties: true }), response: ok },
  { method: 'POST', path: '/api/notifications/bark/test', tag: 'notifications', summary: 'Send a personal test notification', workspace: true, body: ref('BarkSettings'), response: ok },
  // Credentials
  { method: 'GET', path: '/api/network-profiles', tag: 'network-profiles', summary: 'List network profiles (without secrets)', workspace: true, response: array(ref('NetworkProfileSummary')) },
  { method: 'POST', path: '/api/network-profiles', tag: 'network-profiles', summary: 'Add a network profile', description: 'Proxy passwords and header values are stored encrypted and never returned again.', workspace: true, body: ref('NetworkProfileInput'), response: ref('NetworkProfileSummary') },
  { method: 'PUT', path: '/api/network-profiles/:id', tag: 'network-profiles', summary: 'Update a network profile', description: 'Omitted secrets keep their value; changes apply from the next fetch.', workspace: true, body: ref('NetworkProfileInput'), response: ref('NetworkProfileSummary') },
  { method: 'DELETE', path: '/api/network-profiles/:id', tag: 'network-profiles', summary: 'Delete a network profile', description: 'Returns 409 while feeds still use it.', workspace: true, response: ok },
  { method: 'POST', path: '/api/network-profiles/:id/test', tag: 'network-profiles', summary: 'Test a connection with a network profile', description: 'Sends one GET to the URL with this profile (redirects are not followed) and returns the target\'s HTTP status. ok means the target was reached; the test passes only with a 2xx status (such as the 204 of a connectivity check). An unreachable proxy or failed proxy authentication returns 400 with the reason. Makes a network request, so it needs a write token.', workspace: true, body: object({ url: str({ format: 'uri' }) }, ['url']), response: object({ ok: { const: true }, status: int() }, ['ok', 'status']) },
  { method: 'GET', path: '/api/credentials', tag: 'credentials', summary: 'List cookie credentials (without their values)', workspace: true, response: array(ref('CredentialSummary')) },
  { method: 'POST', path: '/api/credentials', tag: 'credentials', summary: 'Add a cookie credential', workspace: true, body: ref('CredentialInput'), response: ref('CredentialSummary') },
  { method: 'PUT', path: '/api/credentials/:id', tag: 'credentials', summary: 'Update a cookie credential', workspace: true, body: ref('CredentialInput'), response: ref('CredentialSummary') },
  { method: 'DELETE', path: '/api/credentials/:id', tag: 'credentials', summary: 'Delete a cookie credential', description: 'Returns 409 while feeds still use it.', workspace: true, response: ok },
  // Feeds
  { method: 'GET', path: '/api/feeds', tag: 'feeds', summary: 'List feeds', workspace: true, response: array(ref('Feed')) },
  { method: 'POST', path: '/api/feeds', tag: 'feeds', summary: 'Create a feed', description: 'Web page feeds are fetched once before the response; RSS feeds are fetched in the background.', workspace: true, body: ref('FeedInput'), response: ref('FeedPayload') },
  { method: 'POST', path: '/api/feeds/bulk', tag: 'feeds', summary: 'Bulk actions', workspace: true, body: object({ ids: array(str(), { minItems: 1, maxItems: 200 }), action: str({ enum: ['copy', 'pause', 'resume', 'refresh', 'delete', 'settings'] }), settings: object({ translationMode, targetLanguage, translationProvider, intervalMinutes: int({ minimum: 5, maximum: 1440 }), itemFilter: nullable(ref('ItemFilter')), outputLimit: int({ minimum: 10, maximum: 500 }), retentionLimit: nullable(int({ minimum: 10, maximum: 1000 })) }) }, ['ids', 'action']), response: ref('BulkResult') },
  { method: 'GET', path: '/api/feeds/:id', tag: 'feeds', summary: 'Feed details and its latest 200 items', workspace: true, response: ref('FeedDetail') },
  { method: 'PUT', path: '/api/feeds/:id', tag: 'feeds', summary: 'Replace a feed\'s URL and rules', description: 'Enabled feeds are fetched again right away.', workspace: true, body: ref('FeedInput'), response: ref('FeedPayload') },
  { method: 'PATCH', path: '/api/feeds/:id', tag: 'feeds', summary: 'Change the name, refresh interval or translation output', workspace: true, body: ref('FeedSettingsInput'), response: ref('FeedPayload') },
  { method: 'DELETE', path: '/api/feeds/:id', tag: 'feeds', summary: 'Delete a feed', workspace: true, response: ok },
  { method: 'POST', path: '/api/feeds/:id/health/redetect', tag: 'feeds', summary: 'Re-detect rules that may have stopped working', description: 'Web page feeds: on the feed\'s page, extracts with the current rules and runs automatic detection, returning both to compare. Rules are not saved; replace them with PUT /api/feeds/:id. Needs a write token.', workspace: true, response: ref('RuleRedetectResult') },
  { method: 'POST', path: '/api/feeds/:id/health/preview', tag: 'feeds', summary: 'Preview a rule set on the feed\'s page', description: 'Doesn\'t change the feed; needs a write token.', workspace: true, body: object({ rules: ref('SelectionRules') }, ['rules']), response: ref('RulePreview') },
  { method: 'POST', path: '/api/feeds/:id/health/ignore', tag: 'feeds', summary: 'Ignore “Rules may have stopped working”', description: 'Clears the warning and makes the latest fetch the new baseline; needs a write token.', workspace: true, response: ref('FeedPayload') },
  { method: 'POST', path: '/api/feeds/:id/refresh', tag: 'feeds', summary: 'Fetch now', workspace: true, response: ref('FeedPayload') },
  { method: 'POST', path: '/api/feeds/:id/toggle', tag: 'feeds', summary: 'Pause or resume', workspace: true, response: ref('FeedPayload') },
  { method: 'POST', path: '/api/feeds/:id/rotate-token', tag: 'feeds', summary: 'Rotate the RSS address key', description: 'The old RSS address stops working at once.', workspace: true, response: ref('FeedPayload') },
  { method: 'GET', path: '/api/feeds/:id/logs', tag: 'feeds', summary: 'Fetch log (paginated)', workspace: true, query: [
    { name: 'status', schema: str({ enum: ['running', 'success', 'failure', 'interrupted'] }) },
    { name: 'cursor', schema: str({ pattern: '^[1-9][0-9]*$' }), description: 'nextCursor of the previous page' },
    { name: 'limit', schema: int({ minimum: 1, maximum: 100, default: 20 }) },
  ], response: ref('FetchLogPage') },
  { method: 'GET', path: '/api/feeds/:id/translation/progress', tag: 'feeds', summary: 'RSS translation progress', workspace: true, response: { type: 'object' } },
  { method: 'GET', path: '/api/translation/providers', tag: 'feeds', summary: 'Available translation services', description: 'Readable by any signed-in user: the instance default service and whether an administrator has configured each service.',
    response: object({ defaultProvider: providerId, providers: array(object({ id: providerId, label: str(), configured: bool }, ['id', 'label', 'configured'])) }, ['defaultProvider', 'providers']) },
  { method: 'POST', path: '/api/feeds/:id/translation/retry', tag: 'feeds', summary: 'Retry failed translations', workspace: true, response: ref('FeedPayload') },
  { method: 'POST', path: '/api/feeds/:id/output-preview', tag: 'feeds', summary: 'Preview the output with an unsaved filter and limit', description: 'Doesn\'t change the feed; it is still a POST, so it needs a write token.', workspace: true, body: object({ itemFilter: nullable(ref('ItemFilter')), outputLimit: int({ minimum: 10, maximum: 500 }) }), response: ref('OutputStatus') },
  { method: 'POST', path: '/api/rss/preview', tag: 'feeds', summary: 'Preview the first 3 items of an RSS source', workspace: true, body: object({ url: str({ format: 'uri' }), networkProfileId }, ['url']), response: object({ title: str(), items: array(ref('ExtractedItem')) }) },
  // Bundles
  { method: 'GET', path: '/api/bundles', tag: 'bundles', summary: 'List bundles', workspace: true, response: array(ref('BundlePayload')) },
  { method: 'POST', path: '/api/bundles', tag: 'bundles', summary: 'Create a bundle', description: 'Combines several feeds of one account into one address. It reads stored items only and never triggers a fetch. Up to 200 per account.', workspace: true, body: ref('BundleInput'), response: ref('BundlePayload') },
  { method: 'GET', path: '/api/bundles/:id', tag: 'bundles', summary: 'Bundle details', workspace: true, response: ref('BundlePayload') },
  { method: 'PUT', path: '/api/bundles/:id', tag: 'bundles', summary: 'Update a bundle', description: 'Changes only the fields given; feedIds replaces the members as a whole.', workspace: true, body: object({ name: str({ minLength: 1, maxLength: 200 }), feedIds: array(str(), { maxItems: BUNDLE_MAX_FEEDS }), itemLimit: int({ minimum: BUNDLE_ITEM_LIMIT.min, maximum: BUNDLE_ITEM_LIMIT.max }) }), response: ref('BundlePayload') },
  { method: 'DELETE', path: '/api/bundles/:id', tag: 'bundles', summary: 'Delete a bundle', description: 'Member feeds are not affected.', workspace: true, response: ok },
  { method: 'POST', path: '/api/bundles/:id/feeds', tag: 'bundles', summary: 'Add feeds to a bundle', description: 'Existing members keep their place; duplicates are ignored.', workspace: true, body: object({ feedIds: array(str(), { maxItems: BUNDLE_MAX_FEEDS }) }, ['feedIds']), response: ref('BundlePayload') },
  { method: 'POST', path: '/api/bundles/:id/rotate-token', tag: 'bundles', summary: 'Rotate the bundle address key', description: 'The old RSS, Atom and JSON Feed bundle addresses stop working at once.', workspace: true, response: ref('BundlePayload') },
  // Import jobs
  { method: 'GET', path: '/api/import-jobs', tag: 'import-jobs', summary: 'List batch imports', workspace: true, response: array(ref('ImportJob')) },
  { method: 'POST', path: '/api/import-jobs', tag: 'import-jobs', summary: 'Create a batch import', workspace: true, body: object({
    entries: array(object({ url: str({ format: 'uri' }), credentialId: nullable(str()), networkProfileId }, ['url']), { minItems: 1, maxItems: 100 }),
    intervalMinutes: int({ minimum: 5, maximum: 1440, default: 60 }), sourceType: str({ enum: ['website', 'rss'] }), translationMode: str({ enum: ['translated', 'bilingual'], description: 'The old name chinese is still accepted' }), targetLanguage, translationProvider,
  }, ['entries']), response: ref('ImportJob') },
  { method: 'POST', path: '/api/import-jobs/:id/:action', tag: 'import-jobs', summary: 'Cancel, retry or confirm a URL in a batch', description: 'confirm needs entryId and a full input and returns FeedPayload; cancel/retry return ImportJob.', workspace: true,
    params: { action: str({ enum: ['confirm', 'cancel', 'retry'] }) }, body: object({ entryId: str(), input: ref('FeedInput') }), response: { oneOf: [ref('ImportJob'), ref('FeedPayload')] } },
  // Settings
  { method: 'GET', path: '/api/settings', tag: 'settings', summary: 'Application settings', admin: true, response: ref('ApplicationSettings') },
  { method: 'PUT', path: '/api/settings', tag: 'settings', summary: 'Update application settings (partial merge)', admin: true, body: ref('ApplicationSettings'), response: ref('ApplicationSettings') },
  { method: 'POST', path: '/api/settings/translation/test', tag: 'settings', summary: 'Test a translation service with unsaved settings', description: 'Translates one sample sentence; an empty apiKey in settings uses the saved key. Nothing is saved.', admin: true,
    body: object({ provider: providerId, targetLanguage, settings: { type: 'object', description: 'deepl or openai settings (as in ApplicationSettings.translation.deepl / openai)' } }, ['provider']),
    response: object({ ok: { const: true }, sample: str(), text: str() }, ['ok', 'sample', 'text']) },
  { method: 'POST', path: '/api/settings/bark/test', tag: 'settings', summary: 'Send a test notification', admin: true, body: ref('BarkSettings'), response: ok },
  // Backups
  { method: 'POST', path: '/api/backups/export', tag: 'backups', summary: 'Export an encrypted full backup', admin: true, body: object({ currentPassword: str(), password: str({ minLength: 12 }) }, ['currentPassword', 'password']), response: ref('EncryptedBackup') },
  { method: 'POST', path: '/api/backups/preview', tag: 'backups', summary: 'Preview a full backup', description: 'Before setup, a setupToken can be used instead of an administrator sign-in.', admin: true, bodyLimit: '100 MB',
    body: object({ archive: ref('EncryptedBackup'), password: str(), currentPassword: str(), setupToken: str() }, ['archive', 'password']), response: { type: 'object', description: 'serverChanges lists the server and network settings that differ between this instance and the backup (key, label, current, backup)' } },
  { method: 'POST', path: '/api/backups/restore', tag: 'backups', summary: 'Restore a full backup over existing data', description: 'Before setup, a setupToken can be used instead of an administrator sign-in. Restoring revokes every session and access token.', admin: true, bodyLimit: '100 MB',
    body: object({ archive: ref('EncryptedBackup'), password: str(), currentPassword: str(), setupToken: str(), confirm: { const: true }, restoreServerSettings: { ...bool, default: false, description: 'Also restore the backup\'s server and network settings (listen address, port, public URL, trusted proxies, allowlist, DNS over HTTPS…); by default this instance keeps its own' } }, ['archive', 'password', 'confirm']), response: object({ ok: bool, serverSettingsRestored: bool }) },
  { method: 'GET', path: '/api/backups/config', tag: 'backups', summary: 'Export the configuration', admin: true, response: { type: 'object' } },
  { method: 'POST', path: '/api/backups/config', tag: 'backups', summary: 'Preview or confirm a configuration import', admin: true, bodyLimit: '10 MB', body: object({ archive: { type: 'object' }, confirm: bool }, ['archive']), response: { type: 'object' } },
  // Browser
  { method: 'POST', path: '/api/browser', tag: 'browser', summary: 'Open a page editing session', workspace: true, body: object({ url: str({ format: 'uri' }), credentialId: nullable(str()), networkProfileId, waitMs: int({ minimum: 0, maximum: 10000 }), waitForSelector: str() }, ['url']), response: ref('ScreenFrame') },
  { method: 'GET', path: '/api/browser/:id', tag: 'browser', summary: 'Capture the first part of the page again', workspace: true, response: ref('ScreenFrame') },
  { method: 'DELETE', path: '/api/browser/:id', tag: 'browser', summary: 'Close the editing session', workspace: true, response: ok },
  { method: 'POST', path: '/api/browser/:id/scroll', tag: 'browser', summary: 'Scroll an area inside the page', workspace: true, body: object({ deltaY: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } }, ['deltaY']), response: ref('ScreenFrame') },
  { method: 'POST', path: '/api/browser/:id/click', tag: 'browser', summary: 'Click a point', workspace: true, body: object({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']), response: ref('ScreenFrame') },
  { method: 'POST', path: '/api/browser/:id/pick', tag: 'browser', summary: 'Pick an element to build a selector', workspace: true, body: ref('PickRequest'), response: ref('PickResult') },
  { method: 'POST', path: '/api/browser/:id/segment', tag: 'browser', summary: 'Capture the next part of the page', workspace: true, body: object({ top: int({ minimum: 1 }) }, ['top']), response: ref('SegmentResult') },
  { method: 'POST', path: '/api/browser/:id/follow', tag: 'browser', summary: 'Open the link on an element', workspace: true, body: object({ node: int({ minimum: 0 }) }, ['node']), response: ref('ScreenFrame') },
  { method: 'POST', path: '/api/browser/:id/preview', tag: 'browser', summary: 'Preview items with rules', description: 'With pagination and maxPages above 1, fetches several pages the same way as a background refresh (in another tab of the session, so it is slower) and returns a pagination report; it is still a POST, so it needs a write token.', workspace: true, body: object({ rules: ref('SelectionRules'), pagination: nullable(ref('PaginationRules')) }, ['rules']), response: object({ items: array(ref('ExtractedItem')), pagination: ref('PaginationReport') }, ['items']) },
  { method: 'POST', path: '/api/browser/:id/detect', tag: 'browser', summary: 'Detect lists automatically', workspace: true, response: ref('DetectionResult') },
];

/** `METHOD /fastify/:path` for every documented operation. */
export function documentedRoutes(): string[] {
  return operations.map(op => `${op.method} ${op.path}`);
}

/** How a route may be called: `public`, `session` (browser login only), or the token scope it needs. */
export function routeAccess(op: Pick<Operation, 'method' | 'path' | 'access'>): 'public' | 'session' | 'read' | 'write' {
  if (op.access === 'public') return 'public';
  if (op.access === 'session' || !tokenAllowedRoute(op.method, op.path)) return 'session';
  return op.method === 'GET' ? 'read' : 'write';
}

const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: ref('Error') } } });

export function buildOpenApi(origin: string, version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const path = op.path.replace(/:([A-Za-z]+)/g, '{$1}');
    const access = routeAccess(op);
    const pathParams = [...op.path.matchAll(/:([A-Za-z]+)/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: op.params?.[name] ?? str() }));
    const parameters = [
      ...pathParams,
      ...(op.query ?? []).map(q => ({ name: q.name, in: 'query', required: false, schema: q.schema, ...(q.description ? { description: q.description } : {}) })),
      ...(op.workspace ? [{ $ref: '#/components/parameters/WorkspaceUser' }] : []),
    ];
    const notes = [
      op.description,
      !tokenAllowedRoute(op.method, op.path) ? '**Browser sessions only**: calls with an access token get 403.' : access === 'read' ? 'Access tokens: read or write scope.' : access === 'write' ? 'Access tokens: write scope; read tokens get 403.' : undefined,
      op.admin ? 'Administrators only.' : undefined,
      op.bodyLimit ? `Request bodies up to ${op.bodyLimit}.` : undefined,
    ].filter(Boolean);
    (paths[path] ??= {})[op.method.toLowerCase()] = {
      operationId: `${op.method.toLowerCase()}${op.path.replace(/^\/api/, '').replace(/[/:.-]+([a-zA-Z])?/g, (_, c: string | undefined) => (c ?? '').toUpperCase())}`,
      tags: [op.tag],
      summary: op.summary,
      ...(notes.length ? { description: notes.join('\n\n') } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: op.body } } } } : {}),
      responses: {
        200: { description: 'OK', content: { 'application/json': { schema: op.response ?? ok } } },
        ...(access === 'public' ? {} : { 401: errorResponse('Not signed in, or the token is invalid or expired') }),
        ...(access !== 'public' ? { 403: errorResponse('Forbidden: CSRF check failed, missing permission, a read-only token tried to write, or a token called a browser-only endpoint') } : {}),
        429: errorResponse('Too many failed attempts'),
      },
      security: access === 'public' ? [] : access === 'session' ? [{ cookieAuth: [] }] : [{ bearerAuth: [] }, { cookieAuth: [] }],
      'x-feedlantern-access': access,
      'x-feedlantern-token': tokenAllowedRoute(op.method, op.path) ? (op.method === 'GET' ? 'read' : 'write') : 'forbidden',
      ...(op.admin ? { 'x-feedlantern-admin': true } : {}),
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'FeedLantern API',
      version,
      description: [
        'Management API of a self-hosted web-page-to-RSS service. Errors return `{"code": string, "message": string, "error": string, "messageKey": string, "params"?: object}` (see the Error schema): `code` is stable and documented, scripts should branch on it; `message` (and `error`) is in the reader\'s language — the account\'s language, else Accept-Language, else the instance default. Responses are not cached.',
        '**Access tokens**: create one in Settings → Access tokens and call with `Authorization: Bearer fl_…`. A token has exactly its account\'s permissions and workspace; read tokens can only call GET; token requests need no cookie, `X-FeedLantern` or `X-CSRF-Token`.',
        '**Browser sessions**: cookie-session writes must send `X-FeedLantern: 1` and `X-CSRF-Token`; Host and Origin are checked.',
        '`x-feedlantern-access` gives each endpoint\'s sign-in requirement: public (no sign-in), session (browser session only), read / write (browser session or a token with that scope). `x-feedlantern-token` gives the token scope needed; forbidden means tokens cannot call it.',
      ].join('\n\n'),
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: origin }],
    tags: ['auth', 'meta', 'tokens', 'users', 'notifications', 'credentials', 'network-profiles', 'feeds', 'bundles', 'import-jobs', 'settings', 'backups', 'browser'].map(name => ({ name })),
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'fl_ personal access token', description: 'Personal access token' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'feedlantern_session', description: 'Browser session; writes also need the X-FeedLantern: 1 and X-CSRF-Token headers' },
      },
      parameters: {
        WorkspaceUser: { name: 'X-FeedLantern-User', in: 'header', required: false, schema: str(), description: 'Administrators can give another user\'s ID to act in that user\'s workspace; omitted means the caller\'s own workspace' },
      },
    },
  };
}
