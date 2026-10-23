import { expect, test } from './fixtures';
import type { FetchLogPage, ScreenFrame } from '../../src/shared/types';
import { FIXTURE_URLS, STATIC_RULES, locatorForUrl, loginAsAdmin, loginInPage, protocolHeaders } from './support';

test('点选“下一页”、试抓多页并保存，抓取日志显示每页结果', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginInPage(page);
  await page.getByRole('button', { name: '新建订阅', exact: true }).click();
  await (await locatorForUrl(page)).fill(`${FIXTURE_URLS.paged}?page=1`);
  const opened = page.waitForResponse(response => new URL(response.url()).pathname === '/api/browser' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '打开并自动识别', exact: true }).click();
  const openResponse = await opened;
  const csrfToken = openResponse.request().headers()['x-csrf-token'];
  const frame = await openResponse.json() as ScreenFrame;
  await expect(page.getByText('Paged 1-1').first()).toBeVisible({ timeout: 45_000 });

  const panel = page.getByRole('region', { name: '多页采集' });
  await expect(panel.getByLabel('翻页方式')).toHaveValue('none');
  await panel.getByLabel('翻页方式').selectOption('next');
  await expect(panel.getByRole('button', { name: '试抓多页' })).toBeDisabled();
  await panel.getByRole('button', { name: '在网页上点选' }).click();
  await expect(page.getByText(/点击网页中的下一页链接或按钮/)).toBeVisible();

  // Pick the "Next page" link on the screenshot, using the element map the server returned.
  const image = page.locator('.browser-screen img').first();
  await expect(image).toBeVisible();
  const scale = (await image.boundingBox())!.width / 1280;
  const node = Number(Object.entries(frame.map!.links).find(([, href]) => href.endsWith('/paged?page=2'))![0]);
  const [x, y, width, height] = frame.map!.boxes.slice(node * 5, node * 5 + 4);
  await image.click({ position: { x: (x + width / 2) * scale, y: (y + height / 2) * scale } });
  await expect(panel.getByLabel('翻页选择器')).toHaveValue('a[rel~="next"]');
  await expect(page.getByText(/下一页链接或按钮匹配 1 项/)).toBeVisible();

  await panel.getByLabel('最多页数').fill('5');
  await panel.getByLabel('每页间隔').fill('2');
  await panel.getByRole('button', { name: '试抓多页' }).click();
  const report = panel.getByRole('status', { name: '翻页结果' });
  await expect(report).toContainText('第 3 页', { timeout: 60_000 });
  await expect(report).toContainText('第 3 页没有找到下一页链接或按钮，翻页结束');
  await expect(page.getByText('Paged 3-3').first()).toBeVisible();
  const order = await page.locator('.preview-item .item-title a').allTextContents();
  expect(order.slice(0, 9)).toEqual(['1', '2', '3'].flatMap(n => [1, 2, 3].map(i => `Paged ${n}-${i}`)));
  await page.screenshot({ path: 'test-results/visual-qa/editor-pagination.png', fullPage: true });

  await page.locator('.save-panel .field input').first().fill('多页采集验收');
  await page.getByRole('button', { name: '保存订阅', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '运行日志', exact: true })).toBeVisible({ timeout: 60_000 });
  await dialog.getByRole('button', { name: '运行日志', exact: true }).click();
  const logs = dialog.getByRole('region', { name: '抓取日志' });
  await expect(logs.locator('article').first()).toContainText('翻页：共 3 页（3 + 3 + 3 条）');
  await expect(logs.locator('article').first()).toContainText('有效 9 条');
  await dialog.getByRole('button', { name: '关闭' }).last().click();

  // Editing keeps the saved pagination.
  const feeds = await (await page.request.get('/api/feeds')).json() as Array<{ id: string; name: string; pagination?: { mode: string; maxPages: number; delayMs: number } }>;
  const saved = feeds.find(feed => feed.name === '多页采集验收')!;
  expect(saved.pagination).toMatchObject({ mode: 'next', maxPages: 5, delayMs: 2000, nextSelector: 'a[rel~="next"]' });
  await page.request.delete(`/api/feeds/${saved.id}`, { headers: protocolHeaders(csrfToken) });
});

test('指向内网的下一页被拦截并保留第 1 页；URL 模板按页码翻页', async ({ request }) => {
  const auth = await loginAsAdmin(request), headers = protocolHeaders(auth.csrfToken);
  const created: string[] = [];
  try {
    const internal = await request.post('/api/feeds', { headers, data: { name: '内网下一页', url: FIXTURE_URLS.pagedInternal, rules: STATIC_RULES, waitMs: 0, pagination: { mode: 'next', maxPages: 3, delayMs: 2000, nextSelector: 'a[rel~="next"]' } } });
    expect(internal.ok()).toBeTruthy();
    const feed = (await internal.json()).feed;
    created.push(feed.id);
    expect(feed.lastError).toBeNull();
    const detail = await (await request.get(`/api/feeds/${feed.id}`, { headers })).json();
    expect(detail.items.map((item: { title: string }) => item.title)).toEqual(['Paged 1-1', 'Paged 1-2', 'Paged 1-3']);
    const logs = await (await request.get(`/api/feeds/${feed.id}/logs`, { headers })).json() as FetchLogPage;
    expect(logs.logs[0].status).toBe('success');
    expect(logs.logs[0].note).toContain('第 2 页被网络安全策略拦截，已保留前 1 页的条目');

    const template = await request.post('/api/feeds', { headers, data: { name: 'URL 模板翻页', url: `${FIXTURE_URLS.paged}?page=1`, rules: STATIC_RULES, waitMs: 0, pagination: { mode: 'template', maxPages: 2, delayMs: 2000, urlTemplate: `${FIXTURE_URLS.paged}?page={n}`, start: 2, step: 1 } } });
    expect(template.ok()).toBeTruthy();
    const templated = (await template.json()).feed;
    created.push(templated.id);
    const items = (await (await request.get(`/api/feeds/${templated.id}`, { headers })).json()).items.map((item: { title: string }) => item.title);
    expect(items).toEqual(['1', '2'].flatMap(n => [1, 2, 3].map(i => `Paged ${n}-${i}`)));
    const templateLogs = await (await request.get(`/api/feeds/${templated.id}/logs`, { headers })).json() as FetchLogPage;
    expect(templateLogs.logs[0].note).toBe('共 2 页（3 + 3 条）；已达到最多 2 页');

    const invalid = await request.post('/api/feeds', { headers, data: { name: '无效模板', url: FIXTURE_URLS.paged, rules: STATIC_RULES, pagination: { mode: 'template', urlTemplate: FIXTURE_URLS.paged } } });
    expect(invalid.status()).toBe(400);
  } finally {
    for (const id of created) await request.delete(`/api/feeds/${id}`, { headers });
  }
});
