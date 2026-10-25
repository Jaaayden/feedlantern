import { test, expect } from './fixtures';
import { loginAsAdmin, protocolHeaders } from './support';
import { fixtureBaseUrl } from '../../playwright.config';

test('RSS 翻译创建、原文预览、双语输出、模式切换和移动端', async ({ page }) => {
  await loginAsAdmin(page.request);
  await page.goto('/#/');
  await page.getByRole('button', { name: '新建订阅', exact: true }).click();
  await page.getByRole('button', { name: 'RSS 翻译', exact: true }).click();
  await page.getByLabel('RSS / Atom 地址').fill(`${fixtureBaseUrl}/feed.xml`);
  await page.getByRole('button', { name: '预览订阅源' }).click();
  await expect(page.getByLabel('订阅名称')).toHaveValue('RSS translation fixture');
  await expect(page.frameLocator('iframe[title="原文预览 1"]').getByText('This is an English article with', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'test-results/rss-create-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '保存 RSS 翻译订阅' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('翻译：1 条完成', { exact: false })).toBeVisible();
  // The item shows the translated title, with the original as a quieter second line.
  const item = dialog.locator('article.preview-item').first();
  await expect(item.getByRole('link', { name: '中文：Hello RSS', exact: true })).toBeVisible();
  await expect(item.locator('.item-original-title')).toHaveText('Hello RSS');
  // Translation progress lives in 运行日志, not under the items.
  await expect(dialog.getByRole('region', { name: '翻译日志' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '运行日志', exact: true }).click();
  await expect(page).toHaveURL(/\/logs$/);
  await dialog.getByRole('button', { name: '翻译记录' }).click();
  const translationLog = dialog.getByRole('region', { name: '翻译日志' });
  await expect(translationLog).toContainText('翻译完成');
  await expect(translationLog).toContainText('开始翻译');
  await expect(translationLog).toContainText('全部文章已翻译完成');
  await dialog.getByRole('button', { name: '订阅内容', exact: true }).click();
  await item.getByRole('button', { name: '展开全文' }).click();
  const frame = dialog.frameLocator('iframe[title="订阅正文 1"]');
  await expect(frame.getByText('const example = 1;', { exact: true })).toBeVisible();
  // The bilingual original is marked so it reads quieter than the translation.
  await expect(frame.locator('.fl-source').first()).toContainText('This is an English article with');
  expect(await dialog.locator('iframe[title="订阅正文 1"]').getAttribute('sandbox')).not.toContain('allow-scripts');
  const rss = await dialog.locator('input[readonly]').inputValue();
  const originalXml = await (await page.request.get(rss)).text();
  expect(originalXml).toContain('中文：Hello RSS / Hello RSS');
  const guid = originalXml.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1];
  await page.screenshot({ path: 'test-results/rss-detail-desktop.png', fullPage: true });
  await dialog.getByRole('button', { name: '订阅设置', exact: true }).click();
  await dialog.getByLabel('输出模式').selectOption('translated');
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  expect(await dialog.locator('input[readonly]').inputValue()).toBe(rss);
  const chineseXml = await (await page.request.get(rss)).text();
  expect(chineseXml).toContain('<title>中文：Hello RSS</title>'); expect(chineseXml).toContain(guid!);
  await dialog.getByRole('button', { name: '编辑 RSS 来源', exact: true }).click();
  await expect(page.getByLabel('RSS / Atom 地址')).toHaveValue(`${fixtureBaseUrl}/feed.xml`);
  await page.setViewportSize({ width: 390, height: 844 });
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.viewport);
  await page.screenshot({ path: 'test-results/rss-edit-mobile.png', fullPage: true });
});

test('批量添加 RSS 翻译，跳过重复地址并输出中文订阅', async ({ page }) => {
  await loginAsAdmin(page.request); await page.goto('/#/');
  await page.getByRole('button', { name: '更多新建方式' }).click();
  await page.getByRole('menuitem', { name: '批量添加' }).click();
  await page.getByLabel('批量订阅类型').selectOption('rss');
  await page.getByLabel('翻译输出模式').selectOption('translated');
  const url = `${fixtureBaseUrl}/feed.xml?batch=translation`;
  await page.getByLabel('每行一个网址（最多 100 个）').fill(`${url}\n${url}`);
  await expect(page.getByText('重复，将跳过', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '开始批量添加翻译' }).click();
  await expect(page.getByText('RSS 中文翻译 · 已创建', { exact: false })).toBeVisible();
  const feeds = await (await page.request.get('/api/feeds')).json();
  const added = feeds.filter((feed: { url: string }) => feed.url === url);
  expect(added).toHaveLength(1); expect(added[0].sourceType).toBe('rss'); expect(added[0].translationMode).toBe('translated');
  await expect.poll(async () => (await (await page.request.get(`/api/feeds/${added[0].id}`)).json()).feed.translation.success).toBe(1);
});

test('网页订阅设置翻译、列表区分来源并筛选', async ({ page }) => {
  const auth = await loginAsAdmin(page.request);
  const created = await page.request.post('/api/feeds', { headers: protocolHeaders(auth.csrfToken), data: { name: 'Website translation settings', url: `${fixtureBaseUrl}/`, rules: { item: 'article', title: '.article-title', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 } });
  expect(created.ok()).toBeTruthy(); const payload = await created.json();
  await page.goto('/#/');
  const row = page.locator('article').filter({ has: page.getByRole('button', { name: '查看订阅 Website translation settings', exact: true }) });
  await expect(row.getByText('网页抓取', { exact: true })).toBeVisible();
  await expect(row.getByText('原文', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: '订阅设置 Website translation settings' }).click();
  await page.getByLabel('输出模式', { exact: true }).selectOption('bilingual');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/feeds/${payload.feed.id}`)).json()).feed.translationMode).toBe('bilingual');
  await page.goto('/#/');
  await expect(row.getByText('双语翻译', { exact: true })).toBeVisible();
  await page.getByLabel('筛选订阅来源').selectOption('rss'); await expect(row).toHaveCount(0);
  await page.getByLabel('筛选订阅来源').selectOption('website'); await expect(row).toBeVisible();
  await page.getByLabel('筛选订阅输出').selectOption('original'); await expect(row).toHaveCount(0);
  await page.getByLabel('筛选订阅输出').selectOption('translated'); await expect(row).toBeVisible();
});
