import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../src/server/store.js';
import type { Feed, FeedInput } from '../src/shared/types.js';

const input: FeedInput = { name: 'Example', url: 'https://example.test/feed', sourceType: 'rss', translationMode: 'bilingual', rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 60, waitMs: 0 };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fl-list-stats-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const alice = store.createUser('alice', 'alice-password');
  const db = new DatabaseSync(store.dbPath);
  const seed = (feed: Feed, statuses: string[]) => {
    store.transaction(() => store.translations.upsert(feed, statuses.map((_, i) => ({ key: String(i), title: `Article ${i}`, link: `https://example.test/${feed.id}/${i}`, html: '<p>Example</p>' }))));
    for (let i = 0; i < statuses.length; i++) db.prepare('UPDATE translations SET status=? WHERE item_id=(SELECT id FROM feed_items WHERE feed_id=? AND normalized_key=?)').run(statuses[i], feed.id, String(i));
  };
  return { dir, store, db, alice, seed, close: () => { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('订阅列表批量读取保留翻译计数、账号隔离、排序、暂停和规则提示', () => {
  const { store, db, alice, seed, close } = fixture();
  try {
    const translated = store.createFeed(input).feed;
    const empty = store.createFeed(input).feed;
    const original = store.createFeed({ ...input, translationMode: 'original' }).feed;
    const website = store.createFeed({ ...input, sourceType: 'website', rules: { item: 'article', title: 'h2', link: 'a' } }).feed;
    const paused = store.createFeed(input).feed;
    store.toggleFeed(paused.id);
    const other = store.createFeed(input, alice.id).feed;
    seed(translated, ['success', 'success', 'pending', 'running', 'failed']);
    seed(original, ['success', 'failed']);
    seed(website, ['success', 'running']);
    seed(paused, ['failed', 'pending']);
    seed(other, ['success', 'success', 'success']);
    const ordered = [translated, empty, original, website, paused, other];
    ordered.forEach((feed, i) => db.prepare('UPDATE feeds SET created_at=? WHERE id=?').run(new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), feed.id));
    const warning = (field: string) => JSON.stringify({ severity: 'warning', reasons: [{ code: 'field-rate', field, baseline: 1, current: 0, message: field }] });
    const insert = db.prepare('INSERT INTO feed_health(feed_id,signature,warning_json) VALUES (?,?,?)');
    insert.run(translated.id, 'fixture', warning('title'));
    insert.run(website.id, 'fixture', warning('date'));
    insert.run(empty.id, 'fixture', '{invalid');
    insert.run(other.id, 'fixture', warning('link'));

    const feeds = store.listFeeds('admin');
    assert.deepEqual(feeds.map(feed => feed.id), [paused, website, original, empty, translated].map(feed => feed.id));
    const byId = new Map(feeds.map(feed => [feed.id, feed]));
    assert.deepEqual(byId.get(translated.id)?.translation, { pending: 2, success: 2, failed: 1 });
    assert.deepEqual(byId.get(empty.id)?.translation, { pending: 0, success: 0, failed: 0 });
    assert.equal(byId.get(empty.id)?.ruleHealth, undefined);
    assert.equal(byId.get(original.id)?.translation, undefined);
    assert.deepEqual(byId.get(website.id)?.translation, { pending: 1, success: 1, failed: 0 });
    assert.deepEqual(byId.get(paused.id)?.translation, { pending: 1, success: 0, failed: 1 });
    assert.equal(byId.get(paused.id)?.enabled, false);
    assert.equal(byId.get(translated.id)?.ruleHealth?.severity, 'warning');
    assert.equal(byId.get(website.id)?.ruleHealth?.severity, 'notice');
    assert.equal(byId.get(translated.id)?.itemCount, 5);
    assert.deepEqual(store.listFeeds(alice.id).map(feed => feed.translation), [{ pending: 0, success: 3, failed: 0 }]);
    assert.deepEqual(store.listFeeds('missing-owner'), []);
    assert.deepEqual(store.listFeeds().map(feed => feed.id), ordered.toReversed().map(feed => feed.id));
    for (const feed of store.listFeeds()) assert.deepEqual(feed, store.getFeed(feed.id));
  } finally { close(); }
});

test('批量统计处理空列表、重复和未知 ID，并只包含请求的订阅', () => {
  const { store, alice, seed, close } = fixture();
  try {
    const first = store.createFeed(input).feed, second = store.createFeed(input, alice.id).feed;
    seed(first, ['running', 'failed']); seed(second, ['success']);
    assert.deepEqual([...store.translations.statsForFeeds([])], []);
    assert.deepEqual([...store.ruleHealth.warnings([])], []);
    const ids = [first.id, first.id, ...Array.from({ length: 1100 }, (_, i) => `missing-${i}`)];
    const stats = store.translations.statsForFeeds(ids);
    assert.equal(stats.size, 1101);
    assert.deepEqual(stats.get(first.id), { pending: 1, success: 0, failed: 1 });
    assert.deepEqual(stats.get('missing-1099'), { pending: 0, success: 0, failed: 0 });
    assert.equal(stats.has(second.id), false);
  } finally { close(); }
});

test('列表查询次数不随订阅数增长', t => {
  const { store, db, close } = fixture();
  try {
    store.createFeed(input);
    const prepare = DatabaseSync.prototype.prepare;
    const queries: string[] = [];
    t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      queries.push(sql);
      return prepare.call(this, sql);
    });
    const read = () => {
      queries.length = 0;
      const feeds = store.listFeeds('admin');
      assert.ok(queries.length <= 3, `列表执行了 ${queries.length} 条查询`);
      return { count: queries.length, feeds };
    };
    const small = read();
    store.transaction(() => { for (let i = 0; i < 100; i++) store.createFeed(input); });
    const large = read();
    assert.equal(large.feeds.length, 101);
    assert.equal(large.count, small.count);
    assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version), 23);
  } finally { close(); }
});

test('v0.9.0 数据库自动补建统计索引，重启保留数据、累计值和订阅密钥', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-stats-index-'));
  let store = new Store(dir);
  try {
    store.createAdmin('admin', 'admin-password');
    const { feed, token } = store.createFeed(input);
    store.transaction(() => store.translations.upsert(feed, [{ key: 'one', title: 'Article', link: 'https://example.test/one', html: '<p>Example</p>' }]));
    const before = store.exportTables();
    store.close();
    const old = new DatabaseSync(join(dir, 'app.db'));
    old.exec('DROP INDEX translations_feed_status');
    assert.equal(Number(old.prepare('PRAGMA user_version').get()?.user_version), 23);
    old.close();

    for (let i = 0; i < 2; i++) {
      store = new Store(dir);
      const db = new DatabaseSync(store.dbPath, { readOnly: true });
      try {
        assert.deepEqual(db.prepare('PRAGMA index_info(translations_feed_status)').all().map(row => row.name), ['feed_id', 'status']);
        assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version), 23);
        assert.deepEqual(store.exportTables(), before);
        assert.equal(store.getFeedToken(feed.id)?.token, token);
        assert.deepEqual(store.getFeed(feed.id)?.translation, { pending: 1, success: 0, failed: 0 });
      } finally { db.close(); }
      if (i === 0) store.close();
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
