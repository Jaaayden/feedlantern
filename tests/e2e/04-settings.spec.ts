import { test, expect } from './fixtures';
import { loginAsAdmin, protocolHeaders } from './support';

test('网页设置保存、配置导出导入及手机显示', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const original = await (await page.request.get('/api/settings')).json();
  try {
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const form = page.getByRole('form', { name: '应用设置' });
    await form.getByLabel('Bark 推送地址').fill('https://api.day.app/e2e-private-key/');
    await form.getByRole('button', { name: '发送测试通知' }).click();
    await expect(form.getByRole('status')).toContainText('测试通知已发送');
    expect((await (await page.request.get('/api/settings')).json()).bark.url).toBe(original.bark.url);
    await form.getByLabel('日志保留天数').fill('90');
    await form.getByLabel('后台并发数').fill('2');
    await expect(form.getByLabel('翻译请求并发数')).toHaveValue('6');
    await form.getByLabel('翻译请求并发数').fill('8');
    await form.getByLabel('翻译请求启动间隔（毫秒）').fill('0');
    await form.getByRole('button', { name: '保存应用设置' }).click();
    await expect(form.getByRole('status')).toContainText('设置已保存');
    await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(form.getByLabel('Bark 推送地址')).toHaveValue('https://api.day.app/e2e-private-key/');
    await expect(form.getByLabel('日志保留天数')).toHaveValue('90');
    await expect(form.getByLabel('翻译请求并发数')).toHaveValue('8');
    await expect(form.getByLabel('翻译请求启动间隔（毫秒）')).toHaveValue('0');
    const archive = await (await page.request.get('/api/backups/config')).json();
    expect(archive.settings.bark.url).toBe('https://api.day.app/e2e-private-key/');
    archive.settings.logRetentionDays = 60;
    await page.getByRole('button', { name: '配置导入', exact: true }).click();
    await page.locator('input[type=file]').setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
    await page.getByRole('button', { name: '预览导入', exact: true }).click();
    await expect(page.getByText('将覆盖的应用及服务器设置（Bark 密钥已隐藏）')).toBeVisible();
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(form.getByLabel('日志保留天数')).toHaveValue('60');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: 'test-results/mobile-settings.png' });
  } finally { await page.request.put('/api/settings', { headers, data: original }); }
});
