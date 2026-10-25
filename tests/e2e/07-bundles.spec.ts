import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures';
import { FIXTURE_URLS, STATIC_RULES, loginAsAdmin, protocolHeaders } from './support';

// Set BUNDLE_SHOTS to a directory to keep screenshots of the bundle UI for review.
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (process.env.BUNDLE_SHOTS) await page.screenshot({ path: `${process.env.BUNDLE_SHOTS}/${name}.png`, fullPage: true });
};

test('聚合订阅：批量加入、复制地址、预览页、编辑成员、轮换密钥、OPML 和删除', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const ids: string[] = [];
  page.on('dialog', dialog => void dialog.accept());
  try {
    for (const [name, url, rules] of [
      ['聚合验收 网页', FIXTURE_URLS.static, STATIC_RULES],
      ['聚合验收 卡片', FIXTURE_URLS.divCards, { item: '.card', title: '.card-heading', link: 'a.card-link' }],
    ] as const) {
      const response = await page.request.post('/api/feeds', { headers, data: { name, url, rules } });
      expect(response.ok()).toBeTruthy(); ids.push((await response.json()).feed.id);
    }
    await page.goto('/#/');
    await page.getByLabel('搜索订阅').fill('聚合验收');
    for (const name of ['聚合验收 网页', '聚合验收 卡片']) await page.getByLabel(`选择订阅 ${name}`, { exact: true }).check();
    await page.getByRole('button', { name: '加入聚合', exact: true }).click();
    const join = page.getByRole('dialog', { name: '加入聚合订阅' });
    await join.getByLabel('新建聚合订阅').check();
    await join.getByLabel('聚合名称').fill('每日聚合验收');
    await join.getByRole('button', { name: '加入聚合', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已创建聚合订阅“每日聚合验收”');

    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '聚合订阅', exact: true }).click();
    const section = page.getByRole('region', { name: '聚合订阅' });
    const card = section.getByRole('article', { name: '聚合订阅 每日聚合验收' });
    await expect(card).toContainText('2 个订阅');
    await expect(card).toContainText('聚合验收 网页');
    await shot(page, 'dashboard');

    await card.getByRole('button', { name: '复制聚合地址 每日聚合验收' }).click();
    await expect(page.getByRole('status')).toContainText('聚合地址已复制');
    const bundleUrl = await page.evaluate(() => navigator.clipboard.readText());
    expect(bundleUrl).toMatch(/\/bundles\/bundle_[a-f0-9]+\/[A-Za-z0-9_-]+\.xml$/);
    const rss = await page.request.get(bundleUrl, { headers: { accept: 'application/rss+xml' } });
    expect(rss.ok()).toBeTruthy();
    const xml = await rss.text();
    expect(xml).toContain('<title>每日聚合验收</title>');
    expect(xml.match(/<item>/g)?.length).toBe(6);
    expect(xml).toContain('<category>聚合验收 网页</category>');
    expect(xml).toContain('<category>聚合验收 卡片</category>');

    await page.goto(bundleUrl);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('每日聚合验收');
    await expect(page.locator('.kicker')).toHaveText('聚合订阅');
    await expect(page.locator('li .source').first()).toBeVisible();
    await shot(page, 'preview');

    await page.goto('/#/bundles');
    await card.getByRole('button', { name: '编辑聚合 每日聚合验收' }).click();
    const editor = page.getByRole('dialog', { name: '编辑聚合订阅' });
    await expect(editor.getByLabel('加入成员 聚合验收 网页')).toBeChecked();
    await editor.getByLabel('加入成员 聚合验收 卡片').uncheck();
    await editor.getByLabel('聚合名称').fill('每日聚合验收 改名');
    await editor.getByLabel('最多条数').fill('20');
    await shot(page, 'editor');
    await editor.getByRole('button', { name: '保存聚合' }).click();
    const renamed = section.getByRole('article', { name: '聚合订阅 每日聚合验收 改名' });
    await expect(renamed).toContainText('1 个订阅 · 最多 20 条');
    expect(((await (await page.request.get(bundleUrl)).text()).match(/<item>/g) ?? []).length).toBe(3);

    await renamed.getByRole('button', { name: '更多操作 每日聚合验收 改名' }).click();
    await page.getByRole('menuitem', { name: '轮换密钥' }).click();
    await expect(page.getByRole('status')).toContainText('聚合地址已更新');
    expect((await page.request.get(bundleUrl)).status()).toBe(404);

    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^全部订阅/ }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 OPML', exact: true }).click();
    const opml = await readFile(await (await download).path(), 'utf8');
    expect(opml).toContain('<outline text="聚合订阅" title="聚合订阅">');
    expect(opml).toContain('title="每日聚合验收 改名"');

    await page.getByRole('button', { name: '更多新建方式' }).click();
    await page.getByRole('menuitem', { name: /聚合订阅/ }).click();
    const creator = page.getByRole('dialog', { name: '新建聚合订阅' });
    await expect(creator.getByLabel('加入成员 聚合验收 卡片')).not.toBeChecked();
    await creator.getByRole('button', { name: '取消' }).click();

    expect((await page.request.delete(`/api/feeds/${ids[0]}`, { headers })).ok()).toBeTruthy();
    await page.goto('/#/bundles');
    await page.reload();
    await expect(section.getByRole('article', { name: '聚合订阅 每日聚合验收 改名' })).toContainText('0 个订阅');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await shot(page, 'mobile');

    await section.getByRole('button', { name: '更多操作 每日聚合验收 改名' }).click();
    await page.getByRole('menuitem', { name: '删除聚合' }).click();
    await expect(page.getByRole('status')).toContainText('聚合订阅已删除');
    await expect(section.getByRole('article')).toHaveCount(0);
    await expect(section.getByRole('heading', { name: '还没有聚合订阅' })).toBeVisible();
  } finally {
    for (const id of ids) await page.request.delete(`/api/feeds/${id}`, { headers });
    for (const { bundle } of await (await page.request.get('/api/bundles')).json()) await page.request.delete(`/api/bundles/${bundle.id}`, { headers });
  }
});
