import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { backupTables } from '../src/server/backups.js';
import { retentionProblem, storedItemLimit } from '../src/server/feed-output.js';
import { digest } from '../src/server/rss-source.js';

const rules = { item: 'a', title: 'a', link: 'a' };
const batch = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ title: `${prefix}${i}`, link: `https://example.test/${prefix}${i}` }));

test('保留条数：留空为自动，不少于输出条数，范围 10–1000', () => {
  assert.equal(storedItemLimit({ sourceType: 'website', outputLimit: 100 }), 200);
  assert.equal(storedItemLimit({ sourceType: 'rss', outputLimit: 100, retentionLimit: null }), 100);
  assert.equal(storedItemLimit({ sourceType: 'website', outputLimit: 20, retentionLimit: 50 }), 50);
  assert.equal(storedItemLimit({ sourceType: 'rss', outputLimit: 300, retentionLimit: 600 }), 600);
  // Stored values below the output limit (never saved through the API) still keep the output limit.
  assert.equal(storedItemLimit({ sourceType: 'website', outputLimit: 100, retentionLimit: 30 }), 100);
  assert.equal(retentionProblem(null, 100), null);
  assert.equal(retentionProblem(100, 100), null);
  assert.match(retentionProblem(99, 100)!, /不能少于输出条数（100）/);
  assert.match(retentionProblem(5, 10)!, /10 到 1000/);
  assert.match(retentionProblem(1001, 10)!, /10 到 1000/);
  assert.match(retentionProblem(50.5, 10)!, /10 到 1000/);
});

test('网页订阅：调小保留条数不立即删除；网页上仍能看到的条目总会保留，不会被当作新条目重复推送', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-retention-web-')), store = new Store(dir);
  try {
    const { feed } = store.createFeed({ name: 'Web', url: 'https://example.test', rules, credentialId: null, intervalMinutes: 60, waitMs: 0 });
    assert.equal(feed.retentionLimit, null);
    assert.throws(() => store.updateFeedSettings(feed.id, { retentionLimit: 50 }), /不能少于输出条数（100）/);
    assert.equal(store.getFeed(feed.id)!.retentionLimit, null, 'a rejected change writes nothing');
    store.updateFeedSettings(feed.id, { outputLimit: 10, retentionLimit: 20 });
    assert.equal(store.getFeed(feed.id)!.retentionLimit, 20);
    assert.throws(() => store.updateFeedSettings(feed.id, { outputLimit: 30 }), /不能少于输出条数（30）/);

    // The page lists 30 items: all of them stay although retention is 20.
    const page = batch('a', 30);
    const first = { itemCount: 0, newItemCount: 0 };
    store.upsertItems(store.getFeed(feed.id)!, page, first);
    assert.equal(first.newItemCount, 30);
    assert.equal(store.getItems(feed.id).length, 30);
    const again = { itemCount: 0, newItemCount: 0 };
    store.upsertItems(store.getFeed(feed.id)!, page, again);
    assert.equal(again.newItemCount, 0, 'items still on the page are not new again');
    const ids = new Set(store.getItems(feed.id).map(item => item.id));

    // Once the page moves on, the next fetch trims to the retention limit, newest first.
    const next = { itemCount: 0, newItemCount: 0 };
    store.upsertItems(store.getFeed(feed.id)!, [...batch('b', 5), ...page.slice(0, 10)], next);
    assert.equal(next.newItemCount, 5);
    const kept = store.getItems(feed.id);
    assert.equal(kept.length, 20);
    assert.ok(kept.some(item => item.title === 'b0'));
    assert.ok(kept.filter(item => item.title.startsWith('a')).every(item => ids.has(item.id)), 'kept items keep their id');

    // Lowering waits for the next fetch; raising keeps everything from then on.
    store.updateFeedSettings(feed.id, { retentionLimit: 10 });
    assert.equal(store.getItems(feed.id).length, 20);
    store.upsertItems(store.getFeed(feed.id)!, batch('c', 1));
    assert.equal(store.getItems(feed.id).length, 10);
    store.updateFeedSettings(feed.id, { retentionLimit: null });
    assert.equal(store.getFeed(feed.id)!.retentionLimit, null);
    assert.equal(storedItemLimit(store.getFeed(feed.id)!), 200);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('RSS 订阅：保留条数少于来源条目时，已见过但已清理的条目不会重新入库', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-retention-rss-')), store = new Store(dir);
  try {
    const { feed } = store.createFeed({ name: 'RSS', url: 'https://example.test/rss', sourceType: 'rss', translationMode: 'bilingual', rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 30, waitMs: 0 });
    store.updateFeedSettings(feed.id, { outputLimit: 10, retentionLimit: 10 });
    const items = Array.from({ length: 40 }, (_, i) => ({ key: digest(`k${i}`), title: `t${i}`, link: `https://example.test/${i}`, html: `<p>${i}</p>` }));
    const fetch = () => {
      const current = store.getFeed(feed.id)!;
      const counts = store.translations.upsert(current, store.translations.incoming(feed.id, items));
      store.translations.saveSource(feed.id, { title: 'RSS', items });
      return counts.newItemCount;
    };
    assert.equal(fetch(), 20, 'the first fetch takes the newest 20');
    assert.equal(store.getItems(feed.id).length, 10);
    assert.equal(store.translations.stats(feed.id).pending, 10, 'trimmed items take their translation tasks with them');
    assert.equal(fetch(), 0, 'trimmed items stay in the seen list and are not stored again');
    assert.equal(fetch(), 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('迁移 18、完整备份往返和旧备份；API、批量设置、配置导入导出都带保留条数', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dataDir = mkdtempSync(join(tmpdir(), 'fl-retention-api-'));
  const fakeBrowser = { async close() {}, async dispose() {}, async scrape() { return []; } } as unknown as BrowserServiceLike;
  // A database from before migration 18 has no retention column.
  {
    const store = new Store(dataDir);
    const db = new DatabaseSync(join(dataDir, 'app.db'));
    db.exec('ALTER TABLE feeds DROP COLUMN retention_limit; PRAGMA user_version=17;'); db.close();
    store.close();
  }
  const app = await createApp({ dataDir, publicOrigin: 'http://127.0.0.1:4321', browserService: fakeBrowser, startScheduler: false });
  try {
    const columns = new DatabaseSync(join(dataDir, 'app.db'));
    assert.ok(columns.prepare('PRAGMA table_info(feeds)').all().some(column => column.name === 'retention_limit'));
    assert.equal(Number((columns.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), 18);
    columns.close();
    const host = '127.0.0.1:4321';
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: readFileSync(join(dataDir, 'setup-token'), 'utf8').trim(), username: 'admin', password: 'password123' } });
    const headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken as string };
    const created = await app.inject({ method: 'POST', url: '/api/feeds', headers, payload: { name: 'API', url: 'https://example.test', rules, credentialId: null, intervalMinutes: 60, waitMs: 0 } });
    const id = created.json().feed.id as string;
    assert.equal(created.json().feed.retentionLimit, null);

    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/api/feeds/${id}`, headers, payload });
    for (const [payload, pattern] of [[{ retentionLimit: 5 }, /10 到 1000/], [{ retentionLimit: 1001 }, /10 到 1000/], [{ retentionLimit: 'many' }, /10 到 1000/], [{ retentionLimit: 50 }, /不能少于输出条数（100）/], [{ outputLimit: 300, retentionLimit: 200 }, /不能少于输出条数（300）/]] as const) {
      const response = await patch(payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.match(response.json().error, pattern);
    }
    const saved = await patch({ outputLimit: 50, retentionLimit: 400 });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().feed.retentionLimit, 400);
    assert.equal((await patch({ retentionLimit: null })).json().feed.retentionLimit, null);

    const bulk = await app.inject({ method: 'POST', url: '/api/feeds/bulk', headers, payload: { ids: [id], action: 'settings', settings: { retentionLimit: 600 } } });
    assert.deepEqual(bulk.json().results, [{ id, ok: true }]);
    const tooLow = await app.inject({ method: 'POST', url: '/api/feeds/bulk', headers, payload: { ids: [id], action: 'settings', settings: { outputLimit: 500, retentionLimit: 400 } } });
    assert.equal(tooLow.json().results[0].ok, false);
    assert.match(tooLow.json().results[0].error, /不能少于输出条数（500）/);

    const exported = (await app.inject({ url: '/api/backups/config', headers })).json();
    assert.equal(exported.feeds[0].retentionLimit, 600);
    exported.feeds[0].url = 'https://example.test/other';
    const imported = await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: exported, confirm: true } });
    assert.equal(imported.statusCode, 200, imported.body);
    const feeds = (await app.inject({ url: '/api/feeds', headers })).json() as Array<{ url: string; retentionLimit: number | null }>;
    assert.equal(feeds.find(feed => feed.url === 'https://example.test/other')?.retentionLimit, 600);
    const invalid = structuredClone(exported); invalid.feeds[0].url = 'https://example.test/third'; invalid.feeds[0].retentionLimit = 20;
    const rejected = await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: invalid } });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().error, /不能少于输出条数/);

    // Full backup: the column travels; backups made before it restore as automatic.
    const targetDir = mkdtempSync(join(tmpdir(), 'fl-retention-target-'));
    const store = new Store(dataDir), target = new Store(targetDir);
    try {
      const tables = store.exportTables();
      const row = backupTables.feeds.parse(tables.feeds).find(feed => feed.id === id)!;
      assert.equal(row.retention_limit, 600);
      target.restoreTables(tables);
      assert.equal(target.getFeed(id)?.retentionLimit, 600);
      const legacy = structuredClone(tables);
      for (const feedRow of legacy.feeds as Array<Record<string, unknown>>) delete feedRow.retention_limit;
      target.restoreTables(backupTables.feeds.parse(legacy.feeds) && legacy);
      assert.equal(target.getFeed(id)?.retentionLimit, null);
      assert.throws(() => backupTables.feeds.parse([{ ...row, retention_limit: 5 }]));
    } finally { store.close(); target.close(); rmSync(targetDir, { recursive: true, force: true }); }
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
