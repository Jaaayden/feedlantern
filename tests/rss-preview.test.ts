import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { etagMatches, renderRssPreview, wantsHtmlPreview } from '../src/server/rss-preview.js';
import { renderRss } from '../src/server/rss.js';
import type { Feed, FeedInput } from '../src/shared/types.js';

const feed: Feed = {
  id: 'feed_preview', name: 'A <b>& B', url: 'https://example.test/list', rules: { item: '.item', title: '.title', link: 'a' }, credentialId: null,
  intervalMinutes: 45, waitMs: 0, enabled: true, createdAt: '2026-01-01T00:00:00.000Z', lastFetchedAt: null,
  lastSuccessAt: '2026-01-02T00:00:00.000Z', nextFetchAt: '2026-01-03T00:00:00.000Z', lastError: null, itemCount: 1,
};
const browserNavigation = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

test('只有浏览器地址栏打开才显示预览页，阅读器和脚本始终拿到 RSS', () => {
  assert.equal(wantsHtmlPreview(browserNavigation, {}), true);
  assert.equal(wantsHtmlPreview(browserNavigation, { format: 'xml' }), false);
  assert.equal(wantsHtmlPreview({ accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' }, {}), false);
  assert.equal(wantsHtmlPreview({ accept: 'text/html' }, {}), false, 'no Fetch Metadata: old clients and readers');
  assert.equal(wantsHtmlPreview({ ...browserNavigation, 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' }, {}), false, 'fetch() from a page or extension');
  assert.equal(wantsHtmlPreview({ ...browserNavigation, accept: 'application/rss+xml' }, {}), false);
});

test('预览页转义内容、使用 nonce CSP，并提供 RSS 自动发现链接', () => {
  const page = renderRssPreview(feed, [
    { id: 'i1', title: '<script>alert(1)</script>', link: 'javascript:alert(1)', description: '摘要 <img src=x onerror=alert(1)>', firstSeenAt: '2026-01-03T00:00:00.000Z' },
    { id: 'i2', title: 'Safe', link: 'https://example.test/a?b=1&c=2', description: 'ok', publishedAt: '2026-01-04T00:00:00.000Z', firstSeenAt: '2026-01-04T00:00:00.000Z' },
  ], 'https://feeds.test/feeds/feed_preview/token.xml');
  assert.ok(!page.html.includes('<script>alert(1)</script>'));
  assert.ok(page.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!page.html.includes('href="javascript:'));
  assert.ok(!page.html.includes('<img src=x'));
  assert.ok(page.html.includes('href="https://example.test/a?b=1&amp;c=2"'));
  assert.ok(page.html.includes('<link rel="alternate" type="application/rss+xml"'));
  assert.ok(page.html.includes('https://feeds.test/feeds/feed_preview/token.xml?format=xml'));
  assert.ok(page.html.includes('A &lt;b&gt;&amp; B'));
  const nonce = /'nonce-([^']+)'/.exec(page.csp)?.[1];
  assert.ok(nonce);
  assert.equal(page.html.match(/<script(?![^>]*nonce=)/g), null, 'every script carries the nonce');
  assert.ok(page.html.includes(`<script nonce="${nonce}">`));
  assert.match(page.csp, /default-src 'none'/);
});

test('RSS 频道包含 ttl、generator 和中文描述，合法图片输出 media:thumbnail', () => {
  const xml = renderRss(feed, [
    { id: 'i1', title: 'One', link: 'https://example.test/1', image: '/cover.png', firstSeenAt: '2026-01-03T00:00:00.000Z' },
    { id: 'i2', title: 'Two', link: 'https://example.test/2', image: 'javascript:alert(1)', firstSeenAt: '2026-01-03T00:00:00.000Z' },
  ], 'https://feeds.test/feed.xml');
  const channel = new XMLParser({ ignoreAttributes: false }).parse(xml).rss.channel;
  assert.equal(channel.ttl, 45);
  assert.equal(channel.generator, 'FeedLantern');
  assert.match(channel.description, /example\.test/);
  assert.equal(channel.item[0]['media:thumbnail']['@_url'], 'https://example.test/cover.png');
  assert.equal(channel.item[1]['media:thumbnail'], undefined);
  assert.equal(channel.language, undefined, 'original-language feeds do not claim a language');
  const translated = new XMLParser().parse(renderRss({ ...feed, sourceType: 'rss', translationMode: 'chinese' }, [], 'https://feeds.test/feed.xml')).rss.channel;
  assert.equal(translated.language, 'zh-cn');
});

test('同一订阅地址：浏览器导航返回预览页，阅读器返回 RSS，两者 ETag 不同', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-preview-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const owner = store.createUser('reader', 'reader-password');
  const input: FeedInput = { name: 'Preview', url: 'https://example.test/articles', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 };
  const { feed: created, token } = store.createFeed(input, owner.id);
  store.upsertItems(created, [{ title: 'Hello <world>', link: 'https://example.test/one' }]);
  const app = await createApp({ store, dataDir: dir, startScheduler: false, browserService: { close: async () => {}, dispose: async () => {} } as unknown as BrowserServiceLike });
  try {
    const url = `/feeds/${created.id}/${token}.xml`;
    const reader = await app.inject({ url, headers: { accept: 'application/rss+xml' } });
    assert.equal(reader.statusCode, 200);
    assert.match(String(reader.headers['content-type']), /application\/rss\+xml/);
    assert.match(String(reader.headers.vary), /Sec-Fetch-Dest/);
    assert.match(String(reader.headers['x-robots-tag']), /noindex/);
    const page = await app.inject({ url, headers: browserNavigation });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers['content-type']), /text\/html/);
    assert.match(String(page.headers['content-security-policy']), /nonce-/);
    assert.ok(page.body.includes('Hello &lt;world&gt;'));
    assert.notEqual(page.headers.etag, reader.headers.etag);
    assert.equal((await app.inject({ url, headers: { ...browserNavigation, 'if-none-match': String(page.headers.etag) } })).statusCode, 304);
    const raw = await app.inject({ url: `${url}?format=xml`, headers: browserNavigation });
    assert.match(String(raw.headers['content-type']), /application\/xml/);
    assert.ok(raw.body.startsWith('<?xml'));
    assert.equal((await app.inject({ url: `/feeds/${created.id}/wrong.xml`, headers: browserNavigation })).statusCode, 404);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('If-None-Match 支持弱校验、多个标签和 *', () => {
  assert.equal(etagMatches('"abc"', '"abc"'), true);
  assert.equal(etagMatches('W/"abc"', '"abc"'), true);
  assert.equal(etagMatches('"x", W/"abc"', '"abc"'), true);
  assert.equal(etagMatches('*', '"abc"'), true);
  assert.equal(etagMatches('"abd"', '"abc"'), false);
  assert.equal(etagMatches(undefined, '"abc"'), false);
});
