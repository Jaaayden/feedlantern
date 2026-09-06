import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/server/store.js';
import { renderRss } from '../src/server/rss.js';
import { XMLParser } from 'fast-xml-parser';

test('凭据值加密保存，summary 不返回敏感内容，FeedItem 按 URL 去重', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-store-'));
  const store = new Store(dataDir);
  try {
    const credential = store.createCredential({ name: 'test', url: 'https://example.test', format: 'header', value: 'secret-cookie=1' }, { domains: ['example.test'], count: 1, expiresAt: null });
    assert.deepEqual(store.listCredentialSummaries(), [credential]);
    assert.ok(!JSON.stringify(store.listCredentialSummaries()).includes('secret-cookie'));
    const encrypted = readFileSync(join(dataDir, 'app.db'));
    assert.ok(!encrypted.includes(Buffer.from('secret-cookie')));
    const created = store.createFeed({ name: 'feed', url: 'https://example.test/list', rules: { item: '.item', title: '.title', link: 'a' }, credentialId: credential.id, intervalMinutes: 60, waitMs: 1000 });
    store.updateFeed(created.feed.id, { ...created.feed, ruleOrigins: { title: 'manual' } });
    const explicitlyReplaced = store.updateFeed(created.feed.id, { ...created.feed, ruleOrigins: { title: 'auto' } });
    assert.equal(explicitlyReplaced?.ruleOrigins?.title, 'auto');
    const omittedOrigins = store.updateFeed(created.feed.id, { ...created.feed, ruleOrigins: undefined });
    assert.equal(omittedOrigins?.ruleOrigins?.title, 'auto');
    const first = store.upsertItems(created.feed, [{ title: 'one', link: 'https://example.test/item#section' }]);
    const second = store.upsertItems(created.feed, [{ title: 'one updated', link: 'https://example.test/item' }, { title: 'two', link: 'https://example.test/two' }]);
    assert.equal(first.length, 1);
    assert.equal(second.length, 2);
    assert.equal(store.getItems(created.feed.id).find((item) => item.link.endsWith('/item'))?.title, 'one updated');
    assert.ok(existsSync(join(dataDir, 'master.key')));
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('历史保留 200 条、RSS 输出 100 条，重复刷新保留条目 ID 和首次发现时间', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-retention-'));
  const store = new Store(dataDir);
  try {
    const { feed } = store.createFeed({ name: 'retention', url: 'https://example.test', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 });
    const input = Array.from({ length: 250 }, (_, index) => ({ title: `Article ${index}`, link: `https://example.test/${index}` }));
    store.upsertItems(feed, input);
    const before = store.getItems(feed.id);
    assert.equal(before.length, 200);
    assert.equal(before[0].title, 'Article 0');
    const first = before[0];
    store.upsertItems(feed, [{ ...input[0], title: 'Updated first title' }]);
    const same = store.getItems(feed.id).find(item => item.link === first.link)!;
    assert.equal(same.id, first.id);
    assert.equal(same.firstSeenAt, first.firstSeenAt);
    const xml = renderRss(feed, store.getItems(feed.id), 'https://feeds.example/feed.xml');
    assert.equal(new XMLParser().parse(xml).rss.channel.item.length, 100);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('频道名称独立于管理名称，更新不改变密钥、历史和调度，偏好重启后保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedlantern-title-'));
  let store = new Store(dir);
  try {
    const { feed, token } = store.createFeed({ name: '管理名称', url: 'https://example.test', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 });
    store.upsertItems(feed, [{ title: '文章', link: 'https://example.test/1' }]);
    const before = store.getFeed(feed.id)!;
    const items = store.getItems(feed.id);
    const after = store.setChannelTitle(feed.id, '阅读器 & 名称')!;
    assert.deepEqual({ ...after, channelTitle: before.channelTitle }, before);
    assert.deepEqual(store.getItems(feed.id), items);
    assert.equal(store.getFeedToken(feed.id)?.token, token);
    assert.equal(new XMLParser().parse(renderRss(after, items, 'https://example.test/rss')).rss.channel.title, '阅读器 & 名称');
    assert.equal(store.getSettings().feedView, 'list');
    store.setFeedView('cards');
    store.close(); store = new Store(dir);
    assert.equal(store.getFeed(feed.id)?.channelTitle, '阅读器 & 名称');
    assert.equal(store.getSettings().feedView, 'cards');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('v0.1.0 表结构原位升级保留频道名、密钥和历史', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'fl-migration-'));
  let store = new Store(dir);
  try {
    const { feed, token } = store.createFeed({ name: '旧订阅', url: 'https://example.test', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 });
    store.upsertItems(feed, [{ title: '旧文章', link: 'https://example.test/old' }]);
    const items = store.getItems(feed.id);
    store.close();
    const db = new DatabaseSync(join(dir, 'app.db'));
    db.exec('ALTER TABLE feeds DROP COLUMN channel_title; DROP TABLE settings; DROP TABLE import_jobs; PRAGMA user_version=0;'); db.close();
    store = new Store(dir);
    assert.equal(store.getFeed(feed.id)?.channelTitle, '旧订阅');
    assert.equal(store.getFeedToken(feed.id)?.token, token);
    assert.deepEqual(store.getItems(feed.id), items);
    assert.equal(store.getSettings().feedView, 'list');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
