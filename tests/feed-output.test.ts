import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { backupTables } from '../src/server/backups.js';
import { classifyItems, parseItemFilter, storedItemLimit, unsafeRegexReason } from '../src/server/feed-output.js';
import { publishedItems, renderAtom, renderJsonFeed, renderRss, rssEtag } from '../src/server/rss.js';
import { feedFormatUrl, type Feed, type FeedInput, type FeedItem } from '../src/shared/types.js';

const feed: Feed = {
  id: 'feed_output', name: 'Out & <put>', url: 'https://example.test/list', rules: { item: '.item', title: '.title', link: 'a' }, credentialId: null,
  intervalMinutes: 60, waitMs: 0, enabled: true, createdAt: '2026-01-01T00:00:00.000Z', lastFetchedAt: null,
  lastSuccessAt: '2026-01-02T00:00:00.000Z', nextFetchAt: '2026-01-03T00:00:00.000Z', lastError: null, itemCount: 0,
};
const item = (id: string, title: string, description?: string): FeedItem => ({ id, title, link: `https://example.test/${id}`, description, firstSeenAt: '2026-01-03T00:00:00.000Z' });

test('过滤规则：去空白去重，空规则视为无过滤，限制条数和长度', () => {
  assert.deepEqual(parseItemFilter({ include: [' Release ', 'release ', ''], exclude: [], regex: false }), { include: ['Release', 'release'], exclude: [], regex: false });
  assert.deepEqual(parseItemFilter({ include: ['  '], exclude: [] }), null);
  assert.equal(parseItemFilter(null), null);
  assert.throws(() => parseItemFilter({ include: Array.from({ length: 31 }, (_, i) => `k${i}`) }), /最多 30 条/);
  assert.throws(() => parseItemFilter({ exclude: ['x'.repeat(201)] }), /200 个字符/);
  assert.throws(() => parseItemFilter({ include: 'release' }), /格式无效/);
  assert.throws(() => parseItemFilter({ include: ['a'], regex: 'yes' }), /格式无效/);
  // Plain keywords are never compiled, so regex syntax in them is just text.
  assert.deepEqual(parseItemFilter({ include: ['(a+)+', '[广告'] })?.include, ['(a+)+', '[广告']);
});

test('正则规则：拒绝无效语法、反向引用和会指数回溯的写法', () => {
  for (const pattern of ['(a+)+', '(a|ab)*', '(\\w+\\s?)+$', '((ab)*)+', '(?:x|y){2,}', '(a)\\1', '(?<n>a)\\k<n>']) {
    assert.ok(unsafeRegexReason(pattern), pattern);
  }
  for (const pattern of ['\\b(ad|sponsored)\\b', 'foo.*bar', '^\\[广告\\]', '\\p{Script=Han}+', '(?<tag>v\\d+)\\.\\d+', '(ab)+', 'a{2,5}', '[(+*]+', '\\u{1F600}+', '(?=x)y', '(a+)?']) {
    assert.equal(unsafeRegexReason(pattern), null, pattern);
  }
  assert.throws(() => parseItemFilter({ include: ['(a+)+'], regex: true }), /嵌套重复/);
  assert.throws(() => parseItemFilter({ exclude: ['(unclosed'], regex: true }), /正则表达式无效/);
  assert.throws(() => parseItemFilter({ exclude: ['(a)\\1'], regex: true }), /反向引用/);
  assert.deepEqual(parseItemFilter({ exclude: ['^\\[广告\\]'], regex: true }), { include: [], exclude: ['^\\[广告\\]'], regex: true });
});

test('关键词过滤不区分大小写，匹配标题和摘要，排除优先；输出条数在过滤之后计算', () => {
  const items = [item('1', 'Release 1.0', 'notes'), item('2', 'Weekly digest', 'contains a RELEASE note'), item('3', 'Sponsored release', ''), item('4', 'Other', 'nothing'), item('5', 'release 2.0')];
  const filtered: Feed = { ...feed, itemFilter: { include: ['release'], exclude: ['sponsored'], regex: false }, outputLimit: 10 };
  assert.deepEqual(classifyItems(filtered, items).statuses, ['published', 'published', 'excluded', 'not-included', 'published']);
  const many = [item('x', 'Sponsored release'), ...Array.from({ length: 12 }, (_, i) => item(`r${i}`, `release ${i}`))];
  const limited = classifyItems({ ...filtered, outputLimit: 500 }, many, { outputLimit: 10 }).statuses;
  assert.deepEqual([limited[0], limited.filter(status => status === 'published').length, limited.slice(11)], ['excluded', 10, ['over-limit', 'over-limit']], 'excluded items do not use up the limit');
  assert.deepEqual(publishedItems({ ...feed, outputLimit: 10 }, Array.from({ length: 30 }, (_, i) => item(String(i), `t${i}`))).length, 10);
  assert.equal(publishedItems(feed, Array.from({ length: 150 }, (_, i) => item(String(i), `t${i}`))).length, 100, 'default stays 100');
  // An override previews unsaved settings: null removes the saved filter.
  assert.deepEqual(classifyItems(filtered, items, { itemFilter: null }).statuses.every(status => status === 'published'), true);
  const regex: Feed = { ...feed, itemFilter: { include: [], exclude: ['^weekly\\b', '\\d\\.0$'], regex: true } };
  assert.deepEqual(classifyItems(regex, items).statuses, ['excluded', 'excluded', 'published', 'published', 'excluded']);
});

test('RSS 来源按纯文本匹配摘要，翻译订阅只对已完成翻译的条目过滤', () => {
  const rssFeed: Feed = { ...feed, sourceType: 'rss', translationMode: 'original', itemFilter: { include: [], exclude: ['hidden'], regex: false } };
  const html = [item('a', 'One', '<p data-x="hidden">visible text</p>'), item('b', 'Two', '<p>a <b>hidden</b> word</p>')];
  assert.deepEqual(classifyItems(rssFeed, html).statuses, ['published', 'excluded'], 'attributes are not summary text');
  const translated: Feed = { ...rssFeed, translationMode: 'translated', itemFilter: { include: [], exclude: ['广告'], regex: false } };
  const items: FeedItem[] = [
    { ...item('c', '新闻'), contentHtml: '<p>正文</p>', translationStatus: 'success' },
    { ...item('d', '广告'), contentHtml: '<p>正文</p>', translationStatus: 'success' },
    { ...item('e', '等待'), contentHtml: '<p>广告</p>', translationStatus: 'pending' },
  ];
  assert.deepEqual(classifyItems(translated, items).statuses, ['published', 'excluded', 'untranslated']);
});

test('正则运行超时会被中断：本次不应用过滤并缓存结果，不会卡住服务', () => {
  // Polynomial backtracking the static check cannot see; 2000 characters make it run for minutes.
  const slow: Feed = { ...feed, id: 'feed_slow', itemFilter: { include: [], exclude: ['.*.*.*.*.*x'], regex: true } };
  assert.deepEqual(parseItemFilter(slow.itemFilter), slow.itemFilter);
  const items = [item('1', 'b', 'a'.repeat(3000)), item('2', 'b')];
  const originalWarn = console.warn; console.warn = () => {};
  try {
    let started = performance.now();
    const first = classifyItems(slow, items);
    assert.ok(performance.now() - started < 2000);
    assert.equal(first.timedOut, true);
    assert.deepEqual(first.statuses, ['published', 'published']);
    started = performance.now();
    assert.equal(classifyItems(slow, items).timedOut, true);
    assert.ok(performance.now() - started < 50, 'the timed-out result is cached');
  } finally { console.warn = originalWarn; }
});

test('Atom 1.0 与 JSON Feed 1.1 输出与 RSS 相同的条目，正确转义', () => {
  const filtered: Feed = { ...feed, itemFilter: { include: [], exclude: ['skip'], regex: false } };
  const items: FeedItem[] = [
    { ...item('i1', 'A <b> & "c"', 'summary <script>alert(1)</script>'), image: '/cover.png', publishedAt: '2026-01-05T10:00:00.000Z' },
    item('i2', 'skip me'),
    { ...item('i3', 'Bad link'), link: 'javascript:alert(1)' },
  ];
  const atom = renderAtom(filtered, items, 'https://feeds.test/feeds/f/t.atom');
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(atom).feed;
  assert.equal(parsed['@_xmlns'], 'http://www.w3.org/2005/Atom');
  assert.equal(parsed.id, 'urn:feedlantern:feed:feed_output');
  assert.equal(parsed.title['#text'], 'Out & <put>');
  assert.equal(parsed.updated, '2026-01-02T00:00:00.000Z');
  assert.deepEqual(parsed.link.map((link: Record<string, string>) => link['@_rel']), ['self', 'alternate']);
  assert.equal(parsed.link[0]['@_href'], 'https://feeds.test/feeds/f/t.atom');
  assert.equal(parsed.entry.length, 2);
  assert.equal(parsed.entry[0].title['#text'], 'A <b> & "c"');
  assert.equal(parsed.entry[0].published, '2026-01-05T10:00:00.000Z');
  assert.match(parsed.entry[0].content['#text'], /&lt;script&gt;/, 'HTML content keeps the summary escaped');
  assert.match(parsed.entry[0].content['#text'], /<img src="https:\/\/example\.test\/cover\.png"/);
  assert.equal(parsed.entry[1].link, undefined, 'unsafe links are left out');
  assert.equal(parsed.entry[1].updated, '2026-01-03T00:00:00.000Z');
  assert.ok(!atom.includes('<script>'));

  const text = renderJsonFeed(filtered, items, 'https://feeds.test/feeds/f/t.json');
  assert.ok(!/[<>&]/.test(text), 'markup characters are \\u-escaped');
  const json = JSON.parse(text);
  assert.equal(json.version, 'https://jsonfeed.org/version/1.1');
  assert.equal(json.title, 'Out & <put>');
  assert.equal(json.feed_url, 'https://feeds.test/feeds/f/t.json');
  assert.equal(json.home_page_url, 'https://example.test/list');
  assert.deepEqual(json.items.map((entry: { id: string }) => entry.id), ['i1', 'i3']);
  assert.equal(json.items[0].image, 'https://example.test/cover.png');
  assert.equal(json.items[0].date_published, '2026-01-05T10:00:00.000Z');
  assert.equal(json.items[1].url, undefined);
  assert.equal(new XMLParser().parse(renderRss(filtered, items, 'https://feeds.test/x.xml')).rss.channel.item.length, 2);
  assert.notEqual(rssEtag(filtered, items, 'atom'), rssEtag(filtered, items));
  assert.notEqual(rssEtag(filtered, items), rssEtag(feed, items), 'changing the filter changes the ETag');
  assert.equal(feedFormatUrl('https://x.test/feeds/a/tok.xml', 'json'), 'https://x.test/feeds/a/tok.json');
});

test('存储保留量随输出条数增大；调小后不立即删除，下次抓取才清理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-output-store-')), store = new Store(dir);
  try {
    const { feed: created } = store.createFeed({ name: 'Limit', url: 'https://example.test', rules: { item: 'a', title: 'a', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 });
    assert.equal(created.outputLimit, 100);
    assert.equal(storedItemLimit(created), 200);
    assert.equal(storedItemLimit({ sourceType: 'rss', outputLimit: 100 }), 100);
    const batch = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ title: `${prefix}${i}`, link: `https://example.test/${prefix}${i}` }));
    store.updateFeedSettings(created.id, { outputLimit: 300 });
    store.upsertItems(store.getFeed(created.id)!, batch('a', 320));
    assert.equal(store.getItems(created.id).length, 300);
    store.updateFeedSettings(created.id, { outputLimit: 20, itemFilter: { include: ['a1'], exclude: [], regex: false } });
    assert.equal(store.getItems(created.id).length, 300, 'lowering the limit keeps data until the next fetch');
    const saved = store.getFeed(created.id)!;
    assert.deepEqual(saved.itemFilter, { include: ['a1'], exclude: [], regex: false });
    assert.equal(publishedItems(saved, store.getItems(created.id)).length, 20);
    store.upsertItems(saved, batch('b', 1));
    assert.equal(store.getItems(created.id).length, 200);
    store.updateFeedSettings(created.id, { itemFilter: null });
    assert.equal(store.getFeed(created.id)!.itemFilter, undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('v8 数据库迁移到 v9：输出条数默认 100，备份保留过滤和条数，旧备份可恢复', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'fl-output-migrate-')), other = mkdtempSync(join(tmpdir(), 'fl-output-restore-'));
  let store = new Store(dir);
  const target = new Store(other);
  try {
    const { feed: created } = store.createFeed({ name: 'Old', url: 'https://example.test', rules: { item: 'a', title: 'a', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 });
    store.close();
    const db = new DatabaseSync(join(dir, 'app.db'));
    db.exec('ALTER TABLE feeds DROP COLUMN item_filter_json; ALTER TABLE feeds DROP COLUMN output_limit; PRAGMA user_version=8;'); db.close();
    store = new Store(dir);
    assert.equal(store.getFeed(created.id)?.outputLimit, 100);
    assert.equal(store.getFeed(created.id)?.itemFilter, undefined);
    store.updateFeedSettings(created.id, { outputLimit: 250, itemFilter: { include: [], exclude: ['广告'], regex: false } });
    const tables = store.exportTables();
    const row = backupTables.feeds.parse(tables.feeds)[0];
    assert.equal(row.output_limit, 250);
    target.restoreTables(tables);
    assert.equal(target.getFeed(created.id)?.outputLimit, 250);
    assert.deepEqual(target.getFeed(created.id)?.itemFilter, { include: [], exclude: ['广告'], regex: false });
    // A backup from before v9 has neither column.
    const legacy = structuredClone(tables);
    for (const feedRow of legacy.feeds as Array<Record<string, unknown>>) { delete feedRow.output_limit; delete feedRow.item_filter_json; }
    backupTables.feeds.parse(legacy.feeds);
    target.restoreTables(legacy);
    assert.equal(target.getFeed(created.id)?.outputLimit, 100);
    assert.throws(() => backupTables.feeds.parse([{ ...row, output_limit: 5000 }]));
  } finally { store.close(); target.close(); rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test('API：三种格式共用密钥与条目，设置面板接口校验过滤规则和条数', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fl-output-api-'));
  const fakeBrowser = { async close() {}, async dispose() {}, async scrape() { return []; } } as unknown as BrowserServiceLike;
  const app = await createApp({ dataDir, publicOrigin: 'http://127.0.0.1:4321', browserService: fakeBrowser, startScheduler: false });
  try {
    const host = '127.0.0.1:4321';
    const setupToken = readFileSync(join(dataDir, 'setup-token'), 'utf8').trim();
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken, username: 'admin', password: 'password123' } });
    const headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken as string };
    const input: FeedInput = { name: 'API', url: 'https://example.test', rules: { item: 'a', title: 'a', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 };
    const created = await app.inject({ method: 'POST', url: '/api/feeds', headers, payload: input });
    const id = created.json().feed.id as string;
    const rssPath = new URL(created.json().feedUrl).pathname;
    // Items arrive through the store, exactly as a fetch would write them.
    const direct = new Store(dataDir);
    try { direct.upsertItems(direct.getFeed(id)!, [{ title: 'Keep me', link: 'https://example.test/1' }, { title: 'Ad: buy', link: 'https://example.test/2' }]); } finally { direct.close(); }

    const bad = async (payload: Record<string, unknown>, pattern: RegExp) => {
      const response = await app.inject({ method: 'PATCH', url: `/api/feeds/${id}`, headers, payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.match(response.json().error, pattern);
    };
    await bad({ outputLimit: 5 }, /10 到 500/);
    await bad({ outputLimit: 501 }, /10 到 500/);
    await bad({ itemFilter: { include: ['(a+)+'], regex: true } }, /嵌套重复/);
    await bad({ itemFilter: { exclude: ['['], regex: true } }, /正则表达式无效/);

    const preview = await app.inject({ method: 'POST', url: `/api/feeds/${id}/output-preview`, headers, payload: { itemFilter: { exclude: ['^ad:'], regex: true }, outputLimit: 10 } });
    assert.equal(preview.statusCode, 200);
    assert.deepEqual(Object.values(preview.json().outputStatus).sort(), ['excluded', 'published']);
    const previewBad = await app.inject({ method: 'POST', url: `/api/feeds/${id}/output-preview`, headers, payload: { itemFilter: { exclude: ['('], regex: true } } });
    assert.equal(previewBad.statusCode, 400);

    const patched = await app.inject({ method: 'PATCH', url: `/api/feeds/${id}`, headers, payload: { itemFilter: { include: [], exclude: ['ad:'], regex: false }, outputLimit: 50 } });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().feed.outputLimit, 50);
    const detail = (await app.inject({ url: `/api/feeds/${id}`, headers })).json();
    assert.equal(detail.items.length, 2, 'stored items are kept');
    assert.deepEqual(detail.items.map((entry: FeedItem) => detail.outputStatus[entry.id]).sort(), ['excluded', 'published']);

    const fetchFormat = (path: string, extra: Record<string, string> = {}) => app.inject({ url: path, headers: extra });
    const rss = await fetchFormat(rssPath);
    const atom = await fetchFormat(rssPath.replace(/\.xml$/, '.atom'));
    const json = await fetchFormat(rssPath.replace(/\.xml$/, '.json'));
    assert.match(String(rss.headers['content-type']), /^application\/rss\+xml/);
    assert.match(String(atom.headers['content-type']), /^application\/atom\+xml; charset=utf-8/);
    assert.match(String(json.headers['content-type']), /^application\/feed\+json; charset=utf-8/);
    for (const response of [rss, atom, json]) {
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.ok(response.headers.vary);
      assert.ok(!response.body.includes('Ad: buy'), 'the filter applies to every format');
      assert.ok(response.body.includes('Keep me'));
    }
    assert.equal(json.json().feed_url, `http://127.0.0.1:4321${rssPath.replace(/\.xml$/, '.json')}`);
    assert.equal((await fetchFormat(rssPath.replace(/\.xml$/, '.atom'), { 'if-none-match': String(atom.headers.etag) })).statusCode, 304);
    assert.notEqual(atom.headers.etag, rss.headers.etag);
    // Browsers navigating to Atom / JSON get a type they display; only .xml has the preview page.
    const navigation = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: 'text/html' };
    assert.match(String((await fetchFormat(rssPath, navigation)).headers['content-type']), /^text\/html/);
    assert.match(String((await fetchFormat(rssPath.replace(/\.xml$/, '.atom'), navigation)).headers['content-type']), /^application\/xml/);
    assert.match(String((await fetchFormat(rssPath.replace(/\.xml$/, '.json'), navigation)).headers['content-type']), /^application\/json/);

    const bulk = await app.inject({ method: 'POST', url: '/api/feeds/bulk', headers, payload: { ids: [id], action: 'settings', settings: { outputLimit: 30 } } });
    assert.deepEqual(bulk.json().results, [{ id, ok: true }]);
    const exported = (await app.inject({ url: '/api/backups/config', headers })).json();
    assert.equal(exported.feeds[0].outputLimit, 30);
    assert.deepEqual(exported.feeds[0].itemFilter, { include: [], exclude: ['ad:'], regex: false });

    const rotated = await app.inject({ method: 'POST', url: `/api/feeds/${id}/rotate-token`, headers, payload: {} });
    assert.equal(rotated.statusCode, 200);
    for (const ext of ['.xml', '.atom', '.json']) assert.equal((await fetchFormat(rssPath.replace(/\.xml$/, ext))).statusCode, 404, `old ${ext} address is revoked`);
    const fresh = new URL(rotated.json().feedUrl).pathname;
    for (const ext of ['.xml', '.atom', '.json']) assert.equal((await fetchFormat(fresh.replace(/\.xml$/, ext))).statusCode, 200);
    assert.equal((await fetchFormat(fresh.replace(/\.xml$/, '.rss'))).statusCode, 404);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
