import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { BrowserService } from '../src/server/browser.js';

test('后台抓取拒绝带有有效列表的 HTTP 401 页面，编辑器仍可显示错误页', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'Content-Type': 'text/html' });
    response.end('<title>Authentication required</title><article><h2>Recommended public item</h2><a href="/item">Read</a></article>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = new BrowserService({ allowedHosts: [host] });
  try {
    const frame = await browser.open({ url: `http://${host}`, waitMs: 0 });
    assert.equal(frame.title, 'Authentication required');
    await browser.close(frame.sessionId);
    await assert.rejects(browser.scrape({ url: `http://${host}`, waitMs: 0, rules: { item: 'article', title: 'h2', link: 'a' } }), /HTTP 401/);
  } finally {
    await browser.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
