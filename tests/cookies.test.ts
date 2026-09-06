import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Cookie } from 'playwright';

import {
  CookieParseError,
  cookiesForUrl,
  parseCookies,
  toPlaywrightCookies,
} from '../src/server/cookies';

type TestCookie = Cookie & { hostOnly?: boolean; expirationDate?: number; session?: boolean };

test('Cookie header 只绑定到输入域名，并保留 HTTPS Secure 属性', () => {
  const cookies = parseCookies(
    'Cookie: session=secret; theme=dark;',
    'header',
    'https://private.example.test/account',
  ) as TestCookie[];
  assert.equal(cookies.length, 2);
  assert.deepEqual(cookies.map(cookie => [cookie.name, cookie.value, cookie.domain, cookie.secure, cookie.hostOnly]), [
    ['session', 'secret', 'private.example.test', true, true],
    ['theme', 'dark', 'private.example.test', true, true],
  ]);
  assert.equal(cookiesForUrl(cookies, 'https://other.example.test/').length, 0);
});

test('OpenCookie JSON 支持域 Cookie、毫秒过期时间和路径过滤', () => {
  const cookies = parseCookies(JSON.stringify([
    { name: 'wide', value: '1', domain: '.example.test', hostOnly: false, path: '/app', expirationDate: 1_800_000_000_000, sameSite: 'no_restriction' },
    { name: 'host', value: '2', domain: 'news.example.test', path: '/' },
    { name: 'other', value: '3', domain: 'other.example.test', path: '/' },
  ]), 'json', 'https://news.example.test/app/list') as TestCookie[];
  assert.deepEqual(cookies.map(cookie => cookie.name), ['wide', 'host']);
  assert.equal(cookies[0]?.domain, '.example.test');
  assert.equal(cookies[0]?.expires, 1_800_000_000);
  assert.equal(cookies[0]?.sameSite, 'None');
  assert.deepEqual(cookiesForUrl(cookies, 'https://news.example.test/api'), cookies);
  // Domain filtering intentionally keeps the /app cookie in the isolated
  // context; Chromium enforces its path when making the actual request.
  assert.equal(cookiesForUrl(cookies, 'https://news.example.test/other').length, 2);
  assert.equal(cookiesForUrl(cookies, 'https://other.example.test/app').length, 1);
});

test('Cookie JSON 拒绝 CHIPS、非法域名和无效过期值', () => {
  assert.throws(
    () => parseCookies(JSON.stringify([{ name: 'sid', value: 'x', domain: 'example.test', partitionKey: 'https://example.test' }]), 'json', 'https://example.test/'),
    CookieParseError,
  );
  assert.throws(
    () => parseCookies(JSON.stringify([{ name: 'sid', value: 'x', domain: 'example.test', partitioned: 'true' }]), 'json', 'https://example.test/'),
    CookieParseError,
  );
  assert.throws(
    () => parseCookies(JSON.stringify([{ name: 'sid', value: 'x', domain: 'example.test', expires: 'tomorrow' }]), 'json', 'https://example.test/'),
    CookieParseError,
  );
  assert.throws(
    () => parseCookies(JSON.stringify([{ name: 'sid', value: 'x', domain: 'example.test' }]), 'json', 'file:///tmp/page'),
    CookieParseError,
  );
});

test('交给 Playwright 前移除导出器扩展字段，避免 Cookie 凭据串到其他来源', () => {
  const cookies = parseCookies('[{"name":"sid","value":"x","domain":".example.test","hostOnly":false}]', 'json', 'https://news.example.test/') as TestCookie[];
  const output = toPlaywrightCookies(cookies as unknown as Cookie[]);
  assert.deepEqual(Object.keys(output[0] ?? {}).sort(), ['domain', 'expires', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'value']);
  assert.equal('hostOnly' in (output[0] ?? {}), false);
});
