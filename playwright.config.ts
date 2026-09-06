import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
// Keep the backend's private test data outside Playwright's outputDir. Playwright
// may clear `test-results` before starting web servers, which would remove the
// one-time setup token before the browser/API fixtures can consume it.
const dataDir = path.join(projectRoot, 'data', 'e2e-test');
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

export const e2eDataDir = dataDir;
export const e2eBaseUrl = 'http://127.0.0.1:4322';
export const fixtureBaseUrl = 'http://127.0.0.1:8766';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.(spec|test)\.ts/,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: e2eBaseUrl,
    browserName: 'chromium',
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    permissions: ['clipboard-read', 'clipboard-write'],
    testIdAttribute: 'data-testid',
  },
  webServer: [
    {
      name: 'FeedLantern backend',
      command: 'pnpm build && pnpm exec tsx tests/fixtures/start-backend.ts',
      cwd: projectRoot,
      url: `${e2eBaseUrl}/api/auth/status`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...inheritedEnv,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: '4322',
        PUBLIC_ORIGIN: e2eBaseUrl,
        DATA_DIR: dataDir,
        ALLOWED_TARGET_HOSTS: '127.0.0.1:8766',
      },
    },
    {
      name: 'FeedLantern fixtures',
      command: 'pnpm exec tsx tests/fixtures/server.ts',
      cwd: projectRoot,
      url: `${fixtureBaseUrl}/health`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: { ...inheritedEnv, FIXTURE_HOST: '127.0.0.1', FIXTURE_PORT: '8766' },
    },
  ],
});
