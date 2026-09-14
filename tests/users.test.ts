import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createCipheriv } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
    const settings = store.getSettings(); settings.bark.enabled = true; settings.bark.url = 'https://example.test/test-key'; settings.bark.failureThreshold = 1; store.setBark(user.id, settings.bark);
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
      DROP INDEX sessions_user; ALTER TABLE sessions DROP COLUMN user_id; DROP TABLE users; DROP TABLE user_notifications;
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

test('管理员跨用户工作台、凭据绑定、角色撤销、改名及删除保护', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-full-users-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password'); const a = store.createUser('alice', 'alice-password'), b = store.createUser('bob', 'bob-password');
  const original = store.createFeed(input, a.id), other = store.createFeed(input, b.id);
  const cred = store.createCredential({ name: 'cookie', url: input.url, format: 'header', value: 'secret=bob' }, { domains: ['example.test'], count: 1, expiresAt: null }, b.id);
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false });
  try {
    const admin = headersFor(store, 'admin'), alice = headersFor(store, 'alice'), scoped = { ...admin, 'x-feedlantern-user': a.id };
    assert.equal((await app.inject({ url: '/api/feeds', headers: { ...alice, 'x-feedlantern-user': b.id } })).statusCode, 403);
    assert.deepEqual((await app.inject({ url: '/api/feeds', headers: scoped })).json().map((f: { id: string }) => f.id), [original.feed.id]);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/feeds/${original.feed.id}`, headers: scoped, payload: { ...input, credentialId: cred.id } })).statusCode, 404);
    assert.equal((await app.inject({ url: `/api/feeds/${other.feed.id}`, headers: scoped })).statusCode, 404);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/users/${a.id}`, headers: admin, payload: { username: 'renamed', role: 'admin' } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/feeds', headers: alice })).statusCode, 401);
    assert.equal(store.getFeedToken(original.feed.id)?.token, original.token);
    const second = headersFor(store, 'renamed');
    assert.equal((await app.inject({ method: 'POST', url: '/api/backups/export', headers: second, payload: { currentPassword: 'alice-password', password: 'long-backup-password' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/users/${a.id}`, headers: second, payload: { username: 'renamed' } })).statusCode, 403);
    const changes = await Promise.all([
      app.inject({ method: 'PATCH', url: '/api/users/admin', headers: admin, payload: { role: 'user' } }),
      app.inject({ method: 'PATCH', url: `/api/users/${a.id}`, headers: second, payload: { role: 'user' } }),
    ]);
    assert.deepEqual(changes.map(r => r.statusCode).sort(), [200, 409]);
    assert.equal(store.listUsers().filter(u => u.role === 'admin' && u.enabled).length, 1);
    assert.equal((await app.inject({ url: '/api/users', headers: admin })).statusCode, 401);
    const manageBob = { ...second, 'x-feedlantern-user': b.id };
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/users/${b.id}`, headers: second, payload: { enabled: false } })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/feeds/${other.feed.id}`, headers: manageBob })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/feeds/${other.feed.id}`, headers: manageBob, payload: { ...input, name: 'static edit' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/feeds/${other.feed.id}/refresh`, headers: manageBob, payload: {} })).statusCode, 409);
    const preview = (await app.inject({ url: `/api/users/${b.id}/deletion-preview`, headers: second })).json();
    assert.equal(preview.feeds, 1); assert.equal(preview.credentials, 1);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/users/${b.id}`, headers: second, payload: { username: 'wrong' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/users/${b.id}`, headers: second, payload: { username: 'bob' } })).statusCode, 200);
    assert.equal(store.getUser(b.id), undefined); assert.equal(store.getFeed(other.feed.id), null);
    assert.equal(store.getCredentialValue(cred.id), null);
    assert.equal((await app.inject({ url: `/feeds/${other.feed.id}/${other.token}.xml` })).statusCode, 404);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('个人 Bark 加密脱敏、保留和清空、故障按所有者发送且没有管理员回退', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-personal-bark-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password'); const a = store.createUser('alice', 'alice-password'), b = store.createUser('bob', 'bob-password');
  const sent: string[] = [];
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false, barkSender: async url => { sent.push(url); } });
  try {
    const ah = headersFor(store, 'alice'), bh = headersFor(store, 'bob');
    const save = (headers: typeof ah, payload: object) => app.inject({ method: 'PUT', url: '/api/notifications/bark', headers, payload });
    store.setBark('admin', { url: 'https://example.test/admin-key', enabled: true, failureThreshold: 1 });
    const first = await save(ah, { url: 'https://example.test/alice-key', enabled: true, failureThreshold: 1 });
    assert.equal(first.statusCode, 200); assert.ok(first.json().configured); assert.ok(!first.body.includes('alice-key'));
    await save(ah, { timeoutSeconds: 3 }); assert.equal(store.getBark(a.id).url, 'https://example.test/alice-key');
    assert.equal((await app.inject({ url: '/api/notifications/bark', headers: bh })).json().configured, false);
    assert.equal((await app.inject({ method: 'POST', url: '/api/notifications/bark/test', headers: ah, payload: {} })).statusCode, 200);
    assert.deepEqual(sent, ['https://example.test/alice-key']); sent.length = 0;
    const af = store.createFeed(input, a.id).feed, bf = store.createFeed(input, b.id).feed;
    const fail = (feed: typeof af) => store.history.fail(store.history.start(feed.id, 'manual'), feed, 'manual', 1, 'failed', true);
    fail(bf); assert.equal(store.history.nextAlert(), null);
    await save(bh, { url: 'https://example.test/bob-key', enabled: true, failureThreshold: 1 });
    fail(af); fail(bf);
    await save(ah, { enabled: false });
    await until(() => sent.length === 1); assert.deepEqual(sent, ['https://example.test/bob-key']);
    await save(ah, { url: '' }); assert.equal(store.getBark(a.id).url, '');
    const { readFileSync } = await import('node:fs');
    assert.ok(!readFileSync(`${store.dbPath}-wal`).includes(Buffer.from('bob-key')));
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('删除运行中任务的用户、管理员降级时关闭编辑器并丢弃旧结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-delete-running-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password'); const actor = store.createUser('manager', 'manager-password'), owner = store.createUser('reader', 'reader-password');
  store.updateUser('admin', actor.id, { role: 'admin' });
  const { feed } = store.createFeed(input, owner.id); store.upsertItems(feed, [item]);
  let release!: () => void, entered = false, aborted: AbortSignal | undefined, closed = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const app = await createApp({ store, dataDir: dir, startScheduler: false, browserService: { ...browser,
    scrape: async options => { entered = true; aborted = options.signal; await gate; return [{ ...item, title: 'must not publish' }]; }, close: async () => { closed++; },
  } });
  let jobs: ImportJobs | undefined;
  try {
    const admin = headersFor(store, 'admin'), scoped = { ...headersFor(store, 'manager'), 'x-feedlantern-user': owner.id };
    await app.inject({ method: 'POST', url: '/api/browser', headers: scoped, payload: { url: input.url } });
    const refresh = app.inject({ method: 'POST', url: `/api/feeds/${feed.id}/refresh`, headers: scoped, payload: {} });
    await until(() => entered);
    await app.inject({ method: 'PATCH', url: `/api/users/${actor.id}`, headers: admin, payload: { role: 'user' } });
    assert.ok(aborted?.aborted); assert.equal(closed, 1); release(); await refresh;
    assert.equal(store.getItems(feed.id)[0].title, item.title);
    entered = false;
    const gate2 = new Promise<void>(resolve => { release = resolve; });
    jobs = new ImportJobs(store, async fn => fn(), async () => { entered = true; await gate2; return { title: 'stale', detection: { candidates: [], recommendedId: null, warnings: [] } }; }, async () => [item]);
    const task = jobs.create([{ url: 'https://example.test/new', credentialId: null, intervalMinutes: 60 }], owner.id);
    await until(() => entered);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/users/${owner.id}`, headers: admin, payload: { username: 'reader' } })).statusCode, 200);
    release(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(store.listImportJobs().some(j => j.id === task.id), false); assert.equal(store.listFeeds(owner.id).length, 0);
    assert.equal(store.history.list(feed.id).logs.length, 0);
  } finally { release?.(); jobs?.stop(); await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('v7 Bark 迁移到原管理员，v3 多管理员备份不生成幽灵账号设置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-v8-')), store = new Store(dir);
  try {
    store.createAdmin('original', 'original-password'); const manager = store.createUser('manager', 'manager-password');
    store.updateUser('admin', manager.id, { role: 'admin' });
    store.setBark(manager.id, { enabled: true, url: 'https://example.test/manager-key' });
    store.deleteUser(manager.id, 'admin', 'original');
    const snapshot = snapshotSchema.parse({ format: 'feedlantern-backup', version: 3, appVersion: 'test', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables: store.exportTables() });
    store.restoreTables(snapshot.tables);
    assert.equal(store.getBark(manager.id).url, 'https://example.test/manager-key');
    assert.equal(store.exportTables().user_notifications.some(n => n.user_id === 'admin'), false);
    assert.doesNotThrow(() => snapshotSchema.parse({ ...snapshot, tables: store.exportTables() }));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  const legacyDir = join(dir, 'legacy'); let legacy = new Store(legacyDir);
  try {
    legacy.createAdmin('original', 'original-password'); const { feed, token } = legacy.createFeed(input);
    const settings = legacy.getSettings(); settings.bark = { ...settings.bark, enabled: true, url: 'https://example.test/legacy-key' };
    const encrypt = (key: Buffer, value: string) => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value), cipher.final()]); return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.'); };
    legacy.close();
    const db = new DatabaseSync(join(legacyDir, 'app.db'));
    db.exec("DROP TABLE user_notifications; CREATE UNIQUE INDEX users_single_admin ON users(role) WHERE role='admin'; PRAGMA user_version=7;");
    db.prepare("INSERT INTO settings(key,value) VALUES ('application',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(encrypt(readFileSync(join(legacyDir, 'master.key')), JSON.stringify(settings)));
    db.close(); legacy = new Store(legacyDir);
    assert.equal(legacy.getBark('admin').url, settings.bark.url); assert.equal(legacy.getFeedToken(feed.id)?.token, token);
  } finally { legacy.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('代管翻译和导入记录操作人，降级取消队列，所有者可重新重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-actor-queues-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password'); const actor = store.createUser('manager', 'manager-password'), owner = store.createUser('reader', 'reader-password');
  store.updateUser('admin', actor.id, { role: 'admin' });
  const feed = store.createFeed({ ...input, sourceType: 'rss', translationMode: 'chinese' }, owner.id).feed;
  store.translations.upsert(feed, [{ key: 'one', title: 'Article', link: item.link, html: '<p>Content</p>' }]);
  store.translations.retry(feed.id, actor.id);
  const translation = store.translations.next()!;
  const signal = store.translations.signal(translation);
  const jobs = new ImportJobs(store, async fn => fn(), async () => ({ title: 'review', detection: { candidates: [], recommendedId: null, warnings: [] } }), async () => [item]);
  jobs.stop();
  try {
    const job = jobs.create([{ url: input.url, credentialId: null, intervalMinutes: 60 }], owner.id, actor.id);
    store.setUserEnabled(actor.id, false);
    assert.equal(store.translations.next(), undefined); assert.ok(signal.aborted);
    store.setUserEnabled(actor.id, true); assert.ok(store.translations.next());
    store.updateUser('admin', actor.id, { role: 'user' });
    assert.ok(signal.aborted); assert.equal(store.translations.next(), undefined); assert.equal(store.translations.valid(translation), false);
    assert.equal(jobs.get(job.id).entries[0].state, 'canceled');
    jobs.update(job.id, 'retry', undefined, owner.id); assert.equal(jobs.get(job.id).actorId, owner.id);
    store.translations.retry(feed.id, owner.id); assert.ok(store.translations.next());
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
