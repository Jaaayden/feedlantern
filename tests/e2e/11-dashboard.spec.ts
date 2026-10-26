import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from './fixtures';
import { e2eDataDir } from '../../playwright.config';
import { FIXTURE_URLS, STATIC_RULES, loginAsAdmin, protocolHeaders } from './support';

test('首页仪表盘、原订阅列表、需要检查和聚合入口；用户统计一致，删除内容保留累计', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const username = `dashboard-${Date.now()}`;
  const user = await (await page.request.post('/api/users', { headers, data: { username, password: 'dashboard-password' } })).json();
  const own = { ...headers, 'x-feedlantern-user': user.id };
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '仪表盘', exact: true })).toBeVisible();
    const nav = page.getByRole('navigation', { name: '主导航' });
    await expect(nav.getByRole('button')).toHaveCount(6);
    await page.goto('/#/');
    await expect(page.getByRole('heading', { name: '全部订阅', exact: true })).toBeVisible();
    await expect(page.locator('main .stats-row')).toHaveCount(0);
    await expect(page.getByRole('region', { name: '聚合订阅' })).toHaveCount(0);

    const normal = await page.request.post('/api/feeds', { headers: own, data: { name: '仪表盘 正常', url: FIXTURE_URLS.static, rules: STATIC_RULES } });
    expect(normal.ok()).toBeTruthy();
    const normalFeed = (await normal.json()).feed;
    const failed = await page.request.post('/api/feeds', { headers: own, data: { name: '仪表盘 失败', url: new URL('/unavailable', FIXTURE_URLS.static).href, rules: STATIC_RULES } });
    expect(failed.ok()).toBeTruthy();
    const failedFeed = (await failed.json()).feed;
    expect(failedFeed.lastError).toBeTruthy();
    for (let i = 0; i < 2; i++) await page.request.post(`/api/feeds/${failedFeed.id}/refresh`, { headers: own });

    await nav.getByRole('button', { name: '用户管理', exact: true }).click();
    const row = page.locator('.user-row').filter({ hasText: username });
    await expect(row).toContainText('1 个需要检查');
    await row.getByRole('button', { name: '1 个需要检查' }).click();
    await expect(page).toHaveURL(new RegExp(`#/u/${user.id}/attention$`));
    const list = page.getByRole('region', { name: '订阅集合' });
    await expect(list.locator('article')).toHaveCount(1);
    await expect(list).toContainText('仪表盘 失败');
    await page.reload();
    await expect(list.locator('article')).toHaveCount(1);
    await nav.getByRole('button', { name: /^全部订阅/ }).click();
    await expect(list.locator('article')).toHaveCount(2);
    await page.getByLabel('搜索订阅').fill('正常');
    await expect(list.locator('article')).toHaveCount(1);
    await nav.getByRole('button', { name: '聚合订阅', exact: true }).click();
    await expect(page.getByRole('heading', { name: '还没有聚合订阅' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: '全部订阅', exact: true })).toBeVisible();
    await expect(list.locator('article')).toHaveCount(2);

    await nav.getByRole('button', { name: '仪表盘', exact: true }).click();
    await expect(page.locator('.dashboard-lifetime-values strong').first()).toHaveText('3');
    await expect(page.locator('.dashboard-stats > div').last()).toContainText('3');
    expect((await page.request.delete(`/api/feeds/${normalFeed.id}`, { headers: own })).ok()).toBeTruthy();
    expect((await page.request.delete(`/api/feeds/${failedFeed.id}`, { headers: own })).ok()).toBeTruthy();
    await page.reload();
    await expect(page.locator('.dashboard-lifetime-values strong').first()).toHaveText('3');
    await expect(page.locator('.dashboard-stats > div').last()).toContainText('0');
    await nav.getByRole('button', { name: /^需要检查/ }).click();
    await expect(page.getByRole('heading', { name: '目前运行正常' })).toBeVisible();
    await nav.getByRole('button', { name: '用户管理', exact: true }).click();
    await expect(row).toContainText('0 个需要检查');
  } finally { await page.request.delete(`/api/users/${user.id}`, { headers, data: { username } }); }
});

test('仪表盘 7/30/90 天真实接口、键盘图表、明暗主题与紧凑响应布局', async ({ page }, testInfo) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const username = `dashboard-chart-${Date.now()}`;
  const user = await (await page.request.post('/api/users', { headers, data: { username, password: 'dashboard-password' } })).json();
  const own = { ...headers, 'x-feedlantern-user': user.id };
  // Seed historical activity only in this disposable test account. The UI still
  // reads the real API and database, including missing days and large counters.
  const db = new DatabaseSync(join(e2eDataDir, 'app.db'));
  try {
    const today = Date.parse(new Date().toISOString().slice(0, 10));
    const date = (offset: number) => new Date(today - offset * 86_400_000).toISOString().slice(0, 10);
    db.prepare('UPDATE activity_totals SET started_at=?, collected=1200000, translated=980000 WHERE owner_id=?').run(`${date(89)}T00:00:00.000Z`, user.id);
    const insert = db.prepare('INSERT INTO activity_daily(owner_id,day,collected,translated) VALUES (?,?,?,?)');
    for (let i = 0; i < 90; i += 2) insert.run(user.id, date(i), 500 + i * 1000, 200 + i * 700);
    await page.goto(`/#/u/${user.id}/dashboard`);
    const trends = page.getByRole('region', { name: '运行趋势' });
    await expect(trends).toHaveAttribute('aria-busy', 'false');
    for (const days of [7, 90, 30]) {
      const response = page.waitForResponse(res => res.url().includes(`/api/dashboard?days=${days}`) && res.status() === 200);
      await trends.getByRole('button', { name: `${days} 天`, exact: true }).click();
      expect((await (await response).json()).daily).toHaveLength(days);
      await expect(trends).toHaveAttribute('aria-busy', 'false');
      await expect(trends.getByRole('button', { name: `${days} 天`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    }
    const chart = page.getByRole('img', { name: '每日新增采集与翻译完成条数' });
    await chart.focus();
    await page.keyboard.press('Home');
    await expect(page.locator('.dashboard-tooltip')).toContainText('新增采集');
    await page.keyboard.press('End');
    await expect(page.locator('.dashboard-tooltip')).toContainText('500');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dashboard-tooltip')).toHaveCount(0);

    for (const width of [1280, 1024, 760, 390, 320]) for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      await expect(chart).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${width} ${colorScheme}`).toBeLessThanOrEqual(1);
      const geometry = await page.locator('.dashboard-chart').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { top: r.top, height: r.height }; }));
      expect(geometry.every(box => box.height <= 162)).toBeTruthy();
      if (width >= 1024) expect(Math.abs(geometry[0].top - geometry[1].top)).toBeLessThan(2);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: testInfo.outputPath('dashboard-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('dashboard-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '设置分组' })).toBeVisible();
    expect((await page.request.get('/api/dashboard?days=90', { headers: own })).ok()).toBeTruthy();
  } finally { db.close(); await page.request.delete(`/api/users/${user.id}`, { headers, data: { username } }); }
});
