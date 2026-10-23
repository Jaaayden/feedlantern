import { test, expect } from './fixtures';
import { fixtureBaseUrl } from '../../playwright.config';
import { loginAsAdmin, protocolHeaders } from './support';
import type { Feed, FeedItem, NetworkProfileSummary } from '../../src/shared/types';

const proxyUrl = fixtureBaseUrl; // The fixture server doubles as an authenticated CONNECT proxy.
const listUrl = `${fixtureBaseUrl}/network/list`;

test('网络配置：设置中管理、编辑器预览与后台刷新经代理携带请求头，代理认证失败时提示清楚', async ({ page }) => {
  const auth = await loginAsAdmin(page.request);
  const headers = protocolHeaders(auth.csrfToken);
  const proxyLog = async () => (await (await page.request.get(`${fixtureBaseUrl}/proxy-log`)).json()) as Array<{ target: string; authorized: boolean }>;
  let feedId = '';
  let profileId = '';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const section = page.getByRole('region', { name: '网络配置' });
    await section.getByRole('button', { name: '添加网络配置' }).first().click();
    const dialog = page.getByRole('dialog', { name: '添加网络配置' });
    await dialog.getByLabel('配置名称').fill('E2E proxy');
    await dialog.getByLabel('代理地址（可选）').fill(proxyUrl);
    await dialog.getByLabel('代理用户名').fill('e2e-proxy-user');
    await dialog.getByLabel('代理密码').fill('e2e-proxy-pass');
    await dialog.getByLabel('User-Agent（可选）').fill('FeedLantern-E2E/1.0');
    await dialog.getByLabel('Referer（可选）').fill('https://referer.e2e.test/');
    await dialog.getByRole('button', { name: '添加请求头' }).click();
    await dialog.getByLabel('请求头 1 名称').fill('Cookie');
    await dialog.getByLabel('请求头 1 值').fill('a=1');
    await dialog.getByRole('button', { name: '保存网络配置' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Cookie 凭据');
    await dialog.getByLabel('请求头 1 名称').fill('X-E2E-Token');
    await dialog.getByLabel('请求头 1 值').fill('e2e-header-secret');
    await page.screenshot({ path: 'test-results/visual-qa/network-profile-form.png' });
    await dialog.getByRole('button', { name: '保存网络配置' }).click();
    await expect(dialog).toBeHidden();
    const card = section.getByTestId('network-profile').filter({ hasText: 'E2E proxy' });
    await expect(card).toContainText('代理认证：已保存');
    await expect(card).toContainText('请求头：X-E2E-Token');
    await section.screenshot({ path: 'test-results/visual-qa/network-profiles.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await card.getByRole('button', { name: '编辑网络配置 E2E proxy' }).click();
    await expect(page.getByRole('dialog', { name: '编辑网络配置' }).getByLabel('请求头 1 值')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: 'test-results/visual-qa/network-profile-form-mobile.png', animations: 'disabled' });
    await page.getByRole('dialog', { name: '编辑网络配置' }).getByRole('button', { name: '取消' }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    // Secrets are never sent back to the page.
    const listed = await page.request.get('/api/network-profiles');
    expect(await listed.text()).not.toMatch(/e2e-proxy-pass|e2e-proxy-user|e2e-header-secret/);
    profileId = ((await listed.json()) as NetworkProfileSummary[]).find(p => p.name === 'E2E proxy')!.id;

    await card.getByRole('button', { name: '测试网络配置 E2E proxy' }).click();
    const tester = page.getByRole('dialog', { name: '测试：E2E proxy' });
    // No feed uses it and it was never tested: the neutral address is filled in.
    await expect(tester.getByLabel('测试网址')).toHaveValue('https://example.com/');
    await expect(tester).toContainText('默认填入通用的连通性检查地址，可以修改。');
    await tester.getByLabel('测试网址').fill(listUrl);
    await tester.getByRole('button', { name: '测试连接' }).click();
    await expect(tester.getByRole('status')).toContainText('连接成功：目标网站返回 HTTP 200');
    await tester.getByRole('button', { name: '关闭', exact: true }).first().click();
    // Reopened: the address tested last in this browser.
    await card.getByRole('button', { name: '测试网络配置 E2E proxy' }).click();
    await expect(tester.getByLabel('测试网址')).toHaveValue(listUrl);
    await expect(tester).toContainText('默认填入上次测试的网址');
    await tester.getByRole('button', { name: '关闭', exact: true }).first().click();

    // Edit without retyping secrets keeps them.
    await card.getByRole('button', { name: '编辑网络配置 E2E proxy' }).click();
    const edit = page.getByRole('dialog', { name: '编辑网络配置' });
    await expect(edit.getByLabel('代理用户名')).toHaveValue('');
    await expect(edit.getByLabel('请求头 1 值')).toHaveAttribute('placeholder', /已保存/);
    await edit.getByRole('button', { name: '保存网络配置' }).click();
    await expect(edit).toBeHidden();

    const before = (await proxyLog()).filter(entry => entry.authorized).length;
    await page.goto('/');
    await page.getByRole('button', { name: '新建订阅' }).first().click();
    await page.getByLabel('源网址').fill(listUrl);
    await page.getByText('加载与网络设置').click();
    await page.getByRole('combobox', { name: '网络配置' }).selectOption(profileId);
    await page.getByRole('button', { name: '打开并自动识别' }).click();
    const expected = 'ua=FeedLantern-E2E/1.0 token=e2e-header-secret referer=https://referer.e2e.test/';
    await expect(page.getByText(`Network 1 ${expected}`).first()).toBeVisible({ timeout: 45_000 });
    expect((await proxyLog()).filter(entry => entry.authorized).length).toBeGreaterThan(before);
    await page.locator('.save-panel .field input').first().fill('Network profile feed');
    await page.getByRole('button', { name: '保存订阅' }).click();
    await expect(page.getByRole('button', { name: '复制 RSS 地址', exact: true }).first()).toBeVisible();

    const feeds = (await (await page.request.get('/api/feeds')).json()) as Feed[];
    const feed = feeds.find(f => f.name === 'Network profile feed')!;
    feedId = feed.id;
    expect(feed.networkProfileId).toBe(profileId);
    const items = async () => ((await (await page.request.get(`/api/feeds/${feedId}`)).json()) as { items: FeedItem[] }).items;
    expect((await items()).map(item => item.title)).toContain(`Network 1 ${expected}`);
    expect((await proxyLog()).every(entry => entry.target === new URL(fixtureBaseUrl).host)).toBeTruthy();

    // Feed settings switch back to the default network.
    await page.getByRole('dialog').getByRole('button', { name: '订阅设置', exact: true }).click();
    const select = page.getByRole('dialog').getByRole('combobox', { name: '网络配置' });
    await expect(select).toHaveValue(profileId);
    await select.selectOption('');
    await page.getByRole('dialog').getByRole('button', { name: '保存设置' }).click();
    await expect(page.getByText('订阅设置已保存')).toBeVisible();
    expect((await page.request.post(`/api/feeds/${feedId}/refresh`, { headers, data: {} })).ok()).toBeTruthy();
    expect((await items()).map(item => item.title).join('\n')).toContain('token=none');

    // A wrong proxy password gives a clear error on the next refresh.
    expect((await page.request.put(`/api/network-profiles/${profileId}`, { headers, data: { name: 'E2E proxy', proxyUrl, proxyUsername: 'e2e-proxy-user', proxyPassword: 'wrong-pass' } })).ok()).toBeTruthy();
    expect((await page.request.patch(`/api/feeds/${feedId}`, { headers, data: { networkProfileId: profileId } })).ok()).toBeTruthy();
    const failed = await (await page.request.post(`/api/feeds/${feedId}/refresh`, { headers, data: {} })).json() as { feed: Feed };
    expect(failed.feed.lastError).toContain('代理认证失败（HTTP 407）');
    expect(failed.feed.lastError).not.toContain('wrong-pass');
    const unreachable = await page.request.post('/api/network-profiles', { headers, data: { name: 'Blocked LAN proxy', proxyUrl: 'socks5://192.168.1.10:1080' } });
    expect(unreachable.status()).toBe(400);
    expect((await unreachable.json()).error).toContain('安全策略阻止');
    const inUse = await page.request.delete(`/api/network-profiles/${profileId}`, { headers });
    expect(inUse.status()).toBe(409);

    // A feed uses the profile now: its source address comes first.
    await page.goto('/');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('region', { name: '网络配置' }).getByRole('button', { name: '测试网络配置 E2E proxy' }).click();
    await expect(tester).toContainText('默认填入订阅“Network profile feed”的来源地址');
    await expect(tester.getByLabel('测试网址')).toHaveValue(listUrl);
  } finally {
    if (feedId) await page.request.delete(`/api/feeds/${feedId}`, { headers });
    if (profileId) await page.request.delete(`/api/network-profiles/${profileId}`, { headers });
  }
});
