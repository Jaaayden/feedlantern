import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { API_TOKEN_LOG_LIMIT, API_TOKEN_LOG_PER_TOKEN, API_TOKEN_LOG_SCHEMA, ApiTokenLog } from '../src/server/api-token-log.js';
import type { ApiTokenCallPage, ApiTokenSummary } from '../src/shared/types.js';

const frame = (id: string) => ({ sessionId: id, image: '', width: 1, height: 1, viewportHeight: 1, documentHeight: 1, url: 'https://example.test/', title: 'test' });
const browser: BrowserServiceLike = {
  open: async () => frame(randomUUID()), snapshot: async id => frame(id),
  async scroll(id) { return this.snapshot(id); }, async click(id) { return this.snapshot(id); },
  pick: async () => ({ selector: 'article', rects: [], count: 1, sampleText: '' }), extract: async () => [],
  scrape: async () => [{ title: 'One', link: 'https://example.test/one' }], detect: async () => ({ candidates: [], recommendedId: null, warnings: [] }),
  close: async () => {}, dispose: async () => {},
};
const cookieHeaders = (store: Store, username: string, extra: Record<string, string> = {}) => {
  const session = store.createSession(username, 60_000);
  return { host: '127.0.0.1:4321', cookie: `feedlantern_session=${session.id}`, 'x-feedlantern': '1', 'x-csrf-token': session.csrfToken, ...extra };
};
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

async function setup(options: { trustedProxies?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fl-token-log-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const alice = store.createUser('alice', 'alice-password');
  store.createUser('bob', 'bob-password');
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false, ...options });
  const mint = async (username: string, scope: 'read' | 'write') => {
    const response = await app.inject({ method: 'POST', url: '/api/tokens', headers: cookieHeaders(store, username), payload: { name: `${username} 脚本`, scope } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { token: ApiTokenSummary; secret: string };
  };
  const logs = async (username: string, tokenId: string, query = '', extra: Record<string, string> = {}) =>
    app.inject({ url: `/api/tokens/${tokenId}/logs${query}`, headers: cookieHeaders(store, username, extra) });
  return { dir, store, app, alice, mint, logs, close: async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('带令牌的调用记录路由模板、状态码、耗时和来源 IP，不记录密钥和查询参数', async () => {
  const t = await setup();
  try {
    const { token, secret } = await t.mint('alice', 'read');
    const feed = t.store.createFeed({ name: 'alice feed', url: 'https://example.test/', rules: { item: 'a', title: 'a', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 }, t.alice.id).feed;
    assert.equal((await t.app.inject({ url: `/api/feeds/${feed.id}?secret=hunter2`, remoteAddress: '10.1.2.3', headers: bearer(secret) })).statusCode, 200);
    // A read token cannot write, and session-only routes stay closed: both are logged.
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/feeds/${feed.id}`, headers: bearer(secret) })).statusCode, 403);
    assert.equal((await t.app.inject({ url: '/api/tokens', headers: bearer(secret) })).statusCode, 403);
    assert.equal((await t.app.inject({ url: '/api/no-such-route?x=1', headers: bearer(secret) })).statusCode, 404);
    // Browser sessions are never logged.
    assert.equal((await t.app.inject({ url: '/api/feeds', headers: cookieHeaders(t.store, 'alice') })).statusCode, 200);

    const response = await t.logs('alice', token.id);
    assert.equal(response.statusCode, 200, response.body);
    const page = response.json() as ApiTokenCallPage;
    assert.deepEqual(page.calls.map(call => [call.method, call.route, call.status]), [
      ['GET', null, 404], ['GET', '/api/tokens', 403], ['DELETE', '/api/feeds/:id', 403], ['GET', '/api/feeds/:id', 200],
    ]);
    const first = page.calls.at(-1)!;
    assert.equal(first.ip, '10.1.2.3');
    assert.equal(first.tokenName, 'alice 脚本');
    assert.equal(first.tokenPrefix, token.prefix);
    assert.ok(first.durationMs >= 0 && Number.isInteger(first.durationMs));
    assert.ok(Math.abs(Date.parse(first.at) - Date.now()) < 60_000);
    assert.equal(page.retentionDays, 30);
    assert.equal(page.perTokenLimit, API_TOKEN_LOG_PER_TOKEN);
    assert.ok(!response.body.includes(secret.slice(12)) && !response.body.includes('hunter2') && !response.body.includes('no-such-route'));

    const db = new DatabaseSync(join(t.dir, 'app.db'));
    try {
      assert.ok(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) >= 19);
      const dump = JSON.stringify(db.prepare('SELECT * FROM api_token_logs').all());
      assert.ok(!dump.includes(secret.slice(12)) && !dump.includes('hunter2'));
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM api_token_logs').get()!.c, 4);
    } finally { db.close(); }

    const list = (await t.app.inject({ url: '/api/tokens', headers: cookieHeaders(t.store, 'alice') })).json() as ApiTokenSummary[];
    assert.deepEqual(list[0].usage24h, { calls: 4, failures: 3 });
  } finally { await t.close(); }
});

test('写令牌的写操作被记录，来源 IP 遵循可信代理设置', async () => {
  const t = await setup({ trustedProxies: ['127.0.0.1'] });
  try {
    const { token, secret } = await t.mint('alice', 'write');
    const created = await t.app.inject({ method: 'POST', url: '/api/feeds', remoteAddress: '127.0.0.1', headers: { ...bearer(secret), 'x-forwarded-for': '203.0.113.9' }, payload: { name: 'by token', url: 'https://example.test/', rules: { item: 'a', title: 'a', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 } });
    assert.equal(created.statusCode, 200, created.body);
    // An untrusted peer cannot choose the address that is logged.
    assert.equal((await t.app.inject({ url: '/api/feeds', remoteAddress: '198.51.100.4', headers: { ...bearer(secret), 'x-forwarded-for': '203.0.113.9' } })).statusCode, 200);
    const calls = ((await t.logs('alice', token.id)).json() as ApiTokenCallPage).calls;
    assert.deepEqual(calls.map(call => [call.method, call.route, call.status, call.ip]), [
      ['GET', '/api/feeds', 200, '198.51.100.4'], ['POST', '/api/feeds', 200, '203.0.113.9'],
    ]);
  } finally { await t.close(); }
});

test('过期令牌的 401 记在该令牌名下，未知令牌不记录', async () => {
  const t = await setup();
  try {
    const { token, secret } = await t.mint('alice', 'read');
    const db = new DatabaseSync(join(t.dir, 'app.db'));
    try { db.prepare('UPDATE api_tokens SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), token.id); } finally { db.close(); }
    assert.equal((await t.app.inject({ url: '/api/feeds', headers: bearer(secret) })).statusCode, 401);
    assert.equal((await t.app.inject({ url: '/api/feeds', headers: bearer(`fl_${'x'.repeat(43)}`) })).statusCode, 401);
    const calls = ((await t.logs('alice', token.id)).json() as ApiTokenCallPage).calls;
    assert.deepEqual(calls.map(call => [call.route, call.status]), [['/api/feeds', 401]]);
    const all = new DatabaseSync(join(t.dir, 'app.db'));
    try { assert.equal(all.prepare('SELECT COUNT(*) AS c FROM api_token_logs').get()!.c, 1); } finally { all.close(); }
  } finally { await t.close(); }
});

test('调用记录可按状态筛选并分页，吊销令牌时一并删除', async () => {
  const t = await setup();
  try {
    const { token, secret } = await t.mint('alice', 'read');
    for (let i = 0; i < 5; i++) await t.app.inject({ url: '/api/feeds', headers: bearer(secret) });
    await t.app.inject({ method: 'POST', url: '/api/feeds/bulk', headers: bearer(secret), payload: {} });
    await t.app.inject({ url: '/api/feeds/missing', headers: bearer(secret) });
    const statuses = async (query: string) => ((await t.logs('alice', token.id, query)).json() as ApiTokenCallPage).calls.map(call => call.status);
    assert.deepEqual(await statuses('?status=success'), [200, 200, 200, 200, 200]);
    assert.deepEqual(await statuses('?status=denied'), [403]);
    assert.deepEqual(await statuses('?status=error'), [404]);
    assert.equal((await t.logs('alice', token.id, '?status=bad')).statusCode, 400);
    assert.equal((await t.logs('alice', token.id, '?limit=500')).statusCode, 400);
    const first = (await t.logs('alice', token.id, '?limit=3')).json() as ApiTokenCallPage;
    assert.equal(first.calls.length, 3);
    assert.ok(first.nextCursor);
    const second = (await t.logs('alice', token.id, `?limit=3&cursor=${first.nextCursor}`)).json() as ApiTokenCallPage;
    assert.equal(second.calls.length, 3);
    assert.ok(second.calls[0].id < first.calls[2].id);
    const third = (await t.logs('alice', token.id, `?limit=3&cursor=${second.nextCursor}`)).json() as ApiTokenCallPage;
    assert.equal(third.calls.length, 1);
    assert.equal(third.nextCursor, null);

    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/tokens/${token.id}`, headers: cookieHeaders(t.store, 'alice') })).statusCode, 200);
    const db = new DatabaseSync(join(t.dir, 'app.db'));
    try { assert.equal(db.prepare('SELECT COUNT(*) AS c FROM api_token_logs').get()!.c, 0); } finally { db.close(); }
  } finally { await t.close(); }
});

test('只能查看自己的令牌记录；管理员可在用户工作台只读查看，但不能替他人创建或吊销', async () => {
  const t = await setup();
  try {
    const { token, secret } = await t.mint('alice', 'read');
    await t.app.inject({ url: '/api/feeds', headers: bearer(secret) });
    assert.equal((await t.logs('bob', token.id)).statusCode, 404);
    // A token can never read token logs, not even its own.
    assert.equal((await t.app.inject({ url: `/api/tokens/${token.id}/logs`, headers: bearer(secret) })).statusCode, 403);
    assert.equal((await t.logs('bob', token.id, '', { 'x-feedlantern-user': t.alice.id })).statusCode, 403);

    const asAdmin = { 'x-feedlantern-user': t.alice.id };
    const list = await t.app.inject({ url: '/api/tokens', headers: cookieHeaders(t.store, 'admin', asAdmin) });
    assert.equal(list.statusCode, 200);
    assert.deepEqual((list.json() as ApiTokenSummary[]).map(item => item.id), [token.id]);
    const logs = await t.logs('admin', token.id, '', asAdmin);
    assert.equal(logs.statusCode, 200);
    assert.deepEqual((logs.json() as ApiTokenCallPage).calls.map(call => call.status), [403, 200]);
    assert.equal((await t.logs('admin', token.id)).statusCode, 404, 'outside the workspace the token is not the admin’s');
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/tokens', headers: cookieHeaders(t.store, 'admin', asAdmin), payload: { name: 'x', scope: 'read' } })).statusCode, 403);
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/tokens/${token.id}`, headers: cookieHeaders(t.store, 'admin', asAdmin) })).statusCode, 403);
  } finally { await t.close(); }
});

test('批量写入：记录先进入内存，读取或到时才写库；按保留天数和条数上限清理', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-token-log-unit-'));
  const db = new DatabaseSync(join(dir, 'log.db'));
  try {
    db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE api_tokens (id TEXT PRIMARY KEY);`);
    db.exec(API_TOKEN_LOG_SCHEMA);
    db.exec("INSERT INTO api_tokens(id) VALUES ('a'),('b')");
    let days = 30;
    const log = new ApiTokenLog(db, () => days);
    const count = () => Number(db.prepare('SELECT COUNT(*) AS c FROM api_token_logs').get()!.c);
    const call = (tokenId: string, at = new Date().toISOString()) => ({ tokenId, userId: 'u', name: tokenId, prefix: 'fl_x', at, method: 'GET', route: '/api/feeds', status: 200, durationMs: 1.4, ip: '127.0.0.1' });
    log.record(call('a'));
    assert.equal(count(), 0, 'a request does not write to the database itself');
    assert.equal(log.list('u', 'a').calls.length, 1, 'reads flush first');
    // Calls of a token revoked before the flush are dropped.
    log.record(call('gone'));
    log.flush();
    assert.equal(count(), 1);

    for (let i = 0; i < API_TOKEN_LOG_PER_TOKEN + 50; i++) log.record(call('a'));
    log.flush();
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM api_token_logs WHERE token_id='a'").get()!.c), API_TOKEN_LOG_PER_TOKEN);

    // Many tokens, each under its own limit, together above the total limit.
    const insert = db.prepare("INSERT INTO api_token_logs(token_id,user_id,token_name,token_prefix,at,method,route,status,duration_ms,ip) VALUES (?,'u','t','fl_x',?,'GET',NULL,200,1,NULL)");
    db.exec('BEGIN');
    for (let i = 0; i < API_TOKEN_LOG_LIMIT; i++) {
      if (i % 1000 === 0) db.prepare('INSERT INTO api_tokens(id) VALUES (?)').run(`t${i / 1000}`);
      insert.run(`t${Math.floor(i / 1000)}`, new Date().toISOString());
    }
    db.exec('COMMIT');
    log.record(call('b'));
    log.flush();
    assert.equal(count(), API_TOKEN_LOG_LIMIT, 'the whole log stays under the total limit');

    // The oldest calls went first: those of token a.
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM api_token_logs WHERE token_id='a'").get()!.c), 0);

    db.exec(`UPDATE api_token_logs SET at='${new Date(Date.now() - 3 * 86_400_000).toISOString()}' WHERE token_id='t5'`);
    days = 2;
    assert.equal(log.prune(), 1000);
    assert.equal(count(), API_TOKEN_LOG_LIMIT - 1000);
    log.close();
    log.record(call('b'));
    log.flush();
    assert.equal(count(), API_TOKEN_LOG_LIMIT - 1000, 'nothing is recorded after close');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
