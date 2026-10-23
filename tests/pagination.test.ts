import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserService } from '../src/server/browser.js';
import { collectPages, reportSummary } from '../src/server/pagination.js';
import type { PaginationReport, PaginationRules } from '../src/shared/types.js';

const rules = { item: 'article', title: 'h2', link: 'h2 a' };
const items = (prefix: string, count = 3, from = 1) => Array.from({ length: count }, (_, i) => `<article><h2><a href="/a/${prefix}-${from + i}">Item ${prefix}-${from + i}</a></h2></article>`).join('');
const html = (body: string) => `<!doctype html><meta charset="utf-8"><title>Paged fixture</title><body>${body}</body>`;

let server: Server;
let outside: Server;
let host = '';
let outsideHits = 0;
const requests: Array<{ path: string; cookie: string }> = [];

function route(request: IncomingMessage): [number, string] {
  const url = new URL(request.url ?? '/', `http://${host}`);
  const page = Number(url.searchParams.get('page') ?? 1);
  switch (url.pathname) {
    case '/list': {
      // Page 2 repeats an item of page 1; page 3 is the last.
      const list = items(String(page)) + (page === 2 ? items('1', 1) : '');
      return [200, html(`<main>${list}</main>${page < 3 ? `<nav><a class="next" rel="next" href="/list?page=${page + 1}">下一页</a></nav>` : ''}`)];
    }
    case '/t': return page <= 3 ? [200, html(items(`t${page}`))] : [404, html('<p>no such page</p>')];
    case '/evil': return [200, html(`${items('evil')}<a rel="next" href="http://127.0.0.1:${(outside.address() as AddressInfo).port}/secret">下一页</a>`)];
    case '/broken': return page === 3 ? [500, html('<p>server error</p>')] : [200, html(`${items(`b${page}`)}<a rel="next" href="/broken?page=${page + 1}">next</a>`)];
    case '/more': return [200, html(`<main id="list">${items('m')}</main><button id="more" type="button">加载更多</button><script>
      let round = 0;
      document.querySelector('#more').addEventListener('click', () => setTimeout(() => {
        round += 1;
        const list = document.querySelector('#list');
        for (let i = 1; i <= 3; i += 1) list.insertAdjacentHTML('beforeend', '<article><h2><a href="/a/m-' + (round * 3 + i) + '">Item m-' + (round * 3 + i) + '</a></h2></article>');
        if (round === 2) document.querySelector('#more').remove();
      }, 150));
    </script>`)];
    case '/spa': return [200, html(`<main id="list">${items('s1')}</main><button class="pager" type="button">下一页</button><script>
      document.querySelector('.pager').addEventListener('click', event => setTimeout(() => {
        document.querySelector('#list').innerHTML = ${JSON.stringify(items('s2'))};
        event.target.disabled = true;
      }, 150));
    </script>`)];
    default: return [404, html('<p>not found</p>')];
  }
}

before(async () => {
  outside = createServer((_request, response) => { outsideHits += 1; response.end(html(items('secret'))); });
  await new Promise<void>(resolve => outside.listen(0, '127.0.0.1', resolve));
  server = createServer((request, response) => {
    requests.push({ path: request.url ?? '', cookie: request.headers.cookie ?? '' });
    const [status, body] = route(request);
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const item of [server, outside]) { item.closeAllConnections(); await new Promise<void>(resolve => item.close(() => resolve())); }
});

const next = (maxPages: number, selector = 'a[rel~="next"]'): PaginationRules => ({ mode: 'next', maxPages, delayMs: 10, nextSelector: selector });

async function withBrowser(run: (browser: BrowserService) => Promise<void>) {
  const browser = new BrowserService({ allowedHosts: [host] });
  try { await run(browser); } finally { await browser.dispose(); }
}

async function scrape(browser: BrowserService, path: string, pagination: PaginationRules | null, extra: { isKnown?: (link: string) => boolean } = {}) {
  let report: PaginationReport | undefined;
  const result = await browser.scrape({ url: `http://${host}${path}`, waitMs: 0, rules, pagination, ...extra, onReport: value => { report = value; } });
  return { titles: result.map(item => item.title), report: report! };
}

test('“下一页”链接：跨页去重、第 1 页在前、沿用 Cookie，预览与后台抓取结果一致', async () => {
  await withBrowser(async browser => {
    requests.length = 0;
    const cookies = [{ name: 'sid', value: 'fixture', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const }];
    let report: PaginationReport | undefined;
    const background = await browser.scrape({ url: `http://${host}/list?page=1`, waitMs: 0, rules, cookies, pagination: next(5), onReport: value => { report = value; } });
    assert.deepEqual(background.map(item => item.title), ['1', '2', '3'].flatMap(page => [1, 2, 3].map(i => `Item ${page}-${i}`)));
    assert.equal(report!.stop, 'end');
    assert.equal(report!.stoppedAt, 3);
    assert.deepEqual(report!.pages.map(page => [page.page, page.count, page.added]), [[1, 3, 3], [2, 4, 3], [3, 3, 3]]);
    assert.match(reportSummary(report!), /^共 3 页（3 \+ 3 \+ 3 条）；第 3 页没有找到下一页链接或按钮/);
    const pageRequests = requests.filter(item => item.path.startsWith('/list'));
    assert.deepEqual(pageRequests.map(item => item.path), ['/list?page=1', '/list?page=2', '/list?page=3']);
    assert.ok(pageRequests.every(item => item.cookie.includes('sid=fixture')), '每一页都应携带订阅的 Cookie');

    const frame = await browser.open({ url: `http://${host}/list?page=1`, waitMs: 0, cookies });
    const preview = await browser.paginate(frame.sessionId, rules, next(5));
    assert.deepEqual(preview.items, background);
    assert.deepEqual(preview.report.pages.map(page => page.added), [3, 3, 3]);
    assert.equal((await browser.snapshot(frame.sessionId)).url, `http://${host}/list?page=1`, '编辑器画面仍停在第 1 页');
    const limited = await browser.paginate(frame.sessionId, rules, next(2));
    assert.equal(limited.items.length, 6);
    assert.equal(limited.report.stop, 'max');
    assert.equal(limited.report.message, '已达到最多 2 页');
    // The pick picks the next link as a reusable selector.
    const node = frame.map!.labels.findIndex(label => label.startsWith('a.next'));
    const picked = await browser.pick(frame.sessionId, { node, target: 'next' });
    assert.equal(picked.selector, 'a[rel~="next"]');
    assert.equal(picked.warning, undefined);

    const single = await scrape(browser, '/list?page=1', null);
    assert.equal(single.titles.length, 3);
    assert.equal(single.report.stop, 'single');
  });
});

test('URL 模板按起始页码和步长生成后续页，遇到 404 时结束', async () => {
  await withBrowser(async browser => {
    const { titles, report } = await scrape(browser, '/t?page=1', { mode: 'template', maxPages: 6, delayMs: 10, urlTemplate: `http://${host}/t?page={n}`, start: 2, step: 1 });
    assert.deepEqual(titles, ['t1', 't2', 't3'].flatMap(page => [1, 2, 3].map(i => `Item ${page}-${i}`)));
    assert.equal(report.stop, 'end');
    assert.equal(report.stoppedAt, 4);
    assert.match(report.message, /第 4 页不存在（HTTP 404）/);
    const stepped = await scrape(browser, '/t?page=1', { mode: 'template', maxPages: 6, delayMs: 10, urlTemplate: `http://${host}/t?page={n}`, start: 3, step: 2 });
    assert.deepEqual(stepped.report.pages.map(page => page.url.replace(/.*page=/, '')), ['1', '3', '5']);
  });
});

test('指向内网的“下一页”被网络安全策略拦截，保留第 1 页', async () => {
  await withBrowser(async browser => {
    outsideHits = 0;
    const { titles, report } = await scrape(browser, '/evil', next(3));
    assert.deepEqual(titles, ['Item evil-1', 'Item evil-2', 'Item evil-3']);
    assert.equal(report.stop, 'blocked');
    assert.match(report.message, /第 2 页被网络安全策略拦截/);
    assert.equal(outsideHits, 0, '内网地址不应收到任何请求');
  });
});

test('中途某页失败时保留已抓到的条目，并标明第几页失败', async () => {
  await withBrowser(async browser => {
    const { titles, report } = await scrape(browser, '/broken?page=1', next(5));
    assert.equal(titles.length, 6);
    assert.equal(report.stop, 'failed');
    assert.equal(report.stoppedAt, 3);
    assert.match(report.message, /^第 3 页失败：目标网页返回 HTTP 500，已保留前 2 页的条目$/);
    assert.ok(report.pages[2].error);
    await assert.rejects(browser.scrape({ url: `http://${host}/broken?page=3`, waitMs: 0, rules, pagination: next(5) }), /HTTP 500/, '第 1 页失败时整体失败');
  });
});

test('增量停止：一页的条目都已见过时不再往后翻', async () => {
  await withBrowser(async browser => {
    requests.length = 0;
    const seenSecond = await scrape(browser, '/list?page=1', next(5), { isKnown: link => link.includes('/a/2-') });
    assert.equal(seenSecond.report.stop, 'known');
    assert.equal(seenSecond.report.stoppedAt, 2);
    assert.equal(seenSecond.titles.length, 6);
    requests.length = 0;
    const seenFirst = await scrape(browser, '/list?page=1', next(5), { isKnown: link => link.includes('/a/1-') });
    assert.equal(seenFirst.report.stop, 'known');
    assert.equal(seenFirst.report.message, '第 1 页的条目都已见过，不再翻页');
    assert.deepEqual(requests.map(item => item.path), ['/list?page=1']);
  });
});

test('“加载更多”按钮在同一页追加内容，按钮消失后结束', async () => {
  await withBrowser(async browser => {
    const { titles, report } = await scrape(browser, '/more', { mode: 'loadMore', maxPages: 5, delayMs: 10, nextSelector: '#more' });
    assert.deepEqual(titles, Array.from({ length: 9 }, (_, i) => `Item m-${i + 1}`));
    assert.deepEqual(report.pages.map(page => page.added), [3, 3, 3]);
    assert.equal(report.stop, 'end');
  });
});

test('没有链接的“下一页”按钮通过点击翻页，按钮禁用后结束', async () => {
  await withBrowser(async browser => {
    const { titles, report } = await scrape(browser, '/spa', next(5, 'button.pager'));
    assert.deepEqual(titles, ['s1', 's2'].flatMap(page => [1, 2, 3].map(i => `Item ${page}-${i}`)));
    assert.equal(report.stop, 'end');
    assert.match(report.message, /已禁用/);
  });
});

test('单次抓取有总时长上限，超出时停在已抓到的页', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://${host}/list?page=1`);
    let loads = 0;
    const result = await collectPages(page, {
      rules, pagination: next(5), budgetMs: 5, settle: async () => {}, assertAllowed: async () => undefined,
      load: async url => { loads += 1; await page.goto(url); }, sleep: async () => {},
    });
    assert.equal(result.items.length, 3);
    assert.equal(result.report.stop, 'budget');
    assert.equal(loads, 0);
  } finally { await browser.close(); }
});
