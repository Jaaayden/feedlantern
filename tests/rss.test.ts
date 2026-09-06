import assert from 'node:assert/strict';
import { test } from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import { renderRss, rssEtag } from '../src/server/rss.js';
import type { Feed } from '../src/shared/types.js';

const feed: Feed = {
  id: 'feed_test', name: 'A & B', url: 'https://example.test', rules: { item: '.item', title: '.title', link: 'a' }, credentialId: null,
  intervalMinutes: 60, waitMs: 1000, enabled: true, createdAt: '2026-01-01T00:00:00.000Z', lastFetchedAt: null,
  lastSuccessAt: '2026-01-02T00:00:00.000Z', nextFetchAt: '2026-01-03T00:00:00.000Z', lastError: null, itemCount: 1,
};

test('RSS 输出转义文本、保留合法图片并固定 pubDate', () => {
  const xml = renderRss(feed, [{ id: 'item_1', title: '<title>', link: 'https://example.test/a?b=1&c=2', description: 'A & B <script>alert(1)</script><img src="https://img.example/bad.png">', image: 'https://img.example/a.png', publishedAt: '2026-01-03T00:00:00.000Z', firstSeenAt: '2026-01-03T00:00:00.000Z' }], 'https://feed.test/feed.xml');
  assert.match(xml, /&lt;title&gt;/);
  assert.ok(xml.includes('<img src="https://img.example/a.png" alt="">'));
  assert.ok(xml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!xml.includes('<img src="https://img.example/bad.png"') && !xml.includes('onerror='));
  const parsed = new XMLParser().parse(xml) as { rss: { channel: { item: { description: string } } } };
  assert.match(parsed.rss.channel.item.description, /<img src="https:\/\/img\.example\/a\.png"/);
  assert.match(parsed.rss.channel.item.description, /&amp;.*&lt;script&gt;/);
  assert.match(xml, /Sat, 03 Jan 2026 00:00:00 GMT/);
  assert.equal(rssEtag(feed, []), rssEtag(feed, []));
});

test('无图片摘要在 XML 解码后仍是安全文本，缺少来源日期时不编造 pubDate', () => {
  const xml = renderRss(feed, [{ id: 'item_2', title: 'text\u0000 🏮', link: 'https://example.test/b', description: '<script>alert(1)</script> & text', firstSeenAt: '2026-01-03T00:00:00.000Z' }], 'https://feed.test/feed.xml');
  const parsed = new XMLParser().parse(xml).rss.channel.item;
  assert.equal(parsed.title, 'text 🏮');
  assert.equal(parsed.description, '&lt;script&gt;alert(1)&lt;/script&gt; &amp; text');
  assert.equal(parsed.pubDate, undefined);
});
