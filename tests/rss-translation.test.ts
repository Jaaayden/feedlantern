import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { parseSource, fetchSource, digest, safeHtml } from '../src/server/rss-source.js';
import { NetworkPolicy } from '../src/server/network.js';
import { TranslationWorker, translateBody, TranslationError, googleTranslate, googleTranslateBatch } from '../src/server/rss-translation.js';
import { Store, createApp, type BrowserServiceLike } from '../src/server/app.js';
import { renderRss, rssEtag } from '../src/server/rss.js';
import { snapshotSchema, sealBackup, openBackup } from '../src/server/backups.js';

const input = { name: 'RSS', url: 'https://example.test/rss', sourceType: 'rss' as const, translationMode: 'bilingual' as const, rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 30, waitMs: 0 };
const sourceItem = { key: digest('one'), title: 'Hello', link: 'https://example.test/one', html: '<p>Hello <strong>world</strong>.</p><pre>const x = 1;</pre><img src="https://example.test/a.png" />', publishedAt: '2026-09-12T00:00:00.000Z' };
async function until(check: () => boolean, timeout = 4000) { const deadline = Date.now() + timeout; while (!check()) { if (Date.now() > deadline) throw Error('condition timed out'); await delay(10); } }

test('RSS/Atom parse full content, stable IDs, HTML safety and unsupported XML', () => {
  const rss = parseSource(`<rss version="2.0"><channel><title>News</title><item><guid>fixed</guid><title>A &amp; B</title><link>/one</link><description>summary</description><content:encoded><![CDATA[<p>Full <a href="/a">article</a><img src="/image" onerror="alert(1)"></p><script>alert(1)</script>]]></content:encoded></item></channel></rss>`, input.url);
  assert.equal(rss.items[0].title, 'A & B');
  assert.match(rss.items[0].html, /Full/); assert.doesNotMatch(rss.items[0].html, /summary|onerror|script|alert/);
  assert.match(rss.items[0].html, /https:\/\/example.test\/image/);
  const atom = parseSource(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title><entry><id>fixed</id><title>Atom &lt;tag&gt;</title><link href="/entry"/><content type="html">&lt;p&gt;Text&lt;/p&gt;</content><updated>2026-09-12T01:00:00Z</updated></entry></feed>`, input.url);
  assert.equal(atom.items[0].title, 'Atom <tag>'); assert.equal(atom.items[0].html, '<p>Text</p>');
  const xhtml = parseSource('<feed><title>F</title><entry><id>x</id><title>X</title><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>A <strong>B</strong></p></div></content></entry></feed>', input.url);
  assert.match(xhtml.items[0].html, /<p>A <strong>B<\/strong><\/p>/);
  assert.throws(() => parseSource('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>', input.url), /实体/);
  assert.throws(() => parseSource('<html/>', input.url), /未返回/);
  assert.equal(parseSource('<rss><channel><title>Empty</title></channel></rss>', input.url).items.length, 0);
  assert.doesNotMatch(safeHtml('<a href="javascript:alert(1)">a</a><iframe src="/x"></iframe>', input.url), /javascript|iframe/);
});

test('HTML translation preserves list/table structure, images and code without submitting markup', async () => {
  const sent: string[] = [];
  const result = await translateBody('<ul><li>Hello <b>world</b><img src="https://e.test/i" /></li></ul><table><tr><td>Cell</td></tr></table><pre>do not translate</pre>', async text => { sent.push(text); return '中文'; });
  assert.ok(sent.every(t => !/[<>]/.test(t))); assert.ok(!sent.includes('do not translate'));
  assert.equal((result.bilingualHtml.match(/<li>/g) ?? []).length, 1);
  assert.equal((result.bilingualHtml.match(/<td>/g) ?? []).length, 1);
  assert.equal((result.bilingualHtml.match(/<img /g) ?? []).length, 1);
  assert.match(result.translatedHtml, /<pre>do not translate<\/pre>/);
  assert.match(result.bilingualHtml, /Hello/);
});

test('fetch RSS pins safe connections, handles redirects/304 and enforces limits', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/rss' }); res.end(); }
    else if (req.url === '/private') { res.writeHead(302, { location: 'http://127.0.0.1:1/internal' }); res.end(); }
    else if (req.url === '/large') { res.end('x'.repeat(5_000_001)); }
    else if (req.headers['if-none-match'] === 'version-one') { res.writeHead(304); res.end(); }
    else { res.setHeader('ETag', 'version-one'); res.end('<rss><channel><title>Local</title></channel></rss>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
  const policy = new NetworkPolicy({ allowedHosts: [`127.0.0.1:${address.port}`], dnsOverHttps: false });
  try {
    const result = await fetchSource(`${base}/redirect`, policy); assert.equal(result.title, 'Local'); assert.equal(result.etag, 'version-one');
    assert.equal((await fetchSource(`${base}/rss`, policy, { etag: result.etag })).unchanged, true);
    await assert.rejects(fetchSource(`${base}/private`, policy), /阻止/);
    await assert.rejects(fetchSource(`${base}/large`, policy), /5 MB/);
    await assert.rejects(fetchSource(`${base}/rss`, new NetworkPolicy()), /阻止/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('persistent cache, mode change, changed content and restart keep item identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-translate-')); let store = new Store(dir); let calls = 0;
  let worker = new TranslationWorker(store.translations, async text => { calls++; return `译${text}`; }, 0);
  try {
    const { feed } = store.createFeed(input);
    store.translations.upsert(feed, [sourceItem]); worker.start();
    await until(() => store.translations.stats(feed.id).success === 1);
    const first = store.getItems(feed.id)[0]; const before = calls;
    assert.match(first.title, /译Hello \/ Hello/); assert.match(first.contentHtml!, /const x = 1/);
    store.translations.upsert(feed, [sourceItem]); worker.wake(); await delay(20); assert.equal(calls, before);
    const etag = rssEtag(store.getFeed(feed.id)!, [first]);
    store.updateFeedSettings(feed.id, { translationMode: 'chinese' });
    assert.equal(store.getItems(feed.id)[0].title, '译Hello'); assert.notEqual(rssEtag(store.getFeed(feed.id)!, store.getItems(feed.id)), etag);
    store.translations.upsert(feed, [{ ...sourceItem, html: sourceItem.html + '<p>New paragraph</p>' }]); worker.wake();
    await until(() => store.translations.stats(feed.id).success === 1); assert.equal(calls, before + 1);
    assert.equal(store.getItems(feed.id)[0].id, first.id); assert.equal(store.getItems(feed.id)[0].publishedAt, first.publishedAt);
    await worker.stop(); store.close(); store = new Store(dir);
    worker = new TranslationWorker(store.translations, async () => { throw Error('cache should survive'); }, 0); worker.start();
    assert.equal(store.getItems(feed.id)[0].translationStatus, 'success');
    assert.match(renderRss(store.getFeed(feed.id)!, store.getItems(feed.id), 'https://e.test/out.xml'), /译Hello/);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('first import only handles 20 entries and subsequent refreshes skip older history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-history-rss-')); const store = new Store(dir);
  try {
    const { feed } = store.createFeed(input);
    const items = Array.from({ length: 100 }, (_, i) => ({ ...sourceItem, key: digest(String(i)), title: `Article ${i}` }));
    const initial = store.translations.incoming(feed.id, items); assert.equal(initial.length, 20);
    store.translations.upsert(feed, initial); store.translations.saveSource(feed.id, { title: 'Feed', items });
    assert.equal(store.translations.incoming(feed.id, items).length, 20);
    assert.equal(store.translations.incoming(feed.id, [{ ...sourceItem, key: digest('new') }, ...items]).length, 21);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('pause/delete invalidate old jobs; interrupted worker resumes safely; finite retry preserves original', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-translate-race-')); const store = new Store(dir);
  let release: (() => void) | undefined; let entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let worker = new TranslationWorker(store.translations, async () => { entered = true; await gate; return '旧结果'; }, 0);
  try {
    const { feed } = store.createFeed(input); store.translations.upsert(feed, [sourceItem]); worker.start();
    await until(() => entered); store.toggleFeed(feed.id); release!(); await worker.stop();
    assert.equal(store.getItems(feed.id)[0].translationStatus, 'pending'); assert.doesNotMatch(store.getItems(feed.id)[0].title, /旧结果/);
    store.toggleFeed(feed.id);
    const job = store.translations.next()!;
    store.translations.begin(job); store.translations.fail(job, '限流', 120_000, false);
    assert.equal(store.translations.next(), undefined);
    const tables = store.exportTables(); const row = tables.translations[0]; assert.equal(row.attempts, 1); assert.ok(row.next_at >= Date.now() + 119_000);
    store.translations.fail({ ...job, attempts: 2 }, '限流', 0, false);
    assert.equal(store.getItems(feed.id)[0].translationStatus, 'failed'); assert.match(store.getItems(feed.id)[0].contentHtml!, /Hello/);
    store.translations.retry(feed.id);
    worker = new TranslationWorker(store.translations, async () => '恢复', 0); worker.start(); await until(() => store.translations.stats(feed.id).success === 1);
    await worker.stop(); store.translations.upsert(feed, [{ ...sourceItem, title: 'changed' }]);
    const old = store.translations.next()!; store.deleteFeed(feed.id); store.translations.finish(old, { html: '', title: 'bad' });
    assert.equal(store.translations.stats(feed.id).success, 0);
  } finally { release?.(); await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('new and old encrypted backups restore RSS state and cache across master keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-rss-backup-')); const target = mkdtempSync(join(tmpdir(), 'fl-rss-restore-'));
  const store = new Store(dir); const other = new Store(target);
  try {
    store.createAdmin('admin', 'password123'); const { feed } = store.createFeed(input);
    store.translations.upsert(feed, [sourceItem]); store.translations.cache('Hello', '你好');
    store.translations.saveSource(feed.id, { title: 'Feed', items: [sourceItem], etag: 'v1' });
    const snapshot = snapshotSchema.parse({ format: 'feedlantern-backup', version: 1, appVersion: '0.3.0', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables: store.exportTables() });
    other.restoreTables(openBackup(sealBackup(snapshot, 'backup-password'), 'backup-password').tables);
    assert.equal(other.getFeed(feed.id)?.sourceType, 'rss'); assert.equal(other.translations.cached('Hello'), '你好');
    assert.deepEqual(other.translations.sourceState(feed.id), { etag: 'v1', modified: undefined });
    const old = JSON.parse(JSON.stringify(snapshot)); delete old.tables.translations; delete old.tables.rss_sources; delete old.tables.translation_cache;
    for (const f of old.tables.feeds) { delete f.source_type; delete f.translation_mode; }
    other.restoreTables(snapshotSchema.parse(old).tables); assert.equal(other.getFeed(feed.id)?.sourceType, 'website');
  } finally { store.close(); other.close(); rmSync(dir, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

const fakeBrowser = { dispose: async () => {}, scrape: async () => { throw Error('RSS must not launch browser'); } } as unknown as BrowserServiceLike;
test('RSS API preview/create/translation/output/settings/retry and fetch logs integrate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-rss-api-')); const store = new Store(dir); let fail = false; let seenEtag = '';
  const app = await createApp({ store, dataDir: dir, browserService: fakeBrowser, startScheduler: false, translator: async text => `中文${text}`, translationIntervalMs: 0,
    rssFetcher: async (_url, options) => { if (fail) throw Error('source offline'); seenEtag = options?.etag ?? ''; return options?.etag ? { title: '', items: [], unchanged: true } : { title: 'News', items: [sourceItem], etag: 'one' }; } });
  try {
    const host = '127.0.0.1:4321';
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: store.getSetupToken(), username: 'admin', password: 'password123' } });
    const headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken };
    const unauth = await app.inject({ method: 'POST', url: '/api/rss/preview', headers: { host, 'x-feedlantern': '1' }, payload: { url: input.url } }); assert.equal(unauth.statusCode, 401);
    const preview = await app.inject({ method: 'POST', url: '/api/rss/preview', headers, payload: { url: input.url } }); assert.equal(preview.statusCode, 200); assert.equal(preview.json().items.length, 1);
    const created = await app.inject({ method: 'POST', url: '/api/feeds', headers, payload: { ...input, rules: undefined } }); assert.equal(created.statusCode, 200);
    const id = created.json().feed.id; await until(() => store.translations.stats(id).success === 1);
    const rssPath = new URL(created.json().feedUrl).pathname;
    const rss = await app.inject({ url: rssPath }); assert.equal(rss.statusCode, 200); assert.match(rss.body, /中文Hello/);
    const notModified = await app.inject({ url: rssPath, headers: { 'if-none-match': rss.headers.etag as string } }); assert.equal(notModified.statusCode, 304);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/feeds/${id}`, headers, payload: { translationMode: 'chinese' } })).statusCode, 200);
    assert.equal(store.getItems(id)[0].title, '中文Hello');
    await app.inject({ method: 'POST', url: `/api/feeds/${id}/refresh`, headers, payload: {} }); assert.equal(seenEtag, 'one');
    const logs = await app.inject({ url: `/api/feeds/${id}/logs`, headers }); assert.equal(logs.json().logs[0].status, 'success');
    fail = true; await app.inject({ method: 'POST', url: `/api/feeds/${id}/refresh`, headers, payload: {} });
    assert.equal(store.history.list(id).logs[0].status, 'failure'); assert.equal(store.getItems(id)[0].translationStatus, 'success');
    assert.equal((await app.inject({ method: 'POST', url: `/api/feeds/${id}/translation/retry`, headers, payload: {} })).statusCode, 200);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Google adapter validates segments, HTML block page, rate limit and empty responses', async t => {
  const signal = new AbortController().signal;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([['你好'], ['en']])));
  assert.equal(await googleTranslate('Hello', signal), '你好');
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>blocked</html>'));
  await assert.rejects(googleTranslate('Hello', signal), /请求限制/);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }));
  await assert.rejects(googleTranslate('Hello', signal), (error: unknown) => error instanceof TranslationError && error.retryAfterMs === 120_000);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([[''], ['en']])));
  await assert.rejects(googleTranslate('Hello', signal), /空译文/);
});

test('DNS hostname requests connect to the checked address with the original Host header', async () => {
  let host = '';
  const server = createServer((request, response) => { host = request.headers.host ?? ''; response.end('<rss><channel><title>Pinned</title></channel></rss>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  class PinnedPolicy extends NetworkPolicy { override async resolveForConnection(url: string) { return { url: new URL(url), address: '127.0.0.1' }; } }
  try {
    assert.equal((await fetchSource(`http://not-resolvable.invalid:${port}/rss`, new PinnedPolicy())).title, 'Pinned');
    assert.equal(host, `not-resolvable.invalid:${port}`);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('long text is bounded, shared fragments deduplicate, worker request concurrency stays bounded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-rss-long-')); const store = new Store(dir);
  const seen: string[] = []; let active = 0; let maxActive = 0;
  const worker = new TranslationWorker(store.translations, async text => { seen.push(text); active++; maxActive = Math.max(maxActive, active); await delay(2); active--; return `译${text}`; }, 0);
  try {
    const { feed } = store.createFeed(input); const long = 'A'.repeat(2501);
    store.translations.upsert(feed, Array.from({ length: 4 }, (_, i) => ({ ...sourceItem, key: digest(`long-${i}`), html: `<p>${long}</p>` })));
    worker.start(); await until(() => store.translations.stats(feed.id).success === 4);
    assert.ok(maxActive <= 6); assert.ok(maxActive > 1); assert.ok(seen.every(text => Array.from(text).length <= 1000));
    assert.equal(seen.filter(text => text === 'A'.repeat(1000)).length, 1);
    assert.equal(seen.filter(text => text === 'Hello').length, 1);
    assert.match(store.getItems(feed.id)[0].contentHtml!, /A{501}/);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('aborted in-flight translation resumes after worker restart without being marked failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-rss-abort-')); const store = new Store(dir); let entered = false;
  let worker = new TranslationWorker(store.translations, async (_text, signal) => { entered = true; await delay(60_000, undefined, { signal }); return 'never'; }, 0);
  try {
    const { feed } = store.createFeed(input); store.translations.upsert(feed, [sourceItem]); worker.start(); await until(() => entered);
    await worker.stop(); assert.equal(store.exportTables().translations[0].attempts, 0); assert.equal(store.getItems(feed.id)[0].translationStatus, 'pending');
    worker = new TranslationWorker(store.translations, async () => '恢复译文', 0); worker.start(); await until(() => store.translations.stats(feed.id).success === 1);
    assert.match(store.getItems(feed.id)[0].title, /恢复译文/);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('public RSS excludes pending, failed and partially translated items; completion updates ETag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-rss-published-')); const store = new Store(dir);
  let release!: () => void; let bodyStarted = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const app = await createApp({ store, dataDir: dir, browserService: fakeBrowser, startScheduler: false, translationIntervalMs: 0,
    translator: async text => { if (text === 'Hello') return '你好'; bodyStarted = true; await gate; return `译${text}`; } });
  try {
    const { feed, token } = store.createFeed(input); store.translations.upsert(feed, [sourceItem]);
    const failed = { ...sourceItem, key: digest('failed-public'), title: 'Failed article' };
    store.translations.upsert(feed, [failed]);
    const tables = store.exportTables();
    // Mark the second title failed before the worker starts, without touching the pending item.
    const failedItem = store.getItems(feed.id).find(item => item.title === 'Failed article')!;
    const failJob = { item_id: failedItem.id, feed_id: feed.id, revision: tables.translations.find(t => t.item_id === failedItem.id)!.revision, attempts: 2, body_json: '{}', title: failedItem.title, link: failedItem.link };
    store.translations.fail(failJob, '测试失败', 0, false);
    const url = `/feeds/${feed.id}/${token}.xml`;
    const before = await app.inject({ url }); await until(() => bodyStarted);
    assert.equal(before.statusCode, 200); assert.doesNotMatch(before.body, /<item>|等待翻译|暂显示原文|Failed article/);
    assert.equal(store.getItems(feed.id).length, 2); assert.ok(store.getItems(feed.id).some(i => i.translationStatus === 'pending'));
    const partiallyTranslated = await app.inject({ url }); assert.doesNotMatch(partiallyTranslated.body, /<item>|你好/);
    assert.equal(partiallyTranslated.headers.etag, before.headers.etag);
    release(); await until(() => store.translations.stats(feed.id).success === 1);
    const after = await app.inject({ url, headers: { 'if-none-match': String(before.headers.etag) } });
    assert.equal(after.statusCode, 200); assert.notEqual(after.headers.etag, before.headers.etag);
    assert.equal((after.body.match(/<item>/g) ?? []).length, 1); assert.match(after.body, /你好/); assert.doesNotMatch(after.body, /Failed article|暂显示原文/);
  } finally { release(); await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('one article uses six concurrent HTTP requests, preserves DOM order and honors configured cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-rss-speed-')); const store = new Store(dir);
  let active = 0, maximum = 0; const release: Array<() => void> = [];
  const worker = new TranslationWorker(store.translations, async text => {
    active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => { release.push(resolve); });
    active--; return `译${text}`;
  }, () => ({ concurrency: 6, requestIntervalMs: 0 }));
  try {
    const { feed } = store.createFeed(input);
    store.translations.upsert(feed, [{ ...sourceItem, html: Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i}</p>`).join('') }]);
    worker.start(); await until(() => active === 6);
    assert.equal(store.translations.stats(feed.id).success, 0);
    while (store.translations.stats(feed.id).success !== 1) {
      release.splice(0).reverse().forEach(resolve => resolve()); await delay(10);
    }
    assert.equal(maximum, 6);
    const content = store.getItems(feed.id)[0].contentHtml!;
    assert.ok(content.indexOf('译Paragraph 0') < content.indexOf('译Paragraph 11'));
  } finally { release.splice(0).forEach(resolve => resolve()); await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a normal translation failure does not cool down unrelated subscriptions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-rss-isolation-')); const store = new Store(dir);
  const worker = new TranslationWorker(store.translations, async text => { if (text === 'Broken') throw new TranslationError('bad response'); return `译${text}`; }, () => ({ concurrency: 1, requestIntervalMs: 0 }));
  try {
    const one = store.createFeed(input).feed, two = store.createFeed({ ...input, name: 'second' }).feed;
    store.translations.upsert(one, [{ ...sourceItem, title: 'Broken', html: '' }]);
    worker.start(); await until(() => store.exportTables().translations[0].attempts === 1);
    store.translations.upsert(two, [sourceItem]); worker.wake();
    await until(() => store.translations.stats(two.id).success === 1);
    assert.equal(store.translations.stats(one.id).pending, 1);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('explicit rate limit stops queued requests and manual retry preserves Retry-After', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-rss-limit-')); const store = new Store(dir); let calls = 0;
  const worker = new TranslationWorker(store.translations, async () => { calls++; throw new TranslationError('限流', 120_000, true); }, () => ({ concurrency: 1, requestIntervalMs: 0 }));
  try {
    const { feed } = store.createFeed(input); store.translations.upsert(feed, [sourceItem]); worker.start();
    await until(() => store.exportTables().translations[0].attempts === 1);
    assert.equal(calls, 1);
    store.translations.retry(feed.id); worker.retry(); await delay(30); assert.equal(calls, 1);
    assert.equal(store.translations.stats(feed.id).success, 0);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('browser batch protocol keeps positional mapping, escapes text and rejects incomplete results', async t => {
  const signal = new AbortController().signal;
  const texts = [' Hello & world ', 'Use <tag> literally', 'Keep &lt; encoded'];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(url, 'https://translate-pa.googleapis.com/v1/translateHtml');
    assert.equal(options?.method, 'POST'); assert.equal(new Headers(options?.headers).get('content-type'), 'application/json+protobuf');
    assert.ok(new Headers(options?.headers).get('x-goog-api-key'));
    assert.deepEqual(JSON.parse(String(options?.body)), [[[' Hello &amp; world ', 'Use &lt;tag&gt; literally', 'Keep &amp;lt; encoded'], 'auto', 'zh-CN'], 'te_lib']);
    return new Response(JSON.stringify([['你好 &amp; 世界', '直接使用 &lt;tag&gt;', '保持 &amp;lt; 编码'], ['en', 'en', 'en']]));
  });
  assert.deepEqual(await googleTranslateBatch(texts, signal), [' 你好 & 世界 ', '直接使用 <tag>', '保持 &lt; 编码']);
  for (const result of [[['只有一个']], [['一', null, '三']], [['一', '', '三']], { error: 'unavailable' }]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(result)));
    await assert.rejects(googleTranslateBatch(texts, signal), /不匹配|空译文/);
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  await assert.rejects(googleTranslateBatch(texts, signal), (error: unknown) => error instanceof TranslationError && !error.rateLimited && /403/.test(error.message));
});

test('production scheduler batches HTTP calls and exposes running progress and persistent logs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-batch-'));
  const store = new Store(dir); const originalFetch = globalThis.fetch;
  let calls = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (_url, options) => {
    calls++; await gate;
    const texts = JSON.parse(String(options?.body))[0][0] as string[];
    return new Response(JSON.stringify([texts.map(text => text.replaceAll('Hello', '你好'))]));
  };
  const worker = new TranslationWorker(store.translations, undefined, 0);
  try {
    const { feed } = store.createFeed(input);
    store.translations.upsert(feed, [{ ...sourceItem, html: Array.from({ length: 12 }, (_, i) => `<p>Hello paragraph ${i}</p>`).join('') }]);
    worker.start(); await until(() => calls > 0);
    const progress = store.translations.progress(feed.id);
    assert.equal(progress.tasks[0].status, 'running');
    assert.match(String(progress.logs[0].message), /开始翻译/);
    assert.equal(worker.status().activeRequests, 1);
    assert.doesNotMatch(renderRss(feed, store.getItems(feed.id), 'https://example.test/rss'), /<item>/);
    release(); await until(() => store.translations.stats(feed.id).success === 1);
    assert.equal(calls, 1, '13 independent text fragments fit one HTTP request');
    assert.match(String(store.translations.progress(feed.id).logs[0].message), /翻译完成/);
    assert.match(renderRss(feed, store.getItems(feed.id), 'https://example.test/rss'), /你好/);
  } finally { release(); await worker.stop(); globalThis.fetch = originalFetch; store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('translation rate limit automatically sends one Bark alert across failed articles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-translation-bark-')), store = new Store(dir);
  let calls = 0;
  const app = await createApp({ store, dataDir: dir, browserService: fakeBrowser, startScheduler: false,
    barkUrl: 'https://api.day.app/test-key/', barkSender: async (_url, body, _signal, title) => { calls++; assert.equal(title, '订阅灯：RSS 翻译失败'); assert.match(body, /限流/); },
    translator: async () => { throw new TranslationError('Google 限流', 60_000, true); }, translationIntervalMs: 0 });
  try {
    const { feed } = store.createFeed(input);
    store.translations.upsert(feed, [sourceItem, { ...sourceItem, key: digest('two'), title: 'Second', link: 'https://example.test/two' }]);
    await app.ready(); await until(() => calls === 1);
    await until(() => store.translations.progress(feed.id).tasks.every(task => task.attempts === 1));
    assert.equal(calls, 1); assert.doesNotMatch(renderRss(feed, store.getItems(feed.id), 'https://example.test/rss'), /<item>/);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('incomplete native batch is neither cached nor published and can retry successfully', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-browser-incomplete-')), store = new Store(dir);
  let incomplete = true;
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, options?: RequestInit) => {
    const texts = JSON.parse(String(options?.body))[0][0] as string[];
    return new Response(JSON.stringify([texts.slice(0, incomplete ? -1 : undefined).map(text => `译${text}`)]));
  });
  const worker = new TranslationWorker(store.translations, undefined, 0);
  try {
    const { feed } = store.createFeed(input); store.translations.upsert(feed, [sourceItem]);
    worker.start(); await until(() => store.translations.progress(feed.id).tasks[0].attempts === 1);
    assert.equal(store.translations.cached(sourceItem.title), undefined);
    assert.equal(store.translations.stats(feed.id).success, 0);
    assert.doesNotMatch(renderRss(feed, store.getItems(feed.id), input.url), /<item>/);
    incomplete = false; store.translations.retry(feed.id); worker.retry();
    await until(() => store.translations.stats(feed.id).success === 1);
    assert.match(renderRss(feed, store.getItems(feed.id), input.url), /译Hello/);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('native batches respect group and text limits across articles', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-browser-limits-')), store = new Store(dir);
  const sizes: number[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, options?: RequestInit) => {
    const texts = JSON.parse(String(options?.body))[0][0] as string[];
    sizes.push(texts.length); assert.ok(texts.length <= 50); assert.ok(texts.join('').length <= 1800);
    await delay(5);
    return new Response(JSON.stringify([texts.map(text => `译${text}`)]));
  });
  const worker = new TranslationWorker(store.translations, undefined, 0);
  try {
    const { feed } = store.createFeed(input);
    store.translations.upsert(feed, Array.from({ length: 6 }, (_, i) => ({ ...sourceItem, key: digest(`batch-${i}`), title: `Title ${i}`, html: Array.from({ length: 30 }, (_, j) => `<p>Paragraph ${i}-${j}: ${'word '.repeat(j % 5)}</p>`).join('') })));
    worker.start(); await until(() => store.translations.stats(feed.id).success === 6);
    assert.ok(sizes.some(size => size === 50)); assert.ok(sizes.length < 20, '186 fragments are submitted in a small number of batches');
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('website translation opt-in preserves originals, IDs, images and output mode without refetch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-website-translate-')), store = new Store(dir);
  let calls = 0;
  const worker = new TranslationWorker(store.translations, async text => { calls++; return `中文${text}`; }, 0);
  try {
    const { feed, token } = store.createFeed({ ...input, sourceType: 'website', translationMode: undefined });
    store.upsertItems(feed, [{ title: 'English title', link: sourceItem.link, description: 'Plain <script> text', image: 'https://example.test/image.png' }]);
    const original = store.getItems(feed.id)[0];
    assert.equal(store.getFeed(feed.id)!.translationMode, 'original');
    store.updateFeedSettings(feed.id, { translationMode: 'chinese' });
    assert.equal(store.translations.stats(feed.id).pending, 1);
    assert.doesNotMatch(renderRss(store.getFeed(feed.id)!, store.getItems(feed.id), input.url), /<item>/);
    worker.start(); await until(() => store.translations.stats(feed.id).success === 1);
    const translated = store.getItems(feed.id)[0];
    assert.equal(translated.id, original.id); assert.match(translated.title, /中文English/);
    assert.match(translated.contentHtml!, /&lt;script&gt;/); assert.match(translated.contentHtml!, /image.png/);
    const before = calls;
    store.updateFeedSettings(feed.id, { translationMode: 'bilingual' }); worker.wake(); await delay(30);
    assert.equal(calls, before); assert.match(store.getItems(feed.id)[0].title, / \/ English title/);
    store.updateFeedSettings(feed.id, { translationMode: 'original' });
    assert.equal(store.getItems(feed.id)[0].description, original.description); assert.equal(store.getItems(feed.id)[0].title, original.title);
    assert.ok(store.checkFeedToken(feed.id, token));
    store.upsertItems(store.getFeed(feed.id)!, [{ title: 'Changed title', link: sourceItem.link, description: 'New summary' }]);
    store.updateFeedSettings(feed.id, { translationMode: 'chinese' });
    assert.equal(store.translations.stats(feed.id).pending, 1); worker.wake();
    await until(() => store.translations.stats(feed.id).success === 1);
    assert.match(store.getItems(feed.id)[0].title, /中文Changed/); assert.equal(store.getItems(feed.id)[0].id, original.id);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
