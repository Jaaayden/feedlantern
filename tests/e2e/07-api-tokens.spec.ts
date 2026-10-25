import { test, expect } from './fixtures';
import { e2eBaseUrl, loginAsAdmin, STATIC_RULES, FIXTURE_URLS } from './support';

test('设置页创建访问令牌，脚本用 Bearer 调用 API，吊销后立即失效', async ({ page, playwright }, testInfo) => {
  await loginAsAdmin(page.request);
  await page.goto('/#/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '访问令牌' }).click();
  const panel = page.getByRole('region', { name: '访问令牌' });
  const name = `e2e 脚本 ${Date.now()}`;
  await panel.getByLabel('令牌名称').fill(name);
  await panel.getByLabel('权限').selectOption('read');
  await panel.getByLabel('有效期').selectOption('30');
  await panel.getByRole('button', { name: '创建令牌' }).click();
  const secretBox = panel.getByLabel('新令牌');
  await expect(secretBox).toHaveValue(/^fl_[A-Za-z0-9_-]{43}$/);
  const secret = await secretBox.inputValue();
  const row = panel.getByRole('listitem', { name: `令牌 ${name}` });
  await expect(row).toContainText('只读');
  await expect(row).toContainText('尚未使用');
  await expect(row).toContainText(secret.slice(0, 11));
  await page.screenshot({ path: testInfo.outputPath('api-tokens.png'), fullPage: true });

  // A script has no browser session: only the bearer token.
  const script = await playwright.request.newContext({ baseURL: e2eBaseUrl, extraHTTPHeaders: { Authorization: `Bearer ${secret}` } });
  try {
    const feeds = await script.get('/api/feeds');
    expect(feeds.status()).toBe(200);
    expect(Array.isArray(await feeds.json())).toBeTruthy();
    const write = await script.post('/api/feeds', { data: { name: 'token write', url: FIXTURE_URLS.static, rules: STATIC_RULES, credentialId: null, intervalMinutes: 60, waitMs: 0 } });
    expect(write.status()).toBe(403);
    expect((await write.json()).error).toContain('只读令牌');
    expect((await script.get('/api/backups/config')).status()).toBe(403);
    const spec = await (await script.get('/api/openapi.json')).json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths['/api/feeds'].get['x-feedlantern-token']).toBe('read');

    await panel.getByRole('button', { name: '我已保存' }).click();
    await expect(secretBox).toHaveCount(0);
    await page.reload();
    await expect(row).toContainText('最近使用');
    page.once('dialog', dialog => void dialog.accept());
    await row.getByRole('button', { name: `吊销令牌 ${name}` }).click();
    await expect(row).toHaveCount(0);
    expect((await script.get('/api/feeds')).status()).toBe(401);
  } finally { await script.dispose(); }
});
