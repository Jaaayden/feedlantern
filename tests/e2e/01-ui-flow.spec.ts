import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Feed } from '../../src/shared/types';
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

  // The browser screenshot is rendered at a smaller CSS size than Chromium's
  // 1280x800 capture. Clicking through the rendered image verifies that the
  // UI converts CSS coordinates back to screenshot coordinates before calling
  // the visual picker.
  const browserImage = page.locator('.browser-screen img');
  await expect(browserImage).toBeVisible();
  const browserBox = await browserImage.boundingBox();
  expect(browserBox).not.toBeNull();
  if (browserBox) {
    await browserImage.click({ position: { x: browserBox.width * 0.6, y: browserBox.height * 0.3 } });
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
