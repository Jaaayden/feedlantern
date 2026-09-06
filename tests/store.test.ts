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
