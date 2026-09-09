import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { extractPage } from '../src/server/extraction.js';

test('本站渲染页面抽取原始时间戳，缺失项回退，空规则跳过；其他域名不适配', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    const reference = Date.parse('2026-09-09T12:00:00Z');
    const html = `<meta charset="utf-8"><script>var BOOT = ${JSON.stringify({ now: reference / 1000, first: { items: [{ u: 'https://example.test/1', a: reference / 1000 - 210 }] } })};</script>
      <a class="frow" href="https://example.test/1"><b>第一条</b><span class="fmeta"><span>NodeSeek</span>3分前</span></a>
      <a class="frow" href="https://example.test/2"><b>第二条</b><span class="fmeta"><span>NodeSeek</span>3分前</span></a>`;
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('https://n.mumingfang.com/intel');
    const rules = { item: '.frow', title: 'b', link: ':scope', date: '.fmeta' };
    const result = await extractPage(page, rules);
    assert.equal(result[0].publishedAt, '2026-09-09T11:56:30.000Z');
    assert.equal(result[0].publishedAtSource, 'absolute');
    assert.equal(result[1].publishedAt, '2026-09-09T11:57:00.000Z');
    assert.equal(result[1].publishedAtSource, 'relative');
    assert.deepEqual(await extractPage(page, rules), result);
    assert.ok((await extractPage(page, { ...rules, date: '' })).every(i => !i.publishedAt));
    await page.goto('https://example.test/intel');
    assert.ok((await extractPage(page, rules)).every(i => i.publishedAtSource === 'relative'));
  } finally { await browser.close(); }
});
