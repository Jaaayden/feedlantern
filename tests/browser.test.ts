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

const revealFixture = `<!doctype html><style>
  body { margin: 0; } .hero { height: 1000px; }
  .list li { height: 140px; } .wow { visibility: hidden; }
</style><title>scrollY:0</title>
<div class="hero">Banner</div>
<div class="leftDiv fl">
  <div class="thirdLink fl"><ul>${[1, 2, 3].map(n => `<li><a href="/category/${n}">栏目 ${n}</a></li>`).join('')}</ul></div>
  <div class="list"><ul>${Array.from({ length: 8 }, (_, n) => `<li class="wow fadeInUp50"><a href="/article/${n + 1}"><div class="name">第 ${n + 1} 条招生简章</div><div class="time">2026-05-${String(n + 1).padStart(2, '0')}</div></a></li>`).join('')}</ul></div>
</div>
<div style="display:none"><ul><li><a href="/hidden/1">隐藏 1</a></li><li><a href="/hidden/2">隐藏 2</a></li><li><a href="/hidden/3">隐藏 3</a></li></ul></div>
<footer><ul><li><a href="/footer/1">页脚 1</a></li><li><a href="/footer/2">页脚 2</a></li><li><a href="/footer/3">页脚 3</a></li></ul></footer>
<script>
  addEventListener('scroll', () => {
    document.title = 'scrollY:' + scrollY;
    for (const row of document.querySelectorAll('.wow')) {
      const rect = row.getBoundingClientRect();
      if (rect.top < innerHeight && rect.bottom > 0) {
        row.style.visibility = 'visible'; row.classList.add('animated');
      }
    }
  });
</script>`;

test('滚动揭示正文列表，编辑器与批量识别、后台刷新保持一致', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(revealFixture);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = new BrowserService({ allowedHosts: [host] });
  try {
    const options = { url: `http://${host}`, waitMs: 0 };
    const frame = await browser.open(options);
    assert.equal(frame.title, 'scrollY:0', '截图前应恢复页面顶部');
    const detection = await browser.detect(frame.sessionId);
    const candidate = detection.candidates.find(c => c.id === detection.recommendedId);
    assert.ok(candidate, JSON.stringify(detection));
    assert.equal(candidate.count, 8);
    assert.ok(candidate.items.every(item => item.link.includes('/article/')));
    assert.ok(Object.values(candidate.rules).every(selector => !selector.includes('animated')));
    const preview = await browser.extract(frame.sessionId, candidate.rules);
    assert.deepEqual(preview.map(item => item.title), Array.from({ length: 8 }, (_, n) => `第 ${n + 1} 条招生简章`));
    assert.equal(preview[0].publishedAt, '2026-05-01T00:00:00.000Z');
    await browser.close(frame.sessionId);
    assert.deepEqual(await browser.scrape({ ...options, rules: candidate.rules }), preview);
    const discovered = await browser.discover(options);
    assert.deepEqual(discovered.detection.candidates.find(c => c.id === discovered.detection.recommendedId)?.items, preview);
  } finally {
    await browser.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('裸文本日期点选保留容器选择器，展示解析结果并与自动识别一致', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><style>body{margin:0}.frow{display:block;height:70px}.fttl,.fmeta{display:block;height:25px}</style>
      ${[1, 2, 3].map(n => `<a class="frow" href="/post-${n}"><span class="fttl">论坛新鲜事标题 ${n}</span><span class="fmeta"><span>猎奇</span><span>NodeSeek</span> · 3分前</span></a>`).join('')}`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = new BrowserService({ allowedHosts: [host] });
  try {
    const options = { url: `http://${host}`, waitMs: 0 };
    const frame = await browser.open(options);
    const pick = await browser.pick(frame.sessionId, { x: 150, y: 36, target: 'date', itemSelector: 'a.frow' });
    assert.equal(pick.count, 3);
    assert.ok(pick.selector.includes('.fmeta'));
    assert.equal(pick.datePreview?.dateText, '3分前');
    assert.equal(pick.datePreview?.publishedAtSource, 'relative');
    assert.match(pick.warning!, /已从选中区域提取时间/);
    const rules = { item: 'a.frow', title: '.fttl', link: ':scope', date: pick.selector };
    const preview = await browser.extract(frame.sessionId, rules);
    assert.equal(preview[0].publishedAt, pick.datePreview?.publishedAt);
    assert.deepEqual(await browser.extract(frame.sessionId, rules), preview, '同一页面重复预览保持基准不变');
    const detection = await browser.detect(frame.sessionId);
    assert.ok(detection.candidates.some(c => c.items.length === 3 && c.items.every(i => i.publishedAtSource === 'relative')), JSON.stringify(detection));
    const scrape = await browser.scrape({ ...options, rules });
    assert.ok(scrape.every(i => i.publishedAtSource === 'relative'));
    assert.deepEqual(scrape.map(i => i.link), preview.map(i => i.link));
    assert.ok(Math.abs(Date.parse(scrape[0].publishedAt!) - Date.parse(preview[0].publishedAt!)) < 30000);
    assert.ok((await browser.extract(frame.sessionId, { ...rules, date: '' })).every(i => !i.publishedAt));
  } finally {
    await browser.dispose(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
