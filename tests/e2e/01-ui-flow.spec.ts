import { mkdir } from 'node:fs/promises';
import { expect, test } from './fixtures';
import type { Feed, ScreenFrame } from '../../src/shared/types';
import { FIXTURE_URLS, locatorForUrl, loginInPage, firstVisible } from './support';

test('completes setup login to automatic detection, save, RSS copy, and token rotation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mkdir('test-results/visual-qa', { recursive: true });
  await loginInPage(page);

  const createButton = await firstVisible([
    page.getByRole('button', { name: '新建订阅' }),
    page.getByRole('button', { name: /新建订阅|创建订阅|添加订阅/i }),
  ]);
  await createButton.click();

  const urlInput = await locatorForUrl(page);
  await urlInput.fill(FIXTURE_URLS.static);

  const openButton = await firstVisible([
    page.getByRole('button', { name: '打开并自动识别' }),
    page.getByRole('button', { name: /打开.*识别|自动识别|加载页面/i }),
  ]);
  await openButton.click();

  await expect(page.getByText('Fixture article one').first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('Fixture article two').first()).toBeVisible();
  await expect(page.getByText('Fixture article three').first()).toBeVisible();
  const nameInput = page.locator('.save-panel .field input').first();
  await nameInput.fill('Fixture UI RSS');
  await page.screenshot({ path: 'test-results/visual-qa/editor-preview.png', fullPage: true });

  const saveButton = await firstVisible([
    page.getByRole('button', { name: '保存订阅' }),
    page.getByRole('button', { name: /保存订阅|创建订阅/i }),
  ]);
  await saveButton.click();

  const rssText = page.locator('input[readonly]').first();
  let previousRss = '';
  if (await rssText.count()) {
    await expect(rssText).toBeVisible();
    previousRss = await rssText.inputValue();
    expect(previousRss).toMatch(/\/feeds\/.*\.xml/);
  } else {
    await expect(page.getByRole('button', { name: '复制 RSS 地址', exact: true }).first()).toBeVisible();
  }

  const copyButton = await firstVisible([
    page.getByRole('button', { name: '复制 RSS 地址', exact: true }),
    page.getByRole('button', { name: /复制.*RSS|复制订阅/i }),
  ]);
  await copyButton.click();
  await expect(page.getByText(/已复制|复制成功/)).toBeVisible();

  await page.getByRole('dialog').getByRole('button', { name: '订阅设置', exact: true }).click();
  page.once('dialog', async (dialog) => { await dialog.accept(); });
  const rotateButton = await firstVisible([
    page.getByRole('button', { name: '轮换订阅密钥' }),
    page.getByRole('button', { name: /轮换.*(?:密钥|token)|重新生成密钥/i }),
    page.getByText(/轮换 token/i),
  ]);
  await rotateButton.click();
  await expect(rssText).toHaveValue(/\/feeds\/.*\.xml/);
  if (previousRss) {
    await expect.poll(() => rssText.inputValue()).not.toBe(previousRss);
  }

  await page.getByRole('button', { name: '关闭' }).last().click();
  await expect(page.getByRole('button', { name: '新建订阅' })).toBeVisible();
  await page.screenshot({ path: 'test-results/visual-qa/dashboard.png', fullPage: true });
});

test('allows a user to open matching adjustment after automatic preview', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mkdir('test-results/visual-qa', { recursive: true });
  await loginInPage(page);
  const createButton = await firstVisible([
    page.getByRole('button', { name: '新建订阅' }),
    page.getByRole('button', { name: /新建订阅|创建订阅|添加订阅/i }),
  ]);
  await createButton.click();
  const urlInput = await locatorForUrl(page);
  await urlInput.fill(FIXTURE_URLS.static);
  const openButton = await firstVisible([
    page.getByRole('button', { name: '打开并自动识别' }),
    page.getByRole('button', { name: /打开.*识别|自动识别|加载页面/i }),
  ]);
  await openButton.click();
  await expect(page.getByText('Fixture article one').first()).toBeVisible({ timeout: 45_000 });
  const nameInput = page.locator('.save-panel .field input').first();
  await nameInput.fill('Fixture UI adjustment');

  const adjustButton = await firstVisible([
    page.getByRole('button', { name: '调整匹配' }),
    page.getByRole('button', { name: /调整匹配|手动选择/i }),
  ]);
  await adjustButton.click();
  await page.getByText('高级：编辑匹配规则').click();
  await expect(page.getByText('标题选择器')).toBeVisible();
  await expect(page.locator('.selector-grid input').first()).toBeVisible();

  // The screenshot is rendered at a smaller CSS size than Chromium's 1280px
  // wide capture. Clicking through the rendered image verifies that the UI
  // converts CSS coordinates back to screenshot coordinates before picking.
  const browserImage = page.locator('.browser-screen img');
  await expect(browserImage).toBeVisible();
  const browserBox = await browserImage.boundingBox();
  expect(browserBox).not.toBeNull();
  if (browserBox) {
    const scale = browserBox.width / 1280;
    await browserImage.click({ position: { x: 768 * scale, y: 240 * scale } });
  }
  await expect(page.getByText(/条目容器匹配\s*3\s*项/)).toBeVisible();
  await expect(page.locator('.preview-item')).toHaveCount(3);
  const pickedPreviewLink = page.locator('.preview-item a').first();
  await expect(pickedPreviewLink).toContainText('Fixture article one');
  await expect(pickedPreviewLink).toHaveAttribute('href', /\/article\/one$/);
  await page.screenshot({ path: 'test-results/visual-qa/editor-adjust.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole('button', { name: '退出登录' }).last()).toBeVisible();
  await page.screenshot({ path: 'test-results/visual-qa/mobile-editor-adjust.png', fullPage: true });
});

test('keeps manually cleared optional fields through re-detection and save', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mkdir('test-results/visual-qa', { recursive: true });
  await loginInPage(page);

  await firstVisible([
    page.getByRole('button', { name: '新建订阅' }),
    page.getByRole('button', { name: /新建订阅|创建订阅|添加订阅/i }),
  ]).then((button) => button.click());
  await (await locatorForUrl(page)).fill(FIXTURE_URLS.static);
  await firstVisible([
    page.getByRole('button', { name: '打开并自动识别' }),
    page.getByRole('button', { name: /打开.*识别|自动识别|加载页面/i }),
  ]).then((button) => button.click());

  await expect(page.getByText('Fixture article one').first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('Fixture article two').first()).toBeVisible();
  await expect(page.getByText('Fixture article three').first()).toBeVisible();
  const nameInput = page.locator('.save-panel .field input').first();
  await nameInput.fill('Fixture UI manual optional fields');
  await firstVisible([
    page.getByRole('button', { name: '调整匹配' }),
    page.getByRole('button', { name: /调整匹配|手动选择/i }),
  ]).then((button) => button.click());
  await page.getByText('高级：编辑匹配规则').click();

  const titleSelector = page.getByLabel('标题选择器');
  const linkSelector = page.getByLabel('链接选择器');
  const titleBefore = await titleSelector.inputValue();
  const linkBefore = await linkSelector.inputValue();
  expect(titleBefore).toBeTruthy();
  expect(linkBefore).toBeTruthy();

  const optionalSelectors = [
    page.getByLabel('摘要选择器'),
    page.getByLabel('图片选择器'),
    page.getByLabel('日期选择器'),
  ];
  for (const selector of optionalSelectors) {
    await selector.fill('');
    await expect(selector).toHaveValue('');
  }
  await expect(page.getByText('The first deterministic fixture article.').first()).toBeHidden();

  // Re-detection must keep a field explicitly cleared by the user.
  await page.getByRole('button', { name: '重新识别' }).click();
  await expect(page.getByRole('button', { name: '重新识别' })).toBeEnabled();
  for (const selector of optionalSelectors) await expect(selector).toHaveValue('');
  await expect(page.getByText(/手动配置 · 重新识别时保留/).first()).toBeVisible();
  await expect(titleSelector).toHaveValue(titleBefore);
  await expect(linkSelector).toHaveValue(linkBefore);

  // The selector container still has three entries, with accurate title/link
  // samples after the re-detection round trip.
  await expect(page.getByText(/3 条内容/).first()).toBeVisible();
  const firstPreviewLink = page.locator('.preview-item a').first();
  await expect(firstPreviewLink).toContainText('Fixture article one');
  await expect(firstPreviewLink).toHaveAttribute('href', /\/article\/one$/);
  await expect(page.locator('.preview-item')).toHaveCount(3);

  // Replacing automatic matches is an explicit user action. Cancelling its
  // confirmation must leave the manually cleared optional fields untouched.
  const replaceButton = page.getByRole('button', { name: '替换全部匹配' });
  await expect(replaceButton).toBeVisible();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('替换全部匹配');
    await dialog.dismiss();
  });
  await replaceButton.click();
  for (const selector of optionalSelectors) await expect(selector).toHaveValue('');

  await firstVisible([
    page.getByRole('button', { name: '保存订阅' }),
    page.getByRole('button', { name: /保存订阅|创建订阅/i }),
  ]).then((button) => button.click());
  await expect(page.getByRole('button', { name: '复制 RSS 地址', exact: true })).toBeVisible();

  const headers = { 'X-FeedLantern': '1' };
  const listResponse = await page.request.get('/api/feeds', { headers });
  expect(listResponse.ok()).toBeTruthy();
  const feeds = (await listResponse.json()) as Feed[];
  const saved = feeds.find((feed) => feed.name === 'Fixture UI manual optional fields');
  expect(saved).toBeDefined();
  expect(saved?.ruleOrigins).toMatchObject({ description: 'manual', image: 'manual', date: 'manual' });
  expect(saved?.rules.description ?? '').toBe('');
  expect(saved?.rules.image ?? '').toBe('');
  expect(saved?.rules.date ?? '').toBe('');

  const detailResponse = await page.request.get(`/api/feeds/${encodeURIComponent(saved!.id)}`, { headers });
  expect(detailResponse.ok()).toBeTruthy();
  const detail = (await detailResponse.json()) as { items: Array<{ title: string; link: string }> };
  expect(detail.items).toHaveLength(3);
  expect(detail.items[0]).toMatchObject({ title: 'Fixture article one', link: expect.stringMatching(/\/article\/one$/) });
  await page.screenshot({ path: 'test-results/visual-qa/editor-manual-preserve.png', fullPage: true });
});

test('日期裸文本点选显示时间片段和估算值，保存后仍可见', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginInPage(page);
  await page.getByRole('button', { name: '新建订阅', exact: true }).click();
  await (await locatorForUrl(page)).fill(FIXTURE_URLS.relativeDates);
  await page.getByRole('button', { name: '打开并自动识别', exact: true }).click();
  await expect(page.locator('.preview-item')).toHaveCount(3, { timeout: 45000 });
  await expect(page.locator('.preview-item time').first()).toContainText('估算');
  await page.getByRole('button', { name: '调整匹配', exact: true }).click();
  await page.getByRole('button', { name: '日期', exact: true }).click();
  const image = page.locator('.browser-screen img');
  const box = await image.boundingBox();
  expect(box).not.toBeNull();
  await image.click({ position: { x: box!.width * 170 / 1280, y: box!.width * 45 / 1280 } });
  await expect(page.getByText(/已从选中区域提取时间.*3分前.*估算/)).toBeVisible();
  await expect(page.locator('.preview-item')).toHaveCount(3);
  await page.locator('.save-panel .field input').first().fill('相对日期回归');
  await page.getByRole('button', { name: '保存订阅', exact: true }).click();
  await expect(page.locator('.modal .preview-item time').first()).toContainText('估算');
});

test('长网页在本地滚动，悬停即时高亮，不发送远端操作', async ({ page }) => {
  await loginInPage(page);
  await page.getByRole('button', { name: '新建订阅', exact: true }).click();
  await (await locatorForUrl(page)).fill(new URL('/static-scroll', FIXTURE_URLS.static).href);
  await page.getByRole('button', { name: '打开并自动识别', exact: true }).click();
  await expect(page.locator('.preview-item')).toHaveCount(3, { timeout: 45000 });
  await page.getByRole('button', { name: '调整匹配', exact: true }).click();
  const image = page.locator('.browser-screen img');
  await expect(image).toBeVisible();
  // The whole page arrives as one tall capture.
  expect(await image.evaluate((element: HTMLImageElement) => element.naturalHeight)).toBeGreaterThan(800);
  let requests = 0;
  page.on('request', request => { if (request.url().includes('/api/browser')) requests++; });

  const box = (await image.boundingBox())!;
  const scale = box.width / 1280;
  await image.hover({ position: { x: 200 * scale, y: 200 * scale } });
  await expect(page.locator('.hover-label')).toBeVisible();
  const before = await page.locator('.hover-rect').getAttribute('style');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.hover-label')).toContainText('已扩大 1 层');
  expect(await page.locator('.hover-rect').getAttribute('style')).not.toBe(before);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.hover-label em')).toHaveCount(0);

  const viewport = page.locator('.browser-viewport');
  await viewport.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '向下滚动网页' })).toHaveCount(0);
  expect(requests).toBe(0);
});

test('按住修饰键点击链接跳转后，可以以此页为源网址', async ({ page }) => {
  await loginInPage(page);
  await page.getByRole('button', { name: '新建订阅', exact: true }).click();
  const urlInput = await locatorForUrl(page);
  await urlInput.fill(FIXTURE_URLS.hub);
  const opened = page.waitForResponse(response => new URL(response.url()).pathname === '/api/browser' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '打开并自动识别', exact: true }).click();
  const frame = await (await opened).json() as ScreenFrame;
  await expect(page.getByRole('heading', { name: '在网页上调整匹配' })).toBeVisible({ timeout: 45000 });
  const image = page.locator('.browser-screen img');
  await expect(image).toBeVisible();
  const box = (await image.boundingBox())!;
  const scale = box.width / 1280;
  // Aim at the link's centre using the element map the server returned.
  const linkNode = Number(Object.entries(frame.map!.links).find(([, href]) => href.endsWith('/div-cards'))![0]);
  const [lx, ly, lw, lh] = frame.map!.boxes.slice(linkNode * 5, linkNode * 5 + 4);
  const linkPoint = { x: (lx + lw / 2) * scale, y: (ly + lh / 2) * scale };
  // Hold the key like a user would. `hover({ modifiers })` releases it right
  // after moving, and link mode correctly ends on key release, so on a slow
  // runner the outline could disappear before the assertion.
  await page.keyboard.down('ControlOrMeta');
  await image.hover({ position: linkPoint });
  await expect(page.locator('.hover-rect.link')).toBeVisible();
  await expect(page.locator('.hover-label')).toContainText('点击打开此链接');
  await image.click({ position: linkPoint });
  await page.keyboard.up('ControlOrMeta');
  await expect(page.getByText('画面已跳转到')).toBeVisible({ timeout: 45000 });
  await expect(page.getByRole('button', { name: '保存订阅', exact: true })).toBeDisabled();
  // A plain click on a page that is not the source never picks.
  await image.click({ position: { x: 300 * scale, y: 300 * scale } });
  await expect(page.getByText('当前画面不是源网址')).toBeVisible();

  await page.getByRole('button', { name: '以此页为源网址', exact: true }).click();
  await expect(urlInput).toHaveValue(FIXTURE_URLS.divCards);
  await expect(page.getByText('画面已跳转到')).toHaveCount(0);
  await expect(page.locator('.preview-item').first()).toBeVisible({ timeout: 45000 });
});

test('超过 8000 像素的长网页按需加载下面的画面，列表在下面也能点选', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginInPage(page);
  await page.getByRole('button', { name: '新建订阅', exact: true }).click();
  await (await locatorForUrl(page)).fill(FIXTURE_URLS.veryLong);
  await page.getByRole('button', { name: '打开并自动识别', exact: true }).click();
  await expect(page.locator('.preview-item')).toHaveCount(3, { timeout: 45000 });
  await page.getByRole('button', { name: '调整匹配', exact: true }).click();

  // The recognized list sits below the first segment: the editor loads the
  // next segment by itself and scrolls the highlight into view.
  await expect(page.locator('.browser-screen img')).toHaveCount(2, { timeout: 30000 });
  const rect = page.locator('.selection-rect').first();
  await expect(rect).toBeInViewport();
  await expect(page.locator('.segment-status')).toHaveCount(0);

  const box = (await rect.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
  await expect(page.getByText(/条目容器匹配\s*3\s*项/)).toBeVisible();
  await expect(page.locator('.preview-item')).toHaveCount(3);
});
