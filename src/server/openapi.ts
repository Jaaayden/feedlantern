import { API_TOKEN_MAX_DAYS, tokenAllowedRoute } from './api-tokens.js';

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
const translationMode = str({ enum: ['original', 'chinese', 'bilingual'] });

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
  }, ['id', 'name', 'scope', 'prefix', 'createdAt', 'expiresAt', 'lastUsedAt']),
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
    sourceType: str({ enum: ['website', 'rss'], default: 'website' }), translationMode,
    name: str({ minLength: 1 }), url: str({ format: 'uri' }), rules: ref('SelectionRules'),
    ruleOrigins: { type: 'object', additionalProperties: str({ enum: ['auto', 'manual'] }) },
    credentialId: nullable(str()), intervalMinutes: int({ minimum: 5, maximum: 1440 }), waitMs: int({ minimum: 0, maximum: 10000 }), waitForSelector: str(),
  }, ['name', 'url', 'rules', 'credentialId', 'intervalMinutes', 'waitMs']),
  FeedSettingsInput: object({ translationMode, channelTitle: str({ minLength: 1, maxLength: 200 }), intervalMinutes: int({ minimum: 5, maximum: 1440 }) }, [], { description: '至少提供一个字段' }),
  Feed: { allOf: [ref('FeedInput'), object({
    id: str(), ownerId: str(), channelTitle: str(), enabled: bool, createdAt: dateTime, lastFetchedAt: nullable(dateTime), lastSuccessAt: nullable(dateTime),
    nextFetchAt: dateTime, lastError: nullable(str()), itemCount: int(), translation: object({ pending: int(), success: int(), failed: int() }),
  }, ['id', 'enabled', 'createdAt', 'lastFetchedAt', 'lastSuccessAt', 'nextFetchAt', 'lastError', 'itemCount'])] },
  FeedItem: object({
    id: str(), title: str(), link: str(), description: str(), image: str(), publishedAt: dateTime, publishedAtSource: str({ enum: ['absolute', 'relative'] }),
    firstSeenAt: dateTime, contentHtml: str(), translationStatus: str({ enum: ['pending', 'success', 'failed'] }), translationError: str(),
  }, ['title', 'link']),
  FeedPayload: object({ feed: ref('Feed'), feedUrl: str({ format: 'uri', description: '带密钥的 RSS 地址' }) }, ['feed', 'feedUrl']),
  FeedDetail: { allOf: [ref('FeedPayload'), object({ items: array(ref('FeedItem')) }, ['items'])] },
  FetchLogPage: object({ logs: array({ type: 'object' }), nextCursor: nullable(str()), retentionDays: int() }, ['logs', 'nextCursor', 'retentionDays']),
  CredentialInput: object({ name: str({ minLength: 1 }), url: str({ format: 'uri' }), format: str({ enum: ['header', 'json'] }), value: { description: 'Cookie 请求头文本或 Cookie JSON' } }, ['name', 'url', 'format', 'value']),
  CredentialSummary: object({ id: str(), name: str(), url: str(), format: str({ enum: ['header', 'json'] }), domains: array(str()), count: int(), updatedAt: dateTime, expiresAt: nullable(dateTime) }, ['id', 'name', 'url', 'format', 'domains', 'count', 'updatedAt', 'expiresAt']),
  BarkSettings: object({
    enabled: bool, url: str(), failureThreshold: int(), timeoutSeconds: int(), maxAttempts: int(), retryDelaySeconds: int(), laterRetryDelaySeconds: int(), cooldownMinutes: int(),
  }),
  BarkSummary: object({
    enabled: bool, configured: bool, maskedUrl: str(), failureThreshold: int(), timeoutSeconds: int(), maxAttempts: int(), retryDelaySeconds: int(), laterRetryDelaySeconds: int(), cooldownMinutes: int(),
  }),
  ApplicationSettings: object({
    translation: object({ concurrency: int(), requestIntervalMs: int() }), feedView: str({ enum: ['list', 'cards'] }), logRetentionDays: int(),
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
    target: str({ enum: ['item', 'title', 'link', 'description', 'image', 'date'] }), node: int(), x: { type: 'number' }, y: { type: 'number' },
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
  { method: 'GET', path: '/api/tokens', tag: 'tokens', summary: '列出自己的访问令牌', response: array(ref('ApiToken')) },
  { method: 'POST', path: '/api/tokens', tag: 'tokens', summary: '创建访问令牌', description: '完整令牌只在响应中出现一次；每个账号最多 50 个。', body: ref('ApiTokenInput'), response: ref('ApiTokenCreated') },
  { method: 'DELETE', path: '/api/tokens/:id', tag: 'tokens', summary: '吊销访问令牌', response: ok },
  // Users
  { method: 'GET', path: '/api/users', tag: 'users', summary: '列出用户及统计', admin: true, response: array(ref('UserSummary')) },
  { method: 'POST', path: '/api/users', tag: 'users', summary: '创建普通用户', admin: true, body: object({ username: str(), password: str({ minLength: 8 }) }, ['username', 'password']), response: ref('UserSummary') },
  { method: 'PATCH', path: '/api/users/:id', tag: 'users', summary: '修改用户名、启用状态或角色', description: '停用或身份变化会撤销目标账号的会话和访问令牌。', admin: true, body: object({ username: str(), enabled: bool, role: str({ enum: ['admin', 'user'] }) }), response: ref('UserSummary') },
  { method: 'POST', path: '/api/users/:id/password', tag: 'users', summary: '重置其他用户的密码', admin: true, body: object({ password: str({ minLength: 8 }) }, ['password']), response: ok },
  { method: 'GET', path: '/api/users/:id/deletion-preview', tag: 'users', summary: '删除用户前的影响预览', admin: true, response: object({ user: ref('UserSummary'), feeds: int(), credentials: int(), jobs: int() }) },
  { method: 'DELETE', path: '/api/users/:id', tag: 'users', summary: '删除用户及其全部数据', admin: true, body: object({ username: str({ description: '输入目标用户名确认' }) }, ['username']), response: ok },
  // Notifications
  { method: 'GET', path: '/api/notifications/bark', tag: 'notifications', summary: '个人 Bark 通知设置', workspace: true, response: ref('BarkSummary') },
  { method: 'PUT', path: '/api/notifications/bark', tag: 'notifications', summary: '保存个人 Bark 通知设置', workspace: true, body: ref('BarkSettings'), response: ref('BarkSummary') },
  { method: 'POST', path: '/api/notifications/bark/test', tag: 'notifications', summary: '发送个人测试通知', workspace: true, body: ref('BarkSettings'), response: ok },
  // Credentials
  { method: 'GET', path: '/api/credentials', tag: 'credentials', summary: '列出 Cookie 凭据（不含明文）', workspace: true, response: array(ref('CredentialSummary')) },
  { method: 'POST', path: '/api/credentials', tag: 'credentials', summary: '添加 Cookie 凭据', workspace: true, body: ref('CredentialInput'), response: ref('CredentialSummary') },
  { method: 'PUT', path: '/api/credentials/:id', tag: 'credentials', summary: '更新 Cookie 凭据', workspace: true, body: ref('CredentialInput'), response: ref('CredentialSummary') },
  { method: 'DELETE', path: '/api/credentials/:id', tag: 'credentials', summary: '删除 Cookie 凭据', description: '仍被订阅引用时返回 409。', workspace: true, response: ok },
  // Feeds
  { method: 'GET', path: '/api/feeds', tag: 'feeds', summary: '列出订阅', workspace: true, response: array(ref('Feed')) },
  { method: 'POST', path: '/api/feeds', tag: 'feeds', summary: '创建订阅', description: '网页订阅会立即抓取一次后返回；RSS 订阅在后台抓取。', workspace: true, body: ref('FeedInput'), response: ref('FeedPayload') },
  { method: 'POST', path: '/api/feeds/bulk', tag: 'feeds', summary: '批量操作', workspace: true, body: object({ ids: array(str(), { minItems: 1, maxItems: 200 }), action: str({ enum: ['copy', 'pause', 'resume', 'refresh', 'delete', 'settings'] }), settings: object({ translationMode, intervalMinutes: int({ minimum: 5, maximum: 1440 }) }) }, ['ids', 'action']), response: ref('BulkResult') },
  { method: 'GET', path: '/api/feeds/:id', tag: 'feeds', summary: '订阅详情和最近 200 条条目', workspace: true, response: ref('FeedDetail') },
  { method: 'PUT', path: '/api/feeds/:id', tag: 'feeds', summary: '替换订阅的网址和规则', description: '启用中的订阅会立即重新抓取。', workspace: true, body: ref('FeedInput'), response: ref('FeedPayload') },
  { method: 'PATCH', path: '/api/feeds/:id', tag: 'feeds', summary: '修改名称、刷新间隔或翻译输出', workspace: true, body: ref('FeedSettingsInput'), response: ref('FeedPayload') },
  { method: 'DELETE', path: '/api/feeds/:id', tag: 'feeds', summary: '删除订阅', workspace: true, response: ok },
  { method: 'POST', path: '/api/feeds/:id/refresh', tag: 'feeds', summary: '立即抓取', workspace: true, response: ref('FeedPayload') },
  { method: 'POST', path: '/api/feeds/:id/toggle', tag: 'feeds', summary: '暂停或恢复', workspace: true, response: ref('FeedPayload') },
  { method: 'POST', path: '/api/feeds/:id/rotate-token', tag: 'feeds', summary: '更换 RSS 地址密钥', description: '旧 RSS 地址立即失效。', workspace: true, response: ref('FeedPayload') },
  { method: 'GET', path: '/api/feeds/:id/logs', tag: 'feeds', summary: '抓取日志（分页）', workspace: true, query: [
    { name: 'status', schema: str({ enum: ['running', 'success', 'failure', 'interrupted'] }) },
    { name: 'cursor', schema: str({ pattern: '^[1-9][0-9]*$' }), description: '上一页的 nextCursor' },
    { name: 'limit', schema: int({ minimum: 1, maximum: 100, default: 20 }) },
  ], response: ref('FetchLogPage') },
  { method: 'GET', path: '/api/feeds/:id/translation/progress', tag: 'feeds', summary: 'RSS 翻译进度', workspace: true, response: { type: 'object' } },
  { method: 'POST', path: '/api/feeds/:id/translation/retry', tag: 'feeds', summary: '重试失败的翻译', workspace: true, response: ref('FeedPayload') },
  { method: 'POST', path: '/api/rss/preview', tag: 'feeds', summary: '预览 RSS 源的前 3 条', workspace: true, body: object({ url: str({ format: 'uri' }) }, ['url']), response: object({ title: str(), items: array(ref('ExtractedItem')) }) },
  // Import jobs
  { method: 'GET', path: '/api/import-jobs', tag: 'import-jobs', summary: '列出批量添加任务', workspace: true, response: array(ref('ImportJob')) },
  { method: 'POST', path: '/api/import-jobs', tag: 'import-jobs', summary: '创建批量添加任务', workspace: true, body: object({
    entries: array(object({ url: str({ format: 'uri' }), credentialId: nullable(str()) }, ['url']), { minItems: 1, maxItems: 100 }),
    intervalMinutes: int({ minimum: 5, maximum: 1440, default: 60 }), sourceType: str({ enum: ['website', 'rss'] }), translationMode: str({ enum: ['chinese', 'bilingual'] }),
  }, ['entries']), response: ref('ImportJob') },
  { method: 'POST', path: '/api/import-jobs/:id/:action', tag: 'import-jobs', summary: '取消、重试或确认任务中的网址', description: 'confirm 需要 entryId 和完整 input，返回 FeedPayload；cancel/retry 返回 ImportJob。', workspace: true,
    params: { action: str({ enum: ['confirm', 'cancel', 'retry'] }) }, body: object({ entryId: str(), input: ref('FeedInput') }), response: { oneOf: [ref('ImportJob'), ref('FeedPayload')] } },
  // Settings
  { method: 'GET', path: '/api/settings', tag: 'settings', summary: '全局应用设置', admin: true, response: ref('ApplicationSettings') },
  { method: 'PUT', path: '/api/settings', tag: 'settings', summary: '修改全局应用设置（局部合并）', admin: true, body: ref('ApplicationSettings'), response: ref('ApplicationSettings') },
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
  { method: 'POST', path: '/api/browser', tag: 'browser', summary: '打开网页编辑会话', workspace: true, body: object({ url: str({ format: 'uri' }), credentialId: nullable(str()), waitMs: int({ minimum: 0, maximum: 10000 }), waitForSelector: str() }, ['url']), response: ref('ScreenFrame') },
  { method: 'GET', path: '/api/browser/:id', tag: 'browser', summary: '重新截取第一段画面', workspace: true, response: ref('ScreenFrame') },
  { method: 'DELETE', path: '/api/browser/:id', tag: 'browser', summary: '关闭编辑会话', workspace: true, response: ok },
  { method: 'POST', path: '/api/browser/:id/scroll', tag: 'browser', summary: '滚动页面内部区域', workspace: true, body: object({ deltaY: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } }, ['deltaY']), response: ref('ScreenFrame') },
  { method: 'POST', path: '/api/browser/:id/click', tag: 'browser', summary: '点击坐标', workspace: true, body: object({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']), response: ref('ScreenFrame') },
  { method: 'POST', path: '/api/browser/:id/pick', tag: 'browser', summary: '点选元素生成选择器', workspace: true, body: ref('PickRequest'), response: ref('PickResult') },
  { method: 'POST', path: '/api/browser/:id/segment', tag: 'browser', summary: '截取下一段画面', workspace: true, body: object({ top: int({ minimum: 1 }) }, ['top']), response: ref('SegmentResult') },
  { method: 'POST', path: '/api/browser/:id/follow', tag: 'browser', summary: '打开元素上的链接', workspace: true, body: object({ node: int({ minimum: 0 }) }, ['node']), response: ref('ScreenFrame') },
  { method: 'POST', path: '/api/browser/:id/preview', tag: 'browser', summary: '按规则预览条目', workspace: true, body: object({ rules: ref('SelectionRules') }, ['rules']), response: object({ items: array(ref('ExtractedItem')) }) },
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
    tags: ['auth', 'meta', 'tokens', 'users', 'notifications', 'credentials', 'feeds', 'import-jobs', 'settings', 'backups', 'browser'].map(name => ({ name })),
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
