import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';

const fakeBrowser: BrowserServiceLike = {
  async open(options) { return { sessionId: 'browser_test', image: '', width: 1, height: 1, url: options.url, title: 'test' }; },
  async snapshot(_id = 'browser_test') { return { sessionId: 'browser_test', image: '', width: 1, height: 1, url: 'https://example.test', title: 'test' }; },
  async scroll(_id = 'browser_test') { return this.snapshot(_id); }, async click(_id = 'browser_test') { return this.snapshot(_id); },
  async pick() { return { selector: '.item', rects: [], count: 0, sampleText: '' }; },
  async extract() { return []; }, async detect() { return { candidates: [], recommendedId: null, warnings: [] }; },
  async scrape() { return [{ title: 'one', link: 'https://example.test/one' }]; },
  async close() {}, async dispose() {},
};

test('API setup/login/CSRF 与 RSS token 流程', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-api-'));
  const app = await createApp({ dataDir, publicOrigin: 'http://127.0.0.1:4321', browserService: fakeBrowser, startScheduler: false });
  try {
    const host = '127.0.0.1:4321';
    const status = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { host } });
    assert.equal(status.statusCode, 200);
    assert.equal(status.headers['cache-control'], 'no-store');
    assert.equal(status.headers['referrer-policy'], 'no-referrer');
    assert.equal(status.headers['x-content-type-options'], 'nosniff');
    const wrongHost = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: 'evil.example:4321' } });
    assert.equal(wrongHost.statusCode, 403);
    assert.deepEqual(wrongHost.json(), { error: '请求主机不被允许' });
    const setupToken = readFileSync(join(dataDir, 'setup-token'), 'utf8').trim();
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken, username: 'admin', password: 'password123' } });
    assert.equal(setup.statusCode, 200);
    const session = setup.cookies[0];
    const cookie = `${session.name}=${session.value}`;
    const csrf = setup.json().csrfToken as string;
    const statusAgain = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { host, cookie } });
    assert.equal(statusAgain.statusCode, 200);
    assert.equal(statusAgain.json().csrfToken, csrf);
    const credential = await app.inject({ method: 'POST', url: '/api/credentials', headers: { host, cookie, 'x-feedlantern': '1', 'x-csrf-token': csrf }, payload: { name: 'bound', url: 'https://allowed.example/private', format: 'header', value: 'secret=1' } });
    assert.equal(credential.statusCode, 200);
    const crossDomain = await app.inject({ method: 'POST', url: '/api/browser', headers: { host, cookie, 'x-feedlantern': '1', 'x-csrf-token': csrf }, payload: { url: 'https://evil.example/page', credentialId: credential.json().id, waitMs: 0 } });
    assert.equal(crossDomain.statusCode, 400);
    const denied = await app.inject({ method: 'POST', url: '/api/feeds', headers: { host, cookie, 'x-feedlantern': '1' }, payload: { name: 'x', url: 'https://example.test', rules: { item: 'x', title: 'x', link: 'a' } } });
    assert.equal(denied.statusCode, 403);
    const created = await app.inject({ method: 'POST', url: '/api/feeds', headers: { host, cookie, 'x-feedlantern': '1', 'x-csrf-token': csrf }, payload: { name: 'x', url: 'https://example.test', rules: { item: 'x', title: 'x', link: 'a' } } });
    assert.equal(created.statusCode, 200);
    const rss = await app.inject({ method: 'GET', url: new URL(created.json().feedUrl).pathname });
    assert.equal(rss.statusCode, 200);
    assert.match(rss.headers['content-type'] as string, /rss/);
    const changed = await app.inject({ method: 'POST', url: '/api/auth/password', headers: { host, cookie, 'x-feedlantern': '1', 'x-csrf-token': csrf }, payload: { currentPassword: 'password123', newPassword: 'new-password123' } });
    assert.equal(changed.statusCode, 200);
    const revoked = await app.inject({ method: 'GET', url: '/api/feeds', headers: { host, cookie } });
    assert.equal(revoked.statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host, 'x-feedlantern': '1' }, payload: { username: 'admin', password: 'new-password123' } });
    assert.equal(login.statusCode, 200);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('并行刷新串行执行，编辑排在旧抓取之后且使用新规则', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-queue-'));
  let active = 0;
  let maxActive = 0;
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const browser = { ...fakeBrowser, async scrape(options: Parameters<BrowserServiceLike['scrape']>[0]) {
    active++;
    maxActive = Math.max(maxActive, active);
    if (entered) {
      const notify = entered;
      entered = undefined;
      await new Promise<void>(resolve => { release = resolve; notify(); });
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    active--;
    return [{ title: options.rules.title, link: `${options.url}item` }];
  } };
  const app = await createApp({ dataDir, publicOrigin: 'http://127.0.0.1:4321', browserService: browser, startScheduler: false });
  try {
    const host = '127.0.0.1:4321';
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: readFileSync(join(dataDir, 'setup-token'), 'utf8').trim(), username: 'admin', password: 'test-password' } });
    const headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken };
    const input = { name: 'queue', url: 'https://example.test/', rules: { item: 'article', title: 'old', link: 'a' } };
    const created = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/feeds', headers, payload: input })));
    assert.ok(created.every(response => response.statusCode === 200));
    assert.equal(maxActive, 1);
    const id = created[0].json().feed.id;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const refresh = app.inject({ method: 'POST', url: `/api/feeds/${id}/refresh`, headers }).then(response => response);
    await started;
    const update = app.inject({ method: 'PUT', url: `/api/feeds/${id}`, headers, payload: { ...input, rules: { ...input.rules, title: 'new' } } }).then(response => response);
    release!();
    await refresh;
    assert.equal((await update).statusCode, 200);
    const detail = await app.inject({ method: 'GET', url: `/api/feeds/${id}`, headers });
    assert.equal(detail.json().items[0].title, 'new');
    assert.equal(maxActive, 1);
  } finally {
    release?.();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('登录限速不能通过更换用户名绕过', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-rate-'));
  const app = await createApp({ dataDir, publicOrigin: 'http://127.0.0.1:4321', browserService: fakeBrowser, startScheduler: false });
  try {
    for (let attempt = 0; attempt < 9; attempt++) {
      const result = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: '127.0.0.1:4321', 'x-feedlantern': '1' }, payload: { username: `user-${attempt}`, password: 'wrong-password' } });
      assert.equal(result.statusCode, attempt < 8 ? 401 : 429);
    }
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('重启恢复加密凭据、订阅、历史条目和已到期调度', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-restart-'));
  let store = new Store(dataDir);
  store.createAdmin('admin', 'test-password');
  const credential = store.createCredential({ name: 'private', url: 'https://example.test', format: 'header', value: 'test=synthetic' }, { domains: ['example.test'], count: 1, expiresAt: null });
  const created = store.createFeed({ name: 'restart', url: 'https://example.test', rules: { item: 'article', title: 'h2', link: 'a' }, intervalMinutes: 60, waitMs: 0, credentialId: credential.id });
  store.upsertItems(created.feed, [{ title: 'history', link: 'https://example.test/history' }]);
  const oldItem = store.getItems(created.feed.id)[0];
  store.markFetchStart(created.feed.id, '2020-01-01T00:00:00.000Z');
  store.close();
  store = new Store(dataDir);
  let entered!: () => void;
  const refreshed = new Promise<void>(resolve => { entered = resolve; });
  const app = await createApp({ store, dataDir, browserService: { ...fakeBrowser, async scrape(options) { assert.equal(options.cookies?.[0].value, 'synthetic'); entered(); return [{ title: 'new', link: 'https://example.test/new' }]; } } });
  try {
    assert.equal(store.authenticate('admin', 'test-password'), true);
    assert.equal(store.checkFeedToken(created.feed.id, created.token), true);
    await app.ready();
    await refreshed;
    await app.close();
    const items = store.getItems(created.feed.id);
    assert.equal(items.length, 2);
    assert.deepEqual(items.find(item => item.id === oldItem.id), oldItem);
    assert.ok(store.getFeed(created.feed.id)?.lastSuccessAt);
    assert.equal(store.dueFeeds().length, 0);
  } finally {
    await app.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
