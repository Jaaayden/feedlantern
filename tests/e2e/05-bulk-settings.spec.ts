import { test, expect } from './fixtures';
import { loginAsAdmin, protocolHeaders, FIXTURE_URLS } from './support';

test('多选修改模式和间隔、保留未指定字段及失败选择', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const ids: string[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const created = await page.request.post('/api/feeds', { headers, data: { name: `批量设置验收 ${i}`, url: FIXTURE_URLS.static, intervalMinutes: 60 + i * 60, rules: { item: '.article-card', title: '.article-title', link: 'a.article-link' } } });
      expect(created.ok()).toBeTruthy(); ids.push((await created.json()).feed.id);
    }
    await page.goto('/'); await page.getByLabel('搜索订阅').fill('批量设置验收');
    for (const i of [0, 1]) await page.getByLabel(`选择订阅 批量设置验收 ${i}`, { exact: true }).check();
    await page.getByRole('button', { name: '批量修改设置', exact: true }).click();
    const form = page.getByRole('form', { name: '批量修改订阅设置' });
    const save = form.getByRole('button', { name: '应用到所选订阅' });
    await expect(save).toBeDisabled();
    await form.getByLabel('翻译输出模式').selectOption('chinese');
    await save.click(); await expect(page.getByRole('status')).toContainText('已完成 2 项');
    const read = async (id: string) => (await (await page.request.get(`/api/feeds/${id}`)).json()).feed;
    expect((await read(ids[0])).intervalMinutes).toBe(60);
    expect((await read(ids[1])).intervalMinutes).toBe(120);
    expect((await read(ids[0])).translationMode).toBe('chinese');
    expect((await read(ids[2])).translationMode).toBe('original');
    await page.reload(); await page.getByLabel('搜索订阅').fill('批量设置验收');
    await page.getByRole('button', { name: '卡片', exact: true }).click();
    for (const i of [0, 1]) await page.getByLabel(`选择订阅 批量设置验收 ${i}`, { exact: true }).check();
    await page.getByRole('button', { name: '批量修改设置', exact: true }).click();
    await form.getByLabel('刷新间隔（分钟）').fill('15');
    await page.route('**/api/feeds/bulk', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试保存失败' }) }));
    await save.click(); await expect(page.getByRole('alert')).toContainText('测试保存失败');
    await expect(form.getByLabel('刷新间隔（分钟）')).toHaveValue('15');
    await expect(page.getByLabel('选择订阅 批量设置验收 0', { exact: true })).toBeChecked();
    await page.unroute('**/api/feeds/bulk');
    await save.click(); await expect(form).toHaveCount(0);
    for (const id of ids.slice(0, 2)) { expect((await read(id)).intervalMinutes).toBe(15); expect((await read(id)).translationMode).toBe('chinese'); }
    expect((await read(ids[2])).intervalMinutes).toBe(180);
    for (const i of [0, 1]) await page.getByLabel(`选择订阅 批量设置验收 ${i}`, { exact: true }).check();
    await page.getByRole('button', { name: '批量修改设置', exact: true }).click();
    await form.getByLabel('翻译输出模式').selectOption('bilingual');
    await form.getByLabel('刷新间隔（分钟）').fill('30');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await save.click(); await expect(form).toHaveCount(0);
    for (const id of ids.slice(0, 2)) { expect((await read(id)).intervalMinutes).toBe(30); expect((await read(id)).translationMode).toBe('bilingual'); }
  } finally { for (const id of ids) await page.request.delete(`/api/feeds/${id}`, { headers }); }
});

test('需要检查筛选与搜索、来源和输出组合，仅选择失败订阅', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const ids: string[] = [];
  try {
    for (const [name, url] of [['状态筛选 正常', FIXTURE_URLS.static], ['状态筛选 失败', new URL('/unavailable', FIXTURE_URLS.static).href]]) {
      const response = await page.request.post('/api/feeds', { headers, data: { name, url, rules: { item: '.article-card', title: '.article-title', link: 'a.article-link' } } });
      expect(response.ok()).toBeTruthy(); const { feed } = await response.json(); ids.push(feed.id);
      expect(!!feed.lastError).toBe(name.endsWith('失败'));
    }
    await page.goto('/'); await page.getByLabel('搜索订阅').fill('状态筛选');
    const collection = page.getByRole('region', { name: '订阅集合' });
    await expect(collection.locator('article')).toHaveCount(2);
    await page.getByLabel('选择订阅 状态筛选 正常', { exact: true }).check();
    await page.getByLabel('筛选订阅状态').selectOption('attention');
    await expect(collection.locator('article')).toHaveCount(1);
    await expect(collection.getByText('已选择 1 项')).toHaveCount(0);
    await page.getByLabel('全选当前结果').check();
    await expect(page.getByLabel('选择订阅 状态筛选 失败', { exact: true })).toBeChecked();
    await page.getByRole('button', { name: '查看订阅 状态筛选 失败', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '卡片', exact: true }).click();
    await expect(collection.locator('article')).toHaveCount(1);
    await page.getByLabel('筛选订阅来源').selectOption('rss');
    await expect(collection.getByText('当前筛选条件下没有订阅。')).toBeVisible();
    await page.getByLabel('筛选订阅来源').selectOption('website');
    await page.getByLabel('筛选订阅输出').selectOption('translated');
    await expect(collection.locator('article')).toHaveCount(0);
    await page.getByLabel('筛选订阅输出').selectOption('original');
    await expect(collection.locator('article')).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.getByLabel('筛选订阅状态').selectOption('all');
    await expect(collection.locator('article')).toHaveCount(2);
  } finally { for (const id of ids) await page.request.delete(`/api/feeds/${id}`, { headers }); }
});
