import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type RequestListener, type Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import { test } from 'node:test';

import {
  createRestrictedForwardProxy,
  NetworkPolicy,
  NetworkPolicyError,
} from '../src/server/network';

async function listen(handler: RequestListener): Promise<Server> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return server;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function portOf(server: Server): number {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

function fetchViaProxy(proxyUrl: string, targetUrl: string): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: proxy.hostname,
      port: Number(proxy.port),
      method: 'GET',
      path: targetUrl,
      headers: { host: new URL(targetUrl).host },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end();
  });
}

test('受限代理把普通 HTTP 请求转发到已校验的目标并保留状态码', async () => {
  const target = await listen((_request, response) => {
    response.writeHead(418, { 'content-type': 'text/plain' });
    response.end('teapot');
  });
  const targetUrl = `http://127.0.0.1:${portOf(target)}/status`;
  const proxy = await createRestrictedForwardProxy({ allowedHosts: [new URL(targetUrl).host] });
  try {
    assert.deepEqual(await fetchViaProxy(proxy.url, targetUrl), { status: 418, body: 'teapot' });
  } finally {
    await proxy.close();
    await close(target);
  }
});

test('关闭代理会中止未结束的上游请求和客户端连接', async () => {
  let targetSocketClosed = false;
  const target = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('started');
    response.socket?.once('close', () => { targetSocketClosed = true; });
  });
  const targetUrl = `http://127.0.0.1:${portOf(target)}/hanging`;
  const proxy = await createRestrictedForwardProxy({ allowedHosts: [new URL(targetUrl).host] });
  const proxyAddress = new URL(proxy.url);
  const started = new Promise<void>((resolve, reject) => {
    const request = httpRequest({
      hostname: proxyAddress.hostname,
      port: Number(proxyAddress.port),
      path: targetUrl,
      headers: { host: new URL(targetUrl).host },
    }, response => {
      response.once('data', () => resolve());
      response.resume();
    });
    request.once('error', error => {
      // The request is intentionally aborted by proxy.close().
      if (!/socket hang up|ECONNRESET|aborted/i.test(String(error.message))) reject(error);
    });
    request.end();
  });
  try {
    await started;
    await Promise.race([
      proxy.close(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('proxy close timed out')), 1_000)),
    ]);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(targetSocketClosed, true);
  } finally {
    await proxy.close();
    await close(target);
  }
});

test('CONNECT 错误使用固定 reason phrase，不把网络错误写入 HTTP 状态行', async () => {
  const target = await listen((_request, response) => response.end('unused'));
  const proxy = await createRestrictedForwardProxy();
  const address = new URL(proxy.url);
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(Number(address.port), address.hostname);
      const chunks: Buffer[] = [];
      socket.once('connect', () => socket.write(`CONNECT 127.0.0.1:${portOf(target)} HTTP/1.1\r\nHost: 127.0.0.1:${portOf(target)}\r\n\r\n`));
      socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
      socket.once('end', () => resolve(Buffer.concat(chunks).toString('ascii')));
      socket.once('error', reject);
    });
    assert.match(response, /^HTTP\/1\.1 403 Forbidden\r\n/);
    assert.equal(response.split('\r\n')[0], 'HTTP/1.1 403 Forbidden');
    assert.equal(response.includes('目标主机'), false);
  } finally {
    await proxy.close();
    await close(target);
  }
});

test('默认拒绝私网地址，显式 fixture host 才能放行', async () => {
  const policy = new NetworkPolicy();
  await assert.rejects(policy.assertAllowed('http://127.0.0.1:4321/'), NetworkPolicyError);
  const allowed = new NetworkPolicy({ allowedHosts: ['127.0.0.1:4321', 'example.test:443'] });
  assert.equal(allowed.hasExplicitHost('http://127.0.0.1:4321/'), true);
  await assert.doesNotReject(allowed.assertAllowed('http://127.0.0.1:4321/'));
  assert.equal(allowed.hasExplicitHost('https://example.test/'), true);
  assert.equal(allowed.hasExplicitHost('http://example.test/'), false);
  assert.equal(allowed.hasExplicitHost('http://example.test:443/'), true);
  assert.equal(allowed.hasExplicitHost('https://example.test:80/'), false);
  const httpOnly = new NetworkPolicy({ allowedHosts: ['example.test'] });
  assert.equal(httpOnly.hasExplicitHost('http://example.test/'), true);
  assert.equal(httpOnly.hasExplicitHost('https://example.test/'), false);
});
