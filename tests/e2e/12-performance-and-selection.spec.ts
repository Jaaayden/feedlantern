import { test, expect } from './fixtures';
import { FIXTURE_URLS, STATIC_RULES, loginAsAdmin, protocolHeaders } from './support';

test('设置栏目共享请求与缓存，加载提示准确且保存后切换保留最新值', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const original = await (await page.request.get('/api/settings')).json();
  let reads = 0, release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'GET') { reads++; await waiting; }
    await route.continue();
  });
  try {
    await page.goto('/#/settings/server');
    await expect(page.getByText('正在加载服务器与网络…', { exact: true })).toBeVisible();
    const nav = page.getByRole('navigation', { name: '设置分组' });
    await nav.getByRole('button', { name: 'PubMed（NCBI）', exact: true }).click();
    await expect(page.getByText('正在加载PubMed（NCBI）…', { exact: true })).toBeVisible();
    await nav.getByRole('button', { name: '翻译服务', exact: true }).click();
    await expect(page.getByText('正在加载翻译服务…', { exact: true })).toBeVisible();
    expect(reads).toBe(1);
    release();
    await expect(page.getByRole('form', { name: '翻译服务', exact: true })).toBeVisible();
    for (const name of ['服务器与网络', 'PubMed（NCBI）', '日志与显示']) {
      await nav.getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('form', { name, exact: true })).toBeVisible();
      await expect(page.getByText(/^正在加载/)).toHaveCount(0);
    }
    expect(reads).toBe(1);
    await page.getByLabel('日志保留天数', { exact: true }).fill('45');
    await page.getByRole('button', { name: '保存日志与显示', exact: true }).click();
    await expect(page.getByText('设置已保存。', { exact: true })).toBeVisible();
    await nav.getByRole('button', { name: '服务器与网络', exact: true }).click();
    await nav.getByRole('button', { name: '日志与显示', exact: true }).click();
    await expect(page.getByLabel('日志保留天数', { exact: true })).toHaveValue('45');
    expect(reads).toBe(1);
  } finally { release(); await page.request.put('/api/settings', { headers, data: original }); }
});

test('大量订阅完整显示和搜索，格式器复用且切到设置不再轮询列表', async ({ page }) => {
  await loginAsAdmin(page.request);
  const now = new Date().toISOString(), past = new Date(Date.now() - 120_000).toISOString();
  const feeds = Array.from({ length: 1000 }, (_, i) => ({ id: `performance-${i}`, name: `大量订阅 ${String(i).padStart(4, '0')}`, url: `https://example.test/${i}`, sourceType: 'website', translationMode: 'original', rules: STATIC_RULES, credentialId: null, intervalMinutes: 60, waitMs: 0, enabled: true, createdAt: now, lastFetchedAt: past, lastSuccessAt: past, nextFetchAt: now, lastError: null, itemCount: 20 }));
  let feedReads = 0;
  await page.route('**/api/feeds', async route => { feedReads++; await route.fulfill({ json: feeds }); });
  await page.route('**/api/bundles', route => route.fulfill({ json: [] }));
  await page.addInitScript(() => {
    (window as unknown as { formatterCount: number }).formatterCount = 0;
    for (const key of ['DateTimeFormat', 'RelativeTimeFormat'] as const) {
      const Original = Intl[key];
      Object.defineProperty(Intl, key, { value: new Proxy(Original, { construct(target, args) {
        (window as unknown as { formatterCount: number }).formatterCount++;
        return Reflect.construct(target, args);
      } }), configurable: true });
    }
  });
  await page.clock.install();
  await page.goto('/#/');
  const list = page.getByRole('region', { name: '订阅集合' });
  await expect(list.locator('article')).toHaveCount(1000);
  expect(await page.evaluate(() => (window as unknown as { formatterCount: number }).formatterCount)).toBeLessThan(20);
  await page.getByLabel('搜索订阅').fill('0999');
  await expect(list.locator('article')).toHaveCount(1);
  await expect(list).toContainText('大量订阅 0999');
  await expect(list).toContainText('2分钟前');
  await page.clock.fastForward(61_000);
  await expect(list).toContainText('3分钟前');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '设置分组' })).toBeVisible();
  const before = feedReads;
  await page.clock.fastForward(31_000);
  await page.waitForTimeout(100);
  expect(feedReads).toBe(before);
});

test('需要检查阈值在个人设置中修改，保存后立即更新侧栏，早期失败显示等待重试', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const username = `attention-ui-${Date.now()}`;
  const user = await (await page.request.post('/api/users', { headers, data: { username, password: 'attention-password' } })).json();
  const own = { ...headers, 'x-feedlantern-user': user.id };
  try {
    const feed = (await (await page.request.post('/api/feeds', { headers: own, data: { name: '偶发失败', url: new URL('/unavailable', FIXTURE_URLS.static).href, rules: STATIC_RULES } })).json()).feed;
    expect(feed.consecutiveFailures).toBe(1);
    await page.goto(`/#/u/${user.id}/feeds`);
    await expect(page.getByRole('button', { name: '等待重试', exact: true })).toBeVisible();
    const nav = page.getByRole('navigation', { name: '主导航' });
    await nav.getByRole('button', { name: '需要检查', exact: true }).click();
    await expect(page.getByRole('heading', { name: '目前运行正常' })).toBeVisible();
    await nav.getByRole('button', { name: '设置', exact: true }).click();
    const threshold = page.getByLabel('连续失败多少次后列入需要检查', { exact: true });
    await expect(threshold).toHaveValue('3');
    await threshold.fill('1');
    await page.getByRole('button', { name: '保存告警策略', exact: true }).click();
    await expect(nav.getByRole('button', { name: /^需要检查/ })).toHaveText('需要检查1');
    await threshold.fill('5');
    await page.getByRole('button', { name: '保存告警策略', exact: true }).click();
    await expect(nav.getByRole('button', { name: '需要检查', exact: true })).toBeVisible();
    await page.reload(); await expect(threshold).toHaveValue('5');
    const detail = (await (await page.request.get(`/api/feeds/${feed.id}`, { headers: own })).json()).feed;
    expect(detail.consecutiveFailures).toBe(1); expect(detail.attentionFailureThreshold).toBe(5);
  } finally { await page.request.delete(`/api/users/${user.id}`, { headers, data: { username } }); }
});

test('聚合按名称或网址搜索后全选，取消当前结果保留其他选择，创建时不重复成员', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const username = `bundle-select-${Date.now()}`;
  const user = await (await page.request.post('/api/users', { headers, data: { username, password: 'bundle-password' } })).json();
  const own = { ...headers, 'x-feedlantern-user': user.id }, ids: string[] = [];
  try {
    for (const [name, url] of [['其他来源', FIXTURE_URLS.static], ['Twitter 作者', FIXTURE_URLS.static], ['网址匹配来源', `${FIXTURE_URLS.static}?twitter=source`]]) {
      const response = await page.request.post('/api/feeds', { headers: own, data: { name, url, rules: STATIC_RULES } });
      expect(response.ok()).toBeTruthy(); ids.push((await response.json()).feed.id);
    }
    await page.goto(`/#/u/${user.id}/bundles`);
    await page.getByRole('button', { name: '新建聚合', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '新建聚合订阅' });
    await editor.getByLabel('聚合名称').fill('Twitter 合集');
    await editor.getByLabel('加入成员 其他来源').check();
    const search = editor.getByLabel('搜索成员订阅');
    await search.fill('TWITTER');
    await expect(editor.getByText('匹配 2 个订阅', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: '全选搜索结果', exact: true }).click();
    await expect(editor.getByText('已选择 3 项', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: '取消选择搜索结果', exact: true }).click();
    await expect(editor.getByText('已选择 1 项', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: '全选搜索结果', exact: true }).click();
    await search.fill('no-match');
    await expect(editor.getByRole('button', { name: '全选搜索结果', exact: true })).toBeDisabled();
    await search.fill('');
    await expect(editor.getByRole('checkbox', { checked: true })).toHaveCount(3);
    const created = page.waitForResponse(response => response.url().endsWith('/api/bundles') && response.request().method() === 'POST');
    await editor.getByRole('button', { name: '创建聚合', exact: true }).click();
    const result = await (await created).json();
    expect(result.bundle.feedIds.sort()).toEqual(ids.sort());
  } finally { await page.request.delete(`/api/users/${user.id}`, { headers, data: { username } }); }
});
