import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';

const noopBrowser = { async close() {}, async dispose() {} } as unknown as BrowserServiceLike;

test('过期会话由定期清理删除，未过期会话保留', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-purge-'));
  const store = new Store(dataDir);
  try {
    store.createAdmin('admin', 'password123');
    const expired = store.createSession('admin', -1_000);
    const live = store.createSession('admin', 60_000);
    assert.equal(store.purgeExpiredSessions(), 1);
    assert.equal(store.findSession(expired.id, 60_000), null);
    assert.ok(store.findSession(live.id, 60_000));
    assert.equal(store.purgeExpiredSessions(), 0);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('创建订阅和凭据时一次写入属主与来源类型', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-owner-'));
  const store = new Store(dataDir);
  try {
    store.createAdmin('admin', 'password123');
    const user = store.createUser('reader', 'password123');
    const credential = store.createCredential({ name: 'c', url: 'https://example.test', format: 'header', value: 'a=1' }, { domains: ['example.test'], count: 1, expiresAt: null }, user.id);
    assert.ok(store.owns('credentials', credential.id, user.id));
    assert.ok(!store.owns('credentials', credential.id, 'admin'));
    const { feed } = store.createFeed({ sourceType: 'rss', name: 'rss', url: 'https://example.test/rss', rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 30, waitMs: 0 }, user.id);
    assert.equal(feed.ownerId, user.id);
    assert.equal(feed.sourceType, 'rss');
    assert.equal(feed.translationMode, 'bilingual');
    assert.equal(feed.channelTitle, 'rss');
    const site = store.createFeed({ name: 'site', url: 'https://example.test/list', rules: { item: '.i', title: '.t', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 }, user.id).feed;
    assert.equal(site.sourceType, 'website');
    assert.equal(site.translationMode, 'original');
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('网页界面禁止被其他站点嵌入，RSS 输出不受影响', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-frame-'));
  const app = await createApp({ dataDir, publicOrigin: 'http://127.0.0.1:4321', browserService: noopBrowser, startScheduler: false });
  try {
    const page = await app.inject({ method: 'GET', url: '/', headers: { host: '127.0.0.1:4321' } });
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    const feed = await app.inject({ method: 'GET', url: '/feeds/missing/token.xml', headers: { host: '127.0.0.1:4321' } });
    assert.equal(feed.headers['x-frame-options'], undefined);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
