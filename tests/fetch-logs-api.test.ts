import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import type { FetchLogPage } from '../src/shared/types.js';

const fake: BrowserServiceLike = {
  open: () => { throw Error('unused'); }, snapshot: () => { throw Error('unused'); }, scroll: () => { throw Error('unused'); }, click: () => { throw Error('unused'); },
  pick: () => { throw Error('unused'); }, extract: () => [], scrape: () => [{ title: 'one', link: 'https://example.test/one' }], close() {}, dispose() {},
};
const input = { name: '日志订阅', url: 'https://example.test/list', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 };
const host = '127.0.0.1:4321';
async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('timeout'); }

test('日志接口鉴权、分页校验、所有交互入口、错误与恢复及并发合并', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-logs-api-')), store = new Store(dir);
  let behavior: 'success' | 'empty' | 'error' = 'success', release: (() => void) | undefined, entered = false, block = false, calls = 0, notifications = 0;
  const browser = { ...fake, async scrape() {
    calls++;
    if (block) { entered = true; await new Promise<void>(resolve => { release = resolve; }); }
    if (behavior === 'error') throw Error('网络超时 https://example.test/?token=secret\nCookie: private');
    return behavior === 'empty' ? [] : [{ title: 'one', link: 'https://example.test/one' }];
  } };
  const app = await createApp({ dataDir: dir, store, publicOrigin: `http://${host}`, browserService: browser, startScheduler: false, barkUrl: 'https://api.day.app/test-key/', barkSender: async () => { notifications++; } });
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: store.getSetupToken(), username: 'admin', password: 'test-password123' } });
    const headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken };
    const created = await app.inject({ method: 'POST', url: '/api/feeds', headers, payload: input });
    assert.equal(created.statusCode, 200);
    const id = created.json().feed.id;
    const logs = async () => (await app.inject({ method: 'GET', url: `/api/feeds/${id}/logs`, headers })).json<FetchLogPage>().logs;
    assert.equal((await logs())[0].source, 'create'); assert.equal((await logs())[0].newItemCount, 1);
    assert.equal((await app.inject({ method: 'GET', url: `/api/feeds/${id}/logs`, headers: { host } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/feeds/missing/logs', headers })).statusCode, 404);
    for (const query of ['limit=0', 'limit=101', 'limit=x', 'cursor=-1', 'cursor=1.5', 'cursor=9007199254740992', 'status=invalid', 'limit=1&limit=2']) assert.equal((await app.inject({ method: 'GET', url: `/api/feeds/${id}/logs?${query}`, headers })).statusCode, 400);
    const refresh = () => app.inject({ method: 'POST', url: `/api/feeds/${id}/refresh`, headers });
    await refresh(); assert.equal((await logs())[0].newItemCount, 0);
    behavior = 'empty'; await refresh(); await until(() => notifications === 1);
    assert.equal((await logs())[0].status, 'failure'); assert.match((await logs())[0].error!, /可能是页面结构或规则变化/);
    assert.equal(store.getItems(id).length, 1);
    behavior = 'error'; await refresh();
    assert.ok(!JSON.stringify(await logs()).includes('secret')); assert.equal(notifications, 1);
    behavior = 'success';
    await app.inject({ method: 'PUT', url: `/api/feeds/${id}`, headers, payload: input });
    assert.equal((await logs())[0].source, 'edit');
    await app.inject({ method: 'POST', url: `/api/feeds/${id}/toggle`, headers });
    const count = (await logs()).length;
    await app.inject({ method: 'POST', url: `/api/feeds/${id}/toggle`, headers });
    assert.equal((await logs()).length, count + 1); assert.equal((await logs())[0].source, 'resume');
    await app.inject({ method: 'POST', url: '/api/feeds/bulk', headers, payload: { ids: [id], action: 'refresh' } });
    assert.equal((await logs())[0].source, 'manual');
    const before = calls, beforeLogs = (await logs()).length;
    block = true;
    const first = refresh().then(r => r); await until(() => entered);
    const second = refresh().then(r => r); await new Promise(r => setTimeout(r, 10));
    assert.equal((await logs())[0].status, 'running');
    release!(); await Promise.all([first, second]); block = false;
    assert.equal(calls, before + 1); assert.equal((await logs()).length, beforeLogs + 1);
    const page = await app.inject({ method: 'GET', url: `/api/feeds/${id}/logs?status=success&limit=1`, headers });
    assert.equal(page.headers['cache-control'], 'no-store'); assert.equal(page.json().logs.length, 1); assert.ok(page.json().nextCursor);
    behavior = 'error'; await refresh(); await until(() => notifications === 2);
    const cred = store.createCredential({ name: 'wrong-domain', url: 'https://other.test', format: 'header', value: 'session=private-cookie' }, { domains: ['other.test'], count: 1, expiresAt: null });
    const cookieFailure = await app.inject({ method: 'PUT', url: `/api/feeds/${id}`, headers, payload: { ...input, credentialId: cred.id } });
    assert.equal(cookieFailure.statusCode, 200);
    assert.match((await logs())[0].error!, /域名不匹配/); assert.ok(!JSON.stringify(await logs()).includes('private-cookie'));
  } finally { release?.(); await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('启动定时调度记录 scheduled，未到期和暂停订阅不生成抓取日志', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-logs-scheduler-')), store = new Store(dir);
  const due = store.createFeed(input).feed;
  store.markFetchStart(due.id, new Date(Date.now() - 1000).toISOString());
  const paused = store.createFeed({ ...input, url: 'https://example.test/paused' }).feed;
  store.toggleFeed(paused.id);
  const future = store.createFeed({ ...input, url: 'https://example.test/future' }).feed;
  store.markFetchStart(future.id, new Date(Date.now() + 3600_000).toISOString());
  const app = await createApp({ store, dataDir: dir, browserService: fake, barkUrl: '' });
  try {
    await app.ready(); await until(() => store.history.list(due.id).logs[0]?.status === 'success');
    assert.equal(store.history.list(due.id).logs[0].source, 'scheduled');
    assert.equal(store.history.list(paused.id).logs.length, 0); assert.equal(store.history.list(future.id).logs.length, 0);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
