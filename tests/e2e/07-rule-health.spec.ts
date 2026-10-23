import { test, expect } from './fixtures';
import { loginAsAdmin, protocolHeaders, FIXTURE_URLS, STATIC_RULES, setFixtureState } from './support';
import type { APIRequestContext } from '@playwright/test';
import type { Feed } from '../../src/shared/types';

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
    await dialog.getByRole('button', { name: '抓取日志', exact: true }).click();
    const logs = dialog.getByRole('region', { name: '抓取日志' });
    await expect(logs.locator('article').first()).toContainText('成功');
    await expect(logs.locator('article').first()).toContainText('规则可能失效');
    await expect(logs.locator('article').first()).toContainText('Bark：未启用');

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
