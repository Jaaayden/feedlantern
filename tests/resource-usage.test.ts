import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { BrowserService } from '../src/server/browser.js';
import { Store } from '../src/server/store.js';
import { formatDateTime, formatRelative } from '../src/shared/i18n.js';

test('空闲后退出 Chromium，正在编辑或抓取时保持可用，下次抓取自动重开', { timeout: 20_000 }, async t => {
  const server = createServer((_request, response) => response.end('<title>Example</title><article><h2>Title</h2><a href="/one">Read</a></article>'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const host = `127.0.0.1:${address.port}`;
  const started: Browser[] = [], launch = chromium.launch.bind(chromium);
  t.mock.method(chromium, 'launch', async (options: Parameters<typeof launch>[0]) => { const browser = await launch(options); started.push(browser); return browser; });
  const service = new BrowserService({ allowedHosts: [host], idleTimeoutMs: 80 });
  const options = { url: `http://${host}`, waitMs: 0, rules: { item: 'article', title: 'h2', link: 'a' } };
  try {
    const editor = await service.open(options);
    assert.equal((await service.scrape(options)).length, 1);
    await delay(160);
    assert.equal(started.length, 1);
    assert.equal(started[0].isConnected(), true);
    assert.equal((await service.snapshot(editor.sessionId)).title, 'Example');
    const disconnected = new Promise<void>(resolve => started[0].once('disconnected', () => resolve()));
    await service.close(editor.sessionId); await disconnected;
    assert.equal(started[0].isConnected(), false);
    assert.equal((await service.scrape(options)).length, 1);
    assert.equal(started.length, 2);
    await new Promise<void>(resolve => started[1].once('disconnected', () => resolve()));
  } finally { await service.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('翻译缓存密集命中不反复写盘，超过一分钟更新保留顺序', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-cache-writes-')), store = new Store(dir), db = new DatabaseSync(store.dbPath);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  try {
    store.translations.cache('sample', '译文');
    const before = db.prepare('SELECT touched_at FROM translation_cache').get()!.touched_at;
    const version = () => db.prepare('PRAGMA data_version').get()!.data_version;
    const original = version();
    for (let i = 0; i < 1000; i++) assert.equal(store.translations.cached('sample'), '译文');
    assert.equal(version(), original, '只读命中不应改变数据库');
    now += 60_000;
    assert.equal(store.translations.cached('sample'), '译文');
    assert.equal(db.prepare('SELECT touched_at FROM translation_cache').get()!.touched_at, Number(before) + 60_000);
    const touched = version();
    assert.equal(store.translations.cached('sample'), '译文');
    assert.equal(version(), touched);
  } finally { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('日期格式复用保持语言、时区、选项和相对时间正确', () => {
  const date = new Date('2026-01-01T00:30:00Z');
  for (const locale of ['en', 'zh-CN'] as const) for (const timeZone of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
    for (const hourCycle of ['h12', 'h23'] as const) {
      const options = { timeZone, hourCycle, dateStyle: 'short', timeStyle: 'short' } as const;
      const expected = new Intl.DateTimeFormat(locale, options).format(date);
      for (let i = 0; i < 3; i++) assert.equal(formatDateTime(locale, date, options), expected);
    }
    assert.equal(formatRelative(locale, date, date.getTime() + 120_000), new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-2, 'minute'));
  }
  assert.equal(formatDateTime('en', 'invalid'), '');
  assert.equal(formatRelative('en', null), '');
});
