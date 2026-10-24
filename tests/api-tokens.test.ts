import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { SESSION_ONLY_ROUTES } from '../src/server/api-tokens.js';
import type { FeedInput } from '../src/shared/types.js';

const input: FeedInput = { name: 'private', url: 'https://example.test/articles', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 };
const item = { title: 'Original', link: 'https://example.test/one' };
const frame = (id: string) => ({ sessionId: id, image: '', width: 1, height: 1, viewportHeight: 1, documentHeight: 1, url: input.url, title: 'test' });
const browser: BrowserServiceLike = {
  open: async () => frame(randomUUID()), snapshot: async id => frame(id),
  async scroll(id) { return this.snapshot(id); }, async click(id) { return this.snapshot(id); },
  pick: async () => ({ selector: 'article', rects: [], count: 1, sampleText: '' }), extract: async () => [item],
  scrape: async () => [item], detect: async () => ({ candidates: [], recommendedId: null, warnings: [] }),
  close: async () => {}, dispose: async () => {},
};
const cookieHeaders = (store: Store, username: string) => {
  const session = store.createSession(username, 60_000);
  return { host: '127.0.0.1:4321', cookie: `feedlantern_session=${session.id}`, 'x-feedlantern': '1', 'x-csrf-token': session.csrfToken };
};
const bearer = (secret: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${secret}`, ...extra });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fl-tokens-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const alice = store.createUser('alice', 'alice-password'), bob = store.createUser('bob', 'bob-password');
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false });
  const mint = async (username: string, scope: 'read' | 'write', extra: Record<string, unknown> = {}) => {
    const response = await app.inject({ method: 'POST', url: '/api/tokens', headers: cookieHeaders(store, username), payload: { name: `${username}-${scope}`, scope, ...extra } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { token: { id: string; prefix: string; expiresAt: string | null }; secret: string };
  };
  return { dir, store, app, alice, bob, mint, close: async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('令牌只在创建时返回一次，数据库只保存哈希', async () => {
  const t = await setup();
  try {
    const created = await t.mint('alice', 'read', { expiresInDays: 30 });
    assert.match(created.secret, /^fl_[A-Za-z0-9_-]{43}$/);
    assert.ok(created.secret.startsWith(created.token.prefix));
    assert.ok(Math.abs(Date.parse(created.token.expiresAt!) - Date.now() - 30 * 86_400_000) < 60_000);
    const list = await t.app.inject({ url: '/api/tokens', headers: cookieHeaders(t.store, 'alice') });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 1);
    assert.ok(!list.body.includes(created.secret));
    assert.equal(list.json()[0].lastUsedAt, null);
    assert.deepEqual((await t.app.inject({ url: '/api/tokens', headers: cookieHeaders(t.store, 'bob') })).json(), []);
    // Neither the raw secret nor its random part is stored.
    const raw = readFileSync(join(t.dir, 'app.db')).toString('latin1') + (() => { try { return readFileSync(join(t.dir, 'app.db-wal')).toString('latin1'); } catch { return ''; } })();
    assert.ok(!raw.includes(created.secret.slice(12)));
    const db = new DatabaseSync(join(t.dir, 'app.db'));
    try {
      assert.ok(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) >= 11);
      const row = db.prepare('SELECT token_hash, prefix FROM api_tokens').get() as Record<string, string>;
      assert.match(row.token_hash, /^[a-f0-9]{64}$/);
      assert.equal(row.prefix, created.token.prefix);
    } finally { db.close(); }
    // Using the token records when it was last used.
    assert.equal((await t.app.inject({ url: '/api/feeds', headers: bearer(created.secret) })).statusCode, 200);
    assert.ok((await t.app.inject({ url: '/api/tokens', headers: cookieHeaders(t.store, 'alice') })).json()[0].lastUsedAt);
    // Validation.
    const alice = cookieHeaders(t.store, 'alice');
    for (const payload of [{ name: '', scope: 'read' }, { name: 'x', scope: 'admin' }, { name: 'x', scope: 'read', expiresInDays: 0 }, { name: 'x', scope: 'read', expiresInDays: 1.5 }, { name: 'x'.repeat(101), scope: 'read' }]) {
      assert.equal((await t.app.inject({ method: 'POST', url: '/api/tokens', headers: alice, payload })).statusCode, 400, JSON.stringify(payload));
    }
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/tokens', headers: { ...alice, 'x-csrf-token': 'wrong' }, payload: { name: 'x', scope: 'read' } })).statusCode, 403);
  } finally { await t.close(); }
});

test('Bearer 请求按令牌所属用户鉴权，工作台隔离与 Cookie 会话一致', async () => {
  const t = await setup();
  try {
    const own = t.store.createFeed(input, t.alice.id).feed, other = t.store.createFeed(input, t.bob.id).feed;
    const alice = (await t.mint('alice', 'write')).secret, admin = (await t.mint('admin', 'write')).secret;
    // No cookie, no Host/Origin match, no X-FeedLantern or CSRF headers are needed.
    const list = await t.app.inject({ url: '/api/feeds', headers: bearer(alice, { host: 'scripts.internal:9999', origin: 'https://elsewhere.example' }) });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json().map((f: { id: string }) => f.id), [own.id]);
    assert.equal((await t.app.inject({ url: `/api/feeds/${other.id}`, headers: bearer(alice) })).statusCode, 404);
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/feeds/${other.id}`, headers: bearer(alice) })).statusCode, 404);
    assert.equal((await t.app.inject({ url: '/api/feeds', headers: bearer(alice, { 'x-feedlantern-user': t.bob.id }) })).statusCode, 403);
    assert.equal((await t.app.inject({ url: '/api/users', headers: bearer(alice) })).statusCode, 403);
    assert.equal((await t.app.inject({ url: '/api/settings', headers: bearer(alice) })).statusCode, 403);
    // An admin token acts on the admin's own workspace unless the request names another one, as the web UI does.
    assert.deepEqual((await t.app.inject({ url: '/api/feeds', headers: bearer(admin) })).json(), []);
    assert.deepEqual((await t.app.inject({ url: '/api/feeds', headers: bearer(admin, { 'x-feedlantern-user': t.bob.id }) })).json().map((f: { id: string }) => f.id), [other.id]);
    assert.equal((await t.app.inject({ url: '/api/users', headers: bearer(admin) })).statusCode, 200);
    // Writes work with a write token and land in the owner's workspace.
    const created = await t.app.inject({ method: 'POST', url: '/api/feeds', headers: bearer(alice), payload: { ...input, name: 'via token' } });
    assert.equal(created.statusCode, 200, created.body);
    assert.ok(t.store.owns('feeds', created.json().feed.id, t.alice.id));
    const patched = await t.app.inject({ method: 'PATCH', url: `/api/feeds/${own.id}`, headers: bearer(alice), payload: { intervalMinutes: 120 } });
    assert.equal(patched.json().feed.intervalMinutes, 120);
    // Whoami.
    const status = (await t.app.inject({ url: '/api/auth/status', headers: bearer(alice) })).json();
    assert.equal(status.authenticated, true); assert.equal(status.userId, t.alice.id); assert.equal(status.tokenScope, 'write'); assert.equal(status.csrfToken, undefined);
  } finally { await t.close(); }
});

test('read 令牌拒绝写操作，令牌不能调用仅限网页会话的接口', async () => {
  const t = await setup();
  try {
    const own = t.store.createFeed(input, t.alice.id).feed;
    const read = (await t.mint('alice', 'read')).secret, admin = (await t.mint('admin', 'write')).secret;
    assert.equal((await t.app.inject({ url: `/api/feeds/${own.id}`, headers: bearer(read) })).statusCode, 200);
    assert.equal((await t.app.inject({ url: `/api/feeds/${own.id}/logs`, headers: bearer(read) })).statusCode, 200);
    for (const [method, url] of [['POST', '/api/feeds'], ['PATCH', `/api/feeds/${own.id}`], ['DELETE', `/api/feeds/${own.id}`], ['POST', `/api/feeds/${own.id}/refresh`], ['PUT', '/api/notifications/bark'], ['POST', '/api/browser']] as const) {
      const response = await t.app.inject({ method, url, headers: bearer(read), payload: {} });
      assert.equal(response.statusCode, 403, `${method} ${url}`);
      assert.match(response.json().error, /只读令牌/);
    }
    assert.ok(t.store.getFeed(own.id));
    // An encoded path still routes to /api/*, and is checked the same way.
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/%61pi/feeds/${own.id}`, headers: bearer(read) })).statusCode, 403);
    assert.equal((await t.app.inject({ method: 'PATCH', url: `/%61pi/users/${t.bob.id}`, headers: bearer(admin), payload: { enabled: false } })).statusCode, 403);
    assert.equal((await t.app.inject({ method: 'POST', url: '/%61pi/tokens', headers: bearer(admin), payload: { name: 'x', scope: 'write' } })).statusCode, 403);
    assert.ok(t.store.getFeed(own.id));
    for (const route of SESSION_ONLY_ROUTES) {
      const [method, path] = route.split(' ') as ['GET' | 'POST' | 'PATCH' | 'DELETE', string];
      const response = await t.app.inject({ method, url: path.replace(':id', t.bob.id), headers: bearer(admin), ...(method !== 'GET' ? { payload: {} } : {}) });
      assert.equal(response.statusCode, 403, route);
      assert.match(response.json().error, /网页登录/, route);
    }
    assert.equal(t.store.getUser(t.bob.id)?.enabled, true);
    assert.equal(t.store.tokens.list(t.alice.id).length, 1);
  } finally { await t.close(); }
});

test('无效令牌返回 401 并限速；Bearer 不回退到 Cookie，其他认证方案不影响 Cookie 会话', async () => {
  const t = await setup();
  try {
    const valid = (await t.mint('alice', 'read')).secret, cookie = cookieHeaders(t.store, 'alice');
    const bad = await t.app.inject({ url: '/api/feeds', headers: bearer('fl_' + 'x'.repeat(43)) });
    assert.equal(bad.statusCode, 401);
    assert.match(String(bad.headers['www-authenticate']), /^Bearer/);
    // A broken bearer header is rejected even when a valid session cookie is present.
    assert.equal((await t.app.inject({ url: '/api/feeds', headers: { ...cookie, authorization: 'Bearer nope' } })).statusCode, 401);
    assert.equal((await t.app.inject({ url: '/api/feeds', headers: { ...cookie, authorization: 'Bearer' } })).statusCode, 401);
    // A reverse proxy's Basic credentials leave the cookie session alone.
    assert.equal((await t.app.inject({ url: '/api/feeds', headers: { ...cookie, authorization: 'Basic dXNlcjpwYXNz' } })).statusCode, 200);
    // Cookie sessions keep their browser checks.
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/feeds', headers: { ...cookie, 'x-csrf-token': '' }, payload: input })).statusCode, 403);
    assert.equal((await t.app.inject({ url: '/api/feeds', headers: { ...cookie, origin: 'https://evil.example' } })).statusCode, 403);
    assert.equal((await t.app.inject({ url: '/api/feeds', headers: { ...cookie, host: 'evil.example' } })).statusCode, 403);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/feeds', headers: { ...cookie, 'x-feedlantern': '' }, payload: input })).statusCode, 400);
    // 20 failures from one address lock it out, valid tokens included; other addresses are unaffected.
    for (let i = 0; i < 18; i++) assert.equal((await t.app.inject({ url: '/api/feeds', remoteAddress: '10.0.0.7', headers: bearer(`fl_guess${i}`) })).statusCode, 401);
    assert.equal((await t.app.inject({ url: '/api/feeds', remoteAddress: '10.0.0.7', headers: bearer(valid) })).statusCode, 200);
    for (let i = 0; i < 2; i++) assert.equal((await t.app.inject({ url: '/api/feeds', remoteAddress: '10.0.0.7', headers: bearer('fl_again') })).statusCode, 401);
    assert.equal((await t.app.inject({ url: '/api/feeds', remoteAddress: '10.0.0.7', headers: bearer(valid) })).statusCode, 429);
    assert.equal((await t.app.inject({ url: '/api/feeds', remoteAddress: '10.0.0.8', headers: bearer(valid) })).statusCode, 200);
  } finally { await t.close(); }
});

test('吊销、过期、停用、改密、删除账号和恢复备份都会让令牌失效', async () => {
  const t = await setup();
  try {
    const admin = cookieHeaders(t.store, 'admin');
    const ok = async (secret: string) => (await t.app.inject({ url: '/api/feeds', headers: bearer(secret) })).statusCode;
    // Revoking: only the owner can, and the token stops working at once.
    const first = await t.mint('alice', 'read');
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/tokens/${first.token.id}`, headers: cookieHeaders(t.store, 'bob') })).statusCode, 404);
    assert.equal(await ok(first.secret), 200);
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/tokens/${first.token.id}`, headers: cookieHeaders(t.store, 'alice') })).statusCode, 200);
    assert.equal(await ok(first.secret), 401);
    // Expiry.
    const expired = t.store.tokens.create(t.alice.id, { name: 'old', scope: 'read', expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(await ok(expired.secret), 401);
    assert.equal(t.store.tokens.purgeExpired(Date.now() + 31 * 86_400_000), 1);
    // Disabling stays revoked after re-enabling, like sessions.
    const disabled = await t.mint('alice', 'read');
    assert.equal((await t.app.inject({ method: 'PATCH', url: `/api/users/${t.alice.id}`, headers: admin, payload: { enabled: false } })).statusCode, 200);
    assert.equal(await ok(disabled.secret), 401);
    assert.equal((await t.app.inject({ method: 'PATCH', url: `/api/users/${t.alice.id}`, headers: admin, payload: { enabled: true } })).statusCode, 200);
    assert.equal(await ok(disabled.secret), 401);
    // Own password change and an admin reset.
    const own = await t.mint('alice', 'read');
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/password', headers: cookieHeaders(t.store, 'alice'), payload: { currentPassword: 'alice-password', newPassword: 'alice-password-2' } })).statusCode, 200);
    assert.equal(await ok(own.secret), 401);
    const reset = await t.mint('alice', 'read');
    assert.equal((await t.app.inject({ method: 'POST', url: `/api/users/${t.alice.id}/password`, headers: admin, payload: { password: 'alice-password-3' } })).statusCode, 200);
    assert.equal(await ok(reset.secret), 401);
    // Deleting the account.
    const bobToken = await t.mint('bob', 'write');
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/users/${t.bob.id}`, headers: admin, payload: { username: 'bob' } })).statusCode, 200);
    assert.equal(await ok(bobToken.secret), 401);
    // A restore replaces every account, so no token survives it.
    const adminToken = await t.mint('admin', 'read');
    t.store.restoreTables(t.store.exportTables());
    assert.equal(await ok(adminToken.secret), 401);
    assert.deepEqual(t.store.tokens.list('admin'), []);
  } finally { await t.close(); }
});

test('每个账号最多 50 个令牌', async () => {
  const t = await setup();
  try {
    for (let i = 0; i < 50; i++) t.store.tokens.create(t.alice.id, { name: `t${i}`, scope: 'read', expiresAt: null });
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/tokens', headers: cookieHeaders(t.store, 'alice'), payload: { name: 'one more', scope: 'read' } })).statusCode, 409);
  } finally { await t.close(); }
});

test('错误响应带机器可读的 code，令牌可以查看自己的摘要和调用记录', async () => {
  const t = await setup();
  try {
    const read = await t.mint('alice', 'read'), write = await t.mint('alice', 'write'), other = await t.mint('bob', 'write');
    const denied = await t.app.inject({ method: 'POST', url: '/api/feeds', headers: bearer(read.secret), payload: input });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().code, 'token_read_only');
    const sessionOnly = await t.app.inject({ url: '/api/tokens', headers: bearer(write.secret) });
    assert.equal(sessionOnly.statusCode, 403);
    assert.equal(sessionOnly.json().code, 'token_not_allowed');
    const invalid = await t.app.inject({ url: '/api/feeds', headers: bearer(`fl_${'x'.repeat(43)}`) });
    assert.equal(invalid.statusCode, 401);
    assert.equal(invalid.json().code, 'unauthorized');
    const missing = await t.app.inject({ url: '/api/feeds/nope', headers: bearer(read.secret) });
    assert.deepEqual([missing.statusCode, missing.json().code], [404, 'not_found']);
    const invalidBody = await t.app.inject({ method: 'POST', url: '/api/feeds', headers: bearer(write.secret), payload: { name: '' } });
    assert.deepEqual([invalidBody.statusCode, invalidBody.json().code], [400, 'validation']);

    const current = await t.app.inject({ url: '/api/tokens/current', headers: bearer(read.secret) });
    assert.equal(current.statusCode, 200, current.body);
    assert.equal(current.json().id, read.token.id);
    assert.equal(current.json().scope, 'read');
    assert.ok(!current.body.includes(read.secret));
    assert.ok(current.json().usage24h.calls >= 2);
    const logs = await t.app.inject({ url: '/api/tokens/current/logs?status=denied', headers: bearer(read.secret) });
    assert.equal(logs.statusCode, 200, logs.body);
    const calls = logs.json().calls as Array<{ tokenId: string; status: number; route: string }>;
    assert.ok(calls.length >= 1);
    assert.ok(calls.every(call => call.tokenId === read.token.id && [401, 403, 429].includes(call.status)));
    assert.ok(calls.some(call => call.route === '/api/feeds' && call.status === 403));
    // Only the presenting token's own calls, never another token's.
    const bobLogs = await t.app.inject({ url: '/api/tokens/current/logs', headers: bearer(other.secret) });
    assert.ok((bobLogs.json().calls as Array<{ tokenId: string }>).every(call => call.tokenId === other.token.id));
    assert.equal((await t.app.inject({ url: '/api/tokens/current/logs?limit=0', headers: bearer(read.secret) })).statusCode, 400);
    // A browser session has no current token.
    const browserSession = await t.app.inject({ url: '/api/tokens/current', headers: cookieHeaders(t.store, 'alice') });
    assert.deepEqual([browserSession.statusCode, browserSession.json().code], [400, 'validation']);
  } finally { await t.close(); }
});
