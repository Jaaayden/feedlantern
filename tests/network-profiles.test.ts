import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { AppError } from '../src/server/auth.js';
import { FORBIDDEN_HEADERS, headerScopeMatches, parseNetworkProfileInput, type NetworkProfileValue } from '../src/server/fetch-options.js';
import { createRestrictedForwardProxy, NetworkPolicy, NetworkPolicyError } from '../src/server/network.js';
import { fetchSource, probeTarget } from '../src/server/rss-source.js';
import { redactForLog } from '../src/server/log.js';
import { friendlyError } from '../src/server/validation.js';
import { closedPort, startHttpProxy, startSocksProxy, startTarget } from './proxy-fixtures.js';

const rssBody = '<?xml version="1.0"?><rss version="2.0"><channel><title>Proxy feed</title><item><title>Through the proxy</title><link>https://example.test/a</link></item></channel></rss>';
const rejects400 = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (error: unknown) => error instanceof AppError && error.statusCode === 400 && pattern.test(error.message));

test('网络配置校验：禁止敏感请求头、拒绝换行注入并限制数量和长度', () => {
  for (const name of ['Host', 'Cookie', 'cookie2', 'Proxy-Authorization', 'Proxy-Connection', 'Connection', 'Keep-Alive', 'Transfer-Encoding', 'TE', 'Upgrade', 'Content-Length', 'Sec-Fetch-Site', 'User-Agent', 'Referer', 'X-FeedLantern']) {
    rejects400(() => parseNetworkProfileInput({ name: 'n', headers: [{ name, value: 'x' }] }), /不允许|Cookie 凭据|专用字段/);
  }
  assert.ok(FORBIDDEN_HEADERS.includes('host') && FORBIDDEN_HEADERS.includes('cookie'));
  rejects400(() => parseNetworkProfileInput({ name: 'n', headers: [{ name: 'X-A', value: 'ok\r\nHost: evil' }] }), /不能换行/);
  rejects400(() => parseNetworkProfileInput({ name: 'n', headers: [{ name: 'Bad Name', value: 'x' }] }), /名称无效/);
  rejects400(() => parseNetworkProfileInput({ name: 'n', headers: [{ name: 'X-A', value: 'a' }, { name: 'x-a', value: 'b' }] }), /重复/);
  rejects400(() => parseNetworkProfileInput({ name: 'n', headers: Array.from({ length: 21 }, (_, i) => ({ name: `X-${i}`, value: 'v' })) }), /最多 20/);
  rejects400(() => parseNetworkProfileInput({ name: 'n', headers: [{ name: 'X-A', value: 'v'.repeat(2049) }] }), /2048/);
  rejects400(() => parseNetworkProfileInput({ name: 'n', userAgent: 'u'.repeat(513) }), /512/);
  rejects400(() => parseNetworkProfileInput({ name: 'n', referer: 'javascript:alert(1)' }), /Referer/);
  rejects400(() => parseNetworkProfileInput({ name: 'n' }), /至少设置/);
  rejects400(() => parseNetworkProfileInput({ name: 'n', proxyUrl: 'ftp://proxy.test:21' }), /只支持/);
  rejects400(() => parseNetworkProfileInput({ name: 'n', proxyUrl: 'http://proxy.test:8080/path' }), /只能包含/);
  rejects400(() => parseNetworkProfileInput({ name: 'n', proxyUrl: 'socks5://proxy.test', proxyUsername: 'u'.repeat(256), proxyPassword: 'p' }), /255/);

  const value = parseNetworkProfileInput({ name: ' JP ', proxyUrl: 'socks5://user:p%40ss@Proxy.Test', userAgent: 'UA/1', referer: 'https://example.test/', headers: [{ name: 'X-Api-Key', value: 'k1' }] });
  assert.deepEqual(value, { name: 'JP', proxy: { type: 'socks5', host: 'proxy.test', port: 1080, username: 'user', password: 'p@ss' }, userAgent: 'UA/1', referer: 'https://example.test/', headers: [{ name: 'X-Api-Key', value: 'k1' }] });
});

test('更新网络配置：省略的密钥保持不变，代理地址改变时不沿用旧密码', () => {
  const saved: NetworkProfileValue = { name: 'a', proxy: { type: 'http', host: 'proxy.test', port: 8080, username: 'u', password: 'secret' }, headers: [{ name: 'X-Token', value: 'old' }] };
  const kept = parseNetworkProfileInput({ name: 'a', proxyUrl: 'http://proxy.test:8080', headers: [{ name: 'x-token' }] }, saved);
  assert.equal(kept.proxy?.password, 'secret');
  assert.deepEqual(kept.headers, [{ name: 'x-token', value: 'old' }]);
  const cleared = parseNetworkProfileInput({ name: 'a', proxyUrl: 'http://proxy.test:8080', proxyUsername: null }, saved);
  assert.equal(cleared.proxy?.username, undefined);
  rejects400(() => parseNetworkProfileInput({ name: 'a', proxyUrl: 'http://other.test:8080' }, saved), /重新填写/);
  rejects400(() => parseNetworkProfileInput({ name: 'a', headers: [{ name: 'X-New' }] }, saved), /请填写/);
});

test('额外请求头只发往订阅所在网站，HTTPS 订阅不降级到 HTTP', () => {
  assert.equal(headerScopeMatches('https://www.example.com/a', 'https://www.example.com/feed'), true);
  assert.equal(headerScopeMatches('https://api.example.com/x', 'https://www.example.com/feed'), true);
  assert.equal(headerScopeMatches('https://example.com/x', 'https://www.example.com/feed'), true);
  assert.equal(headerScopeMatches('https://cdn.other.com/x', 'https://www.example.com/feed'), false);
  assert.equal(headerScopeMatches('https://evilexample.com/x', 'https://example.com/feed'), false);
  assert.equal(headerScopeMatches('http://www.example.com/a', 'https://www.example.com/feed'), false);
  assert.equal(headerScopeMatches('http://127.0.0.1:81/', 'http://127.0.0.1:80/'), true);
  assert.equal(headerScopeMatches('http://127.0.0.2/', 'http://127.0.0.1/'), false);
});

test('代理地址同样受 SSRF 策略约束：回环、私网、元数据地址被拒绝，管理员白名单放行', async () => {
  const policy = new NetworkPolicy();
  for (const host of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '::1']) {
    await assert.rejects(policy.resolveProxy({ type: 'http', host, port: 8080 }), (error: unknown) => error instanceof NetworkPolicyError && /安全策略阻止/.test(error.message) && /allowedHosts|允许访问的主机/.test(error.message));
  }
  await assert.rejects(policy.resolveProxy({ type: 'socks5', host: 'localhost', port: 1080 }), NetworkPolicyError);
  const allowed = new NetworkPolicy({ allowedHosts: ['127.0.0.1:8080'] });
  assert.equal(await allowed.resolveProxy({ type: 'http', host: '127.0.0.1', port: 8080 }), '127.0.0.1');
  await assert.rejects(allowed.resolveProxy({ type: 'http', host: '127.0.0.1', port: 8081 }), NetworkPolicyError);
});

test('代理主机名在开启 DNS_OVER_HTTPS 时同样走加密 DNS，并检查解析结果', async () => {
  const original = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '10.0.0.8' }] }));
  }) as typeof fetch;
  try {
    const policy = new NetworkPolicy({ dnsOverHttps: true });
    await assert.rejects(policy.resolveProxy({ type: 'http', host: 'proxy.example.com', port: 3128 }), /安全策略阻止/);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /cloudflare-dns\.com\/dns-query\?name=proxy\.example\.com/);
  } finally { globalThis.fetch = original; }
});

test('经 HTTP 代理时目标仍按策略校验并以已校验 IP 交给代理；私网目标不会发往代理', async () => {
  const target = await startTarget((_request, response) => { response.writeHead(200, { 'content-type': 'application/rss+xml' }); response.end(rssBody); });
  const upstream = await startHttpProxy({ username: 'alice', password: 's3cret' });
  try {
    const policy = new NetworkPolicy({ allowedHosts: [target.host, `127.0.0.1:${upstream.port}`] });
    const network = { proxy: { type: 'http' as const, host: '127.0.0.1', port: upstream.port, username: 'alice', password: 's3cret' }, userAgent: 'ProfileUA/2', referer: 'https://ref.example/', headers: [{ name: 'X-Api-Key', value: 'key-1' }] };
    const result = await fetchSource(`http://${target.host}/feed.xml`, policy, { network });
    assert.equal(result.items[0].title, 'Through the proxy');
    assert.deepEqual(upstream.log.map(entry => entry.target), [target.host]);
    assert.equal(upstream.log[0].auth, `Basic ${Buffer.from('alice:s3cret').toString('base64')}`);
    const headers = target.requests[0].headers;
    assert.equal(headers['user-agent'], 'ProfileUA/2');
    assert.equal(headers.referer, 'https://ref.example/');
    assert.equal(headers['x-api-key'], 'key-1');
    assert.equal(headers['proxy-authorization'], undefined);

    const before = upstream.connections;
    await assert.rejects(fetchSource('http://10.0.0.5/feed.xml', policy, { network }), /私网|特殊地址/);
    assert.equal(upstream.connections, before, '被策略阻止的目标不应连接代理');
  } finally { await upstream.close(); await target.close(); }
});

test('SOCKS5 代理带认证抓取 RSS；重定向到其他网站时不再携带自定义请求头', async () => {
  const other = await startTarget((_request, response) => { response.writeHead(200, { 'content-type': 'application/rss+xml' }); response.end(rssBody); });
  const first = await startTarget((_request, response) => { response.writeHead(302, { location: `http://localhost:${other.port}/feed.xml` }); response.end(); });
  const upstream = await startSocksProxy({ username: 'bob', password: 'pw' });
  try {
    const policy = new NetworkPolicy({ allowedHosts: [first.host, `localhost:${other.port}`, `127.0.0.1:${upstream.port}`] });
    const network = { proxy: { type: 'socks5' as const, host: '127.0.0.1', port: upstream.port, username: 'bob', password: 'pw' }, headers: [{ name: 'X-Secret', value: 'only-first' }] };
    const result = await fetchSource(`http://${first.host}/`, policy, { network });
    assert.equal(result.title, 'Proxy feed');
    assert.deepEqual(upstream.log.map(entry => [entry.target, entry.user]), [[first.host, 'bob'], [`127.0.0.1:${other.port}`, 'bob']]);
    assert.equal(first.requests[0].headers['x-secret'], 'only-first');
    assert.equal(other.requests[0].headers['x-secret'], undefined);
    assert.equal(other.requests[0].host, `localhost:${other.port}`);
  } finally { await upstream.close(); await first.close(); await other.close(); }
});

test('代理不可达或认证失败时错误清楚，且不含用户名和密码', async () => {
  const target = await startTarget((_request, response) => response.end('ok'));
  const upstream = await startHttpProxy({ username: 'right', password: 'right-pass' });
  const socks = await startSocksProxy({ username: 'right', password: 'right-pass' });
  const deadPort = await closedPort();
  try {
    const policy = new NetworkPolicy({ allowedHosts: [target.host, `127.0.0.1:${upstream.port}`, `127.0.0.1:${socks.port}`, `127.0.0.1:${deadPort}`] });
    const url = `http://${target.host}/`;
    const check = (pattern: RegExp) => (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, /wrong-user|wrong-pass|right-pass/);
      assert.doesNotMatch(friendlyError(error, 'fallback'), /wrong-pass/);
      return true;
    };
    await assert.rejects(probeTarget(url, policy, { proxy: { type: 'http', host: '127.0.0.1', port: deadPort, username: 'wrong-user', password: 'wrong-pass' } }), check(/无法连接代理服务器 127\.0\.0\.1:\d+（HTTP 代理）：连接被拒绝/));
    await assert.rejects(probeTarget(url, policy, { proxy: { type: 'http', host: '127.0.0.1', port: upstream.port, username: 'wrong-user', password: 'wrong-pass' } }), check(/代理认证失败（HTTP 407）/));
    await assert.rejects(probeTarget(url, policy, { proxy: { type: 'http', host: '127.0.0.1', port: upstream.port } }), check(/要求认证/));
    await assert.rejects(probeTarget(url, policy, { proxy: { type: 'socks5', host: '127.0.0.1', port: socks.port, username: 'wrong-user', password: 'wrong-pass' } }), check(/SOCKS5 代理认证失败/));
    await assert.rejects(probeTarget(url, policy, { proxy: { type: 'socks5', host: '127.0.0.1', port: upstream.port } }), check(/SOCKS5 响应|请检查代理类型/));
    assert.deepEqual(await probeTarget(url, policy, { proxy: { type: 'socks5', host: '127.0.0.1', port: socks.port, username: 'right', password: 'right-pass' } }), { status: 200 });
  } finally { await upstream.close(); await socks.close(); await target.close(); }
});

function viaProxy(proxyUrl: string, target: string, auth?: string): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: proxy.hostname, port: Number(proxy.port), path: target, headers: { host: new URL(target).host, ...(auth ? { 'proxy-authorization': auth } : {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    request.once('error', reject);
    request.end();
  });
}

test('每个订阅的受限代理需要独立随机登录，并经上游代理转发；凭据不会转发给目标', async () => {
  const target = await startTarget((_request, response) => response.end('hello'));
  const upstream = await startHttpProxy({ username: 'carol', password: 'pw' });
  const restricted = await createRestrictedForwardProxy({ allowedHosts: [target.host, `127.0.0.1:${upstream.port}`], upstream: { type: 'http', host: '127.0.0.1', port: upstream.port, username: 'carol', password: 'pw' }, requireAuth: true });
  const other = await createRestrictedForwardProxy({ allowedHosts: [target.host], requireAuth: true });
  try {
    assert.ok(restricted.credentials && other.credentials);
    assert.notEqual(restricted.credentials.password, other.credentials.password);
    const basic = (c: { username: string; password: string }) => `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`;
    assert.equal((await viaProxy(restricted.url, `http://${target.host}/`)).status, 407);
    assert.equal((await viaProxy(restricted.url, `http://${target.host}/`, basic(other.credentials))).status, 407, '另一个上下文的登录不能使用这个代理');
    assert.deepEqual(await viaProxy(restricted.url, `http://${target.host}/`, basic(restricted.credentials)), { status: 200, body: 'hello' });
    assert.deepEqual(upstream.log.map(entry => entry.target), [target.host]);
    assert.equal(target.requests.at(-1)!.headers['proxy-authorization'], undefined);
    assert.equal(restricted.lastError, undefined);
  } finally { await restricted.close(); await other.close(); await upstream.close(); await target.close(); }
});

test('受限代理记录上游代理失败原因，供页面错误提示使用', async () => {
  const target = await startTarget((_request, response) => response.end('hello'));
  const deadPort = await closedPort();
  const restricted = await createRestrictedForwardProxy({ allowedHosts: [target.host, `127.0.0.1:${deadPort}`], upstream: { type: 'socks5', host: '127.0.0.1', port: deadPort } });
  try {
    const response = await viaProxy(restricted.url, `http://${target.host}/`);
    assert.equal(response.status, 502);
    assert.match(restricted.lastError ?? '', /无法连接代理服务器 127\.0\.0\.1:\d+（SOCKS5 代理）/);
    assert.equal(target.requests.length, 0);
  } finally { await restricted.close(); await target.close(); }
});

test('日志与错误提示隐藏网址中的用户名和密码，包括 socks5 代理地址', () => {
  const text = 'proxy socks5://alice:hunter2@proxy.example:1080 failed; http://bob:pw@h.test/x Proxy-Authorization: Basic abc';
  const logged = redactForLog(text);
  assert.doesNotMatch(logged, /alice|hunter2|bob:pw|Basic abc/);
  assert.match(logged, /socks5:\/\/\[已隐藏\]@proxy\.example:1080/);
  assert.doesNotMatch(friendlyError(new Error('connect socks5://alice:hunter2@proxy.example:1080'), 'x'), /hunter2|alice/);
});
