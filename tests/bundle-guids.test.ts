import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { openBackup, sealBackup, snapshotSchema } from '../src/server/backups.js';
import { BUNDLE_SEEN_DAYS, BUNDLE_SEEN_ROWS } from '../src/server/bundle-guids.js';
import { dedupeUrlKey } from '../src/server/bundle-dedupe.js';
import { mergeBundleItems, type BundleEntry, type BundleMember } from '../src/server/bundles.js';
import { BUNDLE_DEDUPE_DEFAULT, type BundleDedupe, type Feed, type FeedInput, type FeedItem } from '../src/shared/types.js';

const input = (name: string, url: string): FeedInput => ({ name, url, rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 });
const browserService = { close: async () => {}, dispose: async () => {} } as unknown as BrowserServiceLike;
const dedupe = (mode: BundleDedupe['mode'], extra: Partial<BundleDedupe> = {}): BundleDedupe => ({ ...BUNDLE_DEDUPE_DEFAULT, mode, ...extra });
const hours = (n: number) => new Date(Date.UTC(2026, 1, 1) + n * 3_600_000);
const day = (n: number) => new Date(Date.UTC(2026, 1, 1) + n * 86_400_000);
const feed = (id: string): Feed => ({ id, name: id, url: `https://${id}.test/`, rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 30, waitMs: 0, enabled: true, createdAt: day(0).toISOString(), lastFetchedAt: null, lastSuccessAt: null, nextFetchAt: day(0).toISOString(), lastError: null, itemCount: 0 } as Feed);
const entry = (feedId: string, id: string, link: string, at = day(0), extra: Partial<FeedItem> = {}): BundleEntry => ({ feed: feed(feedId), item: { id, title: id, link, firstSeenAt: at.toISOString(), publishedAt: at.toISOString(), ...extra } });
const guids = (entries: BundleEntry[]) => entries.map(item => item.item.id);

function withStore(run: (store: Store, bundleId: string, dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'fl-bundle-guids-')), store = new Store(dir);
  return (async () => {
    try {
      store.createAdmin('admin', 'admin-password');
      const one = store.createFeed(input('One', 'https://a.test/list'), 'admin');
      const bundle = store.bundles.create({ name: '聚合', feedIds: [one.feed.id] }, 'admin').bundle;
      await run(store, bundle.id, dir);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  })();
}
const rows = (store: Store, bundleId: string) => (store as unknown as { db: DatabaseSync }).db.prepare('SELECT * FROM bundle_seen WHERE bundle_id=? ORDER BY kind,key_hash').all(bundleId) as Array<Record<string, unknown>>;
const bundleOf = (id: string, mode: BundleDedupe = BUNDLE_DEDUPE_DEFAULT) => ({ id, dedupe: mode });

test('保留的副本换成另一个成员的以后，条目仍使用最初发布的 ID', () => withStore((store, id) => {
  const seen = store.bundles.seen;
  // 第一次：“最新发表”里的副本先收集到，“最新热门”里还没有。
  const first = seen.stabilize(bundleOf(id), [entry('latest', 'item_latest', 'https://s.test/t/1', hours(1))], hours(2));
  assert.deepEqual(guids(first), ['item_latest'], '没见过的条目保持自己的 ID，升级后的第一次输出不变');
  // 第二次：“最新发表”已经把它挤出去，只剩“最新热门”里的副本。
  const second = seen.stabilize(bundleOf(id), [entry('hot', 'item_hot', 'https://s.test/t/1', hours(1))], hours(30));
  assert.deepEqual(guids(second), ['item_latest'], '换了成员的副本也沿用原来的 ID');
  assert.equal(second[0].feed.id, 'hot', '内容和来源是当前保留的那份');
  // 所有成员都清掉之后又出现。
  const later = seen.stabilize(bundleOf(id), [entry('other', 'item_other', 'https://s.test/t/1', hours(1))], day(20));
  assert.deepEqual(guids(later), ['item_latest']);
}));

test('两份副本同时输出时按去重规则合并，ID 取先发布的那个；不同链接互不影响', () => withStore((store, id) => {
  const seen = store.bundles.seen;
  const a = entry('latest', 'item_a', 'https://s.test/t/1', hours(1)), b = entry('hot', 'item_b', 'https://s.test/t/2', hours(1));
  assert.deepEqual(guids(seen.stabilize(bundleOf(id), [a, b], hours(2))), ['item_a', 'item_b']);
  assert.deepEqual(guids(seen.stabilize(bundleOf(id), [entry('x', 'item_x', 'https://s.test/t/2', hours(1)), entry('y', 'item_y', 'https://s.test/t/3', hours(1))], hours(3))), ['item_b', 'item_y']);
}));

test('升级后的第一次输出与升级前完全一致；没有记过的内容不改动条目对象', () => withStore((store, id) => {
  const entries = [entry('a', 'item_1', 'https://s.test/1'), entry('b', 'item_2', 'https://s.test/2')];
  const out = store.bundles.seen.stabilize(bundleOf(id), entries, hours(1));
  assert.deepEqual(out, entries);
  assert.ok(out.every((value, index) => value === entries[index]), 'the same objects');
  assert.equal(rows(store, id).length, 2);
}));

test('关闭去重时不记也不改', () => withStore((store, id) => {
  const out = store.bundles.seen.stabilize(bundleOf(id, dedupe('off')), [entry('a', 'item_1', 'https://s.test/1')], hours(1));
  assert.deepEqual(guids(out), ['item_1']);
  assert.equal(rows(store, id).length, 0);
}));

test('切换去重方式后 ID 不变：链接 → 忽略追踪参数 → 标题', () => withStore((store, id) => {
  const seen = store.bundles.seen;
  seen.stabilize(bundleOf(id), [entry('a', 'item_a', 'https://s.test/story?utm_source=x', hours(1), { title: 'Same Story' })], hours(2));
  const asUrl = seen.stabilize(bundleOf(id, dedupe('url')), [entry('b', 'item_b', 'https://www.s.test/story', hours(1), { title: 'Same Story' })], hours(3));
  assert.deepEqual(guids(asUrl), ['item_b'], '忽略追踪参数的键是新记的，换了地址写法就不是同一条');
  const link = seen.stabilize(bundleOf(id), [entry('a', 'item_a2', 'https://s.test/story?utm_source=x', hours(1), { title: 'Same Story' })], hours(4));
  assert.deepEqual(guids(link), ['item_a'], '原来的链接键仍然认得它');
  const url = seen.stabilize(bundleOf(id, dedupe('url')), [entry('c', 'item_c', 'https://s.test/story', hours(1), { title: 'Same Story' })], hours(5));
  assert.deepEqual(guids(url), ['item_b'], '忽略追踪参数的键认得 item_b');
}));

test('论坛帖子的两种地址写法在“忽略追踪参数”下是同一条，ID 也跟着稳定', () => withStore((store, id) => {
  assert.equal(dedupeUrlKey('https://forum.example.test/forum.php?mod=viewthread&tid=123'), dedupeUrlKey('https://forum.example.test/thread-123-1-1.html'));
  assert.equal(dedupeUrlKey('https://forum.example.test/thread-123-2-1.html'), dedupeUrlKey('https://www.forum.example.test/forum.php?mod=viewthread&tid=123&extra=page%3D1&page=2'));
  assert.equal(dedupeUrlKey('https://forum.example.test/viewthread.php?tid=7'), dedupeUrlKey('https://forum.example.test/thread-7-1-1.html'));
  assert.notEqual(dedupeUrlKey('https://forum.example.test/thread-123-1-1.html'), dedupeUrlKey('https://forum.example.test/thread-124-1-1.html'));
  assert.notEqual(dedupeUrlKey('https://forum.example.test/thread-123-1-1.html'), dedupeUrlKey('https://other.test/thread-123-1-1.html'));
  assert.notEqual(dedupeUrlKey('https://forum.example.test/forum.php?mod=forumdisplay&tid=123'), dedupeUrlKey('https://forum.example.test/thread-123-1-1.html'), 'only a thread view counts');
  assert.notEqual(dedupeUrlKey('https://forum.example.test/forum.php?mod=viewthread&tid=abc'), dedupeUrlKey('https://forum.example.test/thread-1-1-1.html'));
  const merged = mergeBundleItems([
    { feed: feed('rss'), items: [{ id: 'item_rss', title: 'post', link: 'https://forum.example.test/forum.php?mod=viewthread&tid=123', firstSeenAt: day(1).toISOString(), publishedAt: day(1).toISOString() }] },
    { feed: feed('board'), items: [{ id: 'item_board', title: '[repost] post', link: 'https://forum.example.test/thread-123-1-1.html', firstSeenAt: day(2).toISOString(), publishedAt: day(1).toISOString() }] },
  ] as BundleMember[], { itemLimit: 100, dedupe: dedupe('url') });
  assert.deepEqual(guids(merged), ['item_rss']);
  assert.equal(mergeBundleItems([{ feed: feed('rss'), items: [merged[0].item] }, { feed: feed('board'), items: [{ ...merged[0].item, id: 'item_board', link: 'https://forum.example.test/thread-123-1-1.html' }] }] as BundleMember[], { itemLimit: 100 }).length, 2, '默认的“相同链接”不认这种写法，需要选忽略追踪参数');
}));

test('标题去重的时间窗口：窗口内沿用 ID，超出窗口是新的一条，周期性标题不被误合并', () => withStore((store, id) => {
  const seen = store.bundles.seen, mode = dedupe('title', { windowDays: 3 });
  const weekly = (n: number, link: string, extra = day(n)) => entry('w', `item_w${n}`, link, extra, { title: '每周一图' });
  assert.deepEqual(guids(seen.stabilize(bundleOf(id, mode), [weekly(1, 'https://s.test/w1')], day(1))), ['item_w1']);
  assert.deepEqual(guids(seen.stabilize(bundleOf(id, mode), [weekly(2, 'https://s.test/w1-copy')], day(2))), ['item_w1'], '相隔一天，同标题，是同一条');
  assert.deepEqual(guids(seen.stabilize(bundleOf(id, mode), [weekly(8, 'https://s.test/w8')], day(8))), ['item_w8'], '相隔一周，是新的一条');
  assert.deepEqual(guids(seen.stabilize(bundleOf(id, mode), [weekly(9, 'https://s.test/w8-copy')], day(9))), ['item_w8'], '标题键跟着最近的一条，窗口按它算');
}));

test('一次输出里不会有两条共用同一个 ID', () => withStore((store, id) => {
  const seen = store.bundles.seen, mode = dedupe('title');
  seen.stabilize(bundleOf(id, mode), [entry('a', 'item_a', 'https://s.test/a', hours(1), { title: 'Alpha' })], hours(2));
  // 现在 Alpha 的两个不同链接同时输出（比如被成员过滤分开了）：第二个不能再拿 item_a。
  const out = seen.stabilize(bundleOf(id, mode), [entry('b', 'item_b', 'https://s.test/a', hours(1), { title: 'Alpha' }), entry('c', 'item_c', 'https://s.test/c', hours(1), { title: 'Alpha' })], hours(3));
  assert.deepEqual(guids(out), ['item_a', 'item_c']);
  assert.equal(new Set(guids(out)).size, out.length);
}));

test('记录只在隔了一天以上才更新访问时间；半年没出现的和超出行数的会被忘掉', () => withStore((store, id) => {
  const db = (store as unknown as { db: DatabaseSync }).db, seen = store.bundles.seen;
  const e = entry('a', 'item_1', 'https://s.test/1', hours(1));
  seen.stabilize(bundleOf(id), [e], hours(2));
  const stamp = () => String(rows(store, id)[0].last_seen_at);
  const first = stamp();
  seen.stabilize(bundleOf(id), [e], hours(10));
  assert.equal(stamp(), first, 'no write within a day');
  seen.stabilize(bundleOf(id), [e], hours(30));
  assert.equal(stamp(), hours(30).toISOString());

  const old = day(0).toISOString();
  db.prepare("INSERT INTO bundle_seen VALUES (?,?,?,?,?,?,?)").run(id, 'link', 'a'.repeat(32), 'item_old', 0, old, old);
  seen.stabilize(bundleOf(id), [e], new Date(hours(30).getTime() + 2 * 3_600_000));
  assert.ok(rows(store, id).some(row => row.guid === 'item_old'), '清理每小时最多一次');
  seen.stabilize(bundleOf(id), [e], new Date(day(0).getTime() + (BUNDLE_SEEN_DAYS + 1) * 86_400_000));
  assert.ok(!rows(store, id).some(row => row.guid === 'item_old'), '半年没出现的被忘掉');

  const insert = db.prepare("INSERT INTO bundle_seen VALUES (?,?,?,?,?,?,?)");
  db.exec('BEGIN');
  for (let i = 0; i < BUNDLE_SEEN_ROWS + 50; i++) insert.run(id, 'link', i.toString(16).padStart(32, '0'), `item_${i}`, 0, hours(1).toISOString(), new Date(hours(1).getTime() + i * 1000).toISOString());
  db.exec('COMMIT');
  const now = new Date(day(0).getTime() + (BUNDLE_SEEN_DAYS + 3) * 86_400_000 + 3_600_000 * 5);
  db.prepare('UPDATE bundle_seen SET last_seen_at=? WHERE guid LIKE ?').run(now.toISOString(), 'item_1%');
  seen.stabilize(bundleOf(id), [entry('a', 'item_z', 'https://s.test/z', hours(1))], now);
  assert.ok((rows(store, id).length as number) <= BUNDLE_SEEN_ROWS, '最多保留 BUNDLE_SEEN_ROWS 行');
}));

test('其他聚合互不干扰，删除聚合时记录一并删除', () => withStore((store, id) => {
  const seen = store.bundles.seen;
  const other = store.bundles.create({ name: '另一个', feedIds: [] }, 'admin').bundle;
  seen.stabilize(bundleOf(id), [entry('a', 'item_a', 'https://s.test/1')], hours(1));
  assert.deepEqual(guids(seen.stabilize(bundleOf(other.id), [entry('b', 'item_b', 'https://s.test/1')], hours(2))), ['item_b'], '另一个聚合不认识它');
  store.bundles.delete(id);
  assert.equal(rows(store, id).length, 0);
  assert.equal(rows(store, other.id).length, 1);
}));

test('聚合地址：保留的副本换了成员，RSS、Atom、JSON 的 GUID 不变，304 与内容一致', async () => withStore(async (store, id, dir) => {
  const user = store.createUser('reader', 'reader-password');
  const latest = store.createFeed(input('Latest', 'https://a.test/latest'), user.id), hot = store.createFeed(input('Hot', 'https://b.test/hot'), user.id);
  const bundle = store.bundles.create({ name: '论坛', feedIds: [latest.feed.id, hot.feed.id], dedupe: dedupe('url') }, user.id);
  const url = `/bundles/${bundle.bundle.id}/${bundle.token}`;
  const app = await createApp({ store, dataDir: dir, startScheduler: false, browserService });
  const read = async (format: '.xml' | '.atom' | '.json') => {
    const response = await app.inject({ url: url + format });
    return { response, ids: format === '.xml' ? [new XMLParser().parse(response.body).rss.channel.item].flat().map((item: { guid: string }) => String(item.guid))
      : format === '.atom' ? [new XMLParser().parse(response.body).feed.entry].flat().map((entryValue: { id: string }) => entryValue.id.replace('urn:feedlantern:item:', ''))
        : (JSON.parse(response.body).items as Array<{ id: string }>).map(item => item.id) };
  };
  try {
    store.upsertItems(latest.feed, [{ title: '帖子', link: 'https://f.test/forum.php?mod=viewthread&tid=9', publishedAt: day(1).toISOString() }]);
    const before = await read('.xml'), original = before.ids[0];
    assert.ok(original);
    // “最新发表”把它挤出去，同一个帖子（另一种地址写法）出现在“最新热门”。
    (store as unknown as { db: DatabaseSync }).db.prepare('DELETE FROM feed_items WHERE feed_id=?').run(latest.feed.id);
    store.upsertItems(hot.feed, [{ title: '帖子', link: 'https://f.test/thread-9-1-1.html', publishedAt: day(1).toISOString() }]);
    const after = await read('.xml');
    assert.deepEqual(after.ids, [original], 'RSS keeps the first id');
    assert.deepEqual((await read('.atom')).ids, [original]);
    assert.deepEqual((await read('.json')).ids, [original]);
    const etag = after.response.headers.etag;
    assert.equal((await app.inject({ url: `${url}.xml`, headers: { 'if-none-match': String(etag) } })).statusCode, 304);
  } finally { await app.close(); }
}));

test('完整备份带上记住的内容；没有记过东西的备份保持旧格式；旧备份照常恢复；孤儿行被拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-bundle-guids-backup-')), a = new Store(join(dir, 'a')), b = new Store(join(dir, 'b'));
  try {
    a.createAdmin('admin', 'source-password'); b.createAdmin('target', 'target-password');
    const user = a.createUser('reader', 'reader-password');
    const one = a.createFeed(input('One', 'https://a.test/list'), user.id);
    const bundle = a.bundles.create({ name: '聚合', feedIds: [one.feed.id] }, user.id).bundle;
    assert.ok(!('bundle_seen' in a.exportTables()), 'nothing remembered: the backup is what older versions wrote');
    a.bundles.seen.stabilize(bundle, [entry('a', 'item_1', 'https://s.test/1', hours(1))], hours(2));
    const tables = a.exportTables();
    assert.equal(tables.bundle_seen.length, 1);
    const snapshot = snapshotSchema.parse({ format: 'feedlantern-backup', version: 3, appVersion: '0.12.1', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables });
    b.restoreTables(openBackup(sealBackup(snapshot, 'long-backup-password'), 'long-backup-password').tables);
    assert.deepEqual(rows(b, bundle.id).map(row => [row.kind, row.guid]), [['link', 'item_1']]);
    assert.deepEqual(guids(b.bundles.seen.stabilize(bundle, [entry('z', 'item_z', 'https://s.test/1', hours(1))], hours(40))), ['item_1'], 'the restored instance still knows it');

    const oldFormat = structuredClone(snapshot) as unknown as { tables: Record<string, unknown> };
    delete oldFormat.tables.bundle_seen;
    b.restoreTables(snapshotSchema.parse(oldFormat).tables);
    assert.equal(rows(b, bundle.id).length, 0);

    const orphan = structuredClone(snapshot); orphan.tables.bundle_seen[0].bundle_id = 'bundle_missing';
    assert.equal(snapshotSchema.safeParse(orphan).success, false);
    const twice = structuredClone(snapshot); twice.tables.bundle_seen.push({ ...twice.tables.bundle_seen[0] });
    assert.equal(snapshotSchema.safeParse(twice).success, false);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('从 v24 数据库升级：新表建好，已有聚合不变，重复启动安全', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-bundle-v25-'));
  try {
    const first = new Store(dir);
    first.createAdmin('admin', 'admin-password');
    const one = first.createFeed(input('One', 'https://a.test/list'), 'admin');
    const before = first.bundles.create({ name: '旧聚合', feedIds: [one.feed.id], dedupe: dedupe('url') }, 'admin').bundle;
    first.close();
    const db = new DatabaseSync(join(dir, 'app.db'));
    db.exec('DROP TABLE bundle_seen; PRAGMA user_version=24;'); db.close();
    for (let start = 0; start < 2; start++) {
      const store = new Store(dir);
      try {
        const raw = new DatabaseSync(join(dir, 'app.db'));
        assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 25); raw.close();
        assert.deepEqual(store.bundles.get(before.id), before);
        assert.deepEqual(guids(store.bundles.seen.stabilize(before, [entry('a', 'item_1', 'https://s.test/1')], hours(1))), ['item_1']);
      } finally { store.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
