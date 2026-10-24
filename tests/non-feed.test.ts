import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { fetchSource, parseSource } from '../src/server/rss-source.js';
import { NetworkPolicy } from '../src/server/network.js';
import { NotAFeedError, nonFeedReason } from '../src/server/fetch-errors.js';
import { friendlyError } from '../src/server/validation.js';
import { lt, rawText } from '../src/server/i18n.js';
import type { NotificationMessage } from '../src/server/notify.js';
import { startTarget } from './proxy-fixtures.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/pubmed/${name}`, import.meta.url), 'utf8');
const challenge = fixture('journal-challenge.html');
const plainPage = '<!DOCTYPE html>\n<html><head><title>Welcome</title></head><body><h1>Sign in</h1><p>Our newsletter.</p></body></html>';
const rss = '<?xml version="1.0"?><rss version="2.0"><channel><title>Valid</title><item><guid>one</guid><title>Hello</title><link>https://example.test/one</link></item></channel></rss>';
/** The reason in the current language (zh-CN in unit tests). */
const reasonOf = (...args: Parameters<typeof nonFeedReason>) => { const reason = nonFeedReason(...args); return reason && lt(reason); };
const externalEntity = '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss version="2.0"><channel><title>&xxe;</title></channel></rss>';

test('解析前识别网页：验证页注明标记，普通网页说明不是订阅源；合法 RSS 正常；外部实体仍按原逻辑拒绝', () => {
  const base = 'https://example.test/feed';
  // The NCBI-style bot check names the marker it recognised.
  const error = (() => { try { parseSource(challenge, base); } catch (reason) { return reason; } })();
  assert.ok(error instanceof NotAFeedError, String(error));
  assert.match(error.message, /^来源返回的是反爬验证页而不是 RSS\/Atom（页面含 cookies-required 标记）。FeedLantern 不会尝试绕过/);
  assert.equal(lt(friendlyError(error, rawText('fallback'))), error.message);
  assert.throws(() => parseSource(plainPage, base), /^NotAFeedError: 来源返回的是网页而不是 RSS\/Atom。可能是对方的反爬验证页或登录页，FeedLantern 不会尝试绕过/);
  // A leading XML declaration or comment does not hide an HTML page.
  assert.throws(() => parseSource(`﻿<?xml version="1.0"?>\n<!-- cached -->\n<html><body>x</body></html>`, base), /网页而不是 RSS\/Atom/);
  assert.equal(parseSource(rss, base).items[0].title, 'Hello');
  // Unsafe XML keeps its original message and refusal.
  assert.throws(() => parseSource(externalEntity, base), /^Error: RSS XML 无效或包含不支持的实体声明$/);
  assert.throws(() => parseSource('<!DOCTYPE rss SYSTEM "http://evil.test/x.dtd"><rss/>', base), /实体声明/);

  // Status and content type are judged before the body.
  assert.match(reasonOf(challenge, 203, 'text/html; charset=utf-8')!, /反爬验证页.*HTTP 203，页面含 cookies-required 标记/);
  assert.match(reasonOf(plainPage, 200, 'text/html')!, /^来源返回的是网页而不是 RSS\/Atom（HTTP 200）/);
  assert.match(reasonOf(rss, 203, 'application/rss+xml')!, /^来源返回 HTTP 203，不是正常的订阅响应（应为 HTTP 200）：内容可能被中间代理/);
  assert.match(reasonOf('', 204)!, /^来源返回 HTTP 204，不是正常的订阅响应/);
  assert.match(reasonOf('<p>not a document</p>', 200, 'text/html')!, /网页而不是/);
  // Some servers label a valid feed text/html: it is still read as a feed.
  assert.equal(nonFeedReason(rss, 200, 'text/html'), undefined);
  assert.equal(nonFeedReason(rss, 200, 'application/rss+xml'), undefined);
  // Other errors keep their status message unless the page is a bot check.
  assert.equal(nonFeedReason(plainPage, 404, 'text/html'), undefined);
  assert.match(reasonOf('<html><body><div class="g-recaptcha"></div></body></html>', 403, 'text/html')!, /^RSS 获取失败（HTTP 403）：来源返回了反爬验证页（页面含 reCAPTCHA 标记）/);
});

test('fetchSource 按状态码、类型和正文给出准确报错，合法 RSS（含标成 text/html 的）照常解析', async () => {
  const target = await startTarget((request, response) => {
    const send = (status: number, type: string, body: string) => { response.writeHead(status, { 'content-type': type }); response.end(body); };
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    if (path === '/challenge') send(203, 'text/html; charset=utf-8', challenge);
    else if (path === '/page') send(200, 'text/html', plainPage);
    else if (path === '/odd-status') send(206, 'application/xml', rss);
    else if (path === '/mislabelled') send(200, 'text/html', rss);
    else if (path === '/entity') send(200, 'application/xml', externalEntity);
    else if (path === '/blocked') send(403, 'text/html', '<html><body>Checking your browser before accessing</body></html>');
    else if (path === '/missing') send(404, 'text/html', plainPage);
    else send(200, 'application/rss+xml', rss);
  });
  const policy = new NetworkPolicy({ allowedHosts: [target.host] });
  const at = (path: string) => `http://${target.host}${path}?token=private-query`;
  try {
    await assert.rejects(fetchSource(at('/challenge'), policy), (error: Error) => error instanceof NotAFeedError && /^来源返回的是反爬验证页而不是 RSS\/Atom（HTTP 203，页面含 cookies-required 标记）/.test(error.message) && !error.message.includes('private-query'));
    await assert.rejects(fetchSource(at('/page'), policy), /^NotAFeedError: 来源返回的是网页而不是 RSS\/Atom（HTTP 200）/);
    await assert.rejects(fetchSource(at('/odd-status'), policy), /来源返回 HTTP 206，不是正常的订阅响应/);
    await assert.rejects(fetchSource(at('/entity'), policy), /RSS XML 无效或包含不支持的实体声明/);
    await assert.rejects(fetchSource(at('/blocked'), policy), /RSS 获取失败（HTTP 403）：来源返回了反爬验证页（页面含 human verification 标记）/);
    await assert.rejects(fetchSource(at('/missing'), policy), /^Error: RSS 获取失败（HTTP 404）$/);
    assert.equal((await fetchSource(at('/mislabelled'), policy)).items[0].title, 'Hello');
    assert.equal((await fetchSource(at('/rss'), policy)).title, 'Valid');
  } finally { await target.close(); }
});

const browser = { dispose: async () => {}, scrape: async () => { throw Error('RSS must not launch browser'); } } as unknown as BrowserServiceLike;

test('验证页的新文案出现在抓取日志、订阅列表错误原因和告警里', async () => {
  const target = await startTarget((_request, response) => { response.writeHead(203, { 'content-type': 'text/html' }); response.end(challenge); });
  const dir = mkdtempSync(join(tmpdir(), 'fl-nonfeed-')), store = new Store(dir);
  const sent: NotificationMessage[] = [];
  const policy = new NetworkPolicy({ allowedHosts: [target.host] });
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false,
    rssFetcher: (url, options) => fetchSource(url, policy, options),
    notificationSenders: { bark: async (_config, message) => { sent.push(message); } } });
  try {
    const host = '127.0.0.1:4321';
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: store.getSetupToken(), username: 'admin', password: 'password123' } });
    const headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken };
    const owner = store.listUsers()[0].id;
    store.setBark(owner, { enabled: true, url: 'https://api.day.app/test-key/', failureThreshold: 1 });
    const { feed } = store.createFeed({ name: '受验证页保护的来源', url: `http://${target.host}/rss/search/abc/?limit=15`, sourceType: 'rss', translationMode: 'original', rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 30, waitMs: 0 }, owner);
    await app.inject({ method: 'POST', url: `/api/feeds/${feed.id}/refresh`, headers, payload: {} });
    const expected = /^来源返回的是反爬验证页而不是 RSS\/Atom（HTTP 203，页面含 cookies-required 标记）。FeedLantern 不会尝试绕过/;
    const listed = (await app.inject({ url: '/api/feeds', headers })).json();
    const row = (listed.feeds ?? listed).find((f: { id: string }) => f.id === feed.id);
    assert.match(row.lastError, expected);
    const log = (await app.inject({ url: `/api/feeds/${feed.id}/logs`, headers })).json().logs[0];
    assert.equal(log.status, 'failure');
    assert.match(log.error, expected);
    const deadline = Date.now() + 4000;
    while (!sent.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(sent.length, 'an alert was sent');
    assert.match(sent[0].body, /原因：来源返回的是反爬验证页而不是 RSS\/Atom/);
    // The new message never says "entity declaration" any more.
    for (const text of [row.lastError, log.error, sent[0].body]) assert.doesNotMatch(text, /实体声明/);
    // The preview of a new RSS subscription shows the same message.
    const preview = await app.inject({ method: 'POST', url: '/api/rss/preview', headers, payload: { url: `http://${target.host}/feed` } });
    assert.equal(preview.statusCode, 400);
    assert.match(preview.json().error, expected);
    assert.equal(preview.json().code, 'source_not_feed');
  } finally { await app.close(); store.close(); await target.close(); rmSync(dir, { recursive: true, force: true }); }
});
