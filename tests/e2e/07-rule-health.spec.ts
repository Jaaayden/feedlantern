import { test, expect } from './fixtures';
import { loginAsAdmin, protocolHeaders, FIXTURE_URLS, STATIC_RULES, setFixtureState } from './support';
import type { APIRequestContext } from '@playwright/test';
import type { Feed } from '../../src/shared/types';

test('条数仍为 6 条：日期缺失仅轻提示，独立筛选、日志标签相邻，重新识别只默认替换日期', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  await setFixtureState({ movedDate: false, absentDate: false });
  const created = await page.request.post('/api/feeds', { headers, data: { name: '日期缺失验收', url: FIXTURE_URLS.optionalFields, rules: STATIC_RULES, ruleOrigins: { item: 'auto', title: 'manual', link: 'auto', description: 'auto', image: 'auto', date: 'auto' }, waitMs: 0 } });
  expect(created.ok()).toBeTruthy();
  const { feed } = await created.json() as { feed: Feed };
  try {
    for (let i = 0; i < 4; i++) expect((await page.request.post(`/api/feeds/${feed.id}/refresh`, { headers })).ok()).toBeTruthy();
    await setFixtureState({ movedDate: true });
    const after = (await (await page.request.post(`/api/feeds/${feed.id}/refresh`, { headers })).json()).feed as Feed;
    expect(after.ruleHealth?.severity).toBe('notice');
    expect(after.ruleHealth?.itemCount).toBe(6);
    expect(after.lastError).toBeNull();
    await page.addInitScript(() => localStorage.removeItem('feedlantern:theme'));
    await page.goto('/');
    const title = page.getByRole('button', { name: '查看订阅 日期缺失验收', exact: true });
    const row = page.locator('article').filter({ has: title });
    await expect(row.getByRole('button', { name: '部分字段缺失', exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: '规则可能失效', exact: true })).toHaveCount(0);
    for (const filter of ['attention', 'rule-health']) {
      await page.getByLabel('筛选订阅状态').selectOption(filter);
      await expect(title).toHaveCount(0);
    }
    await page.getByLabel('筛选订阅状态').selectOption('field-health');
    await expect(title).toBeVisible();
    await title.click();
    const dialog = page.getByRole('dialog');
    const notice = dialog.getByRole('region', { name: '部分字段缺失' });
    await expect(notice).toContainText('本次仍提取到 6 条内容，订阅继续输出');
    await expect(notice).toContainText('日期有效率从约 100% 降到 0%');
    await dialog.getByRole('button', { name: '运行日志', exact: true }).click();
    const log = dialog.getByRole('region', { name: '抓取日志' }).locator('article').first();
    await expect(log).toContainText('有效 6 条');
    await expect(log).toContainText('部分字段缺失');
    await expect(log).not.toContainText('规则可能失效');
    await expect(log).not.toContainText('通知：');
    for (const width of [1280, 390]) for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      await expect(notice).toHaveAttribute('data-severity', 'notice');
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
      const boxes = await log.locator('.fetch-log-statuses .badge').evaluateAll(elements => elements.map(el => { const { x, y, width, height } = el.getBoundingClientRect(); return { x, y, width, height }; }));
      expect(boxes).toHaveLength(2);
      expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2);
      expect(boxes[1].x - boxes[0].x - boxes[0].width).toBeGreaterThanOrEqual(0);
      expect(boxes[1].x - boxes[0].x - boxes[0].width).toBeLessThanOrEqual(12);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    // A missing candidate must not silently propose removing the saved rule.
    await setFixtureState({ absentDate: true });
    await notice.getByRole('button', { name: '重新识别缺失字段' }).click();
    await expect(notice.getByLabel('替换日期')).toBeVisible({ timeout: 30_000 });
    await expect(notice.getByLabel('替换日期')).not.toBeChecked();
    await expect(notice.getByRole('button', { name: '替换所选字段' })).toBeDisabled();
    expect((await (await page.request.get(`/api/feeds/${feed.id}`)).json()).feed.rules).toEqual(STATIC_RULES);
    await setFixtureState({ absentDate: false });
    await notice.getByRole('button', { name: '重新识别缺失字段' }).click();
    await expect(notice.getByLabel('替换日期')).toBeChecked({ timeout: 30_000 });
    const selected = await notice.locator('input[type="checkbox"]:checked').evaluateAll(inputs => inputs.map(input => input.getAttribute('aria-label')));
    expect(selected).toEqual(['替换日期']);
    expect((await (await page.request.get(`/api/feeds/${feed.id}`)).json()).feed.rules).toEqual(STATIC_RULES);
    const preview = notice.getByRole('button', { name: '预览所选组合' });
    if (await preview.isVisible()) await preview.click();
    await expect(notice.getByRole('button', { name: '替换所选字段' })).toBeEnabled({ timeout: 30_000 });
    await notice.getByRole('button', { name: '替换所选字段' }).click();
    await expect(notice).toHaveCount(0, { timeout: 30_000 });
    const saved = (await (await page.request.get(`/api/feeds/${feed.id}`)).json()).feed as Feed;
    for (const key of ['item', 'title', 'link', 'image', 'description'] as const) expect(saved.rules[key]).toBe(STATIC_RULES[key]);
    expect(saved.rules.date).not.toBe(STATIC_RULES.date);
    expect(saved.ruleHealth).toBeUndefined();
  } finally {
    await page.request.delete(`/api/feeds/${feed.id}`, { headers });
    await setFixtureState({ movedDate: false, absentDate: false });
  }
});

// Five healthy fetches form the baseline; the sixth runs on the redesigned page.
async function degradedFeed(request: APIRequestContext, name: string) {
  const auth = await loginAsAdmin(request), headers = protocolHeaders(auth.csrfToken);
  await setFixtureState({ redesigned: false });
  const created = await request.post('/api/feeds', { headers, data: { name, url: FIXTURE_URLS.redesign, rules: STATIC_RULES, ruleOrigins: { item: 'auto', title: 'manual', link: 'auto', description: 'auto', image: 'auto', date: 'auto' }, waitMs: 0 } });
  expect(created.ok()).toBeTruthy();
  const { feed } = await created.json() as { feed: Feed };
  for (let i = 0; i < 4; i++) expect((await request.post(`/api/feeds/${feed.id}/refresh`, { headers })).ok()).toBeTruthy();
  await setFixtureState({ redesigned: true });
  const refreshed = await request.post(`/api/feeds/${feed.id}/refresh`, { headers });
  const after = (await refreshed.json()).feed as Feed;
  expect(after.lastError).toBeNull();
  expect(after.ruleHealth?.reasons[0].message).toContain('条目数从约 10 条降到 2 条');
  return { feed, headers };
}

test('规则可能失效：列表与筛选提示、日志标记、重新识别并排对比后逐项替换', async ({ page }) => {
  const { feed, headers } = await degradedFeed(page.request, '改版预警验收');
  try {
    await page.goto('/');
    const row = page.locator('article').filter({ has: page.getByRole('button', { name: '查看订阅 改版预警验收', exact: true }) });
    await expect(row.getByRole('button', { name: '规则可能失效', exact: true })).toBeVisible();
    await page.getByLabel('筛选订阅状态').selectOption('rule-health');
    await expect(page.getByRole('button', { name: '查看订阅 改版预警验收', exact: true })).toBeVisible();
    await page.getByLabel('筛选订阅状态').selectOption('failing');
    await expect(page.getByRole('button', { name: '查看订阅 改版预警验收', exact: true })).toHaveCount(0);
    await page.getByLabel('筛选订阅状态').selectOption('all');

    await page.getByRole('button', { name: '查看订阅 改版预警验收', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const notice = dialog.getByRole('region', { name: '规则可能失效' });
    await expect(notice).toContainText('条目数从约 10 条降到 2 条');
    await dialog.getByRole('button', { name: '运行日志', exact: true }).click();
    const logs = dialog.getByRole('region', { name: '抓取日志' });
    await expect(logs.locator('article').first()).toContainText('成功');
    await expect(logs.locator('article').first()).toContainText('规则可能失效');
    await expect(logs.locator('article').first()).toContainText('通知：未启用');

    await notice.getByRole('button', { name: '重新识别', exact: true }).click();
    await expect(notice.getByRole('region', { name: '当前规则' })).toContainText('2 条', { timeout: 30_000 });
    await expect(notice.getByRole('region', { name: '新识别规则' })).toContainText('10 条');
    await expect(notice.getByRole('region', { name: '新识别规则' })).toContainText('Redesign fixture story 1');
    // Nothing is saved until the user confirms.
    expect((await (await page.request.get(`/api/feeds/${feed.id}`)).json()).feed.rules.item).toBe(STATIC_RULES.item);
    // The manually chosen title is kept unless ticked; auto fields are offered.
    await expect(notice.getByLabel('替换标题')).not.toBeChecked();
    await expect(notice.getByLabel('替换条目容器')).toBeChecked();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
    await page.screenshot({ path: 'test-results/mobile-rule-health.png' });
    await notice.getByRole('button', { name: '预览所选组合' }).click();
    await expect(notice.getByRole('region', { name: '替换后预览' })).toContainText('0 条', { timeout: 30_000 });
    await expect(notice.getByRole('button', { name: '替换所选字段' })).toBeDisabled();
    await notice.getByLabel('替换标题').check();
    await expect(notice.getByRole('region', { name: '替换后预览' })).toContainText('10 条');
    await notice.getByRole('button', { name: '替换所选字段' }).click();
    await expect(dialog.getByRole('region', { name: '规则可能失效' })).toHaveCount(0, { timeout: 30_000 });
    const saved = (await (await page.request.get(`/api/feeds/${feed.id}`)).json()).feed as Feed;
    expect(saved.rules.item).not.toBe(STATIC_RULES.item);
    expect(saved.ruleOrigins?.title).toBe('auto');
    expect(saved.ruleHealth).toBeUndefined();
    await expect(logs.locator('article').first()).toContainText('修改规则');
  } finally { await setFixtureState({ redesigned: false }); await page.request.delete(`/api/feeds/${feed.id}`, { headers }); }
});

test('规则可能失效：忽略此警告后恢复正常状态', async ({ page }) => {
  const { feed, headers } = await degradedFeed(page.request, '忽略预警验收');
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '查看订阅 忽略预警验收', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('region', { name: '规则可能失效' }).getByRole('button', { name: '忽略此警告' }).click();
    await expect(dialog.getByRole('region', { name: '规则可能失效' })).toHaveCount(0);
    expect((await (await page.request.get(`/api/feeds/${feed.id}`)).json()).feed.ruleHealth).toBeUndefined();
    // Rules were not changed by ignoring.
    expect((await (await page.request.get(`/api/feeds/${feed.id}`)).json()).feed.rules.item).toBe(STATIC_RULES.item);
  } finally { await setFixtureState({ redesigned: false }); await page.request.delete(`/api/feeds/${feed.id}`, { headers }); }
});
