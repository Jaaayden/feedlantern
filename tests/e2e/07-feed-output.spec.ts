import { test, expect } from './fixtures';
import { loginAsAdmin, protocolHeaders, FIXTURE_URLS, STATIC_RULES } from './support';

test('订阅面板切换 Atom / JSON Feed 地址，设置过滤和输出条数并在预览中标出被过滤的条目', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const created = await page.request.post('/api/feeds', { headers, data: { name: '输出格式验收', url: FIXTURE_URLS.static, rules: STATIC_RULES } });
  expect(created.ok()).toBeTruthy();
  const { feed, feedUrl } = await created.json() as { feed: { id: string }; feedUrl: string };
  try {
    await page.goto('/#/');
    await page.getByLabel('搜索订阅').fill('输出格式验收');
    await page.getByRole('button', { name: '查看订阅 输出格式验收', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('RSS 订阅地址')).toHaveValue(feedUrl);

    // Same token, another format: the address and the copy button follow the switch.
    const formats = dialog.getByRole('group', { name: '订阅格式' });
    await formats.getByRole('button', { name: 'Atom 1.0' }).click();
    const atomUrl = feedUrl.replace(/\.xml$/, '.atom');
    await expect(dialog.getByLabel('Atom 订阅地址')).toHaveValue(atomUrl);
    await dialog.getByRole('button', { name: '复制 Atom 地址', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Atom 地址已复制' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(atomUrl);
    const atom = await page.request.get(atomUrl);
    expect(atom.headers()['content-type']).toMatch(/^application\/atom\+xml/);
    expect(await atom.text()).toContain('Fixture article two');
    await formats.getByRole('button', { name: 'JSON Feed 1.1' }).click();
    const jsonUrl = feedUrl.replace(/\.xml$/, '.json');
    await expect(dialog.getByLabel('JSON Feed 订阅地址')).toHaveValue(jsonUrl);

    // Filter in the settings tab: the live summary shows the effect before saving.
    await dialog.getByRole('button', { name: '订阅设置', exact: true }).click();
    await dialog.getByLabel('排除关键词').fill('article TWO');
    await expect(dialog.locator('.output-summary').filter({ hasText: '过滤 1 条' })).toBeVisible();
    await dialog.getByLabel(/按正则表达式匹配/).check();
    await dialog.getByLabel('排除关键词').fill('(two+)+');
    await expect(dialog.getByRole('alert')).toContainText('嵌套重复');
    await dialog.getByLabel('排除关键词').fill('^fixture article two$');
    await expect(dialog.locator('.output-summary').filter({ hasText: '过滤 1 条' })).toBeVisible();
    await dialog.getByLabel('输出条数').fill('5');
    await dialog.getByRole('button', { name: '保存设置' }).click();
    expect(await dialog.getByLabel('输出条数').evaluate(input => (input as HTMLInputElement).validity.rangeUnderflow)).toBe(true);
    await dialog.getByLabel('输出条数').fill('20');
    // Retention: empty is automatic, and it may not drop below the output limit.
    const retention = dialog.getByLabel(/^保留条数/);
    await expect(retention).toHaveValue('');
    await expect(retention).toHaveAttribute('placeholder', '自动（200）');
    await retention.fill('15');
    await dialog.getByRole('button', { name: '保存设置' }).click();
    expect(await retention.evaluate(input => (input as HTMLInputElement).validity.rangeUnderflow)).toBe(true);
    await retention.fill('300');
    await dialog.getByRole('button', { name: '保存设置' }).click();
    await expect(page.getByRole('status').filter({ hasText: '订阅设置已保存' })).toBeVisible();
    await expect(retention).toHaveValue('300');
    await expect(dialog.getByRole('button', { name: '保存设置' })).toBeDisabled();

    // Every format drops the filtered item; the stored item is still listed, marked as filtered.
    for (const url of [feedUrl, atomUrl, jsonUrl]) {
      const body = await (await page.request.get(url)).text();
      expect(body).toContain('Fixture article one');
      expect(body).not.toContain('Fixture article two');
    }
    const settings = (await (await page.request.get(`/api/feeds/${feed.id}`)).json()).feed;
    expect(settings.outputLimit).toBe(20);
    expect(settings.retentionLimit).toBe(300);
    expect(settings.itemFilter).toEqual({ include: [], exclude: ['^fixture article two$'], regex: true });
    await dialog.getByRole('button', { name: '订阅内容', exact: true }).click();
    const hidden = dialog.locator('article.preview-item[data-output="excluded"]');
    await expect(hidden).toHaveCount(1);
    await expect(hidden).toContainText('已过滤：命中排除关键词');
    await expect(hidden).toContainText('Fixture article two');
    await expect(dialog.locator('.output-summary').filter({ hasText: '过滤 1 条' })).toBeVisible();

    // Rotating the key revokes all three addresses at once.
    await dialog.getByRole('button', { name: '订阅设置', exact: true }).click();
    page.once('dialog', prompt => void prompt.accept());
    await dialog.getByRole('button', { name: '轮换订阅密钥' }).click();
    await expect(page.getByRole('status').filter({ hasText: '订阅地址已更新' })).toBeVisible();
    for (const url of [feedUrl, atomUrl, jsonUrl]) expect((await page.request.get(url)).status()).toBe(404);
    await expect(dialog.getByLabel('JSON Feed 订阅地址')).not.toHaveValue(jsonUrl);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  } finally { await page.request.delete(`/api/feeds/${feed.id}`, { headers }); }
});

test('批量修改输出条数和保留条数，只改填写的字段', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const ids: string[] = [];
  try {
    for (const i of [0, 1]) {
      const created = await page.request.post('/api/feeds', { headers, data: { name: `批量条数验收 ${i}`, url: FIXTURE_URLS.static, intervalMinutes: 90, rules: STATIC_RULES } });
      expect(created.ok()).toBeTruthy(); ids.push((await created.json()).feed.id);
    }
    await page.goto('/#/'); await page.getByLabel('搜索订阅').fill('批量条数验收');
    await page.getByLabel('全选当前结果').check();
    await page.getByRole('button', { name: '批量修改设置', exact: true }).click();
    const form = page.getByRole('form', { name: '批量修改订阅设置' });
    await form.getByLabel('输出条数').fill('250');
    await form.getByLabel('保留条数', { exact: true }).selectOption('set');
    await form.getByLabel(/^保留条数（/).fill('400');
    await form.getByRole('button', { name: '应用到所选订阅' }).click();
    await expect(page.getByRole('status')).toContainText('已完成 2 项');
    for (const id of ids) {
      const saved = (await (await page.request.get(`/api/feeds/${id}`)).json()).feed;
      expect(saved.outputLimit).toBe(250);
      expect(saved.retentionLimit).toBe(400);
      expect(saved.intervalMinutes).toBe(90);
    }
    // Back to automatic (a successful batch clears the selection).
    await page.getByLabel('全选当前结果').check();
    await page.getByRole('button', { name: '批量修改设置', exact: true }).click();
    await form.getByLabel('保留条数', { exact: true }).selectOption('auto');
    await form.getByRole('button', { name: '应用到所选订阅' }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/feeds/${ids[1]}`)).json()).feed.retentionLimit).toBeNull();
    for (const id of ids) expect((await (await page.request.get(`/api/feeds/${id}`)).json()).feed.retentionLimit).toBeNull();
  } finally { for (const id of ids) await page.request.delete(`/api/feeds/${id}`, { headers }); }
});
