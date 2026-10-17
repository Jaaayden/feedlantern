import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { snapshotSchema, TRANSLATION_CACHE_LIMIT } from '../src/server/backups.js';

const noopBrowser = { async close() {}, async dispose() {} } as unknown as BrowserServiceLike;
const host = '127.0.0.1:4321';

function fillCache(dbPath: string, rows: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO translation_cache(key,text,touched_at) VALUES (?,?,?)');
    for (let i = 0; i < rows; i++) insert.run(i.toString(16).padStart(64, '0'), `t${i}`, i);
    db.exec('COMMIT');
  } finally { db.close(); }
}

test('翻译缓存超过上限时，导出只保留最新的条目并仍能通过备份校验', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-cache-'));
  const store = new Store(dataDir);
  try {
    store.createAdmin('admin', 'password123');
    const total = TRANSLATION_CACHE_LIMIT + 150;
    fillCache(join(dataDir, 'app.db'), total);
    const tables = store.exportTables();
    assert.equal(tables.translation_cache.length, TRANSLATION_CACHE_LIMIT);
    assert.equal(Math.max(...tables.translation_cache.map(row => row.touched_at)), total - 1);
    assert.equal(Math.min(...tables.translation_cache.map(row => row.touched_at)), 150);
    const parsed = snapshotSchema.safeParse({ format: 'feedlantern-backup', version: 3, appVersion: 'test', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables });
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3)));
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('导出接口在缓存超限时仍成功；数据不合规时返回具体位置而不是笼统的内部错误', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-export-api-'));
  const app = await createApp({ dataDir, publicOrigin: 'http://127.0.0.1:4321', browserService: noopBrowser, startScheduler: false });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    const setupToken = readFileSync(join(dataDir, 'setup-token'), 'utf8').trim();
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken, username: 'admin', password: 'password123' } });
    assert.equal(setup.statusCode, 200);
    const cookie = `${setup.cookies[0].name}=${setup.cookies[0].value}`;
    const headers = { host, cookie, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken as string };
    const exportBackup = () => app.inject({ method: 'POST', url: '/api/backups/export', headers, payload: { currentPassword: 'password123', password: 'a-long-backup-password' } });

    fillCache(join(dataDir, 'app.db'), TRANSLATION_CACHE_LIMIT + 50);
    const ok = await exportBackup();
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().format, 'feedlantern-encrypted');

    const db = new DatabaseSync(join(dataDir, 'app.db'));
    db.exec("INSERT INTO settings(key,value) VALUES ('unexpected','x')");
    db.close();
    const bad = await exportBackup();
    assert.equal(bad.statusCode, 500);
    const message = bad.json().error as string;
    assert.match(message, /备份数据校验失败/);
    assert.match(message, /tables\.settings/);
    assert.ok(errors.some(line => line.includes('备份导出校验失败')));
  } finally {
    console.error = original;
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
