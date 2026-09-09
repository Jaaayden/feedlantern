import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type BrowserServiceLike } from '../src/server/app.js';
const browser: BrowserServiceLike = {
  open() { throw Error('unexpected'); }, snapshot() { throw Error('unexpected'); }, scroll() { throw Error('unexpected'); }, click() { throw Error('unexpected'); }, pick() { throw Error('unexpected'); }, extract() { throw Error('unexpected'); },
  scrape: async () => [{ title: 'Article', link: 'https://example.test/article' }], close() {}, dispose() {},
};
test('新管理 API 权限、名称缓存、批量结果、配置合并及完整恢复撤销会话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-management-'));
  const app = await createApp({ dataDir: dir, browserService: browser, startScheduler: false });
  const base = { host: '127.0.0.1:4321', 'x-feedlantern': '1' };
  try {
    for (const url of ['/api/settings', '/api/import-jobs', '/api/backups/config']) assert.equal((await app.inject({ url, headers: base })).statusCode, 401);
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: base, payload: { setupToken: readFileSync(join(dir, 'setup-token'), 'utf8').trim(), username: 'admin', password: 'test-password' } });
    const headers = { ...base, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-csrf-token': setup.json().csrfToken };
    const input = { name: 'manager', url: 'https://example.test', rules: { item: 'article', title: 'h2', link: 'a' } };
    const create = await app.inject({ method: 'POST', url: '/api/feeds', headers, payload: input });
    const { feed, feedUrl } = create.json(), path = new URL(feedUrl).pathname;
    const before = await app.inject({ url: path });
    const denied = await app.inject({ method: 'PATCH', url: `/api/feeds/${feed.id}`, headers: base, payload: { channelTitle: 'reader' } });
    assert.equal(denied.statusCode, 401);
    for (const channelTitle of ['', 'x'.repeat(201)]) assert.equal((await app.inject({ method: 'PATCH', url: `/api/feeds/${feed.id}`, headers, payload: { channelTitle } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/feeds/${feed.id}`, headers, payload: { channelTitle: 'reader & title' } })).statusCode, 200);
    const after = await app.inject({ url: path, headers: { 'if-none-match': before.headers.etag as string } });
    assert.equal(after.statusCode, 200); assert.match(after.body, /reader &amp; title/);
    const detail = (await app.inject({ url: `/api/feeds/${feed.id}`, headers })).json();
    assert.equal(detail.feed.name, 'reader & title');
    assert.equal(detail.feed.name, detail.feed.channelTitle);
    const bulk = await app.inject({ method: 'POST', url: '/api/feeds/bulk', headers, payload: { ids: [feed.id, 'missing'], action: 'pause' } });
    assert.deepEqual(bulk.json().results.map((r: { ok: boolean }) => r.ok), [true, false]);
    const config = (await app.inject({ url: '/api/backups/config', headers })).json();
    assert.ok(!JSON.stringify(config).includes('token'));
    const imported = await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: config, confirm: true } });
    assert.deepEqual(imported.json(), { created: 0, skipped: 1 });
    const archive = await app.inject({ method: 'POST', url: '/api/backups/export', headers, payload: { currentPassword: 'test-password', password: 'long-backup-password' } });
    assert.equal(archive.statusCode, 200);
    const body = { archive: archive.json(), currentPassword: 'test-password', password: 'long-backup-password', confirm: true };
    const preview = await app.inject({ method: 'POST', url: '/api/backups/preview', headers, payload: body });
    assert.equal(preview.statusCode, 200); assert.equal(preview.json().feeds, 1);
    const invalid = await app.inject({ method: 'POST', url: '/api/backups/restore', headers, payload: { ...body, password: 'wrong-backup-password' } });
    assert.equal(invalid.statusCode, 400); assert.equal((await app.inject({ url: path })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/backups/restore', headers, payload: body })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/feeds', headers })).statusCode, 401);
    assert.equal((await app.inject({ url: path })).statusCode, 200);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('空实例使用本机设置码恢复，不需要临时管理员', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-setup-restore-'));
  const source = await createApp({ dataDir: join(dir, 'source'), browserService: browser, startScheduler: false });
  const target = await createApp({ dataDir: join(dir, 'target'), browserService: browser, startScheduler: false });
  const base = { host: '127.0.0.1:4321', 'x-feedlantern': '1' };
  try {
    const setup = await source.inject({ method: 'POST', url: '/api/auth/setup', headers: base, payload: { setupToken: readFileSync(join(dir, 'source/setup-token'), 'utf8').trim(), username: 'source', password: 'source-password' } });
    const headers = { ...base, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-csrf-token': setup.json().csrfToken };
    const archive = (await source.inject({ method: 'POST', url: '/api/backups/export', headers, payload: { currentPassword: 'source-password', password: 'long-backup-password' } })).json();
    const body = { archive, setupToken: readFileSync(join(dir, 'target/setup-token'), 'utf8').trim(), password: 'long-backup-password', confirm: true };
    assert.equal((await target.inject({ method: 'POST', url: '/api/backups/restore', headers: base, payload: { ...body, setupToken: 'invalid' } })).statusCode, 403);
    assert.equal((await target.inject({ method: 'POST', url: '/api/backups/preview', headers: base, payload: body })).statusCode, 200);
    assert.equal((await target.inject({ method: 'POST', url: '/api/backups/restore', headers: base, payload: body })).statusCode, 200);
    assert.equal((await target.inject({ method: 'POST', url: '/api/auth/login', headers: base, payload: { username: 'source', password: 'source-password' } })).statusCode, 200);
  } finally { await source.close(); await target.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('无需域名配置的本机反代：来源校验、HTTPS Cookie、RSS 地址及并发隔离', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-proxy-'));
  const app = await createApp({ dataDir: dir, browserService: browser, startScheduler: false });
  const headers = { host: 'feeds.example.test', 'x-forwarded-host': 'feeds.example.test', 'x-forwarded-proto': 'https', origin: 'https://feeds.example.test', 'x-feedlantern': '1' };
  try {
    assert.equal((await app.inject({ url: '/api/auth/status', headers })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/auth/status', headers, remoteAddress: '8.8.8.8' })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/auth/status', headers: { ...headers, origin: 'https://evil.test' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/auth/status', headers: { host: 'evil.test' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/auth/status', headers: { ...headers, 'x-forwarded-host': 'feeds.example.test,evil.test' } })).statusCode, 400);
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers, payload: { setupToken: readFileSync(join(dir, 'setup-token'), 'utf8').trim(), username: 'proxy', password: 'test-proxy-password' } });
    assert.equal(setup.statusCode, 200);
    assert.match(String(setup.headers['set-cookie']), /Secure/);
    const auth = { ...headers, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-csrf-token': setup.json().csrfToken };
    const created = await app.inject({ method: 'POST', url: '/api/feeds', headers: auth, payload: { name: 'proxy', url: 'https://example.test', rules: { item: 'article', title: 'h2', link: 'a' } } });
    assert.equal(created.statusCode, 200);
    assert.equal(new URL(created.json().feedUrl).origin, 'https://feeds.example.test');
    const id = created.json().feed.id;
    const [proxied, local] = await Promise.all([
      app.inject({ url: `/api/feeds/${id}`, headers: auth }),
      app.inject({ url: `/api/feeds/${id}`, headers: { host: '127.0.0.1:4321', cookie: auth.cookie } }),
    ]);
    assert.equal(new URL(proxied.json().feedUrl).origin, 'https://feeds.example.test');
    assert.equal(new URL(local.json().feedUrl).origin, 'http://127.0.0.1:4321');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('订阅设置独立保存、严格校验且不抓取网页', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-feed-settings-'));
  let scrapes = 0;
  const app = await createApp({ dataDir: dir, browserService: { ...browser, scrape: async () => { scrapes++; throw Error('目标网页不可用'); } }, startScheduler: false });
  const base = { host: '127.0.0.1:4321', 'x-feedlantern': '1' };
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: base, payload: { setupToken: readFileSync(join(dir, 'setup-token'), 'utf8').trim(), username: 'admin', password: 'test-password' } });
    const headers = { ...base, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-csrf-token': setup.json().csrfToken };
    const created = (await app.inject({ method: 'POST', url: '/api/feeds', headers, payload: { name: '旧名称', url: 'https://example.test', rules: { item: 'article', title: 'h2', link: 'a' } } })).json();
    const url = `/api/feeds/${created.feed.id}`;
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url, headers, payload });
    assert.equal((await app.inject({ method: 'PATCH', url, headers: base, payload: { intervalMinutes: 15 } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'PATCH', url, headers: { ...headers, 'x-csrf-token': '' }, payload: { intervalMinutes: 15 } })).statusCode, 403);
    for (const intervalMinutes of [null, '', '15', true, [], {}, 4, 1441, 5.5]) {
      assert.equal((await patch({ channelTitle: '不应保存', intervalMinutes })).statusCode, 400);
    }
    for (const payload of [{}, { unknown: 1 }, { channelTitle: '' }, { channelTitle: ' '.repeat(4) }, { channelTitle: 'x'.repeat(201) }]) assert.equal((await patch(payload)).statusCode, 400);
    assert.deepEqual((await app.inject({ url, headers })).json().feed, created.feed);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/feeds/missing', headers, payload: { intervalMinutes: 15 } })).statusCode, 404);
    const renamed = (await patch({ channelTitle: '新名称' })).json().feed;
    assert.equal(renamed.name, '新名称'); assert.equal(renamed.channelTitle, '新名称');
    assert.equal(renamed.nextFetchAt, created.feed.nextFetchAt);
    for (const intervalMinutes of [5, 1440]) {
      const before = Date.now();
      const response = await patch({ intervalMinutes });
      assert.equal(response.statusCode, 200);
      const result = response.json();
      assert.equal(result.feed.intervalMinutes, intervalMinutes);
      assert.equal(result.feed.name, '新名称');
      assert.equal(result.feedUrl, created.feedUrl);
      assert.equal(result.feed.lastError, created.feed.lastError);
      assert.ok(Date.parse(result.feed.nextFetchAt) >= before + intervalMinutes * 60000);
      assert.ok(Date.parse(result.feed.nextFetchAt) <= Date.now() + intervalMinutes * 60000);
      assert.equal((await patch({ intervalMinutes })).json().feed.nextFetchAt, result.feed.nextFetchAt);
    }
    await app.inject({ method: 'POST', url: `${url}/toggle`, headers });
    const combined = await patch({ channelTitle: '暂停时修改', intervalMinutes: 30 });
    assert.equal(combined.statusCode, 200);
    assert.equal(combined.json().feed.enabled, false);
    assert.equal(combined.json().feed.name, '暂停时修改');
    assert.equal(combined.json().feed.intervalMinutes, 30);
    assert.equal(scrapes, 1);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
