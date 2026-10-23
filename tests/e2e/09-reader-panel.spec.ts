import { test, expect } from './fixtures';
import { e2eBaseUrl, loginAsAdmin, protocolHeaders, STATIC_RULES, FIXTURE_URLS } from './support';
import { fixtureBaseUrl } from '../../playwright.config';

test('订阅内容按阅读器样式展示：折叠摘要、缩略图、展开全文；非翻译订阅不显示翻译内容', async ({ page }, testInfo) => {
  const auth = await loginAsAdmin(page.request);
  const headers = protocolHeaders(auth.csrfToken);
  const created = await page.request.post('/api/feeds', { headers, data: { sourceType: 'rss', translationMode: 'original', name: '阅读器样式验收', url: `${fixtureBaseUrl}/reader.xml?e2e=reader`, rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 60, waitMs: 0 } });
  expect(created.ok()).toBeTruthy();
  const { feed } = await created.json();
  await expect.poll(async () => (await (await page.request.get(`/api/feeds/${feed.id}`)).json()).items.length, { timeout: 30_000 }).toBe(4);

  await page.goto(`/#/feed/${feed.id}`);
  const dialog = page.getByRole('dialog');
  const items = dialog.locator('article.preview-item');
  await expect(items).toHaveCount(4);
  const first = items.first();
  await expect(first.getByRole('link', { name: 'Night trains are back across Europe' })).toHaveAttribute('target', '_blank');
  await expect(first.locator('.item-host')).toHaveText('127.0.0.1');
  await expect(first.locator('.item-thumb')).toBeVisible();
  await expect(first.locator('.item-summary')).toContainText('Sleeper services');
  // No translation UI anywhere for a feed that is not translated.
  await expect(dialog.getByText('重试未完成翻译')).toHaveCount(0);
  await expect(dialog.locator('.item-tag.pending, .item-tag.failed')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('reader-items-light.png') });

  await first.getByRole('button', { name: '展开全文' }).click();
  const frame = dialog.locator('iframe[title="订阅正文 1"]');
  await expect(dialog.frameLocator('iframe[title="订阅正文 1"]').getByText('Bookings opened on Monday', { exact: false })).toBeVisible();
  // The frame sizes itself to the article instead of scrolling inside a box.
  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeGreaterThan(250);
  const sandbox = await frame.getAttribute('sandbox');
  expect(sandbox).not.toContain('allow-scripts');
  expect(sandbox).not.toContain('allow-top-navigation');
  await first.getByRole('button', { name: '收起' }).click();
  await expect(frame).toHaveCount(0);

  await dialog.getByRole('button', { name: '运行日志', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/feed/${feed.id}/logs$`));
  await expect(dialog.getByRole('region', { name: '抓取日志' })).toBeVisible();
  await expect(dialog.getByRole('group', { name: '日志类型' })).toHaveCount(0);

  await page.emulateMedia({ colorScheme: 'dark' });
  await dialog.getByRole('button', { name: '订阅内容', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/feed/${feed.id}$`));
  await page.screenshot({ path: testInfo.outputPath('reader-items-dark.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.viewport);
  await page.screenshot({ path: testInfo.outputPath('reader-items-mobile.png') });
});

test('访问令牌调用记录：展开查看、按状态筛选、失败高亮；管理员在用户工作台只读查看', async ({ page, playwright }, testInfo) => {
  const auth = await loginAsAdmin(page.request);
  const headers = protocolHeaders(auth.csrfToken);
  const name = `调用记录 ${Date.now()}`;
  const minted = await page.request.post('/api/tokens', { headers, data: { name, scope: 'read' } });
  expect(minted.ok()).toBeTruthy();
  const { secret } = await minted.json();
  const script = await playwright.request.newContext({ baseURL: e2eBaseUrl, extraHTTPHeaders: { Authorization: `Bearer ${secret}` } });
  try {
    expect((await script.get('/api/feeds?page=2')).status()).toBe(200);
    expect((await script.post('/api/feeds', { data: { name: 'x', url: FIXTURE_URLS.static, rules: STATIC_RULES, credentialId: null, intervalMinutes: 60, waitMs: 0 } })).status()).toBe(403);
    expect((await script.get('/api/feeds/missing-feed')).status()).toBe(404);
  } finally { await script.dispose(); }

  await page.goto('/#/settings/tokens');
  const panel = page.getByRole('region', { name: '访问令牌' });
  const row = panel.getByRole('listitem', { name: `令牌 ${name}` });
  await expect(row).toContainText('24 小时 3 次');
  await expect(row).toContainText('2 次失败');
  await row.getByRole('button', { name: `调用记录 ${name}` }).click();
  const calls = row.getByRole('region', { name: `调用记录 ${name}` });
  await expect(calls.locator('.token-call')).toHaveCount(3);
  await expect(calls.locator('.token-call.is-failed')).toHaveCount(2);
  await expect(calls.getByRole('listitem', { name: 'POST /api/feeds 403' })).toBeVisible();
  await expect(calls.getByRole('listitem', { name: 'GET /api/feeds/:id 404' })).toBeVisible();
  await expect(calls).not.toContainText('page=2');
  await expect(calls).toContainText('网页登录后的操作不会出现在这里');
  await calls.getByRole('button', { name: '被拒绝' }).click();
  await expect(calls.locator('.token-call')).toHaveCount(1);
  await expect(calls.locator('.token-call')).toContainText('403');
  await calls.getByRole('button', { name: '成功' }).click();
  await expect(calls.locator('.token-call')).toHaveCount(1);
  await expect(calls.locator('.token-call.is-failed')).toHaveCount(0);
  await calls.getByRole('button', { name: '全部' }).click();
  await panel.screenshot({ path: testInfo.outputPath('token-calls-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await panel.screenshot({ path: testInfo.outputPath('token-calls-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  // Another account's tokens: an administrator can read them in that workspace, nothing more.
  const username = `token-owner-${Date.now()}`;
  const user = await page.request.post('/api/users', { headers, data: { username, password: 'token-owner-password' } });
  expect(user.ok()).toBeTruthy();
  const userId = (await user.json()).id;
  const owner = await playwright.request.newContext({ baseURL: e2eBaseUrl });
  try {
    const login = await owner.post('/api/auth/login', { headers: protocolHeaders(), data: { username, password: 'token-owner-password' } });
    const ownerAuth = await login.json();
    const ownerToken = await owner.post('/api/tokens', { headers: protocolHeaders(ownerAuth.csrfToken), data: { name: '同步脚本', scope: 'read' } });
    const ownerSecret = (await ownerToken.json()).secret;
    expect((await owner.get('/api/feeds', { headers: { Authorization: `Bearer ${ownerSecret}` } })).status()).toBe(200);
  } finally { await owner.dispose(); }
  await page.goto(`/#/u/${userId}/settings/tokens`);
  const theirs = page.getByRole('region', { name: '访问令牌' });
  await expect(theirs).toContainText(`${username} 的访问令牌和调用记录，只能查看`);
  await expect(theirs.getByRole('button', { name: '创建令牌' })).toHaveCount(0);
  const theirRow = theirs.getByRole('listitem', { name: '令牌 同步脚本' });
  await expect(theirRow.getByRole('button', { name: /吊销/ })).toHaveCount(0);
  await theirRow.getByRole('button', { name: '调用记录 同步脚本' }).click();
  await expect(theirRow.getByRole('listitem', { name: 'GET /api/feeds 200' })).toBeVisible();
  await expect(theirs.getByRole('listitem', { name: `令牌 ${name}` })).toHaveCount(0);
});
