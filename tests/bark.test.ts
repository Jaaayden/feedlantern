import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { BarkWorker, sendBark, validateBarkUrl } from '../src/server/bark.js';
import { Store } from '../src/server/store.js';

async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('worker timeout'); }

test('Bark 使用 JSON POST，验证服务端结果、HTTP 错误、超时和禁止重定向', async () => {
  let mode = 'success', redirected = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/redirect-target') { redirected++; res.end('{}'); return; }
    if (mode === 'timeout') return;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/bark/push');
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.device_key, 'test-key');
    assert.equal(body.group, 'FeedLantern'); assert.equal(body.body, 'failure');
    if (mode === 'redirect') { res.writeHead(302, { location: '/redirect-target' }); res.end(); return; }
    res.writeHead(mode === 'http-error' ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: mode === 'api-error' ? 400 : 200 }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/bark/test-key/`;
  try {
    await sendBark(url, 'failure', AbortSignal.timeout(2000));
    for (mode of ['http-error', 'api-error', 'redirect', 'timeout']) await assert.rejects(sendBark(url, 'failure', AbortSignal.timeout(mode === 'timeout' ? 20 : 2000)));
    assert.equal(redirected, 0);
    assert.equal(validateBarkUrl(''), undefined);
    assert.equal(validateBarkUrl('https://api.day.app/test-key/'), 'https://api.day.app/test-key/');
    for (const bad of ['http://localhost/key', 'https://example.test/', 'https://user:secret@example.test/key', 'https://example.test/key?private=secret']) assert.throws(() => validateBarkUrl(bad), error => !String(error).includes('secret'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('后台发送不阻塞，恢复／删除取消进行中的通知，重启处理持久化队列', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-bark-')); const store = new Store(dir);
  const feed = store.createFeed({ name: 'test', url: 'https://example.test', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 }).feed;
  const h = store.history;
  const fail = () => { const id = h.start(feed.id, 'scheduled'); h.fail(id, feed, 'scheduled', 1, '网络错误', true); return id; };
  let started = false, aborted = false, calls = 0;
  let worker = new BarkWorker(h, 'https://api.day.app/test-key/', async (_url, _body, signal) => {
    started = true; await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }, { once: true }); });
  });
  try {
    const id = fail(); worker.start(); await until(() => started);
    h.succeed(h.start(feed.id, 'manual'), feed.id, 2, { itemCount: 1, newItemCount: 0 }); worker.wake();
    await until(() => aborted); await worker.stop();
    assert.equal(h.list(feed.id).logs.find(l => l.id === id)?.notification?.status, 'canceled');
    fail();
    worker = new BarkWorker(h, 'https://api.day.app/test-key/', async () => { calls++; });
    worker.start(); await until(() => h.list(feed.id).logs[0].notification?.status === 'sent');
    fail(); worker.wake(); await new Promise(r => setImmediate(r)); assert.equal(calls, 1);
    await worker.stop();
    h.succeed(h.start(feed.id, 'manual'), feed.id, 2, { itemCount: 1, newItemCount: 0 }); fail();
    started = false; aborted = false;
    worker = new BarkWorker(h, 'https://api.day.app/test-key/', async (_u, _b, signal) => { started = true; await new Promise<void>((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error()); }, { once: true })); });
    worker.start(); await until(() => started); store.deleteFeed(feed.id); worker.wake(); await until(() => aborted);
    assert.equal(h.nextAlert(), null);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('后台发送错误不泄漏密钥；重启后不会发送第四次重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-bark-retry-')), store = new Store(dir);
  const feed = store.createFeed({ name: 'test', url: 'https://example.test', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 }).feed;
  const h = store.history, run = h.start(feed.id, 'scheduled');
  h.fail(run, feed, 'scheduled', 1, '超时', true);
  const job = h.nextAlert()!;
  let sends = 0;
  let worker = new BarkWorker(h, 'https://api.day.app/test-secret/', async () => { sends++; throw Error('https://api.day.app/test-secret/ Authorization: private'); });
  try {
    worker.start(); await until(() => h.list(feed.id).logs[0].notification?.error !== null); await worker.stop();
    assert.equal(sends, 1); assert.equal(h.nextAlert(), null);
    assert.ok(!JSON.stringify(h.list(feed.id)).includes('test-secret'));
    // Simulate an interrupted third send whose persisted lease has expired.
    const past = Date.now() - 120_000;
    h.beginAttempt(job.id, past); h.beginAttempt(job.id, past);
    worker = new BarkWorker(h, 'https://api.day.app/test-secret/', async () => { sends++; });
    worker.start(); await until(() => h.list(feed.id).logs[0].notification?.status === 'failed');
    assert.equal(sends, 1);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
