import { test, expect } from './fixtures';
import { loginAsAdmin, protocolHeaders, TEST_ACCOUNT } from './support';

// Preview only: confirming would replace the shared e2e instance's data.
test('完整恢复预览列出服务器与网络设置，默认不勾选恢复备份中的设置', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const exported = await page.request.post('/api/backups/export', { headers, data: { currentPassword: TEST_ACCOUNT.password, password: 'e2e-backup-password' } });
  expect(exported.ok()).toBeTruthy();
  const archive = await exported.json();
  await page.goto('/#/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '备份与迁移', exact: true }).click();
  await page.getByRole('button', { name: '完整恢复', exact: true }).click();
  await page.getByLabel('当前管理员密码').fill(TEST_ACCOUNT.password);
  await page.getByLabel(/备份密码/).fill('e2e-backup-password');
  await page.locator('input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
  await page.getByRole('button', { name: '预览导入', exact: true }).click();
  await expect(page.getByText('默认保留本机的服务器与网络设置，恢复后仍可从当前地址访问。')).toBeVisible();
  await expect(page.getByText('备份中的服务器与网络设置与本机相同。')).toBeVisible();
  const option = page.getByLabel('同时恢复备份中的服务器与网络设置');
  await expect(option).not.toBeChecked();
  await expect(page.getByText(/请求来源不被允许/)).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(option).toHaveCount(0);
});
