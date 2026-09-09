import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { prepareScrollContent } from '../src/server/page-preparation';

test('短页面提前结束；长页面和持续增长页面有界且恢复原位置', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scenario of ['short', 'long', 'growing']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      try {
        await page.setContent(`<style>html { scroll-behavior: smooth; } body { margin: 0; }</style><div style="height:${scenario === 'short' ? 10 : scenario === 'long' ? 100000 : 1600}px"></div>`);
        if (scenario !== 'short') await page.evaluate("window.scrollTo({ top: 100, behavior: 'instant' })");
        if (scenario === 'growing') await page.evaluate(`addEventListener('scroll', () => {
          if (scrollY + innerHeight >= document.documentElement.scrollHeight - 100) {
            document.querySelector('div').style.height = (document.documentElement.scrollHeight + 600) + 'px';
          }
        })`);
        const before = await page.evaluate('scrollY');
        const started = Date.now();
        await prepareScrollContent(page);
        const elapsed = Date.now() - started;
        assert.equal(await page.evaluate('scrollY'), before, scenario);
        assert.ok(elapsed < (scenario === 'short' ? 4000 : 10000), `${scenario}: ${elapsed}ms`);
        if (scenario === 'growing') assert.ok(await page.evaluate('document.documentElement.scrollHeight > 1600'));
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});

test('预滚动保留延迟揭示页面的内容', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:800}});
    await page.setContent(`<style>body{margin:0}.row{height:640px}</style>${Array.from({length:8},(_,n)=>`<div class="row" data-index="${n}"></div>`).join('')}<script>
      addEventListener('scroll',()=>{
        for (const row of document.querySelectorAll('.row')) {
          if (row.textContent || row.dataset.pending) continue;
          const box=row.getBoundingClientRect();
          if(box.top>=0 && box.top<innerHeight) {
            row.dataset.pending='1';
            setTimeout(()=>{
              const current=row.getBoundingClientRect();
              if(current.top>=0 && current.top<innerHeight) row.textContent='loaded '+row.dataset.index;
              delete row.dataset.pending;
            },250);
          }
        }
      });
    </script>`);
    await prepareScrollContent(page);
    assert.deepEqual(await page.locator('.row').allTextContents(), Array.from({length:8},(_,n)=>`loaded ${n}`));
  } finally {await browser.close();}
});
