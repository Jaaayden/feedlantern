import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { AuthState, CredentialSummary, Feed, FeedInput, FeedItem, SelectionRules } from '../../src/shared/types';
import { e2eBaseUrl, e2eDataDir, fixtureBaseUrl } from '../../playwright.config';

export { e2eBaseUrl };

export const TEST_ACCOUNT = {
  username: 'e2e-admin',
  password: 'e2e-password-123!',
};

export const FIXTURE_URLS = {
  static: `${fixtureBaseUrl}/static`,
  divCards: `${fixtureBaseUrl}/div-cards`,
  dynamic: `${fixtureBaseUrl}/dynamic`,
  cookieGated: `${fixtureBaseUrl}/cookie-gated`,
  ambiguous: `${fixtureBaseUrl}/ambiguous`,
  versioned: `${fixtureBaseUrl}/versioned`,
  redirect: `${fixtureBaseUrl}/redirect-malicious`,
};

export const STATIC_RULES: SelectionRules = {
  item: '.article-card',
  title: '.article-title',
  link: 'a.article-link',
  description: '.article-summary',
  image: 'img.article-image',
  date: 'time.article-date',
};

export function protocolHeaders(csrfToken?: string): Record<string, string> {
  return {
    'X-FeedLantern': '1',
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
  };
}

async function readFirstExisting(paths: string[]): Promise<string> {
  for (const filePath of paths) {
    try {
      const text = (await readFile(filePath, 'utf8')).trim();
      if (text) return text;
    } catch {
      // Try the next supported setup-token filename.
    }
  }
  throw new Error(`No setup token found under ${e2eDataDir}`);
}

export async function readSetupToken(): Promise<string> {
  const raw = await readFirstExisting([
    path.join(e2eDataDir, 'setup-token'),
    path.join(e2eDataDir, 'setup-token.txt'),
    path.join(e2eDataDir, 'setup-token.json'),
  ]);
  try {
    const parsed = JSON.parse(raw) as { token?: unknown; setupToken?: unknown };
    if (typeof parsed.token === 'string') return parsed.token;
    if (typeof parsed.setupToken === 'string') return parsed.setupToken;
  } catch {
    // The normal format is a plain token file.
  }
  return raw;
}

export async function loginAsAdmin(api: APIRequestContext): Promise<AuthState> {
  const statusResponse = await api.get('/api/auth/status', { headers: protocolHeaders() });
  expect(statusResponse.ok()).toBeTruthy();
  const status = (await statusResponse.json()) as AuthState;

  if (status.setupRequired) {
    const setupResponse = await api.post('/api/auth/setup', {
      headers: protocolHeaders(),
      data: {
        setupToken: await readSetupToken(),
        username: TEST_ACCOUNT.username,
        password: TEST_ACCOUNT.password,
      },
    });
    expect(setupResponse.ok()).toBeTruthy();
  }

  const loginResponse = await api.post('/api/auth/login', {
    headers: protocolHeaders(),
    data: TEST_ACCOUNT,
  });
  expect(loginResponse.ok()).toBeTruthy();
  return (await loginResponse.json()) as AuthState;
}

export async function setFixtureState(patch: { failure?: boolean; version?: number }): Promise<void> {
  const response = await fetch(`${fixtureBaseUrl}/__control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`Fixture control failed with ${response.status}`);
}

export async function createCredential(
  api: APIRequestContext,
  csrfToken: string,
  value: string,
  format: 'header' | 'json' = 'header',
  name = `Fixture credential ${format}`,
): Promise<CredentialSummary> {
  const response = await api.post('/api/credentials', {
    headers: protocolHeaders(csrfToken),
    data: { name, url: FIXTURE_URLS.cookieGated, format, value },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as CredentialSummary;
}

export async function openBrowser(
  api: APIRequestContext,
  csrfToken: string,
  url: string,
  credentialId: string | null = null,
  waitMs = 250,
): Promise<{ sessionId: string; image: string; width: number; height: number; url: string; title: string }> {
  const response = await api.post('/api/browser', {
    headers: protocolHeaders(csrfToken),
    data: { url, credentialId, waitMs },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { sessionId: string; image: string; width: number; height: number; url: string; title: string };
}

export async function detect(api: APIRequestContext, csrfToken: string, sessionId: string) {
  const response = await api.post(`/api/browser/${encodeURIComponent(sessionId)}/detect`, {
    headers: protocolHeaders(csrfToken),
    data: {},
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{
    candidates: Array<{
      id: string;
      label: string;
      rules: SelectionRules;
      confidence: 'high' | 'medium' | 'low';
      score: number;
      count: number;
      items: Array<{ title: string; link: string; description?: string; image?: string; publishedAt?: string }>;
      rects: Array<{ x: number; y: number; width: number; height: number }>;
      warnings: string[];
    }>;
    recommendedId: string | null;
    warnings: string[];
  }>;
}

export async function closeBrowser(api: APIRequestContext, csrfToken: string, sessionId: string): Promise<void> {
  const response = await api.delete(`/api/browser/${encodeURIComponent(sessionId)}`, { headers: protocolHeaders(csrfToken) });
  expect(response.ok()).toBeTruthy();
}

export async function createFeed(
  api: APIRequestContext,
  csrfToken: string,
  input: Partial<FeedInput> & Pick<FeedInput, 'name' | 'url' | 'rules'>,
): Promise<{ feed: Feed; feedUrl: string }> {
  const response = await api.post('/api/feeds', {
    headers: protocolHeaders(csrfToken),
    data: {
      credentialId: null,
      intervalMinutes: 60,
      waitMs: 250,
      ...input,
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { feed: Feed; feedUrl: string };
}

export async function getFeed(
  api: APIRequestContext,
  csrfToken: string,
  id: string,
): Promise<{ feed: Feed; items: FeedItem[]; feedUrl: string }> {
  const response = await api.get(`/api/feeds/${encodeURIComponent(id)}`, { headers: protocolHeaders(csrfToken) });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { feed: Feed; items: FeedItem[]; feedUrl: string };
}

export async function firstVisible(locators: Locator[]): Promise<Locator> {
  for (const locator of locators) {
    const candidate = locator.first();
    try {
      await candidate.waitFor({ state: 'visible', timeout: 2_000 });
      return candidate;
    } catch {
      // Try the next compatible locator. This also handles React bootstrapping
      // after a preceding API suite has kept the backend busy.
    }
  }
  throw new Error('No visible locator matched the expected UI control');
}

export async function loginInPage(page: Page): Promise<void> {
  await page.goto('/');
  // The app first renders a connection placeholder and only then mounts the
  // auth form after /api/auth/status returns. Wait for that transition instead
  // of inspecting the DOM during the placeholder frame.
  await page.locator('.auth-page input').first().waitFor({ state: 'visible', timeout: 15_000 });
  const setupInput = page.getByLabel('一次性设置码').first();
  if (await setupInput.count() && await setupInput.isVisible().catch(() => false)) {
    await setupInput.fill(await readSetupToken());
    const username = await firstVisible([
      page.getByLabel('用户名'),
      page.locator('input[autocomplete="username"]'),
    ]);
    const password = await firstVisible([
      page.getByLabel('密码'),
      page.locator('input[type="password"]'),
    ]);
    await username.fill(TEST_ACCOUNT.username);
    await password.fill(TEST_ACCOUNT.password);
    await firstVisible([
      page.getByRole('button', { name: '创建管理员' }),
      page.locator('button[type="submit"]'),
    ]).then((submit) => submit.click());
    await expect(page.getByText(/订阅管理|新建订阅/).first()).toBeVisible();
    return;
  }
  const username = await firstVisible([
    page.getByLabel('用户名'),
    page.getByLabel(/用户名|username/i),
    page.locator('input[name="username"]'),
    page.locator('input[autocomplete="username"]'),
  ]);
  const password = await firstVisible([
    page.getByLabel('密码'),
    page.getByLabel(/密码|password/i),
    page.locator('input[name="password"]'),
    page.locator('input[type="password"]'),
  ]);
  await username.fill(TEST_ACCOUNT.username);
  await password.fill(TEST_ACCOUNT.password);
  const submit = await firstVisible([
    page.getByRole('button', { name: '登录' }),
    page.getByRole('button', { name: /登录|sign in|log in/i }),
    page.locator('button[type="submit"]'),
  ]);
  await submit.click();
  await expect(page.getByText(/订阅管理|新建订阅/).first()).toBeVisible();
}

export async function locatorForUrl(page: Page): Promise<Locator> {
  return firstVisible([
    page.getByLabel('源网址'),
    page.getByLabel(/源网址|网址|URL|地址/i),
    page.locator('input[name="url"]'),
    page.locator('input[type="url"]'),
  ]);
}
