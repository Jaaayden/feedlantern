import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net';
import { createRestrictedForwardProxy, NetworkPolicy } from '../src/server/network.js';
import { fetchSource, probeTarget } from '../src/server/rss-source.js';
import type { UpstreamProxy } from '../src/server/upstream-proxy.js';

/**
 * The machine from the report: the resolver is unreachable directly (its
 * name does not even resolve here), but the upstream proxy reaches it. The
 * proxies map the resolver and the public test address to local fixtures,
 * the way the real proxy would route them to the internet.
 */
const RESOLVER = 'doh.invalid';
const PUBLIC_IP = '93.184.215.14';
const INTERNAL_IP = '10.0.0.7';

function track(server: Server | ReturnType<typeof createNetServer>) {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  return () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); });
}
async function listen(server: Server | ReturnType<typeof createNetServer>): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

async function fixtures() {
  const queries: string[] = [];
  const doh = createHttpServer((request, response) => {
    const name = new URL(request.url ?? '/', 'http://doh').searchParams.get('name') ?? '';
    queries.push(name);
    const data = name === 'internal.example' ? INTERNAL_IP : PUBLIC_IP;
    response.writeHead(200, { 'content-type': 'application/dns-json' });
    response.end(JSON.stringify({ Status: 0, Answer: [{ type: 1, data }] }));
  });
  const closeDoh = track(doh);
  const dohPort = await listen(doh);
  const site = createHttpServer((request, response) => {
    if (request.url === '/generate_204') { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/rss+xml' });
    response.end('<?xml version="1.0"?><rss version="2.0"><channel><title>Via proxy</title><item><title>One</title><link>https://news.example/1</link><guid>1</guid></item></channel></rss>');
  });
  const closeSite = track(site);
  const sitePort = await listen(site);
  const route = (host: string, port: number): number | undefined => host === RESOLVER && port === dohPort ? dohPort : host === PUBLIC_IP ? sitePort : undefined;
  const connects: string[] = [];
  const pipe = (client: Socket, port: number, ready: () => void, head?: Buffer) => {
    const upstream = netConnect(port, '127.0.0.1', () => { ready(); if (head?.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  };

  // HTTP CONNECT proxy.
  const http = createHttpServer((_request, response) => { response.writeHead(405); response.end(); });
  http.on('connect', (request, client: Socket, head) => {
    const [host, port] = (request.url ?? '').split(':');
    connects.push(`http ${request.url}`);
    const target = route(host, Number(port));
    if (!target) { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    pipe(client, target, () => client.write('HTTP/1.1 200 Connection Established\r\n\r\n'), head);
  });
  const closeHttp = track(http);
  const httpPort = await listen(http);

  // SOCKS5 proxy without login; accepts IPv4 (1) and domain (3) targets.
  const socks = createNetServer(client => {
    client.once('data', () => {
      client.write(Buffer.from([5, 0]));
      client.once('data', (request: Buffer) => {
        let host = '', offset = 4;
        if (request[3] === 1) { host = Array.from(request.subarray(4, 8)).join('.'); offset = 8; }
        else if (request[3] === 3) { host = request.subarray(5, 5 + request[4]).toString(); offset = 5 + request[4]; }
        const port = request.readUInt16BE(offset);
        connects.push(`socks ${host}:${port}`);
        const target = route(host, port);
        const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
        if (!target) { client.end(reply(4)); return; }
        pipe(client, target, () => client.write(reply(0)));
      });
    });
  });
  const closeSocks = track(socks);
  const socksPort = await listen(socks);

  return {
    dohUrl: `http://${RESOLVER}:${dohPort}/dns-query`, queries, connects,
    httpProxy: { type: 'http', host: '127.0.0.1', port: httpPort } as UpstreamProxy,
    socksProxy: { type: 'socks5', host: '127.0.0.1', port: socksPort } as UpstreamProxy,
    allowedHosts: [`127.0.0.1:${httpPort}`, `127.0.0.1:${socksPort}`],
    close: async () => { await Promise.all([closeDoh(), closeSite(), closeHttp(), closeSocks()]); },
  };
}

test('直连 DoH 不通时，走代理的订阅经同一代理查询，结果照样做内网检查，缓存不混用', async () => {
  const env = await fixtures();
  try {
    const policy = new NetworkPolicy({ dnsOverHttps: true, dohUrl: env.dohUrl, allowedHosts: env.allowedHosts });
    await assert.rejects(policy.assertAllowed('https://news.example/'), /^NetworkPolicyError: 加密 DNS 查询失败/);
    for (const proxy of [env.httpProxy, env.socksProxy]) {
      const proxied = policy.forProxy(proxy);
      const { address } = await proxied.resolveForConnection('https://news.example/feed');
      assert.equal(address, PUBLIC_IP);
      // Answers obtained through the proxy are still checked.
      await assert.rejects(proxied.assertAllowed('https://internal.example/'), /私网或特殊地址/);
    }
    assert.ok(env.connects.includes(`http ${RESOLVER}:${new URL(env.dohUrl).port}`));
    assert.ok(env.connects.includes(`socks ${RESOLVER}:${new URL(env.dohUrl).port}`), 'SOCKS5 asks for the resolver by name');
    // The direct policy never reuses what a proxied lookup found.
    await assert.rejects(policy.assertAllowed('https://news.example/'), /加密 DNS 查询失败/);

    // A proxy that is down: the message names the proxy and the DNS step.
    const down = new NetworkPolicy({ dnsOverHttps: true, dohUrl: env.dohUrl, allowedHosts: ['127.0.0.1:9'] }).forProxy({ type: 'http', host: '127.0.0.1', port: 9 });
    await assert.rejects(down.assertAllowed('https://news.example/'), (error: Error) => {
      assert.match(error.message, /^经代理 127\.0\.0\.1:9（HTTP 代理） 的加密 DNS 查询失败：无法连接代理服务器：连接被拒绝/);
      assert.match(error.message, /关闭 DNS over HTTPS/);
      return true;
    });
  } finally { await env.close(); }
});

test('RSS 抓取和“测试连接”经代理完成 DoH 查询并连接检查过的 IP', async () => {
  const env = await fixtures();
  try {
    const policy = new NetworkPolicy({ dnsOverHttps: true, dohUrl: env.dohUrl, allowedHosts: env.allowedHosts });
    await assert.rejects(fetchSource('http://news.example/feed.xml', policy, { timeoutSeconds: 5 }), /加密 DNS 查询失败/);
    const result = await fetchSource('http://news.example/feed.xml', policy, { network: { proxy: env.httpProxy }, timeoutSeconds: 5 });
    assert.equal(result.title, 'Via proxy');
    assert.equal(result.items.length, 1);
    assert.ok(env.connects.includes(`http ${PUBLIC_IP}:80`), 'the target is given to the proxy as the checked IP');
    assert.deepEqual(await probeTarget('http://news.example/', policy, { proxy: env.socksProxy }), { status: 200 });
    // A connectivity check endpoint answers 204, which the test reports as is.
    assert.deepEqual(await probeTarget('http://news.example/generate_204', policy, { proxy: env.httpProxy }), { status: 204 });
    assert.ok(env.queries.filter(name => name === 'news.example').length >= 2);
  } finally { await env.close(); }
});

test('网页抓取的受限代理（Chromium 经此访问）也经上游代理查询 DoH', async () => {
  const env = await fixtures();
  const restricted = await createRestrictedForwardProxy({ dnsOverHttps: true, dohUrl: env.dohUrl, allowedHosts: env.allowedHosts, upstream: env.httpProxy });
  try {
    const { port } = new URL(restricted.url);
    const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: Number(port), method: 'GET', path: 'http://news.example/feed.xml', headers: { host: 'news.example' } }, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
      });
      request.on('error', reject); request.end();
    });
    assert.equal(body.status, 200);
    assert.match(body.text, /Via proxy/);
    assert.ok(env.queries.includes('news.example'));
    assert.ok(env.connects.includes(`http ${RESOLVER}:${new URL(env.dohUrl).port}`));
  } finally { await restricted.close(); await env.close(); }
});
