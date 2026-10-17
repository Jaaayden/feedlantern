import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../src/server/store.js';
import { TRANSLATION_EVENTS_PER_FEED } from '../src/server/rss-translation.js';

const feedInput = (name: string) => ({ sourceType: 'rss' as const, name, url: `https://example.test/${name}`, rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 30, waitMs: 0 });
function pragma(dbPath: string, name: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return Number(Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[0]); } finally { db.close(); }
}
function eventCount(dbPath: string, feedId: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return Number((db.prepare('SELECT COUNT(*) AS c FROM translation_events WHERE feed_id=?').get(feedId) as { c: number }).c); } finally { db.close(); }
}
function addEvents(dbPath: string, feedId: string, rows: number, message = '已完成 1 个片段（已提交 12，缓存命中 7）'): void {
  const db = new DatabaseSync(dbPath);
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO translation_events(feed_id,item_id,at,message) VALUES (?,?,?,?)');
  for (let i = 0; i < rows; i++) insert.run(feedId, `item_${i % 50}`, Date.now(), `${message} #${i}`);
  db.exec('COMMIT');
  db.close();
}

test('翻译事件按订阅保留最新的固定条数，其他订阅不受影响', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedlantern-events-'));
  const store = new Store(dir);
  try {
    store.createAdmin('admin', 'password123');
    const busy = store.createFeed(feedInput('busy')).feed.id, quiet = store.createFeed(feedInput('quiet')).feed.id;
    const dbPath = join(dir, 'app.db');
    addEvents(dbPath, busy, TRANSLATION_EVENTS_PER_FEED * 5);
    addEvents(dbPath, quiet, 30);
    store.translations.prune();
    assert.equal(eventCount(dbPath, busy), TRANSLATION_EVENTS_PER_FEED);
    assert.equal(eventCount(dbPath, quiet), 30);
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    const newest = (reader.prepare('SELECT message FROM translation_events WHERE feed_id=? ORDER BY id DESC LIMIT 1').get(busy) as { message: string }).message;
    reader.close();
    assert.ok(newest.endsWith(`#${TRANSLATION_EVENTS_PER_FEED * 5 - 1}`));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('新数据库启用增量回收，清理后文件会逐步缩小；旧数据库调用 compact 不报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedlantern-compact-'));
  const store = new Store(dir);
  try {
    store.createAdmin('admin', 'password123');
    const feed = store.createFeed(feedInput('f')).feed.id;
    const dbPath = join(dir, 'app.db');
    assert.equal(pragma(dbPath, 'auto_vacuum'), 2);
    addEvents(dbPath, feed, 20_000, 'x'.repeat(400));
    const grownPages = pragma(dbPath, 'page_count');
    assert.ok(grownPages > 1000);
    store.translations.prune();
    assert.ok(pragma(dbPath, 'freelist_count') > grownPages / 2);
    for (let i = 0; i < 50; i++) store.compact(1000);
    assert.ok(pragma(dbPath, 'page_count') < grownPages / 10, `页数应明显减少：${grownPages} -> ${pragma(dbPath, 'page_count')}`);
    assert.equal(pragma(dbPath, 'freelist_count'), 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const legacyDir = mkdtempSync(join(tmpdir(), 'feedlantern-legacy-'));
  try {
    const raw = new DatabaseSync(join(legacyDir, 'app.db'));
    raw.exec('CREATE TABLE t(x)'); raw.close();
    const legacy = new Store(legacyDir);
    assert.doesNotThrow(() => legacy.compact());
    legacy.close();
  } finally { rmSync(legacyDir, { recursive: true, force: true }); }
});

test('压缩脚本：旧库切换为增量回收并缩小文件，--dry-run 不改动数据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedlantern-script-'));
  try {
    const dbPath = join(dir, 'app.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec('CREATE TABLE translation_events (id INTEGER PRIMARY KEY AUTOINCREMENT, feed_id TEXT NOT NULL, item_id TEXT, at INTEGER NOT NULL, message TEXT NOT NULL)');
    raw.exec('BEGIN');
    const insert = raw.prepare('INSERT INTO translation_events(feed_id,item_id,at,message) VALUES (?,?,?,?)');
    for (let i = 0; i < 30_000; i++) insert.run(i % 2 ? 'a' : 'b', 'item', Date.now(), 'y'.repeat(300) + i);
    raw.exec('COMMIT'); raw.close();
    assert.equal(pragma(dbPath, 'auto_vacuum'), 0);
    const before = statSync(dbPath).size;
    const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/compact-db.ts', ...args], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });

    const dry = run('--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(statSync(dbPath).size, before);

    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /完整性检查：ok/);
    assert.equal(pragma(dbPath, 'auto_vacuum'), 2);
    const check = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal((check.prepare('SELECT COUNT(*) AS c FROM translation_events').get() as { c: number }).c, TRANSLATION_EVENTS_PER_FEED * 2);
    check.close();
    assert.ok(statSync(dbPath).size < before / 10, `${before} -> ${statSync(dbPath).size}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
