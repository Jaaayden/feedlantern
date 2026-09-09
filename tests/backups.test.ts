import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { openBackup, sealBackup, snapshotSchema } from '../src/server/backups.js';
test('完整备份跨密钥恢复管理员、凭据、频道名称和历史，失败事务不改原数据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-backup-'));
  const a = new Store(join(dir, 'a')), b = new Store(join(dir, 'b'));
  try {
    a.createAdmin('admin', 'source-password'); b.createAdmin('target', 'target-password');
    const credential = a.createCredential({ name: 'cookie', url: 'https://example.test', format: 'header', value: 'secret=private' }, { domains: ['example.test'], count: 1, expiresAt: null });
    const { feed, token } = a.createFeed({ name: '管理名称', url: 'https://example.test', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: credential.id, intervalMinutes: 60, waitMs: 0 });
    a.setChannelTitle(feed.id, '阅读器名称'); a.setFeedView('cards');
    a.upsertItems(feed, [{ title: '文章', link: 'https://example.test/1' }]);
    const snapshot = snapshotSchema.parse({ format: 'feedlantern-backup', version: 1, appVersion: '0.2.0', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables: a.exportTables() });
    const encrypted = sealBackup(snapshot, 'long-backup-password');
    assert.ok(!JSON.stringify(encrypted).includes('secret=private'));
    assert.throws(() => openBackup(encrypted, 'wrong-backup-password'));
    assert.throws(() => openBackup({ ...encrypted, version: 999 }, 'long-backup-password'));
    assert.equal(b.getAdmin()?.username, 'target');
    const restored = openBackup(encrypted, 'long-backup-password');
    restored.tables.feeds[0].name = '旧管理名称';
    b.restoreTables(restored.tables);
    assert.equal(b.authenticate('admin', 'source-password'), true);
    assert.equal(b.getCredentialValue(credential.id)?.value, 'secret=private');
    assert.equal(b.getFeedToken(feed.id)?.token, token);
    assert.equal(b.getFeed(feed.id)?.channelTitle, '阅读器名称');
    assert.equal(b.getFeed(feed.id)?.name, '阅读器名称');
    assert.deepEqual(b.getItems(feed.id), a.getItems(feed.id));
    assert.equal(b.getSettings().feedView, 'cards');
    const bad = structuredClone(restored.tables); bad.feed_items[0].feed_id = 'missing';
    assert.throws(() => b.restoreTables(bad));
    assert.deepEqual(b.getItems(feed.id), a.getItems(feed.id));
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('日期来源随备份恢复，旧备份无来源时按绝对时间读取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-backup-dates-'));
  const store = new Store(dir);
  try {
    store.createAdmin('admin', 'source-password');
    const { feed } = store.createFeed({ name: 'dates', url: 'https://example.test', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 });
    store.upsertItems(feed, [{ title: '文章', link: 'https://example.test/1', publishedAt: '2026-09-09T11:57:00.000Z', publishedAtSource: 'relative' }]);
    const snapshot = { format: 'feedlantern-backup', version: 1, appVersion: '0.2.2', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables: store.exportTables() };
    store.restoreTables(openBackup(sealBackup(snapshotSchema.parse(snapshot), 'long-backup-password'), 'long-backup-password').tables);
    assert.equal(store.getItems(feed.id)[0].publishedAtSource, 'relative');
    const old = JSON.parse(JSON.stringify(snapshot));
    delete old.tables.feed_items[0].published_at_source;
    store.restoreTables(snapshotSchema.parse(old).tables);
    assert.equal(store.getItems(feed.id)[0].publishedAtSource, 'absolute');
    assert.equal(store.getItems(feed.id)[0].publishedAt, '2026-09-09T11:57:00.000Z');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
