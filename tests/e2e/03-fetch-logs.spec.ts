import { test, expect } from './fixtures';
import { loginAsAdmin, protocolHeaders, FIXTURE_URLS, STATIC_RULES, setFixtureState } from './support';
import type { FetchLog } from '../../src/shared/types';

test('真实抓取成功、失败保留文章、日志自动更新及状态筛选', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  await setFixtureState({ failure: false, version: 1 });
  const created = await page.request.post('/api/feeds', { headers, data: { name: '抓取日志验收', url: FIXTURE_URLS.versioned, rules: STATIC_RULES, waitMs: 0 } });
  expect(created.ok()).toBeTruthy();
  const { feed } = await created.json();
  try {
    await page.goto('/'); await page.getByRole('button', { name: '查看订阅 抓取日志验收', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '抓取日志', exact: true }).click();
    const logs = dialog.getByRole('region', { name: '抓取日志' });
    await expect(logs.locator('article')).toHaveCount(1);
    await expect(logs.locator('article')).toContainText('成功');
    await expect(logs.locator('article')).toContainText('创建订阅');
    await setFixtureState({ failure: true });
    await page.request.post(`/api/feeds/${feed.id}/refresh`, { headers });
    await expect(logs.locator('article')).toHaveCount(2, { timeout: 12000 });
    await expect(logs.locator('article').first()).toContainText('HTTP 503');
    await expect(logs.locator('article').first()).toContainText('Bark：未启用');
    const detail = await (await page.request.get(`/api/feeds/${feed.id}`)).json();
    expect(detail.items.length).toBeGreaterThan(0);
    await logs.getByLabel('日志状态').selectOption('failure');
    await expect(logs.locator('article')).toHaveCount(1);
    await logs.getByLabel('日志状态').selectOption('interrupted');
    await expect(logs.getByText('暂无抓取日志')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await logs.getByLabel('日志状态').selectOption('failure');
    await expect(logs.locator('article')).toHaveCount(1);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
    await page.screenshot({ path: 'test-results/mobile-fetch-logs.png' });
  } finally { await setFixtureState({ failure: false }); await page.request.delete(`/api/feeds/${feed.id}`, { headers }); }
});

test('日志分页、通知状态、加载失败重试及离开标签停止轮询', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const created = await page.request.post('/api/feeds', { headers, data: { name: '日志分页验收', url: FIXTURE_URLS.static, rules: STATIC_RULES, waitMs: 0 } });
  const { feed } = await created.json();
  let fail = true, requests = 0;
  const data: FetchLog[] = Array.from({ length: 21 }, (_, i) => ({ id: 21 - i, feedId: feed.id, source: 'scheduled', status: 'failure', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 250, itemCount: null, newItemCount: null, error: '可能是页面结构或规则变化', notification: { status: i === 0 ? 'sent' : i === 1 ? 'failed' : 'pending', error: i === 1 ? 'Bark 推送失败，请检查网络及私有配置' : null } }));
  await page.route(`**/api/feeds/${feed.id}/logs?*`, async route => {
    requests++;
    if (fail) return route.fulfill({ status: 500, json: { error: '模拟日志加载失败' } });
    const more = new URL(route.request().url()).searchParams.has('cursor');
    return route.fulfill({ json: { logs: more ? data.slice(20) : data.slice(0, 20), nextCursor: more ? null : '2' } });
  });
  try {
    await page.goto('/'); await page.getByRole('button', { name: '查看订阅 日志分页验收', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '抓取日志', exact: true }).click();
    const logs = dialog.getByRole('region', { name: '抓取日志' });
    await expect(logs.getByRole('alert')).toContainText('模拟日志加载失败');
    fail = false; await logs.getByRole('button', { name: '重试', exact: true }).click();
    await expect(logs.locator('article')).toHaveCount(20);
    await expect(logs.locator('article').first()).toContainText('Bark：已发送');
    await expect(logs.locator('article').nth(1)).toContainText('Bark：发送失败');
    await logs.getByRole('button', { name: '加载更多' }).click();
    await expect(logs.locator('article')).toHaveCount(21);
    await expect(logs.getByText(/查看历史时暂停自动更新/)).toBeVisible();
    await page.clock.install();
    const afterExpand = requests; await page.clock.fastForward(6000); expect(requests).toBe(afterExpand);
    await logs.getByRole('button', { name: '刷新日志', exact: true }).click();
    await expect(logs.locator('article')).toHaveCount(20);
    await dialog.getByRole('button', { name: '订阅内容', exact: true }).click();
    const afterLeave = requests; await page.clock.fastForward(6000); expect(requests).toBe(afterLeave);
  } finally { await page.request.delete(`/api/feeds/${feed.id}`, { headers }); }
});
