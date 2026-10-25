import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { snapshotSchema } from '../src/server/backups.js';
import type { FeedInput } from '../src/shared/types.js';

const input: FeedInput = { name: 'Activity test', url: 'https://example.test/list', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 };
const items = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ title: `Item ${from + i}`, link: `https://example.test/item/${from + i}` }));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fl-activity-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  return { dir, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('累计采集独立于内容保留、重复抓取、订阅删除和进程重启', () => {
  const { dir, store } = fixture();
  let reopened: Store | undefined;
  try {
    const { feed } = store.createFeed(input);
    store.updateFeedSettings(feed.id, { outputLimit: 20, retentionLimit: 100 });
    store.upsertItems(feed, items(0, 120));
    store.upsertItems(feed, [...items(120, 5), ...items(120, 5)]);
    assert.equal(store.getItems(feed.id).length, 100);
    assert.equal(store.activity.read('admin').totals.collected, 125);
    store.upsertItems(feed, items(120, 5));
    assert.equal(store.activity.read('admin').totals.collected, 125, '已有条目与单次请求中的重复条目不累计');
    store.deleteFeed(feed.id);
    assert.equal(store.activity.read('admin').totals.collected, 125);
    store.history.prune(); store.translations.prune();
    assert.equal(store.activity.read('admin').daily.at(-1)?.removed, 1);
    store.close();
    reopened = new Store(dir);
    assert.equal(reopened.activity.read('admin').totals.collected, 125);
    assert.equal(reopened.activity.read('admin').daily.at(-1)?.subscriptions, 0);
  } finally { if (reopened) reopened.close(); else { try { store.close(); } catch {} } rmSync(dir, { recursive: true, force: true }); }
});

test('采集和翻译计数随事务回滚；重复成功状态不重复计数，清理内容不减少翻译累计', () => {
  const { store, cleanup } = fixture();
  const db = new DatabaseSync(store.dbPath);
  try {
    const { feed } = store.createFeed({ ...input, translationMode: 'bilingual' });
    assert.throws(() => store.transaction(() => { store.upsertItems(feed, items(0, 2)); throw new Error('rollback'); }), /rollback/);
    assert.equal(store.activity.read('admin').totals.collected, 0);
    store.upsertItems(feed, items(0, 2));
    db.prepare("UPDATE translations SET status='success' WHERE feed_id=?").run(feed.id);
    assert.deepEqual(store.activity.read('admin').totals, { collected: 2, translated: 2 });
    db.prepare("UPDATE translations SET status='success' WHERE feed_id=?").run(feed.id);
    assert.equal(store.activity.read('admin').totals.translated, 2);
    db.exec("BEGIN; UPDATE translations SET status='pending'; UPDATE translations SET status='success'; ROLLBACK;");
    assert.equal(store.activity.read('admin').totals.translated, 2);
    store.deleteFeed(feed.id);
    assert.equal(store.activity.read('admin').totals.translated, 2);
  } finally { db.close(); cleanup(); }
});

test('日趋势补齐无活动日期，订阅变化保留删除事件，清理趋势不清理累计', () => {
  const { store, cleanup } = fixture(), db = new DatabaseSync(store.dbPath);
  try {
    const first = store.createFeed(input).feed;
    store.createFeed(input); store.createFeed(input);
    store.upsertItems(first, items(0, 3)); store.deleteFeed(first.id);
    const today = new Date().toISOString().slice(0, 10);
    const twoDaysAgo = new Date(Date.parse(today) - 2 * 86400_000).toISOString().slice(0, 10);
    db.prepare('UPDATE activity_totals SET started_at=?').run(`${twoDaysAgo}T00:00:00.000Z`);
    db.prepare('UPDATE activity_daily SET feeds_created=2 WHERE day=?').run(today);
    db.prepare('INSERT INTO activity_daily(owner_id,day,feeds_created) VALUES (?,?,1)').run('admin',twoDaysAgo);
    const stats = store.activity.read('admin', 7);
    assert.deepEqual(stats.daily.map(d => d.subscriptions), [1,1,2]);
    assert.deepEqual(stats.daily.map(d => d.collected), [0,0,3]);
    store.activity.prune(new Date(Date.now() + 100 * 86400_000));
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM activity_daily').get()?.n), 0);
    assert.deepEqual(store.activity.read('admin').totals, { collected: 3, translated: 0 });
  } finally { db.close(); cleanup(); }
});

test('备份恢复保留累计，不把恢复的内容重复累计；旧备份从恢复时开始统计', () => {
  const { store, cleanup } = fixture();
  try {
    const { feed } = store.createFeed(input);
    store.upsertItems(feed, items(0, 4));
    const snapshot = snapshotSchema.parse({ format: 'feedlantern-backup', version: 3, appVersion: '0.8.1', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables: store.exportTables() });
    const before = store.activity.read('admin');
    store.upsertItems(feed, items(10, 2));
    store.restoreTables(snapshot.tables);
    const after = store.activity.read('admin');
    assert.deepEqual(after.totals, before.totals);
    assert.deepEqual(after.daily, before.daily);
    assert.equal(after.recordingSince, before.recordingSince);
    const legacy: Record<string, unknown> = { ...snapshot.tables };
    delete legacy.activity_totals; delete legacy.activity_daily;
    store.restoreTables(snapshotSchema.parse({ ...snapshot, tables: legacy }).tables);
    assert.deepEqual(store.activity.read('admin').totals, { collected: 0, translated: 0 });
    assert.equal(store.getItems(feed.id).length, 4);
    assert.equal(store.activity.read('admin').daily.at(-1)?.subscriptions, 1);
  } finally { cleanup(); }
});

test('仪表盘 API 隔离账号、支持管理员工作台和只读令牌，拒绝无效时间范围', async () => {
  const { store, dir, cleanup } = fixture();
  const alice = store.createUser('alice', 'alice-password');
  const adminFeed = store.createFeed(input).feed, aliceFeed = store.createFeed(input, alice.id).feed;
  store.upsertItems(adminFeed, items(0, 2)); store.upsertItems(aliceFeed, items(10, 5));
  const browser = { close: async () => {}, dispose: async () => {} } as unknown as BrowserServiceLike;
  const app = await createApp({ store, dataDir: dir, startScheduler: false, browserService: browser });
  try {
    const admin = store.createSession('admin', 60_000), user = store.createSession('alice', 60_000);
    const headers = { host: '127.0.0.1:4321', cookie: `feedlantern_session=${admin.id}`, 'x-feedlantern': '1' };
    assert.equal((await app.inject({ url: '/api/dashboard?days=7', headers })).json().totals.collected, 2);
    assert.equal((await app.inject({ url: '/api/dashboard', headers: { ...headers, 'x-feedlantern-user': alice.id } })).json().totals.collected, 5);
    const own = { ...headers, cookie: `feedlantern_session=${user.id}` };
    assert.equal((await app.inject({ url: '/api/dashboard', headers: own })).json().totals.collected, 5);
    assert.equal((await app.inject({ url: '/api/dashboard', headers: { ...own, 'x-feedlantern-user': 'admin' } })).statusCode, 403);
    for (const days of ['0','8','91','nope']) assert.equal((await app.inject({ url: `/api/dashboard?days=${days}`, headers })).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/dashboard', headers: { host: headers.host, 'x-feedlantern': '1' } })).statusCode, 401);
    const tokenResponse = await app.inject({ method: 'POST', url: '/api/tokens', headers: { ...headers, 'x-csrf-token': admin.csrfToken }, payload: { name: 'dashboard read', scope: 'read', expiresInDays: null } });
    assert.equal(tokenResponse.statusCode, 200);
    const token = tokenResponse.json().secret;
    const tokenRead = await app.inject({ url: '/api/dashboard', headers: { host: headers.host, authorization: `Bearer ${token}` } });
    assert.equal(tokenRead.statusCode, 200);
    assert.equal(tokenRead.json().totals.collected, 2);
  } finally { await app.close(); cleanup(); }
});
