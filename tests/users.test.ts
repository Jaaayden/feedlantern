import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { openBackup, sealBackup, snapshotSchema } from '../src/server/backups.js';
import { ImportJobs } from '../src/server/import-jobs.js';
import { TranslationWorker } from '../src/server/rss-translation.js';
import type { FeedInput } from '../src/shared/types.js';

const input: FeedInput = { name: 'private', url: 'https://example.test/articles', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 };
const item = { title: 'Original', link: 'https://example.test/one' };
const browser: BrowserServiceLike = {
  open: async options => ({ sessionId: randomUUID(), image: '', width: 1, height: 1, url: options.url, title: 'test' }),
  snapshot: async id => ({ sessionId: id, image: '', width: 1, height: 1, url: input.url, title: 'test' }),
  async scroll(id) { return this.snapshot(id); }, async click(id) { return this.snapshot(id); },
  pick: async () => ({ selector: 'article', rects: [], count: 1, sampleText: '' }), extract: async () => [item],
  scrape: async () => [item], detect: async () => ({ candidates: [], recommendedId: null, warnings: [] }),
  discover: async () => ({ title: 'test', detection: { candidates: [], recommendedId: null, warnings: [] } }),
  close: async () => {}, dispose: async () => {},
};
const headersFor = (store: Store, username: string) => {
  const session = store.createSession(username, 60_000);
  return { host: '127.0.0.1:4321', cookie: `feedlantern_session=${session.id}`, 'x-feedlantern': '1', 'x-csrf-token': session.csrfToken };
};
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw Error('timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('用户管理、密码和角色：仅管理员建号，改密只撤销目标用户', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-users-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false });
  try {
    const admin = headersFor(store, 'admin');
    const created = await app.inject({ method: 'POST', url: '/api/users', headers: admin, payload: { username: 'alice', password: 'alice-password', role: 'admin' } });
    assert.equal(created.statusCode, 200); assert.equal(created.json().role, 'user');
    assert.ok(!created.body.includes('password'));
    assert.equal((await app.inject({ method: 'POST', url: '/api/users', headers: admin, payload: { username: 'alice', password: 'new-password' } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/api/users', headers: { ...admin, 'x-csrf-token': '' }, payload: { username: 'bob', password: 'bob-password' } })).statusCode, 403);
    const bob = store.createUser('bob', 'bob-password');
    const alice = headersFor(store, 'alice'), bobHeaders = headersFor(store, 'bob');
    const status = (await app.inject({ url: '/api/auth/status', headers: alice })).json();
    assert.equal(status.userId, created.json().id); assert.equal(status.role, 'user');
    for (const [method, url] of [['GET', '/api/users'], ['POST', '/api/users'], ['PATCH', `/api/users/${bob.id}`], ['POST', `/api/users/${bob.id}/password`], ['GET', '/api/settings'], ['PUT', '/api/settings'], ['POST', '/api/settings/bark/test'], ['GET', '/api/backups/config'], ['POST', '/api/backups/config'], ['POST', '/api/backups/export'], ['POST', '/api/backups/preview'], ['POST', '/api/backups/restore']] as const) {
      assert.equal((await app.inject({ method, url, headers: alice, ...(method !== 'GET' ? { payload: {} } : {}) })).statusCode, 403, `${method} ${url}`);
    }
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/users/admin', headers: admin, payload: { enabled: false } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/password', headers: alice, payload: { currentPassword: 'alice-password', newPassword: 'changed-password' } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/feeds', headers: alice })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/feeds', headers: bobHeaders })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/users', headers: admin })).statusCode, 200);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: admin.host, 'x-feedlantern': '1' }, payload: { username: 'alice', password: 'changed-password' } });
    assert.equal(login.statusCode, 200); assert.equal(login.json().role, 'user');
    assert.equal((await app.inject({ method: 'POST', url: `/api/users/${bob.id}/password`, headers: admin, payload: { password: 'reset-password' } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/feeds', headers: bobHeaders })).statusCode, 401);
    assert.ok(store.authenticate('bob', 'reset-password'));
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('订阅、凭据、批量导入和编辑会话的每个入口按用户隔离', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-isolation-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const a = store.createUser('alice', 'alice-password'), b = store.createUser('bob', 'bob-password');
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false });
  try {
    const ah = headersFor(store, 'alice'), bh = headersFor(store, 'bob'), admin = headersFor(store, 'admin');
    const cred = (await app.inject({ method: 'POST', url: '/api/credentials', headers: ah, payload: { name: 'private', url: input.url, format: 'header', value: 'secret=alice', ownerId: b.id } })).json();
    assert.ok(store.owns('credentials', cred.id, a.id));
    const own = (await app.inject({ method: 'POST', url: '/api/feeds', headers: ah, payload: { ...input, credentialId: cred.id, ownerId: b.id } })).json().feed;
    const other = store.createFeed(input, b.id).feed;
    assert.ok(store.owns('feeds', own.id, a.id));
    assert.deepEqual((await app.inject({ url: '/api/feeds', headers: ah })).json().map((f: {id: string}) => f.id), [own.id]);
    assert.deepEqual((await app.inject({ url: '/api/credentials', headers: bh })).json(), []);
    assert.deepEqual((await app.inject({ url: '/api/feeds', headers: admin })).json(), []);
    for (const [method, suffix, payload] of [
      ['GET', '', undefined], ['GET', '/logs', undefined], ['GET', '/translation/progress', undefined],
      ['POST', '/translation/retry', {}], ['PUT', '', input], ['PATCH', '', { channelTitle: 'stolen' }],
      ['POST', '/refresh', {}], ['POST', '/toggle', {}], ['POST', '/rotate-token', {}], ['DELETE', '', {}],
    ] as const) assert.equal((await app.inject({ method, url: `/api/feeds/${own.id}${suffix}`, headers: bh, ...(payload ? { payload } : {}) })).statusCode, 404, `${method} ${suffix}`);
    for (const method of ['PUT', 'DELETE'] as const) assert.equal((await app.inject({ method, url: `/api/credentials/${cred.id}`, headers: bh, payload: {} })).statusCode, 404);
    for (const url of ['/api/feeds', '/api/browser']) assert.equal((await app.inject({ method: 'POST', url, headers: bh, payload: { ...input, credentialId: cred.id } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/import-jobs', headers: bh, payload: { entries: [{ url: input.url, credentialId: cred.id }] } })).statusCode, 404);
    const job = (await app.inject({ method: 'POST', url: '/api/import-jobs', headers: ah, payload: { entries: [{ url: input.url, credentialId: null }] } })).json();
    assert.equal(job.ownerId, a.id); assert.equal(job.entries[0].feedId, own.id);
    assert.deepEqual((await app.inject({ url: '/api/import-jobs', headers: bh })).json(), []);
    for (const action of ['cancel', 'retry', 'confirm']) assert.equal((await app.inject({ method: 'POST', url: `/api/import-jobs/${job.id}/${action}`, headers: bh, payload: {} })).statusCode, 404);
    for (const action of ['copy', 'pause', 'resume', 'refresh', 'settings', 'delete']) {
      const result = (await app.inject({ method: 'POST', url: '/api/feeds/bulk', headers: bh, payload: { ids: [other.id, own.id], action, settings: { intervalMinutes: 30 } } })).json();
      assert.equal(result.results[0].ok, true, action); assert.equal(result.results[1].ok, false, action);
      assert.equal(result.results[1].feedUrl, undefined);
    }
    assert.equal(store.getFeed(own.id)?.name, input.name);
    const frame = (await app.inject({ method: 'POST', url: '/api/browser', headers: ah, payload: { url: input.url, credentialId: cred.id } })).json();
    for (const [method, suffix] of [['GET', ''], ['POST', '/scroll'], ['POST', '/click'], ['POST', '/pick'], ['POST', '/preview'], ['POST', '/detect'], ['DELETE', '']] as const) {
      assert.equal((await app.inject({ method, url: `/api/browser/${frame.sessionId}${suffix}`, headers: bh, ...(method !== 'GET' ? { payload: {} } : {}) })).statusCode, 404);
    }
    assert.equal((await app.inject({ url: `/api/browser/${frame.sessionId}`, headers: ah })).statusCode, 200);
    const config = (await app.inject({ url: '/api/backups/config', headers: admin })).json();
    assert.deepEqual(config.feeds, []);
    const imported = await app.inject({ method: 'POST', url: '/api/backups/config', headers: admin,
      payload: { archive: { format: 'feedlantern-config', version: 1, feeds: [input] }, confirm: true } });
    assert.equal(imported.statusCode, 200); assert.equal(imported.json().created, 1);
    assert.equal(store.listFeeds('admin').length, 1); assert.equal(store.listFeeds(a.id).length, 1);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('停用撤销会话、关闭编辑器、拒绝缓存 RSS，快速重新启用仍丢弃旧抓取结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-disable-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password'); const user = store.createUser('alice', 'alice-password');
  const { feed, token } = store.createFeed(input, user.id); store.upsertItems(feed, [item]);
  const paused = store.createFeed(input, user.id).feed; store.toggleFeed(paused.id);
  let entered = false, release!: () => void, closed = false, signal: AbortSignal | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const app = await createApp({ store, dataDir: dir, startScheduler: false, browserService: { ...browser,
    close: async () => { closed = true; }, scrape: async options => { signal = options.signal; entered = true; await gate; return [{ ...item, title: 'Stale result' }]; },
  } });
  try {
    const ah = headersFor(store, 'alice'), admin = headersFor(store, 'admin');
    await app.inject({ method: 'POST', url: '/api/browser', headers: ah, payload: { url: input.url } });
    const rssUrl = `/feeds/${feed.id}/${token}.xml`, rss = await app.inject({ url: rssUrl });
    const refresh = app.inject({ method: 'POST', url: `/api/feeds/${feed.id}/refresh`, headers: ah, payload: {} });
    await until(() => entered);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/users/${user.id}`, headers: admin, payload: { enabled: false } })).statusCode, 200);
    assert.ok(signal?.aborted); assert.ok(closed); assert.equal(store.dueFeeds(new Date(Date.now() + 86400_000)).length, 0);
    assert.equal((await app.inject({ url: rssUrl, headers: { 'if-none-match': String(rss.headers.etag) } })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/feeds', headers: ah })).statusCode, 401);
    assert.ok(!store.authenticate('alice', 'alice-password'));
    await app.inject({ method: 'PATCH', url: `/api/users/${user.id}`, headers: admin, payload: { enabled: true } });
    assert.ok(store.dueFeeds().some(f => f.id === feed.id));
    release(); await refresh;
    assert.equal(store.getItems(feed.id)[0].title, 'Original');
    assert.equal(store.history.list(feed.id).logs[0].status, 'interrupted');
    assert.equal(store.getFeed(paused.id)?.enabled, false);
    assert.equal((await app.inject({ url: rssUrl })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/feeds', headers: ah })).statusCode, 401);
    assert.ok(store.authenticate('alice', 'alice-password'));
  } finally { release(); await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('批量导入去重按用户，停用期间不保存发现结果，重新启用后继续', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-job-owners-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password'); const a = store.createUser('alice', 'alice-password'), b = store.createUser('bob', 'bob-password');
  store.createFeed(input, a.id);
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const jobs = new ImportJobs(store, async fn => fn(), async () => { entered = true; await gate; return { title: 'discovered', detection: { candidates: [], recommendedId: null, warnings: [] } }; }, async () => [item]);
  try {
    const entries = [{ url: input.url, credentialId: null, intervalMinutes: 60 }];
    assert.equal(jobs.create(entries, a.id).entries[0].state, 'existing');
    const job = jobs.create(entries, b.id); await until(() => entered);
    assert.equal(jobs.get(job.id).entries[0].feedId, undefined);
    store.setUserEnabled(b.id, false); release();
    await until(() => jobs.get(job.id).entries[0].state === 'queued');
    assert.equal(jobs.get(job.id).entries[0].detection, undefined);
    store.setUserEnabled(b.id, true); jobs.wake();
    await until(() => jobs.get(job.id).entries[0].state === 'review');
    const feed = await jobs.confirm(job.id, job.entries[0].id, input);
    assert.equal(feed?.ownerId, b.id); assert.equal(store.listFeeds(b.id).length, 1);
  } finally { release(); jobs.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('翻译任务在停用时取消，重新启用后完成，通知队列同时遵守用户状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-translation-owner-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password'); const user = store.createUser('alice', 'alice-password');
  const feed = store.createFeed({ ...input, sourceType: 'rss', translationMode: 'chinese' }, user.id).feed;
  store.translations.upsert(feed, [{ key: 'one', title: 'Article', link: item.link, html: '<p>Content</p>' }]);
  let started = false, canceled = false;
  const worker = new TranslationWorker(store.translations, async (text, signal) => {
    started = true;
    if (!canceled) await new Promise<void>((resolve, reject) => { signal.addEventListener('abort', () => { canceled = true; reject(signal.reason); }, { once: true }); });
    return `译文${text}`;
  }, 0);
  try {
    worker.start(); await until(() => started);
    store.setUserEnabled(user.id, false); await until(() => canceled && worker.status().activeArticles === 0);
    assert.equal(store.translations.stats(feed.id).success, 0); assert.equal(store.translations.next(), undefined);
    const settings = store.getSettings(); settings.bark.enabled = true; settings.bark.url = 'https://example.test/test-key'; settings.bark.failureThreshold = 1; store.setSettings(settings);
    const run = store.history.start(feed.id, 'manual'); store.history.fail(run, feed, 'manual', 1, 'error', true);
    assert.equal(store.history.nextAlert(), null);
    store.setUserEnabled(user.id, true); assert.ok(store.history.nextAlert()); worker.wake();
    await until(() => store.translations.stats(feed.id).success === 1);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('多用户备份保留归属、状态和 RSS 密钥，旧备份及 v6 数据库迁移归原管理员', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-user-migrate-'));
  let store = new Store(dir);
  try {
    store.createAdmin('original-admin', 'admin-password'); const user = store.createUser('alice', 'alice-password');
    const credential = store.createCredential({ name: 'private', url: input.url, format: 'header', value: 'secret=alice' }, { domains: ['example.test'], count: 1, expiresAt: null }, user.id);
    const { feed, token } = store.createFeed({ ...input, credentialId: credential.id }, user.id);
    const original = store.createFeed(input); store.upsertItems(original.feed, [item]);
    store.setUserEnabled(user.id, false);
    const snapshot = snapshotSchema.parse({ format: 'feedlantern-backup', version: 2, appVersion: 'test', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables: store.exportTables() });
    const session = store.createSession('original-admin', 60_000);
    store.restoreTables(openBackup(sealBackup(snapshot, 'backup-password-long'), 'backup-password-long').tables);
    assert.equal(store.findSession(session.id, 60_000), null);
    assert.equal(store.getFeed(feed.id)?.ownerId, user.id); assert.equal(store.getFeedToken(feed.id)?.token, token);
    assert.equal(store.isUserActive(user.id), false);
    assert.ok(store.owns('credentials', credential.id, user.id));
    assert.equal(store.getCredentialValue(credential.id)?.value, 'secret=alice');
    const bad = structuredClone(snapshot); bad.tables.feeds[0].owner_id = 'unknown'; assert.throws(() => snapshotSchema.parse(bad));
    const wrongOwner = structuredClone(snapshot); wrongOwner.tables.credentials[0].owner_id = 'admin';
    assert.throws(() => snapshotSchema.parse(wrongOwner));
    const legacy = JSON.parse(JSON.stringify(snapshot)); legacy.version = 1;
    const admin = legacy.tables.users.find((u: {role: string}) => u.role === 'admin');
    legacy.tables.admin = [{ id: 1, username: admin.username, password_hash: admin.password_hash, created_at: admin.created_at, updated_at: admin.updated_at }]; delete legacy.tables.users;
    for (const row of legacy.tables.feeds) delete row.owner_id;
    for (const row of legacy.tables.credentials) delete row.owner_id;
    store.restoreTables(snapshotSchema.parse(legacy).tables);
    assert.ok(store.authenticate('original-admin', 'admin-password')); assert.equal(store.getFeed(feed.id)?.ownerId, 'admin');
    const oldSession = store.createSession('original-admin', 60_000);
    store.close();
    const db = new DatabaseSync(join(dir, 'app.db'));
    db.exec(`CREATE TABLE admin (id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO admin SELECT 1,username,password_hash,created_at,updated_at FROM users WHERE role='admin';
      DROP INDEX sessions_user; ALTER TABLE sessions DROP COLUMN user_id; DROP TABLE users;
      DROP INDEX feeds_owner; DROP INDEX credentials_owner; DROP INDEX import_jobs_owner;
      ALTER TABLE feeds DROP COLUMN owner_id; ALTER TABLE credentials DROP COLUMN owner_id; ALTER TABLE import_jobs DROP COLUMN owner_id;
      PRAGMA user_version=6;`); db.close();
    store = new Store(dir);
    assert.ok(store.authenticate('original-admin', 'admin-password')); assert.equal(store.findSession(oldSession.id, 60_000), null);
    assert.equal(store.getFeed(feed.id)?.ownerId, 'admin'); assert.equal(store.getFeedToken(feed.id)?.token, token);
    assert.equal(store.getItems(original.feed.id)[0].title, item.title);
    store.close(); store = new Store(dir); assert.equal(store.listUsers().length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
