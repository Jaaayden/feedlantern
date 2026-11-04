import { test, expect } from './fixtures';
import { FIXTURE_URLS, STATIC_RULES, loginAsAdmin, protocolHeaders } from './support';

// The rest of the bundle specs run in Chinese; this one drives the English interface.
test.use({ locale: 'en-US' });

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

test('Bundle duplicates and filter in English: live numbers, merge details and no sideways scrolling on a phone', async ({ page }) => {
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  await page.setViewportSize({ width: 1280, height: process.env.BUNDLE_SHOTS ? 1500 : 900 });
  const ids: string[] = [];
  try {
    for (const [name, url, rules] of [
      ['Dedupe English Site', FIXTURE_URLS.static, STATIC_RULES],
      ['Dedupe English Newsletter', FIXTURE_URLS.staticTracked, STATIC_RULES],
      ['Dedupe English Cards', FIXTURE_URLS.divCards, { item: '.card', title: '.card-heading', link: 'a.card-link' }],
    ] as const) {
      const response = await page.request.post('/api/feeds', { headers, data: { name, url, rules } });
      expect(response.ok()).toBeTruthy(); ids.push((await response.json()).feed.id);
    }
    await page.goto('/#/bundles');
    await page.getByRole('button', { name: 'New bundle', exact: true }).first().click();
    const editor = page.getByRole('dialog', { name: 'New bundle' });
    await editor.getByLabel('Bundle name').fill('Dedupe English');
    await editor.getByLabel('Search member feeds').fill('Dedupe English');
    for (const name of ['Site', 'Newsletter', 'Cards']) await editor.getByLabel(`Add member Dedupe English ${name}`).check();
    const summary = editor.getByTestId('bundle-preview-summary');
    await expect(summary).toHaveText('Output 9 of 9 · 0 filtered · 0 duplicates merged');
    await editor.getByRole('radio', { name: /Same link, ignoring tracking/ }).check();
    await expect(summary).toHaveText('Output 6 of 9 · 0 filtered · 3 duplicates merged');
    await editor.getByRole('radio', { name: /Same link or same title/ }).check();
    await expect(summary).toHaveText('Output 3 of 9 · 0 filtered · 6 duplicates merged');
    await editor.getByLabel('Which copy to keep').selectOption('order');
    await editor.getByRole('list', { name: 'Priority' }).evaluate(element => element.scrollIntoView({ block: 'start' }));
    await shot(page, 'editor-order-en');
    await editor.getByRole('textbox', { name: /^Exclude keywords/ }).fill('article two');
    await expect(summary).toHaveText('Output 2 of 9 · 3 filtered · 4 duplicates merged');
    await editor.getByText('Duplicates merged (4)').click();
    await expect(editor.locator('.bundle-group').first()).toContainText('same title');
    await editor.getByText('Filtered out (3)').click();
    await expect(editor.locator('.bundle-detail').first()).toContainText('Excluded by “article two”');
    await editor.getByText('Filtered out (3)').scrollIntoViewIfNeeded();
    await shot(page, 'editor-en');
    await editor.getByRole('button', { name: 'Create bundle' }).click();
    await expect(page.getByRole('status')).toContainText('Bundle created');

    const card = page.getByRole('article', { name: 'Bundle Dedupe English' });
    await expect(card).toContainText('Dedup: link or title');
    await card.getByRole('button', { name: 'Merge details of bundle Dedupe English' }).click();
    const details = page.getByRole('dialog', { name: 'Merge details' });
    await expect(details.getByTestId('bundle-preview-summary')).toHaveText('Output 2 of 9 · 3 filtered · 4 duplicates merged');
    await details.getByText('Duplicates merged (4)').click();
    await shot(page, 'details-en');
    await details.getByRole('button', { name: 'Close' }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Edit bundle Dedupe English' }).click();
    const phone = page.getByRole('dialog', { name: 'Edit bundle' });
    await expect(phone.getByTestId('bundle-preview-summary')).toBeVisible();
    await phone.getByRole('textbox', { name: /^Include keywords/ }).scrollIntoViewIfNeeded();
    await shot(page, 'editor-phone-en');
    const overflow = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll<HTMLElement>('.modal *')].filter(element => element.offsetParent !== null && element.getBoundingClientRect().right > width + 1)
        .filter(element => !element.closest('.bundle-options, .bundle-order, .bundle-detail ul')).slice(0, 5).map(element => `${element.tagName.toLowerCase()}.${element.className}`);
      return { scroll: document.documentElement.scrollWidth - width, wide };
    });
    expect(overflow).toEqual({ scroll: 0, wide: [] });
  } finally {
    for (const { bundle } of await (await page.request.get('/api/bundles')).json()) await page.request.delete(`/api/bundles/${bundle.id}`, { headers });
    for (const id of ids) await page.request.delete(`/api/feeds/${id}`, { headers });
  }
});
