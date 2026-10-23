import { test, expect } from './fixtures';
import { loginAsAdmin, protocolHeaders } from './support';

test('网页设置保存、配置导出导入及手机显示', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const original = await (await page.request.get('/api/settings')).json();
  try {
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const nav = page.getByRole('navigation', { name: '设置分组' });
    const open = async (label: string, path: string) => { await nav.getByRole('button', { name: label, exact: true }).click(); await expect(page).toHaveURL(new RegExp(`#/settings/${path}$`)); };
    // One group per page: the instance groups are separate entries, not one long form.
    await expect(nav.getByRole('button')).toHaveText(['日志与显示', '翻译服务', '服务器与网络', '通知', 'Cookie 凭据', '网络配置', '账号与密码', '访问令牌', '备份与迁移', '关于']);
    await expect(page.getByRole('form', { name: '日志与显示' })).toBeVisible();
    await expect(page.getByRole('region', { name: '个人通知' })).toHaveCount(0);
    await open('通知', 'notifications');
    const notifications = page.getByRole('region', { name: '个人通知' });
    const bark = notifications.getByRole('form', { name: 'Bark 渠道' }), policy = notifications.getByRole('form', { name: '告警策略' });
    await bark.getByLabel('Bark 推送地址').fill('https://api.day.app/e2e-private-key/');
    await bark.getByRole('button', { name: '发送测试通知' }).click();
    await expect(bark.getByRole('status')).toContainText('发送测试通知');
    expect((await (await page.request.get('/api/settings')).json()).bark.url).toBe(original.bark.url);
    await bark.getByLabel('启用 Bark 告警').check();
    await bark.getByRole('button', { name: '保存 Bark' }).click();
    await expect(bark.getByRole('status')).toContainText('Bark 设置已保存');
    await expect(policy.getByLabel('连续抓取失败告警阈值（次）')).toHaveValue('10');
    await policy.getByLabel('连续抓取失败告警阈值（次）').fill('3');
    await policy.getByRole('button', { name: '保存告警策略' }).click();
    await expect(policy.getByRole('status')).toContainText('告警策略已保存');
    // Webhook: secrets are saved but never shown again; tests use the typed values.
    const webhook = notifications.getByRole('form', { name: 'Webhook 渠道' });
    await webhook.getByLabel('Webhook 地址').fill('https://hooks.example.test/e2e-private-path');
    await webhook.getByLabel('签名密钥（可选）').fill('e2e-signing-secret');
    await webhook.getByLabel('自定义请求头（可选）').fill('X-Token: e2e-header-secret');
    await webhook.getByRole('button', { name: '发送测试通知' }).click();
    await expect(webhook.getByRole('status')).toContainText('已通过 Webhook');
    await webhook.getByLabel('启用 Webhook 告警').check();
    await webhook.getByRole('button', { name: '保存 Webhook' }).click();
    await expect(webhook.getByRole('status')).toContainText('Webhook 设置已保存');
    const summary = await (await page.request.get('/api/notifications')).text();
    for (const secret of ['e2e-private-path', 'e2e-signing-secret', 'e2e-header-secret', 'e2e-private-key']) expect(summary).not.toContain(secret);
    // Telegram cannot be enabled without its token and chat.
    const telegram = notifications.getByRole('form', { name: 'Telegram 渠道' });
    await telegram.getByLabel('启用 Telegram 告警').check();
    await telegram.getByRole('button', { name: '保存 Telegram' }).click();
    await expect(telegram.getByRole('alert')).toContainText('启用 Telegram 时请填写 Bot Token 和 Chat ID');
    await expect(telegram.getByRole('button', { name: '发送测试通知' })).toBeDisabled();

    // Each group saves only its own fields and warns before unsaved changes are dropped.
    await open('日志与显示', 'display');
    const display = page.getByRole('form', { name: '日志与显示' });
    await expect(display.getByRole('button', { name: '保存日志与显示' })).toBeDisabled();
    await display.getByLabel('日志保留天数').fill('90');
    await expect(display.getByText('未保存')).toBeVisible();
    page.once('dialog', dialog => { expect(dialog.message()).toContain('未保存'); void dialog.dismiss(); });
    await nav.getByRole('button', { name: '服务器与网络', exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/display$/);
    await expect(display.getByLabel('日志保留天数')).toHaveValue('90');
    const sent = page.waitForRequest(request => request.url().endsWith('/api/settings') && request.method() === 'PUT');
    await display.getByRole('button', { name: '保存日志与显示' }).click();
    expect((await sent).postDataJSON()).toEqual({ logRetentionDays: 90 });
    await expect(display.getByRole('status')).toContainText('设置已保存');
    await open('服务器与网络', 'server');
    const server = page.getByRole('form', { name: '服务器与网络' });
    await server.getByLabel('后台并发数').fill('2');
    const serverSent = page.waitForRequest(request => request.url().endsWith('/api/settings') && request.method() === 'PUT');
    await server.getByRole('button', { name: '保存服务器与网络' }).click();
    expect((await serverSent).postDataJSON()).toEqual({ server: { backgroundConcurrency: 2 } });
    await expect(server.getByRole('status')).toContainText('设置已保存');
    await open('翻译服务', 'translation');
    const translation = page.getByRole('form', { name: '翻译服务' });
    await expect(translation.getByLabel('Google 请求并发数')).toHaveValue('6');
    await translation.getByLabel('Google 请求并发数').fill('8');
    await translation.getByLabel('Google 请求启动间隔（毫秒）').fill('0');
    await translation.getByRole('button', { name: '保存翻译服务' }).click();
    await expect(translation.getByRole('status')).toContainText('设置已保存');

    // The group survives a reload, and Back returns to the previous group.
    await page.reload();
    await expect(translation.getByLabel('Google 请求并发数')).toHaveValue('8');
    await expect(translation.getByLabel('Google 请求启动间隔（毫秒）')).toHaveValue('0');
    await page.goBack();
    await expect(page).toHaveURL(/#\/settings\/server$/);
    await expect(server.getByLabel('后台并发数')).toHaveValue('2');
    await page.goForward();
    await expect(translation).toBeVisible();
    await open('日志与显示', 'display');
    await expect(display.getByLabel('日志保留天数')).toHaveValue('90');
    await open('通知', 'notifications');
    await expect(bark.getByLabel('Bark 推送地址')).toHaveValue('');
    await expect(bark).toContainText('已保存：https://api.day.app/');
    await expect(webhook.locator('.badge')).toHaveText('已启用');
    await expect(webhook).toContainText('已保存：https://hooks.example.test/••••••');
    await expect(webhook.getByLabel('签名密钥（可选）')).toHaveValue('');
    await expect(webhook.getByLabel('自定义请求头（可选）')).toHaveAttribute('placeholder', /X-Token/);
    await expect(telegram.locator('.badge')).toHaveText('未配置');
    await expect(policy.getByLabel('连续抓取失败告警阈值（次）')).toHaveValue('3');
    const archive = await (await page.request.get('/api/backups/config')).json();
    expect(archive.settings.bark.url).toBe('https://api.day.app/e2e-private-key/');
    expect(archive.settings.bark.failureThreshold).toBe(3);
    expect(archive.notificationChannels.webhook).toMatchObject({ enabled: true, secret: 'e2e-signing-secret', headers: [{ name: 'X-Token', value: 'e2e-header-secret' }] });
    archive.settings.bark.failureThreshold = 5;
    archive.notificationChannels.ntfy = { enabled: true, server: 'https://ntfy.example.test/', topic: 'imported-topic', token: '' };
    archive.settings.logRetentionDays = 60;
    await open('备份与迁移', 'backup');
    await page.getByRole('button', { name: '配置导入', exact: true }).click();
    await page.locator('input[type=file]').setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
    await page.getByRole('button', { name: '预览导入', exact: true }).click();
    await expect(page.getByText('将覆盖的应用、服务器及通知设置（通知密钥已隐藏）')).toBeVisible();
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.getByText(/已导入 \d+ 项/)).toBeVisible();
    await open('日志与显示', 'display');
    await expect(display.getByLabel('日志保留天数')).toHaveValue('60');
    await open('通知', 'notifications');
    await expect(policy.getByLabel('连续抓取失败告警阈值（次）')).toHaveValue('5');
    const ntfy = notifications.getByRole('form', { name: 'ntfy 渠道' });
    await expect(ntfy.getByLabel('ntfy 主题')).toHaveValue('imported-topic');
    await expect(ntfy.locator('.badge')).toHaveText('已启用');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await expect(nav.getByRole('button', { name: '通知', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/mobile-settings.png' });
  } finally {
    await page.request.put('/api/settings', { headers, data: original });
    await page.request.put('/api/notifications', { headers, data: { channels: { webhook: { url: '' }, ntfy: { topic: '' }, telegram: { enabled: false } } } });
  }
});
