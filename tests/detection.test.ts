import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';

import { detectPage } from '../src/server/detection';

let browser: Browser | undefined;
let browserError: unknown;

test.before(async () => {
  try {
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
  } catch (error) {
    browserError = error;
    if (process.env.SKIP_BROWSER_TESTS !== '1') throw error;
  }
});

test.after(async () => {
  await browser?.close();
});

async function newPage(t: { skip: (message?: string) => void }): Promise<Page | undefined> {
  if (!browser) {
    if (process.env.SKIP_BROWSER_TESTS !== '1') {
      throw browserError instanceof Error ? browserError : new Error('Chromium unavailable');
    }
    t.skip(`Chromium unavailable${browserError instanceof Error ? `: ${browserError.message}` : ''}`);
    return undefined;
  }
  return browser.newPage({ viewport: { width: 1_280, height: 900 } });
}

async function setFixture(page: Page, html: string, url: string): Promise<void> {
  // Keep page.setContent fixtures deterministic while giving the extractor an
  // HTTP(S) page URL for resolving relative links.
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto(url);
  await page.unroute('**/*');
  await page.setContent(html);
}

const semanticFixture = `
  <base href="https://example.test/news">
  <nav><ul><li><a href="/home">首页</a></li><li><a href="/about">关于</a></li><li><a href="/help">帮助</a></li></ul></nav>
  <main id="feed">
    <article class="post card"><h2 class="title"><a href="/story/1">第一篇新闻</a></h2><p class="summary">第一篇摘要内容足够长，可以被识别为摘要。</p><img data-src="/images/1.jpg"><time datetime="2026-09-01">2026-09-01</time></article>
    <article class="post card"><h2 class="title"><a href="/story/2">第二篇新闻</a></h2><p class="summary">第二篇摘要内容足够长，可以被识别为摘要。</p><img data-src="/images/2.jpg"><time datetime="2026-09-02">2026-09-02</time></article>
    <article class="post card"><h2 class="title"><a href="/story/3">第三篇新闻</a></h2><p class="summary">第三篇摘要内容足够长，可以被识别为摘要。</p><img data-src="/images/3.jpg"><time datetime="2026-09-03">2026-09-03</time></article>
    <article class="post card"><h2 class="title"><a href="/story/4">第四篇新闻</a></h2><p class="summary">第四篇摘要内容足够长，可以被识别为摘要。</p><img data-src="/images/4.jpg"><time datetime="2026-09-04">2026-09-04</time></article>
  </main>`;

test('保存的列表规则不扩展到页脚，摘要与同级日期段落分别提取', async (t) => {
  const page = await newPage(t);
  if (!page) return;
  try {
    const cards = [1, 2, 3, 4].map(n => `<a class="card" href="/post/${n}"><div><h2>Article ${n}</h2><p class="date">2026年9月${n}日</p><p>This is the full article summary number ${n}.</p></div></a>`).join('');
    await setFixture(page, `<main>${cards}<section><p><a href="/one">one</a></p><p><a href="/two">two</a></p><p><a href="/three">three</a></p></section></main><footer><p><a href="/theme">Theme author</a></p></footer>`, 'https://example.test/');
    const result = await detectPage(page);
    assert.ok(result.candidates.every(candidate => candidate.items.every(item => item.title !== 'Theme author')));
    const candidate = result.candidates.find(entry => entry.items[0]?.title === 'Article 1')!;
    assert.ok(candidate);
    assert.equal(candidate.items[0].description, 'This is the full article summary number 1.');
    assert.equal(candidate.items[0].publishedAt, '2026-09-01T00:00:00.000Z');
  } finally { await page.close(); }
});

test('自动识别语义化文章列表并提取可选字段', async (t) => {
  const page = await newPage(t);
  if (!page) return;
  try {
    await setFixture(page, semanticFixture, 'https://example.test/news');
    const result = await detectPage(page);
    assert.ok(result.candidates.length >= 1);
    assert.ok(result.recommendedId);
    const candidate = result.candidates.find((item) => item.id === result.recommendedId) ?? result.candidates[0];
    assert.equal(candidate.confidence, 'high');
    assert.ok(candidate.rules.item.includes('article'));
    assert.ok(candidate.rules.title.includes(':scope'));
    assert.ok(candidate.rules.link.includes(':scope'));
    assert.equal(candidate.items.length, 4);
    assert.equal(candidate.items[0]?.title, '第一篇新闻');
    assert.equal(candidate.items[0]?.link, 'https://example.test/story/1');
    assert.equal(candidate.items[0]?.image, 'https://example.test/images/1.jpg');
    assert.equal(candidate.items[0]?.publishedAt, '2026-09-01T00:00:00.000Z');
    assert.equal(candidate.items[0]?.description, '第一篇摘要内容足够长，可以被识别为摘要。');
  } finally {
    await page.close();
  }
});

test('标题推断跳过日期和类别元信息，选择条目内的主标题链接', async (t) => {
  const page = await newPage(t);
  if (!page) return;
  try {
    await setFixture(page, `
      <base href="https://example.test/changelog">
      <main class="feed">
        <article class="entry">
          <h3 class="entry-meta"><time datetime="2026-09-04">Sep.04</time><span class="entry-category">Release</span></h3>
          <div class="entry-content"><a class="entry-title" href="/one">真正的第一篇标题</a></div>
        </article>
        <article class="entry">
          <h3 class="entry-meta"><time datetime="2026-09-03">Sep.03</time><span class="entry-category">Release</span></h3>
          <div class="entry-content"><a class="entry-title" href="/two">真正的第二篇标题</a></div>
        </article>
        <article class="entry">
          <h3 class="entry-meta"><time datetime="2026-09-02">Sep.02</time><span class="entry-category">Release</span></h3>
          <div class="entry-content"><a class="entry-title" href="/three">真正的第三篇标题</a></div>
        </article>
      </main>`, 'https://example.test/changelog');
    const result = await detectPage(page);
    const candidate = result.candidates.find((item) => item.rules.item.includes('article.entry')) ?? result.candidates[0];
    assert.ok(candidate);
    assert.deepEqual(candidate.items.map((item) => item.title), ['真正的第一篇标题', '真正的第二篇标题', '真正的第三篇标题']);
    assert.ok(candidate.rules.title.includes('entry-title'));
    assert.ok(!candidate.items.some((item) => item.title.includes('Sep.')));
    assert.equal(candidate.confidence, 'high');
  } finally {
    await page.close();
  }
});

test('发现条目中有缺失字段或重复元信息时降低可信度', async (t) => {
  const page = await newPage(t);
  if (!page) return;
  try {
    await setFixture(page, `
      <base href="https://example.test/incomplete">
      <main class="feed">
        <article class="entry">
          <h3 class="entry-meta"><time datetime="2026-09-04">Sep.04</time><span>Release</span></h3>
          <a class="entry-title" href="/one">相同的元信息</a>
        </article>
        <article class="entry">
          <h3 class="entry-meta"><time datetime="2026-09-03">Sep.03</time><span>Release</span></h3>
          <a class="entry-title" href="/two">相同的元信息</a>
        </article>
        <article class="entry">
          <h3 class="entry-meta"><time datetime="2026-09-02">Sep.02</time><span>Release</span></h3>
          <span class="entry-title">相同的元信息</span>
        </article>
      </main>`, 'https://example.test/incomplete');
    const result = await detectPage(page);
    const candidate = result.candidates.find((item) => item.rules.item.includes('article.entry')) ?? result.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.count, 2);
    assert.notEqual(candidate.confidence, 'high');
    assert.ok(candidate.warnings.some((warning) => warning.includes('覆盖率不足')));
    assert.ok(candidate.warnings.some((warning) => warning.includes('标题重复较多')));
  } finally {
    await page.close();
  }
});

test('识别无语义 class 的 HN 风格 tr 列表和相对链接', async (t) => {
  const page = await newPage(t);
  if (!page) return;
  try {
    await setFixture(page, `
      <base href="https://news.ycombinator.com/news">
      <table><tbody>
        <tr class="athing"><td class="title"><span class="titleline"><a href="item?id=1">Story one</a></span></td></tr>
        <tr class="athing"><td class="title"><span class="titleline"><a href="item?id=2">Story two</a></span></td></tr>
        <tr class="athing"><td class="title"><span class="titleline"><a href="item?id=3">Story three</a></span></td></tr>
        <tr class="athing"><td class="title"><span class="titleline"><a href="item?id=4">Story four</a></span></td></tr>
      </tbody></table>`, 'https://news.ycombinator.com/news');
    const result = await detectPage(page);
    const candidate = result.candidates.find((item) => item.rules.item.includes('athing')) ?? result.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.items.length, 4);
    assert.equal(candidate.items[0]?.link, 'https://news.ycombinator.com/item?id=1');
    assert.equal(candidate.items[0]?.title, 'Story one');
    assert.ok(candidate.rules.title.includes(':scope'));
    assert.ok(candidate.rules.link.includes(':scope'));
    assert.ok(!Object.values(candidate.rules).some((selector) => selector.includes('nth-child')));
  } finally {
    await page.close();
  }
});

test('支持条目本身就是链接的非语义卡片', async (t) => {
  const page = await newPage(t);
  if (!page) return;
  try {
    await setFixture(page, `
      <main id="cards">
        <a class="tile" href="/tile/1">卡片一</a>
        <a class="tile" href="/tile/2">卡片二</a>
        <a class="tile" href="/tile/3">卡片三</a>
        <a class="tile" href="/tile/4">卡片四</a>
      </main>`, 'https://example.test/tiles');
    const result = await detectPage(page);
    const candidate = result.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.items.length, 4);
    assert.equal(candidate.items[0]?.title, '卡片一');
    assert.equal(candidate.items[0]?.link, 'https://example.test/tile/1');
    assert.equal(candidate.rules.title, ':scope');
    assert.equal(candidate.rules.link, ':scope');
  } finally {
    await page.close();
  }
});

test('动态渲染完成后识别列表，并且检测不修改 DOM', async (t) => {
  const page = await newPage(t);
  if (!page) return;
  try {
    await setFixture(page, `
      <base href="https://example.test/dynamic">
      <main id="dynamic-feed"></main>
      <script>
        setTimeout(() => {
          document.querySelector('#dynamic-feed').innerHTML = [1,2,3,4].map((id) =>
            '<div class="result-card"><a class="headline" href="/dynamic/' + id + '">动态条目 ' + id + '</a></div>'
          ).join('');
        }, 10);
      </script>`, 'https://example.test/dynamic');
    await page.waitForTimeout(80);
    const before = await page.evaluate(() => document.documentElement.outerHTML);
    const result = await detectPage(page);
    const after = await page.evaluate(() => document.documentElement.outerHTML);
    assert.equal(after, before);
    assert.ok(result.candidates.length >= 1);
    const candidate = result.candidates[0];
    assert.equal(candidate.items.length, 4);
    assert.equal(candidate.items[0]?.link, 'https://example.test/dynamic/1');
  } finally {
    await page.close();
  }
});

test('多个相近列表不强行推荐，并保留人工选择候选', async (t) => {
  const page = await newPage(t);
  if (!page) return;
  try {
    const makeCards = (prefix: string, className: string) => [1, 2, 3, 4].map((id) =>
      `<article class="${className}"><h2><a href="/${prefix}/${id}">${prefix} ${id}</a></h2></article>`).join('');
    await setFixture(page, `<base href="https://example.test/">${makeCards('news', 'news-card')}${makeCards('video', 'video-card')}`, 'https://example.test/');
    const result = await detectPage(page);
    assert.ok(result.candidates.length >= 2);
    assert.equal(result.recommendedId, null);
    assert.ok(result.warnings.some((warning) => warning.includes('多个') || warning.includes('可信度')));
  } finally {
    await page.close();
  }
});

test('没有重复内容列表时返回可操作的警告而不是抛错', async (t) => {
  const page = await newPage(t);
  if (!page) return;
  try {
    await setFixture(page, '<main><h1>只有一个页面标题</h1><a href="/single">单个链接</a></main>', 'https://example.test/single');
    const result = await detectPage(page);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.recommendedId, null);
    assert.ok(result.warnings.length > 0);
  } finally {
    await page.close();
  }
});

test('论坛卡片优先正文标题和直属日期，排除侧栏推荐', async t => {
  const page = await newPage(t); if (!page) return;
  try {
    await setFixture(page, `<style>.frow{display:block;padding:12px}.fbody,.fttl,.fmeta{display:block}</style>
      <div id="fresh-root">${Array.from({length:5},(_,i)=>`<a class="frow" href="/post/${i}"><span class="flead">${i+1}</span><span class="fbody"><span class="fttl">刚刚发布的论坛文章 ${i}</span><span class="fmeta"><span class="ftag">AI</span><span class="fsrc">NodeSeek</span><span>·</span>${i+2} 分钟前</span></span></a>`).join('')}</div>
      <div class="site-sidebar">${Array.from({length:8},(_,i)=>`<a href="/tool/${i}"><h2>工具推荐 ${i}</h2></a>`).join('')}</div>`, 'https://example.test/intel');
    const result = await detectPage(page);
    const candidate = result.candidates.find(c=>c.id===result.recommendedId);
    assert.ok(candidate, JSON.stringify(result));
    assert.match(candidate.rules.title,/fttl/);assert.match(candidate.rules.date!,/fmeta/);
    assert.equal(candidate.items.length,5);
    assert.ok(candidate.items.every(item=>item.title.startsWith('刚刚发布的论坛文章') && item.publishedAt && item.publishedAtSource==='relative'));
    assert.ok(result.candidates.every(c=>c.items.every(item=>!item.link.includes('/tool/'))));
  } finally {await page.close();}
});
