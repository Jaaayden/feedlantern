import { test } from 'node:test';
import { lt, rawText } from '../src/server/i18n.js';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { fetchSource } from '../src/server/rss-source.js';
import { NetworkPolicy } from '../src/server/network.js';
import { FetchTimeoutError } from '../src/server/fetch-errors.js';
import { friendlyError } from '../src/server/validation.js';
import type { NotificationMessage } from '../src/server/notify.js';

/** A local source that accepts connections and never answers. */
async function slowServer(): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer(() => { /* never respond */ });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port, close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }) };
}
async function until(check: () => boolean, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('RSS 来源超时显示主机和秒数及代理提示，不带查询参数；调用方取消不算超时', async () => {
  const slow = await slowServer();
  const policy = new NetworkPolicy({ allowedHosts: [`127.0.0.1:${slow.port}`] });
  const url = `http://127.0.0.1:${slow.port}/feed.xml?token=private-query`;
  try {
    const started = Date.now();
    const error = await fetchSource(url, policy, { timeoutSeconds: 0.3 }).then(() => null, (reason: unknown) => reason);
    assert.ok(error instanceof FetchTimeoutError, String(error));
    assert.ok(Date.now() - started < 3000);
    assert.match(error.message, /^连接 127\.0\.0\.1 超时（0\.3 秒未响应）。/);
    assert.match(error.message, /增强模式或 Fake-IP/);
    assert.match(error.message, /TUN\/增强模式并打开 DNS-over-HTTPS/);
    assert.match(error.message, /网络代理/);
    assert.ok(!error.message.includes('private-query') && !error.message.includes('feed.xml'));
    assert.equal(lt(friendlyError(error, rawText('fallback'))), error.message);

    // With a network profile proxy the hint points at the proxy instead.
    assert.match(new FetchTimeoutError('rss.example.test', 20, true).message, /^连接 rss\.example\.test 超时（20 秒未响应）。请检查该订阅网络配置中的代理是否可用。$/);

    // A user cancel or a stopping service is passed on as an abort, not reported as a timeout.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const canceled = await fetchSource(url, policy, { timeoutSeconds: 5, signal: controller.signal }).then(() => null, (reason: unknown) => reason);
    assert.ok(canceled instanceof Error && !(canceled instanceof FetchTimeoutError), String(canceled));
    assert.equal(canceled.name, 'AbortError');
    assert.doesNotMatch(lt(friendlyError(canceled, rawText('fallback'))), /超时|aborted/);
    // Raw English abort and timeout errors from Node never reach the user.
    assert.equal(lt(friendlyError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'), rawText('fallback'))), '请求超时，目标网站长时间未响应');
    assert.equal(lt(friendlyError(new DOMException('The operation was aborted', 'AbortError'), rawText('fallback'))), '操作已中止（已取消或服务正在停止）');
  } finally { await slow.close(); }
});

const browser = { dispose: async () => {}, scrape: async () => { throw Error('RSS must not launch browser'); } } as unknown as BrowserServiceLike;

test('后台抓取超时：抓取日志、订阅错误原因和 Bark 告警都显示可读文案，查询参数照旧隐藏', async () => {
  const slow = await slowServer();
  const dir = mkdtempSync(join(tmpdir(), 'fl-timeout-')), store = new Store(dir);
  const sent: NotificationMessage[] = [];
  const policy = new NetworkPolicy({ allowedHosts: [`127.0.0.1:${slow.port}`] });
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false,
    rssFetcher: (url, options) => fetchSource(url, policy, { ...options, timeoutSeconds: 0.3 }),
    notificationSenders: { bark: async (_config, message) => { sent.push(message); } } });
  try {
    const host = '127.0.0.1:4321';
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: store.getSetupToken(), username: 'admin', password: 'password123' } });
    const headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken };
    const owner = store.listUsers()[0].id;
    store.setBark(owner, { enabled: true, url: 'https://api.day.app/test-key/', failureThreshold: 1 });
    const { feed } = store.createFeed({ name: '慢速来源', url: `http://127.0.0.1:${slow.port}/rss?key=private-query`, sourceType: 'rss', translationMode: 'original', rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 30, waitMs: 0 }, owner);
    const refreshed = await app.inject({ method: 'POST', url: `/api/feeds/${feed.id}/refresh`, headers, payload: {} });
    assert.ok(refreshed.statusCode < 500, refreshed.body);
    const expected = /^连接 127\.0\.0\.1 超时（0\.3 秒未响应）。如果本机开启了代理软件的增强模式或 Fake-IP/;
    const detail = (await app.inject({ url: `/api/feeds/${feed.id}`, headers })).json();
    assert.match(detail.feed.lastError, expected);
    const log = (await app.inject({ url: `/api/feeds/${feed.id}/logs`, headers })).json().logs[0];
    assert.equal(log.status, 'failure');
    assert.match(log.error, expected);
    await until(() => sent.length > 0);
    assert.match(sent[0].body, /原因：连接 127\.0\.0\.1 超时（0\.3 秒未响应）/);
    for (const text of [detail.feed.lastError, log.error, sent[0].body, sent[0].error]) {
      assert.ok(!text.includes('private-query'), text);
      assert.ok(!/operation was aborted/i.test(text), text);
    }
  } finally { await app.close(); store.close(); await slow.close(); rmSync(dir, { recursive: true, force: true }); }
});
