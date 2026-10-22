import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserService, launchFailureMessage } from '../src/server/browser.js';
import { frameError, friendlyError } from '../src/server/validation.js';

const playwrightBanner = `browserType.launch: Executable doesn't exist at /app/node_modules/.local-browsers/chrome-headless-shell
╔════════════════════════════════════════╗
║ Please run the following command to download new browsers: ║
║     npx playwright install                                 ║
╚════════════════════════════════════════╝`;

test('找不到 Chromium 时给出一行可操作的提示，并原样显示给用户', () => {
  const hint = launchFailureMessage(playwrightBanner);
  assert.match(hint!, /pnpm browser:install/);
  assert.match(hint!, /PLAYWRIGHT_BROWSERS_PATH/);
  assert.equal(friendlyError(new Error(hint!), '兜底'), hint, 'the API must not replace the hint with the generic fallback');
  assert.match(launchFailureMessage(playwrightBanner, '/opt/chromium')!, /BROWSER_EXECUTABLE_PATH/);
  assert.equal(launchFailureMessage('net::ERR_NAME_NOT_RESOLVED'), undefined);
});

test('自定义 Chromium 路径不存在：提示检查路径，原始错误只记一次日志', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const browser = new BrowserService({ executablePath: '/nonexistent/feedlantern-chromium', allowedHosts: ['127.0.0.1:9'] });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(browser.open({ url: 'http://127.0.0.1:9/', waitMs: 0 }), /BROWSER_EXECUTABLE_PATH/);
    }
  } finally {
    await browser.dispose();
  }
  const lines = logged.mock.calls.map(call => String(call.arguments[0]));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /^启动 Chromium 失败：.*feedlantern-chromium/s);
});

test('网页操作只显示兜底提示时，原始错误写入日志并隐藏查询参数和凭据', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const hidden = frameError(new Error('page.goto: net::ERR_TIMED_OUT at https://example.test/list?session=abc123\nCall log:\n  - Cookie: sid=secret'), '打开网页');
  assert.equal(hidden.message, '网页操作失败，请检查目标页面和等待条件');
  assert.equal(logged.mock.callCount(), 1);
  const line = String(logged.mock.calls[0].arguments[0]);
  assert.match(line, /^打开网页失败：Error: page\.goto: net::ERR_TIMED_OUT/);
  assert.match(line, /https:\/\/example\.test\/list\?\[已隐藏\]/);
  assert.doesNotMatch(line, /abc123|sid=secret/);

  const shown = frameError(new Error('坐标处没有可选的 DOM 元素'), '点选元素');
  assert.equal(shown.message, '坐标处没有可选的 DOM 元素');
  assert.equal(logged.mock.callCount(), 1, 'messages the user already sees in full are not logged');
});
