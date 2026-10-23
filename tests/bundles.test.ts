import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { openBackup, sealBackup, snapshotSchema } from '../src/server/backups.js';
import { mergeBundleItems, renderBundleRss } from '../src/server/bundles.js';
import type { Bundle, Feed, FeedInput, FeedItem } from '../src/shared/types.js';

const base: Feed = {
  id: 'feed_a', name: 'Alpha', url: 'https://a.test/', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null,
  intervalMinutes: 30, waitMs: 0, enabled: true, createdAt: '2026-01-01T00:00:00.000Z', lastFetchedAt: null,
  lastSuccessAt: '2026-01-05T00:00:00.000Z', nextFetchAt: '2026-01-06T00:00:00.000Z', lastError: null, itemCount: 0,
};
const item = (id: string, link: string, firstSeenAt: string, publishedAt?: string, extra: Partial<FeedItem> = {}): FeedItem => ({ id, title: id, link, firstSeenAt, publishedAt, ...extra });
const bundle: Bundle = { id: 'bundle_x', name: '晨读 & 周末', feedIds: ['feed_a', 'feed_b'], itemLimit: 100, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
const input = (name: string, url: string): FeedInput => ({ name, url, rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 });
const browserService = { close: async () => {}, dispose: async () => {} } as unknown as BrowserServiceLike;
const browserNavigation = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: 'text/html' };

test('合并按发布时间（缺失时用首次发现时间）倒序，去重同链接并截断到上限', () => {
  const alpha = base, beta = { ...base, id: 'feed_b', name: 'Beta', url: 'https://b.test/' };
  const merged = mergeBundleItems([
    { feed: alpha, items: [item('a1', 'https://x.test/1', '2026-01-03T00:00:00.000Z'), item('a2', 'https://x.test/shared#top', '2026-01-01T00:00:00.000Z', '2026-01-01T12:00:00.000Z')] },
    { feed: beta, items: [item('b1', 'https://x.test/2', '2026-01-02T00:00:00.000Z', '2026-01-04T00:00:00.000Z'), item('b2', 'https://X.test/shared', '2026-01-04T00:00:00.000Z', '2026-01-04T08:00:00.000Z')] },
  ], 100);
  assert.deepEqual(merged.map(entry => entry.item.id), ['b1', 'a1', 'a2'], 'b2 duplicates a2, which was seen first and keeps its place');
  assert.equal(merged[0].feed.name, 'Beta');
  assert.deepEqual(mergeBundleItems([{ feed: alpha, items: [item('a1', 'https://x.test/1', '2026-01-03T00:00:00.000Z'), item('a3', 'https://x.test/3', '2026-01-02T00:00:00.000Z')] }], 1).map(entry => entry.item.id), ['a1']);
});

test('翻译成员只贡献已完成翻译的条目，与该订阅自己的 RSS 一致', () => {
  const translated: Feed = { ...base, sourceType: 'rss', translationMode: 'translated' };
  const merged = mergeBundleItems([{ feed: translated, items: [
    item('done', 'https://x.test/done', '2026-01-02T00:00:00.000Z', undefined, { translationStatus: 'success', contentHtml: '<p>完成</p>' }),
    item('pending', 'https://x.test/pending', '2026-01-03T00:00:00.000Z', undefined, { translationStatus: 'pending', contentHtml: '<p>等待</p>' }),
  ] }], 100);
  assert.deepEqual(merged.map(entry => entry.item.id), ['done']);
});

test('聚合 RSS 用 category 注明来源，复用单个订阅的条目输出', () => {
  const xml = renderBundleRss(bundle, [
    { feed: base, items: [item('a1', 'https://x.test/1', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', { description: '<b>摘要</b>' })] },
    { feed: { ...base, id: 'feed_b', name: 'Beta <B>', intervalMinutes: 15 }, items: [] },
  ], 'https://rss.test/bundles/bundle_x/token.xml', 'https://rss.test/');
  const channel = new XMLParser({ ignoreAttributes: false }).parse(xml).rss.channel;
  assert.equal(channel.title, '晨读 & 周末');
  assert.equal(channel.ttl, 15);
  assert.match(channel.description, /2 个订阅/);
  assert.equal(channel['atom:link']['@_href'], 'https://rss.test/bundles/bundle_x/token.xml');
  assert.equal(channel.item.category, 'Alpha');
  assert.equal(channel.item.guid['#text'], 'a1');
  assert.ok(xml.includes('&lt;b&gt;摘要&lt;/b&gt;'), 'website summaries stay escaped text, exactly as in the member feed');
  assert.ok(!xml.includes('<source'));
});

test('聚合订阅 API：仅限本人订阅、只读输出、暂停仍输出、删除自动移出、轮换密钥和停用所有者', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-bundles-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const user = store.createUser('reader', 'reader-password'), other = store.createUser('other', 'other-password');
  const one = store.createFeed(input('One', 'https://a.test/list'), user.id), two = store.createFeed(input('Two', 'https://b.test/list'), user.id);
  const foreign = store.createFeed(input('Foreign', 'https://c.test/list'), other.id);
  store.upsertItems(one.feed, [{ title: 'Old', link: 'https://a.test/old', publishedAt: '2026-01-01T00:00:00.000Z' }, { title: 'Shared', link: 'https://shared.test/x', publishedAt: '2026-01-02T00:00:00.000Z' }]);
  store.upsertItems(two.feed, [{ title: 'New', link: 'https://b.test/new', publishedAt: '2026-01-03T00:00:00.000Z' }, { title: 'Shared again', link: 'https://shared.test/x', publishedAt: '2026-01-02T00:00:00.000Z' }]);
  let scraped = 0;
  const app = await createApp({ store, dataDir: dir, startScheduler: false, browserService: { ...browserService, scrape: async () => { scraped++; return []; } } as BrowserServiceLike });
  const session = store.createSession('reader', 60_000);
  const headers = { host: '127.0.0.1:4321', cookie: `feedlantern_session=${session.id}`, 'x-feedlantern': '1', 'x-csrf-token': session.csrfToken };
  try {
    assert.equal((await app.inject({ url: '/api/bundles', headers: { host: '127.0.0.1:4321' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/bundles', headers, payload: { name: 'x', feedIds: [foreign.feed.id] } })).statusCode, 400, 'another account’s feed');
    assert.equal((await app.inject({ method: 'POST', url: '/api/bundles', headers, payload: { name: ' ', feedIds: [] } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/bundles', headers, payload: { name: 'x', feedIds: [], itemLimit: 5 } })).statusCode, 400);
    const { 'x-csrf-token': _csrf, ...noCsrf } = headers;
    assert.equal((await app.inject({ method: 'POST', url: '/api/bundles', headers: noCsrf, payload: { name: 'x', feedIds: [] } })).statusCode, 403);
    const created = await app.inject({ method: 'POST', url: '/api/bundles', headers, payload: { name: '每日', feedIds: [one.feed.id, one.feed.id] } });
    assert.equal(created.statusCode, 200);
    const { bundle, bundleUrl } = created.json();
    assert.deepEqual(bundle.feedIds, [one.feed.id]);
    assert.equal(bundle.itemLimit, 100);
    const added = (await app.inject({ method: 'POST', url: `/api/bundles/${bundle.id}/feeds`, headers, payload: { feedIds: [two.feed.id, one.feed.id] } })).json();
    assert.deepEqual(added.bundle.feedIds, [one.feed.id, two.feed.id]);
    assert.equal((await app.inject({ url: '/api/bundles', headers })).json().length, 1);
    const otherSession = store.createSession('other', 60_000);
    assert.equal((await app.inject({ url: `/api/bundles/${bundle.id}`, headers: { ...headers, cookie: `feedlantern_session=${otherSession.id}`, 'x-csrf-token': otherSession.csrfToken } })).statusCode, 404);

    const path = new URL(bundleUrl).pathname;
    const rss = await app.inject({ url: path, headers: { accept: 'application/rss+xml' } });
    assert.equal(rss.statusCode, 200);
    assert.match(String(rss.headers['content-type']), /application\/rss\+xml/);
    const channel = new XMLParser().parse(rss.body).rss.channel;
    assert.deepEqual(channel.item.map((entry: { title: string }) => entry.title), ['New', 'Shared', 'Old']);
    assert.deepEqual(channel.item.map((entry: { category: string }) => entry.category), ['Two', 'One', 'One']);
    assert.equal(scraped, 0, 'reading a bundle never fetches');
    assert.equal((await app.inject({ url: path, headers: { 'if-none-match': String(rss.headers.etag) } })).statusCode, 304);
    const page = await app.inject({ url: path, headers: browserNavigation });
    assert.match(String(page.headers['content-type']), /text\/html/);
    assert.match(page.body, /聚合订阅/);
    assert.match(page.body, /class="source">Two</);
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
    assert.equal((await app.inject({ url: path.replace(/\/[^/]+\.xml$/, '/wrong.xml') })).statusCode, 404);

    store.toggleFeed(one.feed.id);
    assert.match((await app.inject({ url: path })).body, /<title>Old<\/title>/, 'paused members keep publishing stored items');
    const renamed = await app.inject({ method: 'PUT', url: `/api/bundles/${bundle.id}`, headers, payload: { name: '新名称', itemLimit: 10 } });
    assert.equal(renamed.json().bundle.name, '新名称'); assert.equal(renamed.json().bundle.itemLimit, 10);
    assert.notEqual((await app.inject({ url: path })).headers.etag, rss.headers.etag);

    assert.equal((await app.inject({ method: 'DELETE', url: `/api/feeds/${two.feed.id}`, headers })).statusCode, 200);
    assert.deepEqual(store.bundles.get(bundle.id)?.feedIds, [one.feed.id], 'a deleted feed leaves every bundle');

    store.setUserEnabled(user.id, false);
    assert.equal((await app.inject({ url: path })).statusCode, 404);
    assert.equal((await app.inject({ url: `/feeds/${one.feed.id}/${one.token}.xml` })).statusCode, 404, 'same as a single feed address');
    store.setUserEnabled(user.id, true);
    assert.equal((await app.inject({ url: path })).statusCode, 200);

    const fresh = store.createSession('reader', 60_000);
    const live = { ...headers, cookie: `feedlantern_session=${fresh.id}`, 'x-csrf-token': fresh.csrfToken };
    const rotated = (await app.inject({ method: 'POST', url: `/api/bundles/${bundle.id}/rotate-token`, headers: live, payload: {} })).json();
    assert.notEqual(rotated.bundleUrl, bundleUrl);
    assert.equal((await app.inject({ url: path })).statusCode, 404);
    assert.equal((await app.inject({ url: new URL(rotated.bundleUrl).pathname })).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/bundles/${bundle.id}`, headers: live })).statusCode, 200);
    assert.equal((await app.inject({ url: new URL(rotated.bundleUrl).pathname })).statusCode, 404);
    assert.equal(store.getFeed(one.feed.id)?.id, one.feed.id, 'deleting a bundle keeps its members');
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('完整备份包含聚合订阅与密钥，旧备份没有聚合表也能恢复；删除用户一并删除其聚合', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-bundle-backup-'));
  const a = new Store(join(dir, 'a')), b = new Store(join(dir, 'b'));
  try {
    a.createAdmin('admin', 'source-password'); b.createAdmin('target', 'target-password');
    const user = a.createUser('reader', 'reader-password');
    const one = a.createFeed(input('One', 'https://a.test/list'), user.id);
    const created = a.bundles.create({ name: '聚合', feedIds: [one.feed.id], itemLimit: 50 }, user.id);
    const snapshot = snapshotSchema.parse({ format: 'feedlantern-backup', version: 3, appVersion: '0.6.3', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables: a.exportTables() });
    const restored = openBackup(sealBackup(snapshot, 'long-backup-password'), 'long-backup-password');
    b.restoreTables(restored.tables);
    assert.deepEqual(b.bundles.get(created.bundle.id), created.bundle);
    assert.equal(b.bundles.token(created.bundle.id), created.token);
    assert.equal(b.bundles.checkToken(created.bundle.id, created.token), true);

    const foreign = structuredClone(snapshot); foreign.tables.bundles[0].owner_id = 'admin';
    assert.equal(snapshotSchema.safeParse(foreign).success, false, 'a bundle cannot hold another account’s feed');
    const old = structuredClone(snapshot) as unknown as { tables: Record<string, unknown> };
    delete old.tables.bundles; delete old.tables.bundle_feeds;
    b.restoreTables(snapshotSchema.parse(old).tables);
    assert.equal(b.bundles.list().length, 0);

    assert.equal(a.deletionPreview(user.id).bundles, 1);
    a.deleteUser('admin', user.id, 'reader');
    assert.equal(a.bundles.list().length, 0);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('v8 数据库升级到 14 后可以创建聚合订阅', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-bundle-migrate-'));
  try {
    new Store(dir).close();
    const db = new DatabaseSync(join(dir, 'app.db'));
    db.exec('DROP TABLE bundle_feeds; DROP TABLE bundles; PRAGMA user_version = 8;'); db.close();
    const store = new Store(dir);
    try {
      const raw = new DatabaseSync(join(dir, 'app.db'));
      assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 14); raw.close();
      store.createAdmin('admin', 'admin-password');
      assert.equal(store.bundles.create({ name: 'x', feedIds: [] }, 'admin').bundle.name, 'x');
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('配置导出导入包含聚合订阅，成员指向新建或已有的订阅', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-bundle-config-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const app = await createApp({ store, dataDir: dir, startScheduler: false, browserService });
  const session = store.createSession('admin', 60_000);
  const headers = { host: '127.0.0.1:4321', cookie: `feedlantern_session=${session.id}`, 'x-feedlantern': '1', 'x-csrf-token': session.csrfToken };
  try {
    const one = store.createFeed(input('One', 'https://a.test/list'), 'admin'), two = store.createFeed(input('Two', 'https://b.test/list'), 'admin');
    store.bundles.create({ name: '聚合', feedIds: [two.feed.id, one.feed.id], itemLimit: 30 }, 'admin');
    const config = (await app.inject({ url: '/api/backups/config', headers })).json();
    assert.equal(config.bundles.length, 1);
    assert.ok(!JSON.stringify(config).includes(store.bundles.list()[0].id), 'no ids or tokens');
    store.bundles.delete(store.bundles.list()[0].id);
    store.deleteFeed(two.feed.id);
    const preview = (await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: config } })).json();
    assert.deepEqual(preview.bundles, [{ name: '聚合', members: 2, duplicate: false }]);
    const imported = (await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: config, confirm: true } })).json();
    assert.deepEqual(imported, { created: 1, skipped: 1, bundles: { created: 1, skipped: 0 } });
    const [bundle] = store.bundles.list('admin');
    assert.equal(bundle.itemLimit, 30);
    const names = bundle.feedIds.map(id => store.getFeed(id)?.name);
    assert.deepEqual(names, ['Two', 'One']);
    assert.ok(bundle.feedIds.includes(one.feed.id), 'an existing duplicate is reused');
    const again = (await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: config, confirm: true } })).json();
    assert.deepEqual(again.bundles, { created: 0, skipped: 1 });
    const bad = (await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: { ...config, bundles: [{ name: 'x', feeds: [99] }] } } }));
    assert.equal(bad.statusCode, 400);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('成员的条目过滤和输出条数先生效；语言一致时声明语言，不一致时省略', () => {
  const filtered: Feed = { ...base, itemFilter: { include: [], exclude: ['skip'], regex: false }, outputLimit: 10 };
  const items = Array.from({ length: 12 }, (_, n) => item(`a${n}`, `https://x.test/${n}`, `2026-01-${String(n + 1).padStart(2, '0')}T00:00:00.000Z`, undefined, n === 11 ? { title: 'skip me' } : {}));
  items.reverse(); // stored newest first, like the database
  const merged = mergeBundleItems([{ feed: filtered, items }], 100);
  assert.equal(merged.length, 10, 'the member’s own output limit applies before merging');
  assert.ok(!merged.some(entry => entry.item.title === 'skip me'), 'the member’s filter applies');

  const ja = (id: string): Feed => ({ ...base, id, sourceType: 'rss', translationMode: 'translated', targetLanguage: 'ja' });
  const language = (feeds: Feed[]) => new XMLParser().parse(renderBundleRss(bundle, feeds.map(feed => ({ feed, items: [] })), 'https://rss.test/b.xml', 'https://rss.test/')).rss.channel.language;
  assert.equal(language([ja('feed_a'), ja('feed_b')]), 'ja');
  assert.equal(language([ja('feed_a'), { ...ja('feed_b'), targetLanguage: 'en' }]), undefined);
  assert.equal(language([ja('feed_a'), base]), undefined, 'an untranslated member has no known language');
  assert.equal(language([]), undefined);
});

test('聚合的 Atom 与 JSON Feed 地址共用密钥，内容与来源一致；访问令牌遵守权限和工作台隔离', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-bundles-formats-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const user = store.createUser('reader', 'reader-password'), other = store.createUser('other', 'other-password');
  const one = store.createFeed(input('One', 'https://a.test/list'), user.id);
  store.upsertItems(one.feed, [{ title: 'Hello', link: 'https://a.test/hello', publishedAt: '2026-01-01T00:00:00.000Z' }]);
  const app = await createApp({ store, dataDir: dir, startScheduler: false, browserService });
  const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
  try {
    const read = store.tokens.create(user.id, { name: 'read', scope: 'read', expiresAt: null }).secret;
    const write = store.tokens.create(user.id, { name: 'write', scope: 'write', expiresAt: null }).secret;
    const foreign = store.tokens.create(other.id, { name: 'other', scope: 'write', expiresAt: null }).secret;
    assert.equal((await app.inject({ method: 'POST', url: '/api/bundles', headers: bearer(read), payload: { name: 'x', feedIds: [] } })).statusCode, 403, 'read tokens cannot write');
    const created = await app.inject({ method: 'POST', url: '/api/bundles', headers: bearer(write), payload: { name: '令牌聚合', feedIds: [one.feed.id] } });
    assert.equal(created.statusCode, 200);
    const { bundle, bundleUrl } = created.json();
    assert.equal((await app.inject({ url: '/api/bundles', headers: bearer(read) })).json().length, 1);
    assert.equal((await app.inject({ url: `/api/bundles/${bundle.id}`, headers: bearer(foreign) })).statusCode, 404, 'another account’s token');
    assert.equal((await app.inject({ url: '/api/bundles', headers: bearer(foreign) })).json().length, 0);
    assert.equal((await app.inject({ url: '/api/bundles', headers: { ...bearer(foreign), 'x-feedlantern-user': user.id } })).statusCode, 403, 'only admins may switch workspaces');
    assert.equal((await app.inject({ method: 'POST', url: '/api/bundles', headers: bearer(foreign), payload: { name: 'x', feedIds: [one.feed.id] } })).statusCode, 400);

    const path = new URL(bundleUrl).pathname;
    const atom = await app.inject({ url: path.replace(/\.xml$/, '.atom') });
    assert.equal(atom.statusCode, 200);
    assert.match(String(atom.headers['content-type']), /application\/atom\+xml/);
    const feed = new XMLParser({ ignoreAttributes: false }).parse(atom.body).feed;
    assert.equal(feed.title['#text'], '令牌聚合');
    assert.equal(feed.entry.category['@_term'], 'One');
    const json = await app.inject({ url: path.replace(/\.xml$/, '.json') });
    assert.match(String(json.headers['content-type']), /application\/feed\+json/);
    const document = JSON.parse(json.body);
    assert.equal(document.items[0].title, 'Hello');
    assert.deepEqual(document.items[0].tags, ['One']);
    assert.notEqual(json.headers.etag, (await app.inject({ url: path })).headers.etag);

    await app.inject({ method: 'POST', url: `/api/bundles/${bundle.id}/rotate-token`, headers: bearer(write), payload: {} });
    for (const extension of ['.xml', '.atom', '.json']) assert.equal((await app.inject({ url: path.replace(/\.xml$/, extension) })).statusCode, 404);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
