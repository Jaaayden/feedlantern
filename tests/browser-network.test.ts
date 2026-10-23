import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserService } from '../src/server/browser.js';
import type { FetchNetworkOptions } from '../src/server/fetch-options.js';
import { closedPort, startHttpProxy, startSocksProxy, startTarget } from './proxy-fixtures.js';

test('Chromium 每个上下文独立使用自己的代理、UA、Referer 和请求头，不串用也不影响启动参数', async () => {
  const third = await startTarget((_request, response) => { response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); });
  const target = await startTarget((request, response) => {
    const from = new URL(request.url ?? '/', 'http://x').searchParams.get('p') ?? 'none';
    if (request.url?.startsWith('/same.svg')) { response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<title>${from}</title><main>${[1, 2, 3].map(n => `<article><h2><a href="/item/${n}">Item ${n}</a></h2></article>`).join('')}</main><img src="/same.svg?p=${from}"><img src="http://localhost:${third.port}/pixel.svg?p=${from}">`);
  });
  const proxyA = await startHttpProxy({ username: 'user-a', password: 'pass-a' });
  const proxyB = await startSocksProxy({ username: 'user-b', password: 'pass-b' });
  const launches: unknown[] = [];
  const originalLaunch = chromium.launch;
  chromium.launch = (async function (this: typeof chromium, options?: Parameters<typeof chromium.launch>[0]) {
    launches.push(options);
    return originalLaunch.call(this, options);
  }) as typeof chromium.launch;
  const browser = new BrowserService({ allowedHosts: [target.host, `localhost:${third.port}`, `127.0.0.1:${proxyA.port}`, `127.0.0.1:${proxyB.port}`] });
  const networkA: FetchNetworkOptions = { proxy: { type: 'http', host: '127.0.0.1', port: proxyA.port, username: 'user-a', password: 'pass-a' }, userAgent: 'FeedLanternTest-A', referer: 'https://ref-a.test/', headers: [{ name: 'X-Token', value: 'token-a' }] };
  const networkB: FetchNetworkOptions = { proxy: { type: 'socks5', host: '127.0.0.1', port: proxyB.port, username: 'user-b', password: 'pass-b' }, userAgent: 'FeedLanternTest-B', headers: [{ name: 'X-Token', value: 'token-b' }] };
  try {
    const [frameA, frameB] = await Promise.all([
      browser.open({ url: `http://${target.host}/?p=a`, waitMs: 300, network: networkA }),
      browser.open({ url: `http://${target.host}/?p=b`, waitMs: 300, network: networkB }),
    ]);
    assert.equal(frameA.title, 'a');
    assert.equal(frameB.title, 'b');
    const items = await browser.scrape({ url: `http://${target.host}/?p=none`, waitMs: 300, rules: { item: 'article', title: 'h2', link: 'a' } });
    assert.equal(items.length, 3);
    await browser.close(frameA.sessionId);
    await browser.close(frameB.sessionId);

    const byProfile = (p: string) => target.requests.filter(r => r.path.includes(`p=${p}`));
    const thirdBy = (p: string) => third.requests.filter(r => r.path.includes(`p=${p}`));
    for (const [p, ua, token] of [['a', 'FeedLanternTest-A', 'token-a'], ['b', 'FeedLanternTest-B', 'token-b']] as const) {
      assert.ok(byProfile(p).length >= 2, `${p}: page and same-site image`);
      for (const request of byProfile(p)) {
        assert.equal(request.headers['user-agent'], ua);
        assert.equal(request.headers['x-token'], token);
        assert.equal(request.headers['proxy-authorization'], undefined);
      }
      assert.ok(thirdBy(p).length >= 1);
      for (const request of thirdBy(p)) {
        assert.equal(request.headers['user-agent'], ua);
        assert.equal(request.headers['x-token'], undefined, '自定义请求头不能发给第三方资源');
      }
    }
    assert.equal(byProfile('a').find(r => r.path === '/?p=a')?.headers.referer, 'https://ref-a.test/');
    assert.equal(byProfile('b').find(r => r.path === '/?p=b')?.headers.referer, undefined);
    for (const request of [...byProfile('none'), ...thirdBy('none')]) {
      assert.doesNotMatch(String(request.headers['user-agent']), /FeedLanternTest/);
      assert.equal(request.headers['x-token'], undefined);
    }
    // Every request of a profile went through that profile's proxy, with its
    // own login, and nothing else did.
    assert.equal(proxyA.log.length, byProfile('a').length + thirdBy('a').length);
    assert.equal(proxyB.log.length, byProfile('b').length + thirdBy('b').length);
    assert.ok(proxyA.log.every(entry => entry.auth === `Basic ${Buffer.from('user-a:pass-a').toString('base64')}`));
    assert.ok(proxyB.log.every(entry => entry.user === 'user-b'));

    // Profiles do not relaunch Chromium or change its sandbox and network flags.
    assert.equal(launches.length, 1);
    const options = launches[0] as { chromiumSandbox?: boolean; args?: string[] };
    assert.equal(options.chromiumSandbox, true);
    assert.ok(options.args?.includes('--disable-quic'));
    assert.ok(options.args?.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
    assert.equal(browser.contextOptions(undefined, networkA).proxy, undefined);
    assert.equal('userAgent' in browser.contextOptions(undefined, {}), false);
  } finally {
    chromium.launch = originalLaunch;
    await browser.dispose();
    await proxyA.close(); await proxyB.close(); await target.close(); await third.close();
  }
});

test('Chromium 经代理失败时给出代理原因；未加入白名单的内网代理在启动页面前被拒绝', async () => {
  const target = await startTarget((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>ok</title>'); });
  const deadPort = await closedPort();
  const proxy = await startHttpProxy({ username: 'u', password: 'right' });
  const browser = new BrowserService({ allowedHosts: [target.host, `127.0.0.1:${deadPort}`, `127.0.0.1:${proxy.port}`] });
  try {
    const rules = { item: 'article', title: 'h2', link: 'a' };
    await assert.rejects(browser.scrape({ url: `http://${target.host}/`, waitMs: 0, rules, network: { proxy: { type: 'http', host: '127.0.0.1', port: deadPort, username: 'u', password: 'secret-pass' } } }),
      (error: Error) => /通过代理访问失败：无法连接代理服务器 127\.0\.0\.1:\d+（HTTP 代理）：连接被拒绝/.test(error.message) && !error.message.includes('secret-pass'));
    await assert.rejects(browser.open({ url: `http://${target.host}/`, waitMs: 0, network: { proxy: { type: 'http', host: '127.0.0.1', port: proxy.port, username: 'u', password: 'wrong' } } }),
      /通过代理访问失败：代理认证失败（HTTP 407）/);
    await assert.rejects(browser.scrape({ url: `http://${target.host}/`, waitMs: 0, rules, network: { proxy: { type: 'socks5', host: '10.20.30.40', port: 1080 } } }), /安全策略阻止/);
    assert.equal(target.requests.length, 0);
  } finally {
    await browser.dispose();
    await proxy.close(); await target.close();
  }
});
