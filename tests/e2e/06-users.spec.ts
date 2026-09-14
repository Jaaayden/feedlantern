import { test, expect } from './fixtures';
import { e2eBaseUrl, loginAsAdmin, protocolHeaders, STATIC_RULES, FIXTURE_URLS } from './support';

test('管理员创建、停用、启用和重置用户；普通用户独立使用工作台', async ({ page, browser }, testInfo) => {
  await loginAsAdmin(page.request);
  await page.goto('/');
  await page.getByRole('button', { name: '用户管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '用户管理', exact: true })).toBeVisible();
  const username = `reader-${Date.now()}`;
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('初始密码', { exact: true }).fill('reader-password');
  await page.getByRole('button', { name: '创建用户', exact: true }).click();
  const row = page.locator('.user-row').filter({ hasText: username });
  await expect(row).toContainText('已启用');
  await page.screenshot({ path: testInfo.outputPath('user-management.png'), fullPage: true });
  const context = await browser.newContext({ baseURL: e2eBaseUrl });
  const reader = await context.newPage();
  try {
    const login = async (password: string) => {
      await reader.goto('/');
      await reader.getByLabel('用户名', { exact: true }).fill(username);
      await reader.getByLabel('密码', { exact: true }).fill(password);
      await reader.getByRole('button', { name: '登录', exact: true }).click();
      await expect(reader.getByText('普通用户', { exact: true })).toBeVisible();
    };
    await login('reader-password');
    await expect(reader.getByRole('button', { name: '用户管理', exact: true })).toHaveCount(0);
    await expect(reader.getByRole('heading', { name: '从一个值得关注的网址开始' })).toBeVisible();
    const auth = await (await reader.request.get('/api/auth/status')).json();
    const created = await reader.request.post('/api/feeds', { headers: protocolHeaders(auth.csrfToken), data: { name: `Reader feed ${username}`, url: FIXTURE_URLS.static, rules: STATIC_RULES, credentialId: null, waitMs: 0 } });
    expect(created.ok()).toBeTruthy();
    const feed = (await created.json()).feed;
    await reader.reload();
    await expect(reader.getByText(`Reader feed ${username}`, { exact: true })).toBeVisible();
    await reader.getByRole('button', { name: '设置', exact: true }).click();
    await expect(reader.getByRole('heading', { name: '修改密码', exact: true })).toBeVisible();
    await expect(reader.getByRole('heading', { name: '备份', exact: true })).toHaveCount(0);
    expect((await reader.request.get('/api/settings')).status()).toBe(403);
    expect((await page.request.get(`/api/feeds/${feed.id}`)).status()).toBe(404);
    page.once('dialog', dialog => dialog.accept());
    await row.getByRole('button', { name: '停用', exact: true }).click();
    await expect(row).toContainText('已停用');
    await reader.reload();
    await expect(reader.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await row.getByRole('button', { name: '启用', exact: true }).click();
    await expect(row).toContainText('已启用');
    await row.getByRole('button', { name: '重置密码', exact: true }).click();
    await page.getByLabel('新密码', { exact: true }).fill('reader-reset-password');
    await page.getByRole('button', { name: '确认重置密码', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('密码已重置');
    await login('reader-reset-password');
    await expect(reader.getByText(`Reader feed ${username}`, { exact: true })).toBeVisible();
    await reader.setViewportSize({ width: 390, height: 844 });
    await reader.screenshot({ path: testInfo.outputPath('reader-mobile.png'), fullPage: true });
    const nextAuth = await (await reader.request.get('/api/auth/status')).json();
    await reader.request.delete(`/api/feeds/${feed.id}`, { headers: protocolHeaders(nextAuth.csrfToken) });
  } finally { await context.close(); }
});
