import { test, expect } from './fixtures';
import { FIXTURE_URLS, STATIC_RULES, loginAsAdmin, protocolHeaders } from './support';

// Set BUNDLE_SHOTS to a directory to keep screenshots of the bundle UI for review.
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (!process.env.BUNDLE_SHOTS) return;
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${process.env.BUNDLE_SHOTS}/${name}-${colorScheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
};

// The three fixture pages list the same three articles: "static" and "div-cards" under other links,
// "static-tracked" under the same links plus tracking parameters and a trailing slash.
test('聚合订阅的去重与过滤：设置、实时预览的数字与明细、保存后核对输出', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  await page.setViewportSize({ width: 1280, height: process.env.BUNDLE_SHOTS ? 1500 : 900 });
  const ids: string[] = [];
  const names = { plain: '去重验收 原站', tracked: '去重验收 推送', cards: '去重验收 卡片' };
  try {
    for (const [name, url, rules] of [
      [names.plain, FIXTURE_URLS.static, STATIC_RULES],
      [names.tracked, FIXTURE_URLS.staticTracked, STATIC_RULES],
      [names.cards, FIXTURE_URLS.divCards, { item: '.card', title: '.card-heading', link: 'a.card-link' }],
    ] as const) {
      const response = await page.request.post('/api/feeds', { headers, data: { name, url, rules } });
      expect(response.ok()).toBeTruthy(); ids.push((await response.json()).feed.id);
    }

    // Before: a bundle with the original behaviour keeps every distinct link.
    const original = await (await page.request.post('/api/bundles', { headers, data: { name: '去重验收 原有行为', feedIds: ids } })).json();
    const originalBody = await (await page.request.get(original.bundleUrl)).text();
    expect(originalBody.match(/<item>/g)).toHaveLength(9);
    expect(original.bundle.dedupe).toEqual({ mode: 'link', windowDays: null, prefer: 'earliest' });

    await page.goto('/#/bundles');
    await page.getByRole('button', { name: '新建聚合', exact: true }).first().click();
    const editor = page.getByRole('dialog', { name: '新建聚合订阅' });
    await editor.getByLabel('聚合名称').fill('去重验收');
    await editor.getByLabel('搜索成员订阅').fill('去重验收');
    for (const name of Object.values(names)) await editor.getByLabel(`加入成员 ${name}`).check();
    const summary = editor.getByTestId('bundle-preview-summary');

    // The default settings reproduce the original output: nothing is merged, nothing filtered.
    await expect(summary).toHaveText('输出 9 条（成员共 9 条）· 过滤掉 0 条 · 去重合并 0 条');
    await expect(editor.getByRole('radio', { name: /相同链接 · 默认/ })).toBeChecked();

    // Ignoring tracking parameters merges the newsletter copies into the originals.
    await editor.getByRole('radio', { name: /忽略追踪参数/ }).check();
    await expect(summary).toHaveText('输出 6 条（成员共 9 条）· 过滤掉 0 条 · 去重合并 3 条');
    await editor.getByText('被合并的重复条目（3）').click();
    await expect(editor.locator('.bundle-group').first()).toContainText('保留');
    await expect(editor.locator('.bundle-group').first()).toContainText('合并');
    await expect(editor.locator('.bundle-group').first()).toContainText('忽略追踪参数后链接相同');
    await shot(page, 'dedupe-editor-url');

    // Same title merges the cards too. The window is only offered for titles.
    await expect(editor.getByLabel('标题只在多少天内比较')).toHaveCount(0);
    await editor.getByRole('radio', { name: /链接或标题相同/ }).check();
    await expect(summary).toHaveText('输出 3 条（成员共 9 条）· 过滤掉 0 条 · 去重合并 6 条');
    await expect(editor.locator('.bundle-group').first()).toContainText('标题相同');
    // The three pages publish each article on the same day, so a one-day window changes nothing here
    // (the window itself is covered by the unit tests); an out-of-range value is refused on save.
    await editor.getByLabel('标题只在多少天内比较').fill('1');
    await expect(summary).toHaveText('输出 3 条（成员共 9 条）· 过滤掉 0 条 · 去重合并 6 条');
    await editor.getByLabel('标题只在多少天内比较').fill('');

    // Which copy is kept: by default the one collected first (the original site); by priority the card page can win.
    const keptSources = () => editor.locator('.bundle-group > .bundle-item-line').allTextContents();
    expect((await keptSources()).every(text => text.includes(names.plain))).toBeTruthy();
    await editor.getByLabel('保留哪一份').selectOption('order');
    await editor.getByLabel(`上移 ${names.cards}`).click();
    await editor.getByLabel(`上移 ${names.cards}`).click();
    await expect(editor.getByRole('list', { name: '优先级' }).locator('li').first()).toContainText(`1. ${names.cards}`);
    await expect.poll(async () => (await keptSources()).every(text => text.includes(names.cards))).toBeTruthy();

    await editor.getByRole('list', { name: '优先级' }).evaluate(element => element.scrollIntoView({ block: 'start' }));
    await shot(page, 'dedupe-editor-order');
    // The bundle filter judges the merged items; the preview names the rule that dropped each one.
    const exclude = editor.getByRole('textbox', { name: /^排除关键词/ }), include = editor.getByRole('textbox', { name: /^包含关键词/ });
    await exclude.fill('article two');
    await expect(summary).toHaveText('输出 2 条（成员共 9 条）· 过滤掉 3 条 · 去重合并 4 条');
    await editor.getByText('被过滤的条目（3）').click();
    await expect(editor.locator('.bundle-detail').first()).toContainText('命中排除规则“article two”');
    await include.fill('推送');
    await expect(summary).toHaveText('输出 0 条（成员共 9 条）· 过滤掉 9 条 · 去重合并 0 条');
    await editor.getByLabel('同时匹配来源订阅名称').check();
    await expect(summary).toHaveText('输出 2 条（成员共 9 条）· 过滤掉 7 条 · 去重合并 0 条');
    await include.fill('');
    await exclude.fill('(a+)+');
    await editor.getByLabel(/按正则表达式匹配/).check();
    await expect(editor.getByRole('alert')).toContainText('嵌套重复');
    await editor.getByLabel(/按正则表达式匹配/).uncheck();
    await exclude.fill('article two');
    await expect(summary).toHaveText('输出 2 条（成员共 9 条）· 过滤掉 3 条 · 去重合并 4 条');
    await shot(page, 'dedupe-editor-filter');
    await editor.getByRole('button', { name: '创建聚合' }).click();
    await expect(page.getByRole('status')).toContainText('聚合订阅已创建');

    // Saved: the card says what it does, its merge details agree with the editor, and the address publishes the result.
    const card = page.getByRole('article', { name: '聚合订阅 去重验收', exact: true });
    await expect(card).toContainText('去重：链接或标题');
    await expect(card).toContainText('已过滤');
    await card.getByRole('button', { name: '聚合订阅 去重验收 的合并详情' }).click();
    const details = page.getByRole('dialog', { name: '合并详情' });
    await expect(details.getByTestId('bundle-preview-summary')).toHaveText('输出 2 条（成员共 9 条）· 过滤掉 3 条 · 去重合并 4 条');
    await shot(page, 'dedupe-details');
    await details.getByRole('button', { name: '关闭' }).click();

    const saved = (await (await page.request.get('/api/bundles')).json()).find((entry: { bundle: { name: string } }) => entry.bundle.name === '去重验收');
    expect(saved.bundle.feedIds[0]).toBe(ids[2]);
    expect(saved.bundle.dedupe).toEqual({ mode: 'title', windowDays: null, prefer: 'order' });
    expect(saved.bundle.itemFilter).toEqual({ include: [], exclude: ['article two'], regex: false, matchSource: true });
    const output = await (await page.request.get(saved.bundleUrl)).text();
    expect(output.match(/<item>/g)).toHaveLength(2);
    expect(output).not.toContain('Fixture article two');
    expect(output).toContain(`<category>${names.cards}</category>`);
    expect(output).not.toContain(`<category>${names.plain}</category>`);
    // The members keep everything they stored: filtering and merging only change the bundle's output.
    for (const id of ids) expect((await (await page.request.get(`/api/feeds/${id}`)).json()).items).toHaveLength(3);
    // The bundle that was never touched still publishes exactly what it did before.
    // (The channel description follows the owner's interface language, which another spec may have changed; the items are what matters.)
    const items = (xml: string) => xml.match(/<item>.*?<\/item>/g);
    expect(items(await (await page.request.get(original.bundleUrl)).text())).toEqual(items(originalBody));

    // Edit again: the saved settings come back into the form.
    await card.getByRole('button', { name: '编辑聚合 去重验收' }).click();
    const again = page.getByRole('dialog', { name: '编辑聚合订阅' });
    await expect(again.getByRole('radio', { name: /链接或标题相同/ })).toBeChecked();
    await expect(again.getByLabel('保留哪一份')).toHaveValue('order');
    await expect(again.getByRole('textbox', { name: /^排除关键词/ })).toHaveValue('article two');
    await expect(again.getByLabel('同时匹配来源订阅名称')).toBeChecked();
    await expect(again.getByTestId('bundle-preview-summary')).toHaveText('输出 2 条（成员共 9 条）· 过滤掉 3 条 · 去重合并 4 条');
    await again.getByRole('button', { name: '取消', exact: true }).click();
  } finally {
    for (const { bundle } of await (await page.request.get('/api/bundles')).json()) await page.request.delete(`/api/bundles/${bundle.id}`, { headers });
    for (const id of ids) await page.request.delete(`/api/feeds/${id}`, { headers });
  }
});
