import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { defaultApplicationSettings } from '../src/shared/types.js';
import { openBackup, sealBackup, snapshotSchema } from '../src/server/backups.js';

const browser: BrowserServiceLike = { open() { throw Error(); }, snapshot() { throw Error(); }, scroll() { throw Error(); }, click() { throw Error(); }, pick() { throw Error(); }, extract: () => [], scrape: () => [], close() {}, dispose() {} };
const key = 'test-private-bark-key';
const endpoint = `https://api.day.app/${key}/`;

test('应用设置加密、跨密钥备份往返、旧备份兼容、日志保留设置生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-settings-')), a = new Store(join(dir, 'a')), b = new Store(join(dir, 'b'));
  try {
    a.createAdmin('admin', 'source-password');
    const value = structuredClone(defaultApplicationSettings);
    value.bark.enabled = true; value.bark.url = endpoint; value.logRetentionDays = 7;
    value.server.backgroundConcurrency = 3; value.server.allowedHosts = ['internal.test:443']; value.server.dnsOverHttps = true;
    a.setSettings(value);
    assert.deepEqual(a.getSettings(), value);
    for (const path of [a.dbPath, `${a.dbPath}-wal`]) assert.ok(!readFileSync(path).includes(Buffer.from(key)));
    const snapshot = snapshotSchema.parse({ format: 'feedlantern-backup', version: 1, appVersion: 'test', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables: a.exportTables() });
    const sealed = sealBackup(snapshot, 'long-backup-password');
    assert.ok(!JSON.stringify(sealed).includes(key)); b.restoreTables(openBackup(sealed, 'long-backup-password').tables);
    assert.deepEqual(b.getSettings(), value);
    const feed = b.createFeed({ name: 'test', url: 'https://example.test', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 }).feed;
    const id = b.history.start(feed.id, 'manual', new Date(Date.now() - 8 * 86400_000).toISOString());
    b.history.succeed(id, feed.id, 1, { itemCount: 1, newItemCount: 1 }); b.history.prune(); assert.equal(b.history.list(feed.id).logs.length, 0);
    const old = structuredClone(snapshot.tables); old.settings = old.settings.filter(s => s.key === 'feedView');
    b.restoreTables(old); assert.equal(b.getSettings().bark.enabled, false); assert.equal(b.getSettings().server.backgroundConcurrency, 3);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('网页设置即时生效、配置完整往返、预览不泄密及旧配置不覆盖设置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-settings-api-')), store = new Store(dir);
  let calls = 0;
  const app = await createApp({ dataDir: dir, store, browserService: browser, barkUrl: endpoint, barkSender: async () => { calls++; }, startScheduler: false });
  const host = '127.0.0.1:4321';
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: store.getSetupToken(), username: 'admin', password: 'test-password' } });
    const headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken };
    assert.equal(store.getSettings().bark.url, endpoint);
    const set = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/settings', headers, payload });
    const changed = await set({ bark: { enabled: false }, logRetentionDays: 90, server: { backgroundConcurrency: 2, allowedHosts: ['private.test:443'], dnsOverHttps: true } });
    assert.equal(changed.statusCode, 200); assert.equal(changed.json().bark.url, endpoint); assert.equal(calls, 0);
    for (const payload of [{ bark: { enabled: true, url: '' } }, { server: { allowedHosts: ['localhost'] } }, { server: { trustedProxies: ['*'] } }, { logRetentionDays: 0 }, { server: { port: 0 } }, { bark: { maxAttempts: 6 } }]) assert.equal((await set(payload)).statusCode, 400);
    const archive = (await app.inject({ url: '/api/backups/config', headers })).json();
    assert.equal(archive.version, 2); assert.equal(archive.settings.bark.url, endpoint);
    await set({ bark: { url: '' }, server: { backgroundConcurrency: 1 } });
    const preview = await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive } });
    assert.equal(preview.statusCode, 200); assert.ok(!preview.body.includes(key)); assert.equal(preview.json().settings.bark.configured, true);
    assert.equal(store.getSettings().bark.url, '');
    const imported = await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive, confirm: true } });
    assert.equal(imported.statusCode, 200); assert.deepEqual(store.getSettings(), archive.settings); assert.equal(calls, 0);
    await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: { format: 'feedlantern-config', version: 1, feeds: [] }, confirm: true } });
    assert.deepEqual(store.getSettings(), archive.settings);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', headers: { host, 'x-feedlantern': '1' }, payload: archive.settings })).statusCode, 401);
    store.initializeSettings({ ...defaultApplicationSettings, bark: { ...defaultApplicationSettings.bark, enabled: true, url: 'https://api.day.app/stale-key/' } });
    assert.equal(store.getSettings().bark.url, endpoint);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
