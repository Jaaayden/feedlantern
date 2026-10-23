import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { snapshotSchema } from '../src/server/backups.js';
import type { FetchNetworkOptions } from '../src/server/fetch-options.js';

const PROXY = '93.184.215.14';
const base = { host: '127.0.0.1:4321', 'x-feedlantern': '1' };

function recordingBrowser(calls: Array<[string, FetchNetworkOptions | undefined]>): BrowserServiceLike {
  const frame = (url: string) => ({ sessionId: 'browser_test', image: '', width: 1, height: 1, viewportHeight: 1, documentHeight: 1, url, title: 'test' });
  return {
    async open(options) { calls.push(['open', options.network]); return frame(options.url); },
    async discover(options) { calls.push(['discover', options.network]); return { title: 'found', detection: { candidates: [], recommendedId: null, warnings: [] } }; },
    async snapshot() { return frame('https://example.test'); }, async scroll() { return frame('https://example.test'); }, async click() { return frame('https://example.test'); },
    async pick() { return { selector: '.item', rects: [], count: 0, sampleText: '' }; },
    async extract() { return []; },
    async scrape(options) { calls.push(['scrape', options.network]); return [{ title: 'one', link: `${options.url}one` }]; },
    async close() {}, async dispose() {},
  };
}

async function signIn(app: Awaited<ReturnType<typeof createApp>>, dir: string) {
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: base, payload: { setupToken: readFileSync(join(dir, 'setup-token'), 'utf8').trim(), username: 'admin', password: 'admin-password' } });
  assert.equal(setup.statusCode, 200);
  return { ...base, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-csrf-token': setup.json().csrfToken as string };
}

test('网络配置 API：加密保存、不回显，编辑器预览、批量识别和后台刷新使用同一份设置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-network-'));
  const calls: Array<[string, FetchNetworkOptions | undefined]> = [];
  const rssCalls: Array<FetchNetworkOptions | undefined> = [];
  const store = new Store(dir);
  const app = await createApp({ dataDir: dir, store, browserService: recordingBrowser(calls), startScheduler: false,
    rssFetcher: async (_url, options) => { rssCalls.push(options?.network); return { title: 'RSS', items: [] }; } });
  try {
    const admin = await signIn(app, dir);
    const blocked = await app.inject({ method: 'POST', url: '/api/network-profiles', headers: admin, payload: { name: 'lan', proxyUrl: 'http://10.0.0.8:3128' } });
    assert.equal(blocked.statusCode, 400);
    assert.match(blocked.json().error, /安全策略阻止/);
    const cookieHeader = await app.inject({ method: 'POST', url: '/api/network-profiles', headers: admin, payload: { name: 'x', headers: [{ name: 'Cookie', value: 'a=1' }] } });
    assert.equal(cookieHeader.statusCode, 400);

    const created = await app.inject({ method: 'POST', url: '/api/network-profiles', headers: admin, payload: {
      name: 'JP exit', proxyUrl: `socks5://${PROXY}:1080`, proxyUsername: 'proxy-user', proxyPassword: 'proxy-pass-123',
      userAgent: 'TestUA/1.0', referer: 'https://ref.example/', headers: [{ name: 'X-Api-Key', value: 'header-secret-456' }],
    } });
    assert.equal(created.statusCode, 200);
    const summary = created.json();
    assert.deepEqual(summary.proxy, { type: 'socks5', host: PROXY, port: 1080, url: `socks5://${PROXY}:1080`, authenticated: true });
    assert.deepEqual(summary.headerNames, ['X-Api-Key']);
    const listed = await app.inject({ url: '/api/network-profiles', headers: admin });
    for (const body of [created.body, listed.body]) assert.doesNotMatch(body, /proxy-user|proxy-pass-123|header-secret-456/);
    // Secrets are encrypted at rest, in the database and its WAL.
    for (const file of readdirSync(dir).filter(name => name.startsWith('app.db'))) {
      assert.doesNotMatch(readFileSync(join(dir, file)).toString('latin1'), /proxy-pass-123|header-secret-456|proxy-user/);
    }
    const id = summary.id as string;
    const expected: FetchNetworkOptions = { proxy: { type: 'socks5', host: PROXY, port: 1080, username: 'proxy-user', password: 'proxy-pass-123' }, userAgent: 'TestUA/1.0', referer: 'https://ref.example/', headers: [{ name: 'X-Api-Key', value: 'header-secret-456' }] };

    assert.equal((await app.inject({ method: 'POST', url: '/api/browser', headers: admin, payload: { url: 'https://site.example/list', networkProfileId: id, waitMs: 0 } })).statusCode, 200);
    const feed = await app.inject({ method: 'POST', url: '/api/feeds', headers: admin, payload: { name: 'site', url: 'https://site.example/list', networkProfileId: id, rules: { item: 'li', title: 'a', link: 'a' } } });
    assert.equal(feed.statusCode, 200);
    assert.equal(feed.json().feed.networkProfileId, id);
    const feedId = feed.json().feed.id as string;
    assert.equal((await app.inject({ method: 'POST', url: `/api/feeds/${feedId}/refresh`, headers: admin, payload: {} })).statusCode, 200);
    const job = await app.inject({ method: 'POST', url: '/api/import-jobs', headers: admin, payload: { entries: [{ url: 'https://other.example/news', networkProfileId: id }] } });
    assert.equal(job.statusCode, 200);
    for (let i = 0; i < 100 && !calls.some(([kind]) => kind === 'discover'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const rss = await app.inject({ method: 'POST', url: '/api/feeds', headers: admin, payload: { sourceType: 'rss', name: 'rss', url: 'https://rss.example/feed.xml', networkProfileId: id } });
    assert.equal(rss.statusCode, 200);
    for (let i = 0; i < 100 && !rssCalls.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await app.inject({ method: 'POST', url: '/api/rss/preview', headers: admin, payload: { url: 'https://rss.example/feed.xml', networkProfileId: id } })).statusCode, 200);

    const kinds = calls.map(([kind]) => kind);
    for (const kind of ['open', 'scrape', 'discover']) assert.ok(kinds.includes(kind), `${kind} called`);
    for (const [kind, network] of calls) assert.deepEqual(network, expected, kind);
    assert.equal(rssCalls.length, 2);
    for (const network of rssCalls) assert.deepEqual(network, expected);

    // Editing without secrets keeps them; the feed's next refresh uses the update.
    const updated = await app.inject({ method: 'PUT', url: `/api/network-profiles/${id}`, headers: admin, payload: { name: 'JP exit', proxyUrl: `socks5://${PROXY}:1080`, userAgent: 'TestUA/2.0', headers: [{ name: 'X-Api-Key' }] } });
    assert.equal(updated.statusCode, 200);
    calls.length = 0;
    await app.inject({ method: 'POST', url: `/api/feeds/${feedId}/refresh`, headers: admin, payload: {} });
    assert.deepEqual(calls[0][1], { proxy: expected.proxy, userAgent: 'TestUA/2.0', headers: expected.headers });
    const moved = await app.inject({ method: 'PUT', url: `/api/network-profiles/${id}`, headers: admin, payload: { name: 'JP exit', proxyUrl: 'socks5://93.184.215.15:1080' } });
    assert.equal(moved.statusCode, 400);

    // In use: cannot delete; unbinding in feed settings allows it.
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/network-profiles/${id}`, headers: admin })).statusCode, 409);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/feeds/${feedId}`, headers: admin, payload: { networkProfileId: null } })).json().feed.networkProfileId, null);
    calls.length = 0;
    await app.inject({ method: 'POST', url: `/api/feeds/${feedId}/refresh`, headers: admin, payload: {} });
    assert.equal(calls[0][1], undefined);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/feeds/${feedId}`, headers: admin, payload: { networkProfileId: id } })).json().feed.networkProfileId, id);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('网络配置按用户隔离：其他用户不能查看、引用或测试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-network-owner-'));
  const store = new Store(dir);
  const app = await createApp({ dataDir: dir, store, browserService: recordingBrowser([]), startScheduler: false });
  try {
    const admin = await signIn(app, dir);
    const profile = (await app.inject({ method: 'POST', url: '/api/network-profiles', headers: admin, payload: { name: 'mine', userAgent: 'Mine/1' } })).json();
    store.createUser('bob', 'bob-password');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: base, payload: { username: 'bob', password: 'bob-password' } });
    const bob = { ...base, cookie: `${login.cookies[0].name}=${login.cookies[0].value}`, 'x-csrf-token': login.json().csrfToken };
    assert.deepEqual((await app.inject({ url: '/api/network-profiles', headers: bob })).json(), []);
    for (const [method, url, payload] of [
      ['PUT', `/api/network-profiles/${profile.id}`, { name: 'stolen', userAgent: 'x' }],
      ['DELETE', `/api/network-profiles/${profile.id}`, undefined],
      ['POST', `/api/network-profiles/${profile.id}/test`, { url: 'https://example.test/' }],
      ['POST', '/api/browser', { url: 'https://example.test/', networkProfileId: profile.id }],
      ['POST', '/api/feeds', { name: 'x', url: 'https://example.test/', networkProfileId: profile.id, rules: { item: 'a', title: 'a', link: 'a' } }],
      ['POST', '/api/import-jobs', { entries: [{ url: 'https://example.test/', networkProfileId: profile.id }] }],
      ['POST', '/api/rss/preview', { url: 'https://example.test/feed', networkProfileId: profile.id }],
    ] as const) {
      const response = await app.inject({ method, url, headers: bob, ...(payload ? { payload } : {}) });
      assert.equal(response.statusCode, 404, `${method} ${url}`);
    }
    assert.throws(() => store.createFeed({ name: 'x', url: 'https://example.test/', credentialId: null, networkProfileId: profile.id, intervalMinutes: 60, waitMs: 0, rules: { item: 'a', title: 'a', link: 'a' } }, store.listUsers().find(u => u.username === 'bob')!.id), /网络配置不存在/);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('完整备份跨密钥恢复网络配置与绑定；轻量配置只导出不含密钥的部分', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-network-backup-'));
  const source = new Store(join(dir, 'source'));
  const target = new Store(join(dir, 'target'));
  try {
    source.createAdmin('admin', 'admin-password');
    const secret = source.createNetworkProfile({ name: 'secret', proxy: { type: 'http', host: PROXY, port: 3128, username: 'u', password: 'p' }, headers: [{ name: 'X-Key', value: 'v' }] }, 'admin');
    const plain = source.createNetworkProfile({ name: 'plain', proxy: null, userAgent: 'UA/1', headers: [] }, 'admin');
    const { feed } = source.createFeed({ name: 'f', url: 'https://example.test/', credentialId: null, networkProfileId: secret.id, intervalMinutes: 60, waitMs: 0, rules: { item: 'a', title: 'a', link: 'a' } });
    const snapshot = snapshotSchema.parse({ format: 'feedlantern-backup', version: 3, appVersion: 'test', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables: source.exportTables() });
    target.restoreTables(snapshot.tables);
    assert.deepEqual(target.getNetworkProfile(secret.id), source.getNetworkProfile(secret.id));
    assert.equal(target.getFeed(feed.id)?.networkProfileId, secret.id);
    assert.equal(target.listNetworkProfiles('admin').length, 2);
    // Older backups without the table restore with no profiles.
    const legacy = structuredClone(snapshot) as unknown as { tables: Record<string, unknown[]> };
    delete legacy.tables.network_profiles;
    for (const row of legacy.tables.feeds as Array<Record<string, unknown>>) delete row.network_profile_id;
    assert.equal(snapshotSchema.parse(legacy).tables.network_profiles.length, 0);
    // A forged backup cannot bind a profile with forbidden headers or another owner's profile.
    const forged = structuredClone(snapshot);
    forged.tables.network_profiles[0].encrypted_value = JSON.stringify({ proxy: null, headers: [{ name: 'Host', value: 'evil' }] });
    assert.equal(snapshotSchema.safeParse(forged).success, false);
    assert.ok(plain.id);
  } finally { source.close(); target.close(); rmSync(dir, { recursive: true, force: true }); }

  const appDir = mkdtempSync(join(tmpdir(), 'fl-network-config-'));
  const store = new Store(appDir);
  const app = await createApp({ dataDir: appDir, store, browserService: recordingBrowser([]), startScheduler: false });
  try {
    const admin = await signIn(app, appDir);
    const secret = store.createNetworkProfile({ name: 'secret', proxy: { type: 'http', host: PROXY, port: 3128, username: 'u', password: 'p' }, headers: [] }, 'admin');
    const plain = store.createNetworkProfile({ name: 'plain', proxy: { type: 'socks5', host: PROXY, port: 1080 }, userAgent: 'UA/1', headers: [] }, 'admin');
    for (const [name, networkProfileId] of [['a', secret.id], ['b', plain.id]]) store.createFeed({ name, url: `https://example.test/${name}`, credentialId: null, networkProfileId, intervalMinutes: 60, waitMs: 0, rules: { item: 'a', title: 'a', link: 'a' } });
    const exported = await app.inject({ url: '/api/backups/config', headers: admin });
    assert.doesNotMatch(exported.body, /"u"|"p"|password/i);
    const feeds = exported.json().feeds as Array<Record<string, unknown>>;
    assert.equal(feeds.find(f => f.name === 'a')?.requiresNetworkProfile, true);
    assert.deepEqual(feeds.find(f => f.name === 'b')?.networkProfile, { name: 'plain', proxyUrl: `socks5://${PROXY}:1080`, userAgent: 'UA/1', referer: null });
    for (const feed of store.listFeeds('admin')) store.deleteFeed(feed.id);
    store.deleteNetworkProfile(secret.id); store.deleteNetworkProfile(plain.id);
    const archive = { ...exported.json(), settings: undefined, version: 1 };
    const preview = await app.inject({ method: 'POST', url: '/api/backups/config', headers: admin, payload: { archive } });
    assert.equal(preview.json().entries.find((e: { name: string }) => e.name === 'a').needsNetwork, true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/backups/config', headers: admin, payload: { archive, confirm: true } })).statusCode, 200);
    const imported = store.listFeeds('admin');
    const a = imported.find(f => f.name === 'a')!, b = imported.find(f => f.name === 'b')!;
    assert.equal(a.enabled, false);
    assert.equal(a.lastError, '请绑定网络配置后恢复订阅');
    assert.equal(a.networkProfileId, null);
    const recreated = store.getNetworkProfile(b.networkProfileId!);
    assert.deepEqual({ name: recreated?.name, proxy: recreated?.proxy, userAgent: recreated?.userAgent }, { name: 'plain', proxy: { type: 'socks5', host: PROXY, port: 1080 }, userAgent: 'UA/1' });
  } finally { await app.close(); store.close(); rmSync(appDir, { recursive: true, force: true }); }
});

test('迁移 17 可重复执行：版本号较低时补齐，较高时不降级', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-network-migrate-'));
  try {
    new Store(dir).close();
    const version = () => { const db = new DatabaseSync(join(dir, 'app.db')); try { return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version); } finally { db.close(); } };
    const setVersion = (value: number) => { const db = new DatabaseSync(join(dir, 'app.db')); db.exec(`PRAGMA user_version=${value}`); db.close(); };
    assert.ok(version() >= 17);
    setVersion(8);
    let store = new Store(dir);
    assert.deepEqual(store.listNetworkProfiles(), []);
    store.close();
    assert.ok(version() >= 17);
    setVersion(18);
    store = new Store(dir);
    store.createNetworkProfile({ name: 'n', proxy: null, userAgent: 'x', headers: [] });
    store.close();
    assert.equal(version(), 18);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
