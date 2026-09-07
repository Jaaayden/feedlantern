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
