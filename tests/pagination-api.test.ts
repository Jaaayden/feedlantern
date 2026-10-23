import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { snapshotSchema } from '../src/server/backups.js';
import { parsePagination } from '../src/server/validation.js';
import type { FetchLogPage, PaginationReport, PaginationRules } from '../src/shared/types.js';

const host = '127.0.0.1:4321';
const rules = { item: 'article', title: 'h2', link: 'a' };
const pagination: PaginationRules = { mode: 'next', maxPages: 4, delayMs: 3000, nextSelector: 'a[rel~="next"]' };
const report: PaginationReport = {
  pages: [{ page: 1, url: 'https://example.test/list', count: 2, added: 2 }, { page: 2, url: 'https://example.test/list?page=2', count: 1, added: 1 }, { page: 3, url: 'https://example.test/list?page=3', count: 0, added: 0, error: '目标网页返回 HTTP 500' }],
  stoppedAt: 3, stop: 'failed', message: '第 3 页失败：目标网页返回 HTTP 500，已保留前 2 页的条目',
};

test('翻页设置校验：默认保守、有上限、模板必须含 {n}', () => {
  assert.equal(parsePagination(undefined), undefined);
  assert.equal(parsePagination(null), null);
  assert.equal(parsePagination({ mode: 'none' }), null);
  assert.deepEqual(parsePagination({ mode: 'next', nextSelector: ' a.next ' }), { mode: 'next', maxPages: 3, delayMs: 3000, nextSelector: 'a.next' });
  assert.deepEqual(parsePagination({ mode: 'template', urlTemplate: 'https://example.test/list?page={n}', maxPages: 10, delayMs: 2000 }), { mode: 'template', maxPages: 10, delayMs: 2000, urlTemplate: 'https://example.test/list?page={n}', start: 2, step: 1 });
  for (const bad of [
    { mode: 'scroll' }, { mode: 'next' }, { mode: 'loadMore', nextSelector: '' },
    { mode: 'next', nextSelector: 'a', maxPages: 11 }, { mode: 'next', nextSelector: 'a', maxPages: 0 },
    { mode: 'next', nextSelector: 'a', delayMs: 1999 }, { mode: 'next', nextSelector: 'a', delayMs: 30_001 },
    { mode: 'template', urlTemplate: 'https://example.test/list?page=2' }, { mode: 'template', urlTemplate: 'ftp://example.test/{n}' },
    { mode: 'template', urlTemplate: 'https://example.test/{n}', step: 0 },
  ]) assert.throws(() => parsePagination(bad), JSON.stringify(bad));
});

test('翻页设置随订阅保存，后台刷新传入已见条目并在抓取日志标明第几页失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-pagination-')), store = new Store(dir);
  const calls: Array<{ pagination?: PaginationRules | null; known?: boolean[] }> = [];
  const browser: BrowserServiceLike = {
    open: () => { throw Error('unused'); }, snapshot: () => { throw Error('unused'); }, scroll: () => { throw Error('unused'); }, click: () => { throw Error('unused'); },
    pick: () => { throw Error('unused'); }, extract: () => [], close() {}, dispose() {},
    scrape: async options => {
      calls.push({ pagination: options.pagination, known: options.isKnown && ['https://example.test/one#top', 'https://example.test/new'].map(options.isKnown) });
      options.onReport?.(report);
      return [{ title: 'one', link: 'https://example.test/one' }, { title: 'two', link: 'https://example.test/two' }, { title: 'three', link: 'https://example.test/three' }];
    },
  };
  const app = await createApp({ dataDir: dir, store, publicOrigin: `http://${host}`, browserService: browser, startScheduler: false });
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: store.getSetupToken(), username: 'admin', password: 'test-password123' } });
    const headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken };
    const input = { name: '多页订阅', url: 'https://example.test/list', rules, credentialId: null, intervalMinutes: 60, waitMs: 0, pagination };
    const created = await app.inject({ method: 'POST', url: '/api/feeds', headers, payload: input });
    assert.equal(created.statusCode, 200, created.body);
    const id = created.json().feed.id;
    assert.deepEqual(created.json().feed.pagination, pagination);
    assert.deepEqual(calls[0], { pagination, known: [false, false] });
    const logs = async () => (await app.inject({ method: 'GET', url: `/api/feeds/${id}/logs`, headers })).json<FetchLogPage>().logs;
    let latest = (await logs())[0];
    assert.equal(latest.status, 'success');
    assert.equal(latest.itemCount, 3);
    assert.equal(latest.pages, 2);
    assert.equal(latest.note, '共 2 页（2 + 1 条）；第 3 页失败：目标网页返回 HTTP 500，已保留前 2 页的条目');
    assert.deepEqual(store.getItems(id).map(item => item.title), ['one', 'two', 'three'], '第 1 页的条目排在最前');

    await app.inject({ method: 'POST', url: `/api/feeds/${id}/refresh`, headers });
    assert.deepEqual(calls[1].known, [true, false], '已保存的链接（忽略 #hash）视为已见过');

    // A client that does not send the field keeps the saved setting; null clears it.
    const { pagination: _omit, ...withoutPagination } = input;
    assert.deepEqual((await app.inject({ method: 'PUT', url: `/api/feeds/${id}`, headers, payload: withoutPagination })).json().feed.pagination, pagination);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/feeds/${id}`, headers, payload: { ...input, pagination: { ...pagination, maxPages: 11 } } })).statusCode, 400);
    const exported = await app.inject({ method: 'GET', url: '/api/backups/config', headers });
    assert.deepEqual(exported.json().feeds[0].pagination, pagination);
    const tables = store.exportTables();
    assert.equal(JSON.parse(tables.feeds[0].pagination_json!).maxPages, 4);
    assert.ok(snapshotSchema.safeParse({ format: 'feedlantern-backup', version: 3, appVersion: 'test', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables }).success);
    const { pagination_json: _column, ...oldRow } = tables.feeds[0];
    assert.ok(snapshotSchema.safeParse({ format: 'feedlantern-backup', version: 3, appVersion: 'test', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables: { ...tables, feeds: [oldRow] } }).success, '旧备份没有翻页列也能恢复');

    const cleared = await app.inject({ method: 'PUT', url: `/api/feeds/${id}`, headers, payload: { ...input, pagination: null } });
    assert.equal(cleared.json().feed.pagination, undefined);
    assert.equal(calls.at(-1)!.pagination, undefined, '单页订阅不传翻页设置');
    latest = (await logs())[0];
    assert.equal(latest.pages, undefined);
    assert.equal(latest.note, undefined);

  } finally {
    await app.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('编辑器预览：设置 2 页以上时按同一套逻辑试抓多页', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-pagination-preview-')), store = new Store(dir);
  const seen: string[] = [];
  const frame = { sessionId: 'session-1', image: '', width: 1, height: 1, viewportHeight: 1, documentHeight: 1, url: 'https://example.test/list', title: 'List' };
  const browser: BrowserServiceLike = {
    open: () => frame, snapshot: () => frame, scroll: () => frame, click: () => frame, pick: () => { throw Error('unused'); }, close() {}, dispose() {}, scrape: () => [],
    extract: () => { seen.push('single'); return [{ title: 'one', link: 'https://example.test/one' }]; },
    paginate: async (_id, _rules, value) => { seen.push(`pages:${value.maxPages}`); return { items: [{ title: 'one', link: 'https://example.test/one' }], report }; },
  };
  const app = await createApp({ dataDir: dir, store, publicOrigin: `http://${host}`, browserService: browser, startScheduler: false });
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: store.getSetupToken(), username: 'admin', password: 'test-password123' } });
    const headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken };
    assert.equal((await app.inject({ method: 'POST', url: '/api/browser', headers, payload: { url: 'https://example.test/list', waitMs: 0 } })).statusCode, 200);
    const preview = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/browser/session-1/preview', headers, payload: body });
    assert.equal((await preview({ rules })).json().pagination, undefined);
    assert.deepEqual((await preview({ rules, pagination })).json().pagination, report);
    assert.equal((await preview({ rules, pagination: { ...pagination, maxPages: 1 } })).statusCode, 200);
    assert.equal((await preview({ rules, pagination: { mode: 'template', urlTemplate: 'https://example.test/list' } })).statusCode, 400);
    assert.deepEqual(seen, ['single', 'pages:4', 'single']);
  } finally {
    await app.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('数据库迁移 16 为旧数据库补上翻页设置列', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-pagination-migrate-'));
  try {
    new Store(dir).close();
    const db = new DatabaseSync(join(dir, 'app.db'));
    db.exec('ALTER TABLE feeds DROP COLUMN pagination_json; PRAGMA user_version=8;');
    db.close();
    const store = new Store(dir);
    store.close();
    const check = new DatabaseSync(join(dir, 'app.db'));
    assert.equal(Number((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), 16);
    assert.ok(check.prepare('PRAGMA table_info(feeds)').all().some(row => row.name === 'pagination_json'));
    check.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
