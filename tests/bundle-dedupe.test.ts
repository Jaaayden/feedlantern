import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { openBackup, sealBackup, snapshotSchema } from '../src/server/backups.js';
import { dedupeTitleKey, dedupeUrlKey } from '../src/server/bundle-dedupe.js';
import { mergeBundleItems, previewBundle, type BundleMember } from '../src/server/bundles.js';
import { normalizeLink } from '../src/server/links.js';
import { publishedItems } from '../src/server/rss.js';
import { BUNDLE_DEDUPE_DEFAULT, type BundleDedupe, type BundleFilter, type Feed, type FeedInput, type FeedItem } from '../src/shared/types.js';

const base: Feed = {
  id: 'feed_a', name: 'Alpha', url: 'https://a.test/', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null,
  intervalMinutes: 30, waitMs: 0, enabled: true, createdAt: '2026-01-01T00:00:00.000Z', lastFetchedAt: null,
  lastSuccessAt: '2026-01-05T00:00:00.000Z', nextFetchAt: '2026-01-06T00:00:00.000Z', lastError: null, itemCount: 0,
};
const feed = (id: string, name = id): Feed => ({ ...base, id, name });
const item = (id: string, link: string, firstSeenAt: string, extra: Partial<FeedItem> = {}): FeedItem => ({ id, title: id, link, firstSeenAt, publishedAt: firstSeenAt, ...extra });
const ids = (entries: Array<{ item: FeedItem }>) => entries.map(entry => entry.item.id);
const dedupe = (mode: BundleDedupe['mode'], extra: Partial<BundleDedupe> = {}): BundleDedupe => ({ ...BUNDLE_DEDUPE_DEFAULT, mode, ...extra });
const filter = (extra: Partial<BundleFilter>): BundleFilter => ({ include: [], exclude: [], regex: false, matchSource: false, ...extra });
const input = (name: string, url: string): FeedInput => ({ name, url, rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 });
const browserService = { close: async () => {}, dispose: async () => {} } as unknown as BrowserServiceLike;
const day = (n: number) => `2026-02-${String(n).padStart(2, '0')}T00:00:00.000Z`;

test('追踪参数、协议、www、末尾斜杠和参数顺序不影响忽略追踪参数的链接键，真正不同的页面仍然不同', () => {
  const same = [
    'https://example.com/post/1', 'http://example.com/post/1', 'https://www.example.com/post/1/', 'HTTPS://WWW.EXAMPLE.COM/post/1#comments',
    'https://example.com/post/1?utm_source=rss&utm_medium=feed', 'https://example.com/post/1?fbclid=abc&gclid=def&spm=a.b&ref=home&UTM_Campaign=x',
    'https://example.com:443/post/1', 'http://example.com:80/post/1/?',
  ];
  assert.equal(new Set(same.map(dedupeUrlKey)).size, 1, same.map(dedupeUrlKey).join('\n'));
  assert.equal(dedupeUrlKey('https://example.com/p?id=2&page=1'), dedupeUrlKey('https://example.com/p?page=1&id=2&utm_term=z'));
  for (const different of ['https://example.com/post/2', 'https://example.com/p?id=1', 'https://example.com:8443/post/1', 'https://blog.example.com/post/1', 'https://example.com/Post/1', 'https://example.org/post/1']) {
    assert.notEqual(dedupeUrlKey(different), dedupeUrlKey('https://example.com/post/1'), different);
  }
  assert.notEqual(dedupeUrlKey('https://example.com/p?id=1'), dedupeUrlKey('https://example.com/p?id=2'));
  assert.equal(dedupeUrlKey('mailto:a@b.test'), normalizeLink('mailto:a@b.test'));
  assert.equal(dedupeUrlKey('not a url'), 'not a url');
  assert.equal(normalizeLink('https://example.com/post/1?utm_source=a'), 'https://example.com/post/1?utm_source=a', 'the item identity inside a feed is untouched');
});

test('标题规范化忽略大小写、全半角、多余空格和标点；只有标点的标题不参与比较', () => {
  const key = dedupeTitleKey('Hello,  World!');
  for (const same of ['hello world', 'HELLO WORLD', ' Ｈｅｌｌｏ，Ｗｏｒｌｄ！ ', 'Hello — World…', '“Hello” “World”', 'hello\tworld\n']) assert.equal(dedupeTitleKey(same), key, same);
  assert.equal(dedupeTitleKey('今天发布：新版本！'), dedupeTitleKey('今天发布: 新版本'));
  assert.notEqual(dedupeTitleKey('Hello World 2'), key);
  assert.equal(dedupeTitleKey('!!! … ???'), null);
  assert.equal(dedupeTitleKey('   '), null);
});

const channels = (): BundleMember[] => [
  { feed: feed('feed_a', 'Alpha'), items: [item('a1', 'https://x.test/1?utm_source=alpha', day(3)), item('a2', 'https://x.test/2', day(5)), item('a3', 'https://x.test/3', day(7), { title: 'Same Story' })] },
  { feed: feed('feed_b', 'Beta'), items: [item('b1', 'http://www.x.test/1/', day(1)), item('b2', 'https://x.test/2', day(4)), item('b3', 'https://y.test/other', day(8), { title: 'same story!' })] },
];

test('各档去重：关闭、相同链接、忽略追踪参数、链接或标题', () => {
  const run = (mode: BundleDedupe['mode']) => ids(mergeBundleItems(channels(), { itemLimit: 100, dedupe: dedupe(mode) }));
  assert.deepEqual(run('off'), ['b3', 'a3', 'a2', 'b2', 'a1', 'b1']);
  assert.deepEqual(run('link'), ['b3', 'a3', 'b2', 'a1', 'b1'], 'only the identical link a2/b2 is merged, b2 was collected first; a1/b1 are different links');
  assert.deepEqual(run('url'), ['b3', 'a3', 'b2', 'b1'], 'a1 and b1 differ only by tracking, scheme, www and slash');
  assert.deepEqual(run('title'), ['a3', 'b2', 'b1'], 'b3 has the same title as a3');
  assert.deepEqual(ids(mergeBundleItems(channels(), 100)), run('link'), 'a plain number is the original behaviour');
});

test('保留哪一份：默认最早收集，也可以按成员顺序；同成员内最早收集', () => {
  const members = channels();
  const earliest = mergeBundleItems(members, { itemLimit: 100, dedupe: dedupe('url') });
  assert.equal(earliest.find(entry => entry.item.id === 'b1')?.feed.name, 'Beta', 'b1 was collected before a1');
  assert.ok(!ids(earliest).includes('a1'));
  const ordered = mergeBundleItems(members, { itemLimit: 100, dedupe: dedupe('url', { prefer: 'order' }) });
  assert.ok(ids(ordered).includes('a1') && !ids(ordered).includes('b1'), 'Alpha is listed first');
  assert.ok(ids(ordered).includes('a2') && !ids(ordered).includes('b2'));
  assert.ok(ids(earliest).includes('b2') && !ids(earliest).includes('a2'), 'b2 was collected before a2');
  const reversed = mergeBundleItems([members[1], members[0]], { itemLimit: 100, dedupe: dedupe('url', { prefer: 'order' }) });
  assert.ok(ids(reversed).includes('b1') && ids(reversed).includes('b2') && !ids(reversed).includes('a1'), 'reordering the members changes the winner');
  const sameMember = mergeBundleItems([{ feed: feed('feed_a'), items: [item('late', 'https://x.test/p', day(9)), item('early', 'https://x.test/p?utm_source=a', day(2))] }], { itemLimit: 100, dedupe: dedupe('url', { prefer: 'order' }) });
  assert.deepEqual(ids(sameMember), ['early']);
});

test('标题时间窗口：只有相隔不超过 N 天的同标题条目才合并，周期性标题不被误合并', () => {
  const weekly = (n: number, week: number) => item(`w${n}`, `https://x.test/picture/${n}`, day(week * 7 - 6), { title: '每周一图' });
  const members = [{ feed: feed('feed_a'), items: [weekly(1, 1), weekly(2, 2), weekly(3, 3)] }, { feed: feed('feed_b'), items: [item('mirror', 'https://mirror.test/2', day(8), { title: '每周一图！' })] }];
  const run = (windowDays: number | null) => ids(mergeBundleItems(members, { itemLimit: 100, dedupe: dedupe('title', { windowDays }) })).sort();
  assert.deepEqual(run(null), ['w1'], 'without a window the recurring title collapses');
  assert.deepEqual(run(3), ['mirror', 'w1', 'w2', 'w3'].filter(id => id !== 'mirror'), 'weekly pictures are 7 days apart; day 8 vs day 8 (w2) are the same moment');
  assert.deepEqual(run(7), ['w1'], 'a chain of weekly posts is related through the neighbours');
  const apart = [{ feed: feed('feed_a'), items: [item('x1', 'https://x.test/1', day(1), { title: 'Launch' })] }, { feed: feed('feed_b'), items: [item('x2', 'https://y.test/2', day(20), { title: 'launch' })] }];
  assert.equal(mergeBundleItems(apart, { itemLimit: 100, dedupe: dedupe('title', { windowDays: 5 }) }).length, 2);
  assert.equal(mergeBundleItems(apart, { itemLimit: 100, dedupe: dedupe('title', { windowDays: 30 }) }).length, 1);
});

test('链接与标题连起来的重复条目归为同一组，保留的一份可以是任意成员的', () => {
  const members = [
    { feed: feed('feed_a'), items: [item('a', 'https://x.test/a', day(3), { title: 'Story' })] },
    { feed: feed('feed_b'), items: [item('b', 'https://x.test/b?utm_source=z', day(2), { title: 'Story' })] },
    { feed: feed('feed_c'), items: [item('c', 'https://x.test/b', day(1), { title: 'Unrelated title' })] },
  ];
  const result = previewBundle(members, { itemLimit: 100, dedupe: dedupe('title') });
  assert.equal(result.output, 1);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].kept.id, 'c');
  assert.deepEqual(result.groups[0].merged.map(entry => [entry.id, entry.reason]).sort(), [['a', 'indirect'], ['b', 'url']]);
});

test('去重报告：数量、被保留的和被合并的条目、判定原因', () => {
  const report = previewBundle(channels(), { itemLimit: 100, dedupe: dedupe('title') });
  assert.deepEqual([report.members, report.candidates, report.filtered, report.merged, report.overLimit, report.output], [2, 6, 0, 3, 0, 3]);
  const byKept = Object.fromEntries(report.groups.map(group => [group.kept.id, group.merged.map(entry => `${entry.id}:${entry.reason}`)]));
  assert.deepEqual(byKept, { b1: ['a1:url'], b2: ['a2:link'], a3: ['b3:title'] });
  assert.equal(report.groups.find(group => group.kept.id === 'b1')?.kept.feedName, 'Beta');
  assert.equal(report.items.length, 3);
  assert.deepEqual(previewBundle(channels(), { itemLimit: 100, dedupe: dedupe('off') }).groups, []);
});

test('顺序：成员过滤 → 聚合过滤 → 去重 → 条数上限；上限按去重后的结果计', () => {
  const members: BundleMember[] = [
    { feed: { ...feed('feed_a', 'Alpha'), itemFilter: { include: [], exclude: ['member-skip'], regex: false } }, items: [item('a1', 'https://x.test/1', day(1), { title: 'One' }), item('a2', 'https://x.test/2', day(2), { title: 'member-skip' })] },
    { feed: feed('feed_b', 'Beta'), items: [item('b1', 'https://x.test/1?utm_source=b', day(3), { title: 'One' }), item('b2', 'https://x.test/b2', day(4), { title: 'Beta only' }), item('b3', 'https://x.test/b3', day(5), { title: 'Third' })] },
  ];
  const settings = { itemLimit: 10, dedupe: dedupe('url') };
  assert.deepEqual(ids(mergeBundleItems(members, settings)), ['b3', 'b2', 'a1'], 'a2 is gone because of its member’s filter, b1 is merged into the earlier a1');
  // The bundle filter runs before duplicates are merged: when it drops the kept copy, the other copy survives.
  const dropsEarlier = previewBundle(members, { ...settings, itemFilter: filter({ exclude: ['alpha'], matchSource: true }) });
  assert.deepEqual(dropsEarlier.filteredItems.map(entry => [entry.id, entry.status, entry.pattern]), [['a1', 'excluded', 'alpha']]);
  assert.deepEqual([dropsEarlier.candidates, dropsEarlier.filtered, dropsEarlier.merged, dropsEarlier.output], [4, 1, 0, 4 - 1]);
  assert.deepEqual(dropsEarlier.items.map(entry => entry.id), ['b3', 'b2', 'b1']);
  // The limit is applied last: duplicates do not use up places.
  const limited = previewBundle(members, { ...settings, itemLimit: 2 });
  assert.deepEqual([limited.merged, limited.overLimit, limited.output], [1, 1, 2]);
  const many = (n: number) => Array.from({ length: n }, (_, k) => item(`m${k}`, `https://x.test/m${k}`, day(1 + k % 20)));
  const twins = [{ feed: feed('feed_a'), items: many(30) }, { feed: feed('feed_b'), items: many(30).map(entry => ({ ...entry, id: `t${entry.id}`, link: `${entry.link}?utm_source=b` })) }];
  assert.equal(mergeBundleItems(twins, { itemLimit: 30, dedupe: dedupe('url') }).length, 30, '30 distinct items fit a limit of 30 once the twins are merged');
  assert.equal(mergeBundleItems(twins, { itemLimit: 30, dedupe: dedupe('off') }).length, 30);
  assert.equal(new Set(ids(mergeBundleItems(twins, { itemLimit: 30, dedupe: dedupe('url') }))).size, 30);
});

test('聚合过滤复用订阅过滤：关键词、排除优先、正则、来源名称；过滤不删除成员条目', () => {
  const members: BundleMember[] = [
    { feed: feed('feed_a', 'Tech Daily'), items: [item('t1', 'https://x.test/t1', day(1), { title: 'Rust release' }), item('t2', 'https://x.test/t2', day(2), { title: 'Sponsored: VPN' })] },
    { feed: feed('feed_b', 'Gossip'), items: [item('g1', 'https://x.test/g1', day(3), { title: 'Rust celebrity' })] },
  ];
  const run = (itemFilter: BundleFilter | null) => ids(mergeBundleItems(members, { itemLimit: 100, itemFilter }));
  assert.deepEqual(run(filter({ include: ['rust'] })), ['g1', 't1']);
  assert.deepEqual(run(filter({ include: ['rust'], exclude: ['celebrity'] })), ['t1']);
  assert.deepEqual(run(filter({ exclude: ['^sponsored'], regex: true })), ['g1', 't1']);
  assert.deepEqual(run(filter({ include: ['gossip'] })), [], 'the member’s name is not matched by default');
  assert.deepEqual(run(filter({ include: ['gossip'], matchSource: true })), ['g1']);
  assert.deepEqual(run(filter({ exclude: ['gossip'], matchSource: true })), ['t2', 't1']);
  assert.deepEqual(run(null), ['g1', 't2', 't1']);
  assert.equal(members[0].items.length, 2, 'stored items are untouched');
  const report = previewBundle(members, { itemLimit: 100, itemFilter: filter({ include: ['rust'], exclude: ['celebrity'] }) });
  assert.deepEqual(report.filteredItems.map(entry => [entry.id, entry.status, entry.pattern]), [['t2', 'not-included', undefined], ['g1', 'excluded', 'celebrity']], 'in collection order');
  assert.equal(report.filtered, 2);
  // A pattern the safety check would refuse never reaches here through the API; if one ever ran out of time, the filter is left out and the preview says so.
  const hostile: BundleMember[] = [{ feed: feed('feed_a'), items: [item('h1', 'https://x.test/h1', day(1), { title: `${'a'.repeat(34)}!` })] }];
  const timedOut = previewBundle(hostile, { itemLimit: 100, itemFilter: filter({ exclude: ['^(a+)+$'], regex: true }) });
  assert.deepEqual([timedOut.filterTimedOut, timedOut.filtered, timedOut.output], [true, 0, 1]);
});

test('规模：200 个成员、每个 300 条，去重是近线性的且结果正确', () => {
  const build = (membersCount: number, per: number): BundleMember[] => Array.from({ length: membersCount }, (_, m) => ({
    feed: { ...feed(`feed_${m}`, `Feed ${m}`), outputLimit: 500 },
    // Half of every member's items are shared with the others (same link with a tracking parameter, same title).
    items: Array.from({ length: per }, (_, k) => k % 2 === 0
      ? item(`s${m}-${k}`, `https://shared.test/${k}?utm_source=m${m}`, day(1 + (m + k) % 25), { title: `Shared story ${k}` })
      : item(`u${m}-${k}`, `https://own${m}.test/${k}`, day(1 + (m + k) % 25), { title: `Own story ${m}-${k}` })),
  }));
  const time = (members: BundleMember[], settings: Parameters<typeof mergeBundleItems>[1]) => { const start = performance.now(); const out = mergeBundleItems(members, settings); return { out, ms: performance.now() - start }; };
  const big = build(200, 300);
  const heavy = time(big, { itemLimit: 500, dedupe: dedupe('title', { windowDays: 30 }), itemFilter: filter({ exclude: ['nothing-matches'] }) });
  assert.equal(heavy.out.length, 500);
  const all = mergeBundleItems(big, { itemLimit: 500, dedupe: dedupe('title') });
  assert.equal(all.length, 500);
  const distinct = previewBundle(big, { itemLimit: 500, dedupe: dedupe('url') });
  assert.equal(distinct.candidates, 200 * 300);
  assert.equal(distinct.merged, 200 * 300 - (150 + 200 * 150), 'one copy of each of the 150 shared stories, all own stories');
  const small = time(build(50, 300), { itemLimit: 500, dedupe: dedupe('url') }).ms, large = time(big, { itemLimit: 500, dedupe: dedupe('url') }).ms;
  assert.ok(large < 5_000, `60000 items took ${Math.round(large)} ms`);
  assert.ok(large < small * 12 + 300, `4x the items took ${Math.round(large)} ms against ${Math.round(small)} ms`);
});

/** The merge as it was before deduplication and filters were configurable. */
function legacyMerge(members: BundleMember[], limit: number): Array<{ feed: Feed; item: FeedItem }> {
  const time = (value: FeedItem) => { for (const v of [value.publishedAt, value.firstSeenAt]) { const t = v ? Date.parse(v) : Number.NaN; if (!Number.isNaN(t)) return t; } return 0; };
  const winners = new Map<string, { feed: Feed; item: FeedItem; order: number }>();
  let order = 0;
  for (const { feed: member, items } of members) {
    for (const entry of publishedItems(member, items)) {
      const key = normalizeLink(entry.link), current = winners.get(key), candidate = { feed: member, item: entry, order: order++ };
      if (!current || entry.firstSeenAt < current.item.firstSeenAt) winners.set(key, candidate);
    }
  }
  return [...winners.values()].sort((a, b) => time(b.item) - time(a.item) || a.order - b.order).slice(0, limit).map(({ feed: member, item: entry }) => ({ feed: member, item: entry }));
}

test('前后对比：默认设置下，同一份数据的聚合输出与升级前逐条一致', () => {
  let seed = 7;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const links = ['https://x.test/a', 'https://X.test/a#frag', 'http://x.test/a', 'https://x.test/a/', 'https://x.test/a?utm_source=1', 'https://x.test/b', 'https://www.x.test/b', 'https://y.test:443/c', 'https://y.test/c'];
  for (let round = 0; round < 25; round++) {
    const members: BundleMember[] = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, m) => ({
      feed: { ...feed(`feed_${m}`, `Feed ${m}`), ...(random() < 0.3 ? { itemFilter: { include: [], exclude: ['skip'], regex: false } } : {}) },
      items: Array.from({ length: Math.floor(random() * 25) }, (_, k) => {
        const seen = day(1 + Math.floor(random() * 27));
        return item(`i${m}-${k}`, random() < 0.4 ? links[Math.floor(random() * links.length)] : `https://own.test/${m}/${k}`, seen, {
          title: random() < 0.15 ? 'skip this' : random() < 0.5 ? 'Same title' : `Title ${m}-${k}`, ...(random() < 0.4 ? { publishedAt: undefined } : { publishedAt: day(1 + Math.floor(random() * 27)) }),
        });
      }),
    }));
    const limit = 10 + Math.floor(random() * 40);
    const expected = legacyMerge(members, limit);
    for (const settings of [limit, { itemLimit: limit }, { itemLimit: limit, dedupe: BUNDLE_DEDUPE_DEFAULT, itemFilter: null }] as const) {
      assert.deepEqual(mergeBundleItems(members, settings).map(entry => [entry.feed.id, entry.item.id]), expected.map(entry => [entry.feed.id, entry.item.id]), `round ${round}`);
    }
  }
});

test('聚合 API：创建与合并更新、预览接口、输出使用去重和过滤、非法设置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-bundle-dedupe-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const user = store.createUser('reader', 'reader-password'), other = store.createUser('other', 'other-password');
  const one = store.createFeed(input('One', 'https://a.test/list'), user.id), two = store.createFeed(input('Two', 'https://b.test/list'), user.id), foreign = store.createFeed(input('Foreign', 'https://c.test/list'), other.id);
  store.upsertItems(one.feed, [{ title: 'Story', link: 'https://s.test/story?utm_source=one', publishedAt: day(1) }, { title: 'Only one', link: 'https://s.test/one', publishedAt: day(2) }, { title: 'Ad: sale', link: 'https://s.test/ad', publishedAt: day(3) }]);
  store.upsertItems(two.feed, [{ title: 'Story', link: 'https://www.s.test/story/', publishedAt: day(4) }, { title: 'Only two', link: 'https://s.test/two', publishedAt: day(5) }]);
  const app = await createApp({ store, dataDir: dir, startScheduler: false, browserService });
  const session = store.createSession('reader', 60_000);
  const headers = { host: '127.0.0.1:4321', cookie: `feedlantern_session=${session.id}`, 'x-feedlantern': '1', 'x-csrf-token': session.csrfToken };
  try {
    const created = (await app.inject({ method: 'POST', url: '/api/bundles', headers, payload: { name: '默认', feedIds: [one.feed.id, two.feed.id] } })).json();
    assert.deepEqual(created.bundle.dedupe, BUNDLE_DEDUPE_DEFAULT);
    assert.equal(created.bundle.itemFilter, null);
    const titles = async (path: string) => (new XMLParser().parse((await app.inject({ url: path })).body).rss.channel.item as Array<{ title: string }>).map(entry => entry.title);
    const path = new URL(created.bundleUrl).pathname;
    assert.deepEqual(await titles(path), ['Only two', 'Story', 'Ad: sale', 'Only one', 'Story'], 'the default only merges the identical link');
    const etag = (await app.inject({ url: path })).headers.etag;

    const updated = await app.inject({ method: 'PUT', url: `/api/bundles/${created.bundle.id}`, headers, payload: { dedupe: { mode: 'url', prefer: 'order' }, itemFilter: { exclude: ['ad:'], matchSource: false } } });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json().bundle.dedupe, { mode: 'url', windowDays: null, prefer: 'order' });
    assert.deepEqual(updated.json().bundle.itemFilter, { include: [], exclude: ['ad:'], regex: false, matchSource: false });
    assert.deepEqual(await titles(path), ['Only two', 'Only one', 'Story'], 'RSS output uses the merge and the filter');
    assert.notEqual((await app.inject({ url: path })).headers.etag, etag);
    for (const extension of ['.atom', '.json']) assert.equal((await app.inject({ url: path.replace(/\.xml$/, extension) })).statusCode, 200);
    const page = await app.inject({ url: path, headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: 'text/html' } });
    assert.ok(!page.body.includes('Ad: sale') && page.body.includes('Only two'), 'the browser page agrees');

    const merged = await app.inject({ method: 'PUT', url: `/api/bundles/${created.bundle.id}`, headers, payload: { dedupe: { mode: 'title', windowDays: 7 } } });
    assert.deepEqual(merged.json().bundle.dedupe, { mode: 'title', windowDays: 7, prefer: 'order' }, 'only the given fields change');
    assert.deepEqual((await app.inject({ method: 'PUT', url: `/api/bundles/${created.bundle.id}`, headers, payload: { dedupe: { mode: 'link' } } })).json().bundle.dedupe, { mode: 'link', windowDays: null, prefer: 'order' }, 'the window belongs to title mode only');
    assert.equal((await app.inject({ method: 'PUT', url: `/api/bundles/${created.bundle.id}`, headers, payload: { itemFilter: null } })).json().bundle.itemFilter, null);

    const saved = (await app.inject({ url: `/api/bundles/${created.bundle.id}/preview`, headers })).json();
    assert.deepEqual([saved.candidates, saved.filtered, saved.merged, saved.output], [5, 0, 0, 5], 'the saved bundle is in link mode now: the two Story links differ');
    const draft = (await app.inject({ method: 'POST', url: '/api/bundles/preview', headers, payload: { feedIds: [two.feed.id, one.feed.id], dedupe: { mode: 'url' }, itemFilter: { include: ['only'] } } })).json();
    assert.deepEqual([draft.candidates, draft.filtered, draft.merged, draft.output], [5, 3, 0, 2]);
    assert.deepEqual(draft.filteredItems.map((entry: { status: string }) => entry.status), ['not-included', 'not-included', 'not-included']);
    assert.equal(draft.listLimit, 50);
    const grouped = (await app.inject({ method: 'POST', url: '/api/bundles/preview', headers, payload: { feedIds: [one.feed.id, two.feed.id], dedupe: { mode: 'url' } } })).json();
    assert.deepEqual(grouped.groups.map((group: { kept: { feedName: string }; merged: Array<{ feedName: string; reason: string }> }) => [group.kept.feedName, group.merged.map(entry => `${entry.feedName}:${entry.reason}`)]), [['One', ['Two:url']]]);

    const bad = async (payload: unknown, url = '/api/bundles', method: 'POST' | 'PUT' = 'POST') => app.inject({ method, url, headers, payload: payload as never });
    for (const dedupe of [{ mode: 'fuzzy' }, { prefer: 'newest' }, { mode: 'title', windowDays: 0 }, { mode: 'title', windowDays: 366 }, { windowDays: 1.5 }, 'url', []]) {
      const response = await bad({ name: 'x', feedIds: [], dedupe });
      assert.equal(response.statusCode, 400, JSON.stringify(dedupe));
      const body = response.json();
      assert.equal(body.code, 'validation'); assert.match(body.messageKey, /^error\.bundleDedupe/);
    }
    for (const itemFilter of [{ include: ['('], regex: true }, { exclude: ['(a+)+$'], regex: true }, { include: 'x' }, { include: Array.from({ length: 31 }, (_, n) => `k${n}`) }, { matchSource: 'yes', include: ['a'] }, []]) {
      assert.equal((await bad({ name: 'x', feedIds: [], itemFilter })).statusCode, 400, JSON.stringify(itemFilter));
    }
    assert.equal((await bad({ feedIds: [foreign.feed.id] }, '/api/bundles/preview')).statusCode, 400, 'only the account’s own feeds');
    assert.equal((await bad({ feedIds: [one.feed.id], itemLimit: 3 }, '/api/bundles/preview')).statusCode, 400);
    const otherSession = store.createSession('other', 60_000);
    assert.equal((await app.inject({ url: `/api/bundles/${created.bundle.id}/preview`, headers: { ...headers, cookie: `feedlantern_session=${otherSession.id}`, 'x-csrf-token': otherSession.csrfToken } })).statusCode, 404);
    assert.equal((await app.inject({ url: `/api/bundles/${created.bundle.id}/preview`, headers: { host: headers.host } })).statusCode, 401);

    const added = (await app.inject({ method: 'POST', url: `/api/bundles/${created.bundle.id}/feeds`, headers, payload: { feedIds: [one.feed.id] } })).json();
    assert.deepEqual(added.bundle.feedIds, [one.feed.id, two.feed.id], 'adding keeps the priority; existing members stay in place');
    assert.deepEqual(added.bundle.dedupe, { mode: 'link', windowDays: null, prefer: 'order' }, 'adding members leaves the settings alone');
    const extra = store.createFeed(input('Extra', 'https://d.test/list'), user.id);
    assert.deepEqual((await app.inject({ method: 'POST', url: `/api/bundles/${created.bundle.id}/feeds`, headers, payload: { feedIds: [extra.feed.id] } })).json().bundle.feedIds, [one.feed.id, two.feed.id, extra.feed.id], 'new members are appended last');
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('聚合可以保存安全的正则过滤', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-bundle-regex-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const user = store.createUser('reader', 'reader-password');
  const one = store.createFeed(input('One', 'https://a.test/list'), user.id);
  store.upsertItems(one.feed, [{ title: `${'a'.repeat(450)}!`, link: 'https://s.test/1', publishedAt: day(1) }]);
  const app = await createApp({ store, dataDir: dir, startScheduler: false, browserService });
  const session = store.createSession('reader', 60_000);
  const headers = { host: '127.0.0.1:4321', cookie: `feedlantern_session=${session.id}`, 'x-feedlantern': '1', 'x-csrf-token': session.csrfToken };
  try {
    const ok = await app.inject({ method: 'POST', url: '/api/bundles', headers, payload: { name: 'x', feedIds: [one.feed.id], itemFilter: { exclude: ['^a{1,5}b'], regex: true } } });
    assert.equal(ok.statusCode, 200);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('完整备份与轻量配置带上去重和过滤；旧备份与旧配置按默认处理；默认设置的备份保持旧格式', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-bundle-settings-backup-'));
  const a = new Store(join(dir, 'a')), b = new Store(join(dir, 'b'));
  try {
    a.createAdmin('admin', 'source-password'); b.createAdmin('target', 'target-password');
    const user = a.createUser('reader', 'reader-password');
    const one = a.createFeed(input('One', 'https://a.test/list'), user.id), two = a.createFeed(input('Two', 'https://b.test/list'), user.id);
    const custom = a.bundles.create({ name: '自定义', feedIds: [two.feed.id, one.feed.id], dedupe: dedupe('title', { windowDays: 14, prefer: 'order' }), itemFilter: filter({ include: ['rust'], regex: false, matchSource: true }) }, user.id);
    const plain = a.bundles.create({ name: '默认', feedIds: [one.feed.id] }, user.id);
    const tables = a.exportTables();
    const rows = Object.fromEntries(tables.bundles.map(row => [row.name, row]));
    assert.ok(!('dedupe_json' in rows['默认']) && !('item_filter_json' in rows['默认']), 'a bundle with the original behaviour is written exactly as before');
    assert.deepEqual(JSON.parse(String(rows['自定义'].dedupe_json)), { mode: 'title', windowDays: 14, prefer: 'order' });
    const snapshot = snapshotSchema.parse({ format: 'feedlantern-backup', version: 3, appVersion: '0.12.0', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables });
    b.restoreTables(openBackup(sealBackup(snapshot, 'long-backup-password'), 'long-backup-password').tables);
    assert.deepEqual(b.bundles.get(custom.bundle.id), custom.bundle);
    assert.deepEqual(b.bundles.get(plain.bundle.id)?.dedupe, BUNDLE_DEDUPE_DEFAULT);
    assert.equal(b.bundles.get(plain.bundle.id)?.itemFilter, null);
    const damaged = structuredClone(snapshot); damaged.tables.bundles[0].dedupe_json = '{"mode":1}';
    assert.equal(snapshotSchema.safeParse(damaged).success, true, 'the shape is checked by the restore preview, like a feed’s filter');
    const oldFormat = structuredClone(snapshot) as unknown as { tables: { bundles: Array<Record<string, unknown>> } };
    for (const row of oldFormat.tables.bundles) { delete row.dedupe_json; delete row.item_filter_json; }
    b.restoreTables(snapshotSchema.parse(oldFormat).tables);
    assert.deepEqual(b.bundles.get(custom.bundle.id)?.dedupe, BUNDLE_DEDUPE_DEFAULT, 'a backup from before the settings restores the default');
    assert.equal(b.bundles.get(custom.bundle.id)?.itemFilter, null);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }

  const configDir = mkdtempSync(join(tmpdir(), 'fl-bundle-settings-config-')), store = new Store(configDir);
  store.createAdmin('admin', 'admin-password');
  const app = await createApp({ store, dataDir: configDir, startScheduler: false, browserService });
  const session = store.createSession('admin', 60_000);
  const headers = { host: '127.0.0.1:4321', cookie: `feedlantern_session=${session.id}`, 'x-feedlantern': '1', 'x-csrf-token': session.csrfToken };
  try {
    const one = store.createFeed(input('One', 'https://a.test/list'), 'admin'), two = store.createFeed(input('Two', 'https://b.test/list'), 'admin');
    store.bundles.create({ name: '自定义', feedIds: [two.feed.id, one.feed.id], dedupe: dedupe('url', { prefer: 'order' }), itemFilter: filter({ exclude: ['ad'] }) }, 'admin');
    const config = (await app.inject({ url: '/api/backups/config', headers })).json();
    assert.deepEqual(config.bundles[0].dedupe, { mode: 'url', windowDays: null, prefer: 'order' });
    assert.deepEqual(config.bundles[0].itemFilter, { include: [], exclude: ['ad'], regex: false, matchSource: false });
    store.bundles.delete(store.bundles.list()[0].id);
    assert.equal((await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: config, confirm: true } })).statusCode, 200);
    const [restored] = store.bundles.list('admin');
    assert.deepEqual([restored.dedupe, restored.itemFilter, restored.feedIds], [{ mode: 'url', windowDays: null, prefer: 'order' }, filter({ exclude: ['ad'] }), [two.feed.id, one.feed.id]]);
    store.bundles.delete(restored.id);
    const legacy = structuredClone(config); delete legacy.bundles[0].dedupe; delete legacy.bundles[0].itemFilter;
    assert.equal((await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: legacy, confirm: true } })).statusCode, 200);
    const [fromLegacy] = store.bundles.list('admin');
    assert.deepEqual([fromLegacy.dedupe, fromLegacy.itemFilter], [BUNDLE_DEDUPE_DEFAULT, null], 'an older configuration file means the default');
    store.bundles.delete(fromLegacy.id);
    const invalid = structuredClone(config); invalid.bundles[0].dedupe = { mode: 'fuzzy' };
    assert.equal((await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: invalid } })).statusCode, 400);
  } finally { await app.close(); store.close(); rmSync(configDir, { recursive: true, force: true }); }
});

test('从 v23 数据库升级：已有聚合保持原有行为，之后可以保存去重与过滤', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-bundle-v24-'));
  try {
    const first = new Store(dir);
    first.createAdmin('admin', 'admin-password');
    const one = first.createFeed(input('One', 'https://a.test/list'), 'admin');
    const before = first.bundles.create({ name: '旧聚合', feedIds: [one.feed.id], itemLimit: 40 }, 'admin').bundle;
    first.close();
    const db = new DatabaseSync(join(dir, 'app.db'));
    db.exec('ALTER TABLE bundles DROP COLUMN dedupe_json; ALTER TABLE bundles DROP COLUMN item_filter_json; PRAGMA user_version=23;'); db.close();
    const store = new Store(dir);
    try {
      const raw = new DatabaseSync(join(dir, 'app.db'));
      assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 24); raw.close();
      assert.deepEqual(store.bundles.get(before.id), before, 'the same bundle, with the original behaviour');
      assert.deepEqual(store.bundles.update(before.id, { dedupe: dedupe('url'), itemFilter: filter({ exclude: ['x'] }) })?.dedupe, dedupe('url'));
      assert.deepEqual(store.bundles.update(before.id, { itemFilter: null })?.itemFilter, null);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
