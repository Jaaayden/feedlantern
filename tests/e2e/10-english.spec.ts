import { mkdir } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { FIXTURE_URLS, loginAsAdmin, protocolHeaders } from './support';

// The rest of the suite runs in Chinese; this file signs in from an English browser.
test.use({ locale: 'en-US' });

const ACCOUNT = { username: 'english-reader', password: 'english-password-123' };
const shots = 'test-results/i18n';

/** Switch the color scheme and let the form controls finish their color transition. */
async function scheme(page: Page, colorScheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme });
  await page.waitForTimeout(400);
}

/** Nothing on the page may be wider than the viewport (longer English text must wrap, not overflow). */
async function expectNoOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter(element => element.offsetParent !== null && element.getBoundingClientRect().right > width + 1)
      .filter(element => !element.closest('.settings-nav, .format-switch, .collection-filters, pre, code, .feed-host, .copy-row input'))
      .slice(0, 5).map(element => `${element.tagName.toLowerCase()}.${element.className}`);
    return { scroll: document.documentElement.scrollWidth - width, wide };
  });
  expect(overflow.scroll, `${where}: page scrolls sideways`).toBeLessThanOrEqual(1);
  expect(overflow.wide, `${where}: elements wider than the viewport`).toEqual([]);
}

test.beforeAll(async ({ request }) => {
  const admin = await loginAsAdmin(request);
  const response = await request.post('/api/users', { headers: protocolHeaders(admin.csrfToken), data: ACCOUNT });
  expect(response.ok() || response.status() === 409).toBeTruthy();
});

test('English interface: sign in, create a feed, settings and language preference', async ({ page }) => {
  await mkdir(shots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The sign-in page follows the browser language and offers a switch.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByLabel('Language').selectOption('zh-CN');
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.getByLabel('界面语言').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.screenshot({ path: `${shots}/sign-in-light.png` });

  // Server errors arrive in the same language.
  await page.getByLabel('Username').fill(ACCOUNT.username);
  await page.getByLabel('Password').fill('wrong-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Incorrect username or password.');
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your feeds, kept lit.' })).toBeVisible();

  // Create a web page feed.
  await page.getByRole('button', { name: 'New feed', exact: true }).click();
  await page.getByRole('textbox', { name: 'Source URL' }).fill(FIXTURE_URLS.static);
  await page.getByRole('button', { name: 'Open and detect' }).click();
  await expect(page.getByText('Fixture article one').first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/Matched automatically|Match result/)).toBeVisible();
  await page.locator('.save-panel .field input').first().fill('English fixture feed');
  await page.screenshot({ path: `${shots}/editor-light.png`, fullPage: true });
  await page.getByRole('button', { name: 'Save feed' }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByText('Feed address')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Copy RSS address' })).toBeVisible();
  await panel.getByRole('button', { name: 'Feed settings', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save settings' })).toBeVisible();
  await page.screenshot({ path: `${shots}/feed-settings-light.png` });
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'View feed English fixture feed' })).toBeVisible();
  await expectNoOverflow(page, 'feed list');
  await page.screenshot({ path: `${shots}/feeds-light.png`, fullPage: true });

  await scheme(page, 'dark');
  await page.screenshot({ path: `${shots}/feeds-dark.png`, fullPage: true });
  await scheme(page, 'light');

  // Settings: the language is saved to the account, so it survives a reload.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('navigation', { name: 'Settings groups' }).getByRole('button', { name: 'Account & password' }).click();
  const account = page.getByRole('form', { name: 'Account & password' });
  await expect(account.getByLabel('Language')).toHaveValue('');
  await expect(account.getByRole('option', { name: 'Browser language (English)' })).toBeAttached();
  await expectNoOverflow(page, 'settings');
  await page.screenshot({ path: `${shots}/settings-light.png`, fullPage: true });
  await scheme(page, 'dark');
  await page.screenshot({ path: `${shots}/settings-dark.png`, fullPage: true });
  await scheme(page, 'light');

  await account.getByLabel('Language').selectOption('zh-CN');
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.reload();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  const status = await page.request.get('/api/auth/status');
  expect((await status.json()).locale).toBe('zh-CN');

  // The top bar switches back.
  await page.locator('.topbar').getByLabel('界面语言').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/auth/status')).json()).locale).toBe('en');

  // Phone width: no sideways scrolling with the longer English text.
  for (const [route, name] of [['/#/', 'feeds'], ['/#/settings/notifications', 'notifications'], ['/#/settings/tokens', 'tokens']] as const) {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    await expectNoOverflow(page, `mobile ${name}`);
    await page.screenshot({ path: `${shots}/mobile-${name}.png`, fullPage: true });
  }
  await scheme(page, 'dark');
  await page.screenshot({ path: `${shots}/mobile-tokens-dark.png`, fullPage: true });

  // Leave the account following the browser again for later runs.
  await page.request.put('/api/auth/locale', { headers: { ...protocolHeaders((await (await page.request.get('/api/auth/status')).json()).csrfToken) }, data: { locale: null } });
});
