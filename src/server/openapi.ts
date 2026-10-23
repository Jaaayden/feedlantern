import { API_TOKEN_MAX_DAYS, tokenAllowedRoute } from './api-tokens.js';
import { BUNDLE_ITEM_LIMIT, BUNDLE_MAX_FEEDS } from '../shared/types.js';
import { NETWORK_LIMITS } from '../shared/network-rules.js';

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
const translationMode = str({ enum: ['original', 'translated', 'bilingual'], description: 'translated 为仅译文（旧名 chinese 仍被接受）' });
const targetLanguage = str({ enum: ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'], default: 'zh-CN', description: '翻译目标语言' });
const translationProvider = nullable(str({ enum: ['google', 'deepl', 'openai'], description: '翻译服务；null 跟随实例默认服务' }));
const providerId = str({ enum: ['google', 'deepl', 'openai'] });
const networkProfileId = nullable(str({ description: '网络配置 ID；null 表示默认网络（直连，无额外请求头）' }));

const schemas: Record<string, Schema> = {
  Error: object({ error: str({ description: '面向用户的中文错误说明' }) }, ['error']),
  Ok: object({ ok: { const: true } }, ['ok']),
  AuthState: object({
    setupRequired: bool, authenticated: bool, version: str(), userId: str(), username: str(), role: str({ enum: ['admin', 'user'] }),
    csrfToken: str({ description: '仅网页会话返回；Cookie 会话的写操作需放在 X-CSRF-Token 请求头中' }),
    tokenScope: str({ enum: ['read', 'write'], description: '使用访问令牌调用时返回令牌权限' }),
  }, ['setupRequired', 'authenticated', 'version']),
  ApiToken: object({
    id: str(), name: str(), scope: str({ enum: ['read', 'write'] }), prefix: str({ description: '令牌开头几个字符，便于识别', examples: ['fl_Ab12Cd34'] }),
    createdAt: dateTime, expiresAt: nullable(dateTime), lastUsedAt: nullable(dateTime),
    usage24h: object({ calls: int(), failures: int({ description: '状态码 ≥ 400 的调用' }) }, ['calls', 'failures'], { description: '最近 24 小时的调用次数（列表接口返回）' }),
  }, ['id', 'name', 'scope', 'prefix', 'createdAt', 'expiresAt', 'lastUsedAt']),
  ApiTokenCall: object({
    id: int(), tokenId: str(), tokenName: str(), tokenPrefix: str({ description: '令牌开头几个字符；不记录完整令牌' }), at: dateTime,
    method: str(), route: nullable(str({ description: '路由模板，例如 /api/feeds/:id；不记录原始路径和查询参数。未匹配任何接口时为 null', examples: ['/api/feeds/:id'] })),
    status: int({ description: 'HTTP 状态码' }), durationMs: int(), ip: nullable(str({ description: '来源 IP，遵循 TRUSTED_PROXIES 设置' })),
  }, ['id', 'tokenId', 'tokenName', 'tokenPrefix', 'at', 'method', 'route', 'status', 'durationMs', 'ip']),
  ApiTokenCallPage: object({
    calls: array(ref('ApiTokenCall')), nextCursor: nullable(str()), retentionDays: int({ description: '与抓取日志共用的保留天数' }), perTokenLimit: int({ description: '每个令牌最多保留的记录数' }),
  }, ['calls', 'nextCursor', 'retentionDays', 'perTokenLimit']),
  ApiTokenInput: object({
    name: str({ minLength: 1, maxLength: 100 }),
    scope: str({ enum: ['read', 'write'], description: 'read 只能调用 GET；write 可调用全部开放给令牌的接口' }),
    expiresInDays: nullable(int({ minimum: 1, maximum: API_TOKEN_MAX_DAYS, description: '省略或 null 表示永不过期' })),
  }, ['name', 'scope']),
  ApiTokenCreated: object({ token: ref('ApiToken'), secret: str({ description: '完整令牌，只在创建时返回这一次', pattern: '^fl_[A-Za-z0-9_-]{43}$' }) }, ['token', 'secret']),
  UserSummary: object({
    id: str(), username: str(), role: str({ enum: ['admin', 'user'] }), enabled: bool, createdAt: dateTime, updatedAt: dateTime,
    stats: object({ feeds: int(), failingFeeds: int(), pausedFeeds: int(), credentials: int(), lastSeenAt: nullable(dateTime) }),
  }, ['id', 'username', 'role', 'enabled', 'createdAt', 'updatedAt']),
  SelectionRules: object({ item: str(), title: str(), link: str(), description: str(), image: str(), date: str() }, ['item', 'title', 'link'], { description: 'CSS 选择器；title/link 等相对于 item' }),
  FeedInput: object({
    sourceType: str({ enum: ['website', 'rss'], default: 'website' }), translationMode, targetLanguage, translationProvider,
    name: str({ minLength: 1 }), url: str({ format: 'uri' }), rules: ref('SelectionRules'),
    ruleOrigins: { type: 'object', additionalProperties: str({ enum: ['auto', 'manual'] }) },
    credentialId: nullable(str()), intervalMinutes: int({ minimum: 5, maximum: 1440 }), waitMs: int({ minimum: 0, maximum: 10000 }), waitForSelector: str(),
    pagination: nullable(ref('PaginationRules')),
    networkProfileId: { ...networkProfileId, description: '网络配置 ID（代理、User-Agent、Referer、额外请求头）。更新时省略表示保留，null 表示改回默认网络' },
  }, ['name', 'url', 'rules', 'credentialId', 'intervalMinutes', 'waitMs']),
  PaginationRules: object({
    mode: str({ enum: ['next', 'template', 'loadMore'], description: 'next：点击“下一页”链接或按钮；template：按 URL 模板代入页码；loadMore：点击“加载更多”按钮' }),
    maxPages: int({ minimum: 1, maximum: 10, default: 3, description: '包含第 1 页（源网址）' }), delayMs: int({ minimum: 2000, maximum: 30000, default: 3000, description: '每页之间的间隔，另加最多 20% 随机抖动' }),
    nextSelector: str({ description: 'next / loadMore 必填' }), urlTemplate: str({ description: 'template 必填，须包含 {n}' }), start: int({ minimum: 0, default: 2, description: '第 2 页代入的 {n}' }), step: int({ minimum: 1, default: 1 }),
  }, ['mode'], { description: '多页采集设置。FeedInput 中省略表示保留已保存的设置，null 表示只抓源网址这一页' }),
  PaginationReport: object({
    pages: array(object({ page: int(), url: str(), count: int(), added: int(), error: str() }, ['page', 'url', 'count', 'added'])),
    stoppedAt: int(), stop: str({ enum: ['single', 'max', 'end', 'repeat', 'known', 'empty', 'failed', 'blocked', 'budget', 'limit'] }), message: str({ description: '在哪一页、因为什么原因停止' }),
  }, ['pages', 'stoppedAt', 'stop', 'message']),
  ItemFilter: object({ include: array(str({ maxLength: 200 }), { maxItems: 30 }), exclude: array(str({ maxLength: 200 }), { maxItems: 30 }), regex: bool }, ['include', 'exclude', 'regex'], { description: '条目过滤：排除优先，include 非空时必须命中其一；只影响输出' }),
  FeedSettingsInput: object({ translationMode, targetLanguage, translationProvider, channelTitle: str({ minLength: 1, maxLength: 200 }), intervalMinutes: int({ minimum: 5, maximum: 1440 }), itemFilter: nullable(ref('ItemFilter')), outputLimit: int({ minimum: 10, maximum: 500 }), networkProfileId }, [], { description: '至少提供一个字段；itemFilter 为 null 时删除过滤；networkProfileId 为 null 时改回默认网络' }),
  OutputStatus: object({ outputStatus: { type: 'object', additionalProperties: str({ enum: ['published', 'untranslated', 'excluded', 'not-included', 'over-limit'] }), description: '条目 ID → 是否输出及原因' }, filterTimedOut: bool }, ['outputStatus']),
  NotificationSummary: { type: 'object', description: '告警策略（阈值、超时、重试、冷却、规则失效预警开关 ruleHealthAlerts）和各渠道状态；不返回任何密钥', properties: { channels: { type: 'object' } } },
  NotificationUpdate: { type: 'object', description: '局部更新：省略的字段保持原值，空字符串清除密钥；headers 整体替换', properties: { channels: { type: 'object', properties: { bark: { type: 'object' }, webhook: { type: 'object' }, ntfy: { type: 'object' }, telegram: { type: 'object' } } } } },
  Feed: { allOf: [ref('FeedInput'), object({
    id: str(), ownerId: str(), channelTitle: str(), enabled: bool, createdAt: dateTime, lastFetchedAt: nullable(dateTime), lastSuccessAt: nullable(dateTime),
    nextFetchAt: dateTime, lastError: nullable(str()), itemCount: int(), itemFilter: ref('ItemFilter'), outputLimit: int({ minimum: 10, maximum: 500, default: 100 }), translation: object({ pending: int(), success: int(), failed: int() }),
    ruleHealth: ref('RuleHealthWarning'),
  }, ['id', 'enabled', 'createdAt', 'lastFetchedAt', 'lastSuccessAt', 'nextFetchAt', 'lastError', 'itemCount'])] },
  FeedItem: object({
    id: str(), title: str(), link: str(), description: str(), image: str(), publishedAt: dateTime, publishedAtSource: str({ enum: ['absolute', 'relative'] }),
    firstSeenAt: dateTime, contentHtml: str(), translationStatus: str({ enum: ['pending', 'success', 'failed'] }), translationError: str(),
    translatedTitle: str({ description: '翻译完成时：译文标题' }), sourceTitle: str({ description: '翻译完成时：原文标题' }),
  }, ['title', 'link']),
  RuleHealthWarning: object({
    detectedAt: dateTime, checkedAt: dateTime, itemCount: int(), baselineSamples: int({ description: '参与比较的最近正常抓取次数' }),
    reasons: array(object({
      code: str({ enum: ['item-count', 'field-rate', 'duplicate-links', 'same-link'] }), field: str({ enum: ['title', 'link', 'date', 'image', 'description'] }),
      baseline: { type: 'number' }, current: { type: 'number' }, message: str({ description: '面向用户的中文说明' }),
    }, ['code', 'baseline', 'current', 'message'])),
  }, ['detectedAt', 'checkedAt', 'itemCount', 'baselineSamples', 'reasons'], { description: '只在“规则可能失效”时出现；抓取本身仍记为成功' }),
  RulePreview: object({ count: int(), items: array(ref('ExtractedItem'), { maxItems: 5 }), error: str({ description: '没有抽取到内容时的原因' }) }, ['count', 'items']),
  RuleRedetectResult: object({ current: ref('RulePreview'), detection: ref('DetectionResult') }, ['current', 'detection']),
  FeedPayload: object({ feed: ref('Feed'), feedUrl: str({ format: 'uri', description: '带密钥的 RSS 地址' }) }, ['feed', 'feedUrl']),
  Bundle: object({
    id: str(), name: str(), feedIds: array(str(), { description: '成员订阅 ID，按添加顺序' }),
    itemLimit: int({ minimum: BUNDLE_ITEM_LIMIT.min, maximum: BUNDLE_ITEM_LIMIT.max }), createdAt: dateTime, updatedAt: dateTime,
  }, ['id', 'name', 'feedIds', 'itemLimit', 'createdAt', 'updatedAt']),
  BundleInput: object({
    name: str({ minLength: 1, maxLength: 200 }),
    feedIds: array(str(), { maxItems: BUNDLE_MAX_FEEDS, description: '只能是同一账号的订阅；重复项自动去掉' }),
    itemLimit: int({ minimum: BUNDLE_ITEM_LIMIT.min, maximum: BUNDLE_ITEM_LIMIT.max, default: BUNDLE_ITEM_LIMIT.default }),
  }, ['name', 'feedIds']),
  BundlePayload: object({ bundle: ref('Bundle'), bundleUrl: str({ format: 'uri', description: '带密钥的聚合 RSS 地址；把 .xml 换成 .atom 或 .json 得到 Atom / JSON Feed' }) }, ['bundle', 'bundleUrl']),
  FeedDetail: { allOf: [ref('FeedPayload'), ref('OutputStatus'), object({ items: array(ref('FeedItem')) }, ['items'])] },
  FetchLogPage: object({ logs: array({ type: 'object' }), nextCursor: nullable(str()), retentionDays: int() }, ['logs', 'nextCursor', 'retentionDays']),
  NetworkProfileInput: object({
    name: str({ minLength: 1, maxLength: NETWORK_LIMITS.name }),
    proxyUrl: nullable(str({ description: 'http://、https:// 或 socks5:// 加主机和端口；null 或空表示不使用代理。代理地址受内网拦截，需管理员加入 allowedHosts 才能指向内网', examples: ['socks5://proxy.example.com:1080'] })),
    proxyUsername: nullable(str({ maxLength: NETWORK_LIMITS.proxyUser, description: '修改时省略表示保留已保存的认证，null 表示移除；更改代理地址时必须重新填写' })),
    proxyPassword: nullable(str({ maxLength: NETWORK_LIMITS.proxyUser })),
    userAgent: nullable(str({ maxLength: NETWORK_LIMITS.userAgent })),
    referer: nullable(str({ format: 'uri', maxLength: NETWORK_LIMITS.referer })),
    headers: array(object({ name: str({ maxLength: NETWORK_LIMITS.headerName }), value: str({ maxLength: NETWORK_LIMITS.headerValue, description: '修改时省略表示保留已保存的值' }) }, ['name']), { maxItems: NETWORK_LIMITS.headers, description: '只发往订阅网址所在网站及其子域名。禁止 Host、Cookie、Cookie2、Set-Cookie、Connection、Keep-Alive、Transfer-Encoding、TE、Trailer、Upgrade、Content-Length、Content-Encoding、Expect、HTTP2-Settings、Accept-Encoding、User-Agent、Referer，以及 Proxy-*、Sec-*、X-FeedLantern* 开头的请求头' }),
  }, ['name'], { description: '至少设置代理、User-Agent、Referer 或一个请求头' }),
  NetworkProfileSummary: object({
    id: str(), name: str(),
    proxy: nullable(object({ type: str({ enum: ['http', 'https', 'socks5'] }), host: str(), port: int(), url: str(), authenticated: bool }, ['type', 'host', 'port', 'url', 'authenticated'])),
    userAgent: nullable(str()), referer: nullable(str()), headerNames: array(str()), feedCount: int(), updatedAt: dateTime,
  }, ['id', 'name', 'proxy', 'userAgent', 'referer', 'headerNames', 'feedCount', 'updatedAt'], { description: '不含代理用户名、密码和请求头的值' }),
  CredentialInput: object({ name: str({ minLength: 1 }), url: str({ format: 'uri' }), format: str({ enum: ['header', 'json'] }), value: { description: 'Cookie 请求头文本或 Cookie JSON' } }, ['name', 'url', 'format', 'value']),
  CredentialSummary: object({ id: str(), name: str(), url: str(), format: str({ enum: ['header', 'json'] }), domains: array(str()), count: int(), updatedAt: dateTime, expiresAt: nullable(dateTime) }, ['id', 'name', 'url', 'format', 'domains', 'count', 'updatedAt', 'expiresAt']),
  BarkSettings: object({
    enabled: bool, url: str(), failureThreshold: int(), timeoutSeconds: int(), maxAttempts: int(), retryDelaySeconds: int(), laterRetryDelaySeconds: int(), cooldownMinutes: int(),
    ruleHealthAlerts: { ...bool, description: '规则可能失效时通知，默认 true' },
  }),
  BarkSummary: object({
    enabled: bool, configured: bool, maskedUrl: str(), failureThreshold: int(), timeoutSeconds: int(), maxAttempts: int(), retryDelaySeconds: int(), laterRetryDelaySeconds: int(), cooldownMinutes: int(),
    ruleHealthAlerts: bool,
  }),
  ApplicationSettings: object({
    translation: object({
      concurrency: int({ description: 'Google 通道的并发数' }), requestIntervalMs: int({ description: 'Google 通道的请求启动间隔' }), defaultProvider: providerId,
      deepl: object({ apiKey: str({ description: '只写：响应中始终为空字符串；更新时省略或留空保持原值，null 删除' }), apiKeyConfigured: bool, plan: str({ enum: ['auto', 'free', 'pro'] }), concurrency: int(), requestIntervalMs: int() }),
      openai: object({ baseUrl: str({ description: '请求发送到 baseUrl/chat/completions' }), model: str(), apiKey: str({ description: '只写，同 deepl.apiKey' }), apiKeyConfigured: bool, systemPrompt: str({ maxLength: 4000 }), concurrency: int(), requestIntervalMs: int() }),
    }), feedView: str({ enum: ['list', 'cards'] }), logRetentionDays: int(),
    bark: ref('BarkSettings'), server: { type: 'object', description: '后台并发、目标白名单、代理与会话等服务器设置' },
  }),
  ImportJob: object({ id: str(), createdAt: dateTime, ownerId: str(), actorId: str(), entries: array({ type: 'object', description: '每个网址的识别状态、结果和错误' }) }, ['id', 'createdAt', 'entries']),
  ExtractedItem: object({ title: str(), link: str(), description: str(), image: str(), publishedAt: str(), contentHtml: str() }, ['title', 'link']),
  ElementMap: object({ boxes: array({ type: 'number' }), labels: array(str()), links: { type: 'object', additionalProperties: str() }, truncated: bool, innerScroll: bool }),
  ScreenFrame: object({
    sessionId: str(), image: str({ description: 'JPEG data URL' }), width: int(), height: int(), viewportHeight: int(), documentHeight: int(),
    url: str(), title: str(), map: ref('ElementMap'), truncated: bool,
  }, ['sessionId', 'image', 'width', 'height', 'url', 'title']),
  SegmentResult: object({ top: int(), height: int(), image: str(), documentHeight: int(), map: ref('ElementMap'), truncated: bool }, ['top', 'height', 'image', 'documentHeight', 'map']),
  PickRequest: object({
    target: str({ enum: ['item', 'title', 'link', 'description', 'image', 'date', 'next'], description: 'next：点选“下一页”或“加载更多”，不预览规则' }), node: int(), x: { type: 'number' }, y: { type: 'number' },
    exact: bool, itemSelector: str(), ancestorLevel: int(), rules: { type: 'object' },
  }, ['target']),
  PickResult: object({ selector: str(), rects: array({ type: 'object' }), count: int(), sampleText: str(), warning: str(), node: int(), items: array(ref('ExtractedItem')), previewError: str() }, ['selector', 'rects', 'count', 'sampleText']),
  DetectionResult: object({ candidates: array({ type: 'object' }), recommendedId: nullable(str()), warnings: array(str()) }, ['candidates', 'recommendedId', 'warnings']),
  EncryptedBackup: object({ format: { const: 'feedlantern-encrypted' }, version: { const: 1 }, salt: str(), iv: str(), tag: str(), data: str() }),
  BulkResult: object({ results: array(object({ id: str(), ok: bool, feedUrl: str(), error: str() }, ['id', 'ok'])) }, ['results']),
};

const operations: Operation[] = [
  // Auth
  { method: 'GET', path: '/api/auth/status', tag: 'auth', summary: '登录状态', description: '公开。带令牌调用时返回令牌所属账号和 tokenScope，可用于确认令牌是否有效。', access: 'public', response: ref('AuthState') },
  { method: 'POST', path: '/api/auth/setup', tag: 'auth', summary: '首次初始化管理员', access: 'public', body: object({ setupToken: str(), username: str(), password: str({ minLength: 8 }) }, ['setupToken', 'username', 'password']), response: ref('AuthState') },
  { method: 'POST', path: '/api/auth/login', tag: 'auth', summary: '登录', access: 'public', body: object({ username: str(), password: str() }, ['username', 'password']), response: ref('AuthState') },
  { method: 'POST', path: '/api/auth/logout', tag: 'auth', summary: '退出登录', response: ref('AuthState') },
  { method: 'POST', path: '/api/auth/password', tag: 'auth', summary: '修改自己的密码', description: '撤销此账号所有会话和访问令牌。', body: object({ currentPassword: str(), newPassword: str({ minLength: 8 }) }, ['currentPassword', 'newPassword']), response: ref('AuthState') },
  { method: 'GET', path: '/api/openapi.json', tag: 'meta', summary: '本 OpenAPI 文档', access: 'public', response: { type: 'object' } },
  // Tokens
  { method: 'GET', path: '/api/tokens', tag: 'tokens', summary: '列出访问令牌', description: '管理员可用 X-FeedLantern-User 只读查看其他用户的令牌。', workspace: true, response: array(ref('ApiToken')) },
  { method: 'GET', path: '/api/tokens/:id/logs', tag: 'tokens', summary: '令牌调用记录', workspace: true,
    description: '只记录带 Bearer 令牌的 /api/* 请求（包括写操作和 401/403/429），网页 Cookie 会话的请求不记录。记录时间、令牌名称与前缀、方法、路由模板、状态码、耗时和来源 IP，不记录令牌密钥和查询参数。按日志保留天数清理，每个令牌最多保留 2000 条、全站最多 20000 条。',
    query: [
      { name: 'status', schema: str({ enum: ['success', 'denied', 'error'] }), description: 'success：状态码 < 400；denied：401、403、429；error：其他 ≥ 400' },
      { name: 'cursor', schema: str(), description: '上一页的 nextCursor' },
      { name: 'limit', schema: int({ minimum: 1, maximum: 100, default: 20 }) },
    ], response: ref('ApiTokenCallPage') },
  { method: 'POST', path: '/api/tokens', tag: 'tokens', summary: '创建访问令牌', description: '完整令牌只在响应中出现一次；每个账号最多 50 个。只能为自己创建。', body: ref('ApiTokenInput'), response: ref('ApiTokenCreated') },
  { method: 'DELETE', path: '/api/tokens/:id', tag: 'tokens', summary: '吊销访问令牌', description: '只能吊销自己的令牌；令牌的调用记录随之删除。', response: ok },
  // Users
  { method: 'GET', path: '/api/users', tag: 'users', summary: '列出用户及统计', admin: true, response: array(ref('UserSummary')) },
  { method: 'POST', path: '/api/users', tag: 'users', summary: '创建普通用户', admin: true, body: object({ username: str(), password: str({ minLength: 8 }) }, ['username', 'password']), response: ref('UserSummary') },
  { method: 'PATCH', path: '/api/users/:id', tag: 'users', summary: '修改用户名、启用状态或角色', description: '停用或身份变化会撤销目标账号的会话和访问令牌。', admin: true, body: object({ username: str(), enabled: bool, role: str({ enum: ['admin', 'user'] }) }), response: ref('UserSummary') },
  { method: 'POST', path: '/api/users/:id/password', tag: 'users', summary: '重置其他用户的密码', admin: true, body: object({ password: str({ minLength: 8 }) }, ['password']), response: ok },
  { method: 'GET', path: '/api/users/:id/deletion-preview', tag: 'users', summary: '删除用户前的影响预览', admin: true, response: object({ user: ref('UserSummary'), feeds: int(), bundles: int(), credentials: int(), jobs: int() }) },
  { method: 'DELETE', path: '/api/users/:id', tag: 'users', summary: '删除用户及其全部数据', admin: true, body: object({ username: str({ description: '输入目标用户名确认' }) }, ['username']), response: ok },
  // Notifications
  { method: 'GET', path: '/api/notifications/bark', tag: 'notifications', summary: '个人 Bark 通知设置', workspace: true, response: ref('BarkSummary') },
  { method: 'PUT', path: '/api/notifications/bark', tag: 'notifications', summary: '保存个人 Bark 通知设置', workspace: true, body: ref('BarkSettings'), response: ref('BarkSummary') },
  { method: 'GET', path: '/api/notifications', tag: 'notifications', summary: '通知渠道和告警策略', workspace: true, response: ref('NotificationSummary') },
  { method: 'PUT', path: '/api/notifications', tag: 'notifications', summary: '保存通知渠道和告警策略', workspace: true, body: ref('NotificationUpdate'), response: ref('NotificationSummary') },
  { method: 'POST', path: '/api/notifications/test', tag: 'notifications', summary: '向一个渠道发送测试通知（不保存）', workspace: true, body: object({ channel: str({ enum: ['bark', 'webhook', 'ntfy', 'telegram'] }) }, ['channel'], { additionalProperties: true }), response: ok },
  { method: 'POST', path: '/api/notifications/bark/test', tag: 'notifications', summary: '发送个人测试通知', workspace: true, body: ref('BarkSettings'), response: ok },
  // Credentials
  { method: 'GET', path: '/api/network-profiles', tag: 'network-profiles', summary: '列出网络配置（不含密钥）', workspace: true, response: array(ref('NetworkProfileSummary')) },
  { method: 'POST', path: '/api/network-profiles', tag: 'network-profiles', summary: '添加网络配置', description: '代理密码和请求头的值加密保存，之后不再返回。', workspace: true, body: ref('NetworkProfileInput'), response: ref('NetworkProfileSummary') },
  { method: 'PUT', path: '/api/network-profiles/:id', tag: 'network-profiles', summary: '修改网络配置', description: '省略的密钥保持原值；下一次抓取起生效。', workspace: true, body: ref('NetworkProfileInput'), response: ref('NetworkProfileSummary') },
  { method: 'DELETE', path: '/api/network-profiles/:id', tag: 'network-profiles', summary: '删除网络配置', description: '仍被订阅引用时返回 409。', workspace: true, response: ok },
  { method: 'POST', path: '/api/network-profiles/:id/test', tag: 'network-profiles', summary: '用网络配置测试连接', description: '用这组配置对网址发一次 GET（不跟随重定向），返回目标的 HTTP 状态；代理不可达或认证失败时返回 400 和原因。会发出网络请求，需要 write 令牌。', workspace: true, body: object({ url: str({ format: 'uri' }) }, ['url']), response: object({ ok: { const: true }, status: int() }, ['ok', 'status']) },
  { method: 'GET', path: '/api/credentials', tag: 'credentials', summary: '列出 Cookie 凭据（不含明文）', workspace: true, response: array(ref('CredentialSummary')) },
  { method: 'POST', path: '/api/credentials', tag: 'credentials', summary: '添加 Cookie 凭据', workspace: true, body: ref('CredentialInput'), response: ref('CredentialSummary') },
  { method: 'PUT', path: '/api/credentials/:id', tag: 'credentials', summary: '更新 Cookie 凭据', workspace: true, body: ref('CredentialInput'), response: ref('CredentialSummary') },
  { method: 'DELETE', path: '/api/credentials/:id', tag: 'credentials', summary: '删除 Cookie 凭据', description: '仍被订阅引用时返回 409。', workspace: true, response: ok },
  // Feeds
  { method: 'GET', path: '/api/feeds', tag: 'feeds', summary: '列出订阅', workspace: true, response: array(ref('Feed')) },
  { method: 'POST', path: '/api/feeds', tag: 'feeds', summary: '创建订阅', description: '网页订阅会立即抓取一次后返回；RSS 订阅在后台抓取。', workspace: true, body: ref('FeedInput'), response: ref('FeedPayload') },
  { method: 'POST', path: '/api/feeds/bulk', tag: 'feeds', summary: '批量操作', workspace: true, body: object({ ids: array(str(), { minItems: 1, maxItems: 200 }), action: str({ enum: ['copy', 'pause', 'resume', 'refresh', 'delete', 'settings'] }), settings: object({ translationMode, targetLanguage, translationProvider, intervalMinutes: int({ minimum: 5, maximum: 1440 }), itemFilter: nullable(ref('ItemFilter')), outputLimit: int({ minimum: 10, maximum: 500 }) }) }, ['ids', 'action']), response: ref('BulkResult') },
  { method: 'GET', path: '/api/feeds/:id', tag: 'feeds', summary: '订阅详情和最近 200 条条目', workspace: true, response: ref('FeedDetail') },
  { method: 'PUT', path: '/api/feeds/:id', tag: 'feeds', summary: '替换订阅的网址和规则', description: '启用中的订阅会立即重新抓取。', workspace: true, body: ref('FeedInput'), response: ref('FeedPayload') },
  { method: 'PATCH', path: '/api/feeds/:id', tag: 'feeds', summary: '修改名称、刷新间隔或翻译输出', workspace: true, body: ref('FeedSettingsInput'), response: ref('FeedPayload') },
  { method: 'DELETE', path: '/api/feeds/:id', tag: 'feeds', summary: '删除订阅', workspace: true, response: ok },
  { method: 'POST', path: '/api/feeds/:id/health/redetect', tag: 'feeds', summary: '规则可能失效时重新识别', description: '网页订阅：在订阅网页上按当前规则抽取并运行自动识别，返回两者供对比；不保存规则。替换规则用 PUT /api/feeds/:id。需要 write 令牌。', workspace: true, response: ref('RuleRedetectResult') },
  { method: 'POST', path: '/api/feeds/:id/health/preview', tag: 'feeds', summary: '在订阅网页上预览规则组合', description: '不修改订阅；需要 write 令牌。', workspace: true, body: object({ rules: ref('SelectionRules') }, ['rules']), response: ref('RulePreview') },
  { method: 'POST', path: '/api/feeds/:id/health/ignore', tag: 'feeds', summary: '忽略“规则可能失效”', description: '清除警告并以最近一次抓取结果作为新的比较基线；需要 write 令牌。', workspace: true, response: ref('FeedPayload') },
  { method: 'POST', path: '/api/feeds/:id/refresh', tag: 'feeds', summary: '立即抓取', workspace: true, response: ref('FeedPayload') },
  { method: 'POST', path: '/api/feeds/:id/toggle', tag: 'feeds', summary: '暂停或恢复', workspace: true, response: ref('FeedPayload') },
  { method: 'POST', path: '/api/feeds/:id/rotate-token', tag: 'feeds', summary: '更换 RSS 地址密钥', description: '旧 RSS 地址立即失效。', workspace: true, response: ref('FeedPayload') },
  { method: 'GET', path: '/api/feeds/:id/logs', tag: 'feeds', summary: '抓取日志（分页）', workspace: true, query: [
    { name: 'status', schema: str({ enum: ['running', 'success', 'failure', 'interrupted'] }) },
    { name: 'cursor', schema: str({ pattern: '^[1-9][0-9]*$' }), description: '上一页的 nextCursor' },
    { name: 'limit', schema: int({ minimum: 1, maximum: 100, default: 20 }) },
  ], response: ref('FetchLogPage') },
  { method: 'GET', path: '/api/feeds/:id/translation/progress', tag: 'feeds', summary: 'RSS 翻译进度', workspace: true, response: { type: 'object' } },
  { method: 'GET', path: '/api/translation/providers', tag: 'feeds', summary: '可选的翻译服务', description: '任何已登录用户可读：实例默认服务，以及各服务是否已由管理员配置。',
    response: object({ defaultProvider: providerId, providers: array(object({ id: providerId, label: str(), configured: bool }, ['id', 'label', 'configured'])) }, ['defaultProvider', 'providers']) },
  { method: 'POST', path: '/api/feeds/:id/translation/retry', tag: 'feeds', summary: '重试失败的翻译', workspace: true, response: ref('FeedPayload') },
  { method: 'POST', path: '/api/feeds/:id/output-preview', tag: 'feeds', summary: '按未保存的过滤和条数预览输出', description: '不修改订阅；仍是 POST，因此需要 write 令牌。', workspace: true, body: object({ itemFilter: nullable(ref('ItemFilter')), outputLimit: int({ minimum: 10, maximum: 500 }) }), response: ref('OutputStatus') },
  { method: 'POST', path: '/api/rss/preview', tag: 'feeds', summary: '预览 RSS 源的前 3 条', workspace: true, body: object({ url: str({ format: 'uri' }), networkProfileId }, ['url']), response: object({ title: str(), items: array(ref('ExtractedItem')) }) },
  // Bundles
  { method: 'GET', path: '/api/bundles', tag: 'bundles', summary: '列出聚合订阅', workspace: true, response: array(ref('BundlePayload')) },
  { method: 'POST', path: '/api/bundles', tag: 'bundles', summary: '创建聚合订阅', description: '把同一账号的多个订阅合并成一个地址；只读取已存储的条目，不触发抓取。每个账号最多 200 个。', workspace: true, body: ref('BundleInput'), response: ref('BundlePayload') },
  { method: 'GET', path: '/api/bundles/:id', tag: 'bundles', summary: '聚合订阅详情', workspace: true, response: ref('BundlePayload') },
  { method: 'PUT', path: '/api/bundles/:id', tag: 'bundles', summary: '修改聚合订阅', description: '只修改提供的字段；feedIds 整体替换成员。', workspace: true, body: object({ name: str({ minLength: 1, maxLength: 200 }), feedIds: array(str(), { maxItems: BUNDLE_MAX_FEEDS }), itemLimit: int({ minimum: BUNDLE_ITEM_LIMIT.min, maximum: BUNDLE_ITEM_LIMIT.max }) }), response: ref('BundlePayload') },
  { method: 'DELETE', path: '/api/bundles/:id', tag: 'bundles', summary: '删除聚合订阅', description: '成员订阅不受影响。', workspace: true, response: ok },
  { method: 'POST', path: '/api/bundles/:id/feeds', tag: 'bundles', summary: '向聚合订阅追加成员', description: '已有成员保持原位，重复项忽略。', workspace: true, body: object({ feedIds: array(str(), { maxItems: BUNDLE_MAX_FEEDS }) }, ['feedIds']), response: ref('BundlePayload') },
  { method: 'POST', path: '/api/bundles/:id/rotate-token', tag: 'bundles', summary: '更换聚合地址密钥', description: '旧的 RSS、Atom、JSON Feed 聚合地址立即失效。', workspace: true, response: ref('BundlePayload') },
  // Import jobs
  { method: 'GET', path: '/api/import-jobs', tag: 'import-jobs', summary: '列出批量添加任务', workspace: true, response: array(ref('ImportJob')) },
  { method: 'POST', path: '/api/import-jobs', tag: 'import-jobs', summary: '创建批量添加任务', workspace: true, body: object({
    entries: array(object({ url: str({ format: 'uri' }), credentialId: nullable(str()), networkProfileId }, ['url']), { minItems: 1, maxItems: 100 }),
    intervalMinutes: int({ minimum: 5, maximum: 1440, default: 60 }), sourceType: str({ enum: ['website', 'rss'] }), translationMode: str({ enum: ['translated', 'bilingual'], description: '旧名 chinese 仍被接受' }), targetLanguage, translationProvider,
  }, ['entries']), response: ref('ImportJob') },
  { method: 'POST', path: '/api/import-jobs/:id/:action', tag: 'import-jobs', summary: '取消、重试或确认任务中的网址', description: 'confirm 需要 entryId 和完整 input，返回 FeedPayload；cancel/retry 返回 ImportJob。', workspace: true,
    params: { action: str({ enum: ['confirm', 'cancel', 'retry'] }) }, body: object({ entryId: str(), input: ref('FeedInput') }), response: { oneOf: [ref('ImportJob'), ref('FeedPayload')] } },
  // Settings
  { method: 'GET', path: '/api/settings', tag: 'settings', summary: '全局应用设置', admin: true, response: ref('ApplicationSettings') },
  { method: 'PUT', path: '/api/settings', tag: 'settings', summary: '修改全局应用设置（局部合并）', admin: true, body: ref('ApplicationSettings'), response: ref('ApplicationSettings') },
  { method: 'POST', path: '/api/settings/translation/test', tag: 'settings', summary: '用未保存的设置测试翻译服务', description: '翻译一句示例；settings 中 apiKey 留空时使用已保存的 Key。不保存任何设置。', admin: true,
    body: object({ provider: providerId, targetLanguage, settings: { type: 'object', description: 'deepl 或 openai 的设置（同 ApplicationSettings.translation.deepl / openai）' } }, ['provider']),
    response: object({ ok: { const: true }, sample: str(), text: str() }, ['ok', 'sample', 'text']) },
  { method: 'POST', path: '/api/settings/bark/test', tag: 'settings', summary: '发送测试通知', admin: true, body: ref('BarkSettings'), response: ok },
  // Backups
  { method: 'POST', path: '/api/backups/export', tag: 'backups', summary: '导出加密完整备份', admin: true, body: object({ currentPassword: str(), password: str({ minLength: 12 }) }, ['currentPassword', 'password']), response: ref('EncryptedBackup') },
  { method: 'POST', path: '/api/backups/preview', tag: 'backups', summary: '预览完整备份', description: '未初始化时可用 setupToken 代替管理员登录。', admin: true, bodyLimit: '100 MB',
    body: object({ archive: ref('EncryptedBackup'), password: str(), currentPassword: str(), setupToken: str() }, ['archive', 'password']), response: { type: 'object' } },
  { method: 'POST', path: '/api/backups/restore', tag: 'backups', summary: '覆盖恢复完整备份', description: '未初始化时可用 setupToken 代替管理员登录。恢复会吊销全部会话和访问令牌。', admin: true, bodyLimit: '100 MB',
    body: object({ archive: ref('EncryptedBackup'), password: str(), currentPassword: str(), setupToken: str(), confirm: { const: true } }, ['archive', 'password', 'confirm']), response: ok },
  { method: 'GET', path: '/api/backups/config', tag: 'backups', summary: '导出轻量配置', admin: true, response: { type: 'object' } },
  { method: 'POST', path: '/api/backups/config', tag: 'backups', summary: '预览或确认导入轻量配置', admin: true, bodyLimit: '10 MB', body: object({ archive: { type: 'object' }, confirm: bool }, ['archive']), response: { type: 'object' } },
  // Browser
  { method: 'POST', path: '/api/browser', tag: 'browser', summary: '打开网页编辑会话', workspace: true, body: object({ url: str({ format: 'uri' }), credentialId: nullable(str()), networkProfileId, waitMs: int({ minimum: 0, maximum: 10000 }), waitForSelector: str() }, ['url']), response: ref('ScreenFrame') },
  { method: 'GET', path: '/api/browser/:id', tag: 'browser', summary: '重新截取第一段画面', workspace: true, response: ref('ScreenFrame') },
  { method: 'DELETE', path: '/api/browser/:id', tag: 'browser', summary: '关闭编辑会话', workspace: true, response: ok },
  { method: 'POST', path: '/api/browser/:id/scroll', tag: 'browser', summary: '滚动页面内部区域', workspace: true, body: object({ deltaY: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } }, ['deltaY']), response: ref('ScreenFrame') },
  { method: 'POST', path: '/api/browser/:id/click', tag: 'browser', summary: '点击坐标', workspace: true, body: object({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']), response: ref('ScreenFrame') },
  { method: 'POST', path: '/api/browser/:id/pick', tag: 'browser', summary: '点选元素生成选择器', workspace: true, body: ref('PickRequest'), response: ref('PickResult') },
  { method: 'POST', path: '/api/browser/:id/segment', tag: 'browser', summary: '截取下一段画面', workspace: true, body: object({ top: int({ minimum: 1 }) }, ['top']), response: ref('SegmentResult') },
  { method: 'POST', path: '/api/browser/:id/follow', tag: 'browser', summary: '打开元素上的链接', workspace: true, body: object({ node: int({ minimum: 0 }) }, ['node']), response: ref('ScreenFrame') },
  { method: 'POST', path: '/api/browser/:id/preview', tag: 'browser', summary: '按规则预览条目', description: '带 pagination 且 maxPages 大于 1 时，按与后台刷新相同的逻辑试抓多页（在会话的另一个标签中进行，较慢），并返回 pagination 报告；仍是 POST，因此需要 write 令牌。', workspace: true, body: object({ rules: ref('SelectionRules'), pagination: nullable(ref('PaginationRules')) }, ['rules']), response: object({ items: array(ref('ExtractedItem')), pagination: ref('PaginationReport') }, ['items']) },
  { method: 'POST', path: '/api/browser/:id/detect', tag: 'browser', summary: '自动识别列表', workspace: true, response: ref('DetectionResult') },
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
      !tokenAllowedRoute(op.method, op.path) ? '**仅限网页登录会话**：访问令牌调用返回 403。' : access === 'read' ? '访问令牌：read 或 write 权限均可。' : access === 'write' ? '访问令牌：需要 write 权限，read 令牌返回 403。' : undefined,
      op.admin ? '仅管理员。' : undefined,
      op.bodyLimit ? `请求体上限 ${op.bodyLimit}。` : undefined,
    ].filter(Boolean);
    (paths[path] ??= {})[op.method.toLowerCase()] = {
      operationId: `${op.method.toLowerCase()}${op.path.replace(/^\/api/, '').replace(/[/:.-]+([a-zA-Z])?/g, (_, c: string | undefined) => (c ?? '').toUpperCase())}`,
      tags: [op.tag],
      summary: op.summary,
      ...(notes.length ? { description: notes.join('\n\n') } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: op.body } } } } : {}),
      responses: {
        200: { description: '成功', content: { 'application/json': { schema: op.response ?? ok } } },
        ...(access === 'public' ? {} : { 401: errorResponse('未登录、令牌无效或已过期') }),
        ...(access !== 'public' ? { 403: errorResponse('无权访问：CSRF 校验失败、权限不足、只读令牌执行写操作，或令牌调用了仅限网页会话的接口') } : {}),
        429: errorResponse('验证失败次数过多'),
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
        '自托管网页转 RSS 服务的管理接口。错误统一返回 `{"error": string}`，响应不缓存。',
        '**访问令牌**：在“设置 → 访问令牌”创建，以 `Authorization: Bearer fl_…` 调用。令牌与所属账号的权限、工作台隔离完全一致；read 令牌只能调用 GET；令牌请求不需要 Cookie、`X-FeedLantern` 或 `X-CSRF-Token`。',
        '**网页会话**：Cookie 会话的写操作必须带 `X-FeedLantern: 1` 和 `X-CSRF-Token`，并校验 Host/Origin。',
        '`x-feedlantern-access` 标出每个接口的登录要求：public（无需登录）、session（仅网页会话）、read / write（网页会话或对应权限的令牌）。`x-feedlantern-token` 标出令牌所需权限，forbidden 表示令牌不能调用。',
      ].join('\n\n'),
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: origin }],
    tags: ['auth', 'meta', 'tokens', 'users', 'notifications', 'credentials', 'network-profiles', 'feeds', 'bundles', 'import-jobs', 'settings', 'backups', 'browser'].map(name => ({ name })),
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'fl_ personal access token', description: '个人访问令牌' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'feedlantern_session', description: '网页登录会话；写操作另需 X-FeedLantern: 1 与 X-CSRF-Token 请求头' },
      },
      parameters: {
        WorkspaceUser: { name: 'X-FeedLantern-User', in: 'header', required: false, schema: str(), description: '管理员可填写其他用户 ID，在该用户的工作台中操作；省略时为调用者自己的工作台' },
      },
    },
  };
}
