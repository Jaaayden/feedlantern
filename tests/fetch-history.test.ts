import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import { safeDiagnostic } from '../src/server/fetch-history.js';

const input = { name: '日志测试', url: 'https://example.test/list?secret=private', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fl-history-')), store = new Store(dir);
  const feed = store.createFeed(input).feed;
  return { dir, store, feed, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('日志分页顺序、状态筛选、200 条上限下准确计数与原子回滚', () => {
  const { store, feed, close } = fixture();
  try {
    const counts = { itemCount: 0, newItemCount: 0 };
    store.upsertItems(feed, Array.from({ length: 200 }, (_, i) => ({ title: `文章${i}`, link: `https://example.test/${i}` })), counts);
    assert.equal(counts.newItemCount, 200);
    const items = [{ title: '旧文章', link: 'https://example.test/0#fragment' }, { title: '新增', link: 'https://example.test/new' }, { title: '重复', link: 'https://example.test/new#fragment' }];
    const run = store.history.start(feed.id, 'manual');
    store.transaction(() => { store.upsertItems(feed, items, counts); store.history.succeed(run, feed.id, 12.5, counts); });
    assert.equal(counts.itemCount, 2); assert.equal(counts.newItemCount, 1);
    assert.equal(store.getItems(feed.id).length, 200);
    store.upsertItems(feed, items, counts); assert.equal(counts.newItemCount, 0);
    const failed = store.history.start(feed.id, 'edit');
    store.history.fail(failed, feed, 'edit', 5, 'Cookie: sensitive', false);
    const page = store.history.list(feed.id, undefined, undefined, 1);
    assert.equal(page.logs[0].id, failed); assert.equal(page.nextCursor, String(failed));
    assert.equal(page.logs[0].notification?.status, 'disabled');
    assert.equal(page.logs[0].error, '[敏感信息已隐藏]');
    assert.equal(store.history.list(feed.id, undefined, Number(page.nextCursor), 1).logs[0].id, run);
    assert.equal(store.history.list(feed.id, 'success').logs.length, 1);
    assert.throws(() => store.transaction(() => {
      store.upsertItems(feed, [{ title: 'rollback', link: 'https://example.test/rollback' }]);
      store.history.succeed(failed, feed.id, 1, counts);
      throw Error('rollback');
    }));
    assert.equal(store.getItems(feed.id).some(i => i.title === 'rollback'), false);
  } finally { close(); }
});

test('Bark 故障去重、准确重试时间、冷却后重试与恢复后重新告警', () => {
  const { store, feed, close } = fixture();
  try {
    const h = store.history, now = Date.now();
    const fail = (time: number) => { const id = h.start(feed.id, 'scheduled'); h.fail(id, feed, 'scheduled', 20, '无法加载 https://example.test/?token=secret\nCookie: private', true, time); return id; };
    const first = fail(now), job = h.nextAlert(now)!;
    assert.ok(job); assert.ok(!job.body.includes('secret')); assert.ok(!job.body.includes('private'));
    assert.ok(job.body.includes('日志测试')); assert.ok(job.body.includes('定时'));
    h.beginAttempt(job.id, now); h.finishAttempt(job.id, false, now);
    assert.equal(h.nextAlert(now + 59_999), null);
    h.beginAttempt(job.id, now + 60_000); h.finishAttempt(job.id, false, now + 60_000);
    assert.equal(h.nextAlert(now + 359_999), null);
    h.beginAttempt(job.id, now + 360_000); h.finishAttempt(job.id, false, now + 360_000);
    assert.equal(h.list(feed.id).logs[0].notification?.status, 'failed');
    fail(now + 360_001); assert.equal(h.nextAlert(now + 360_001), null);
    fail(now + 360_000 + 30 * 60_000);
    const retry = h.nextAlert(now + 360_000 + 30 * 60_000)!;
    assert.notEqual(retry.id, job.id);
    h.beginAttempt(retry.id); h.finishAttempt(retry.id, true);
    fail(now + 4_000_000); assert.equal(h.nextAlert(now + 4_000_000), null);
    const success = h.start(feed.id, 'manual'); h.succeed(success, feed.id, 5, { itemCount: 1, newItemCount: 0 });
    const last = fail(now + 4_000_001); assert.ok(h.nextAlert(now + 4_000_001));
    h.succeed(h.start(feed.id, 'manual'), feed.id, 5, { itemCount: 1, newItemCount: 0 });
    assert.equal(h.list(feed.id).logs.find(l => l.id === last)?.notification?.status, 'canceled');
    assert.equal(h.list(feed.id).logs.find(l => l.id === first)?.notification?.status, 'failed');
    assert.equal(h.nextAlert(now + 5_000_000), null);
  } finally { close(); }
});

test('30 天清理、重启中断恢复、队列持久化、删除及备份恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-history-restart-'));
  let store = new Store(dir);
  try {
    const feed = store.createFeed(input).feed, now = Date.now();
    const old = store.history.start(feed.id, 'manual', new Date(now - 31 * 86400_000).toISOString());
    store.history.succeed(old, feed.id, 10, { itemCount: 1, newItemCount: 1 });
    const pending = store.history.start(feed.id, 'scheduled');
    store.history.fail(pending, feed, 'scheduled', 1, '网络错误', true);
    const running = store.history.start(feed.id, 'manual');
    const backup = store.exportTables();
    assert.equal('fetch_logs' in backup, false); assert.equal('fetch_alerts' in backup, false);
    store.close(); store = new Store(dir); store.history.recover(now);
    const logs = store.history.list(feed.id).logs;
    assert.equal(logs.some(l => l.id === old), false);
    assert.equal(logs.find(l => l.id === running)?.status, 'interrupted');
    assert.equal(logs.find(l => l.id === running)?.durationMs, null);
    assert.ok(store.history.nextAlert());
    store.restoreTables(backup);
    assert.equal(store.history.list(feed.id).logs.length, 0); assert.equal(store.history.nextAlert(), null);
    const again = store.history.start(feed.id, 'scheduled'); store.history.fail(again, feed, 'scheduled', 1, '失败', true);
    store.deleteFeed(feed.id);
    assert.equal(store.history.nextAlert(), null); assert.equal(store.history.list(feed.id).logs.length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('旧数据库自动加入日志表，不补造历史和旧错误告警', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-history-upgrade-'));
  let store = new Store(dir);
  try {
    const feed = store.createFeed(input).feed;
    store.markFetchFailure(feed.id, '升级前错误', feed.nextFetchAt);
    store.close();
    const db = new DatabaseSync(join(dir, 'app.db'));
    db.exec('DROP TABLE fetch_logs; DROP TABLE fetch_incidents; DROP TABLE fetch_alerts;'); db.close();
    store = new Store(dir); store.history.recover();
    assert.equal(store.getFeed(feed.id)?.lastError, '升级前错误');
    assert.equal(store.history.list(feed.id).logs.length, 0); assert.equal(store.history.nextAlert(), null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('错误诊断移除 URL、认证信息和浏览器堆栈并限制长度', () => {
  for (const message of ['Authorization: Bearer secret', 'Cookie: secret', 'device_key=secret', 'https://api.day.app/secret/', 'timeout\nCall log: secret']) {
    assert.ok(!safeDiagnostic(message).includes('secret'));
  }
  assert.equal(safeDiagnostic('x'.repeat(500)).length, 300);
});
