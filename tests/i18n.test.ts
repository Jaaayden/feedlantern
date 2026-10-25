import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { backupTables } from '../src/server/backups.js';
import { alertTitle, deliveryError } from '../src/server/notify.js';
import { renderRssPreview } from '../src/server/rss-preview.js';
import { withLocale } from '../src/server/i18n.js';
import { NcbiError, NotAFeedError, nonFeedReason, sourceMessages } from '../src/server/fetch-errors.js';
import { catalogs } from '../src/shared/locales/index.js';
import { formatList, formatRelative, locales, negotiateLocale, translate, type Locale, type MessageValue } from '../src/shared/i18n.js';
import type { Feed } from '../src/shared/types.js';

// The rest of the suite pins DEFAULT_LOCALE=zh-CN (see package.json); this file checks the real default.
delete process.env.DEFAULT_LOCALE;

const placeholders = (value: MessageValue) => (typeof value === 'string' ? [value] : Object.values(value))
  .flatMap(text => [...text!.matchAll(/\{(\w+)\}/g)].map(match => match[1]));
const nameSet = (value: MessageValue) => [...new Set(placeholders(value))].sort();

test('every catalog has exactly the reference keys, with the same placeholders and valid plural forms', () => {
  const reference = catalogs.en.messages as Record<string, MessageValue>;
  for (const locale of locales) {
    const messages = catalogs[locale].messages as Record<string, MessageValue>;
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(reference).sort(), `${locale}: keys differ from en`);
    for (const [key, value] of Object.entries(messages)) {
      assert.deepEqual(nameSet(value), nameSet(reference[key]), `${locale} ${key}: placeholders differ`);
      if (typeof value === 'string') { assert.ok(value.length > 0 || key === 'error.raw' || key === 'app.tagline', `${locale} ${key} is empty`); continue; }
      assert.ok(typeof value.other === 'string' && value.other, `${locale} ${key}: plural needs "other"`);
      const categories = new Intl.PluralRules(catalogs[locale].code).resolvedOptions().pluralCategories;
      for (const form of Object.keys(value)) assert.ok(form === 'zero' || categories.includes(form as Intl.LDMLPluralRule), `${locale} ${key}: unknown plural form ${form}`);
    }
  }
});

test('interpolation, plurals, nested messages and Intl formatting', () => {
  assert.equal(translate('en', 'users.feedCount', { count: 1 }), '1 feed');
  assert.equal(translate('en', 'users.feedCount', { count: 3 }), '3 feeds');
  assert.equal(translate('zh-CN', 'users.feedCount', { count: 3 }), '3 个订阅');
  assert.equal(translate('en', 'tokens.days', { count: 12345 }), '12,345 days', 'large numbers are grouped');
  assert.equal(translate('en', 'error.fieldRequired', { label: { key: 'label.tokenName' }, max: 100 }), 'Token name is required and must be at most 100 characters.');
  assert.equal(translate('zh-CN', 'error.fieldRequired', { label: { key: 'label.tokenName' }, max: 100 }), '令牌名称不能为空且长度不能超过 100');
  assert.equal(translate('en', 'no.such.key'), 'no.such.key', 'unknown keys come back unchanged');
  assert.equal(formatList('en', ['a', 'b', 'c']), 'a, b, and c');
  assert.equal(formatList('zh-CN', ['a', 'b'], 'unit'), 'a、b');
  const now = Date.parse('2026-05-01T12:00:00Z');
  assert.equal(formatRelative('en', now - 10_000, now), 'just now');
  assert.equal(formatRelative('en', now - 3 * 60_000, now), '3 minutes ago');
  assert.equal(formatRelative('zh-CN', now - 3 * 60_000, now), '3分钟前');
  assert.equal(formatRelative('en', now + 2 * 3600_000, now), 'in 2 hours');
});

test('language negotiation: quality order, regional and script variants, English fallback', () => {
  assert.equal(negotiateLocale(undefined), 'en');
  assert.equal(negotiateLocale('fr-FR,de;q=0.8'), 'en');
  assert.equal(negotiateLocale('zh-CN,zh;q=0.9,en;q=0.8'), 'zh-CN');
  assert.equal(negotiateLocale('en-GB,zh-CN;q=0.5'), 'en');
  assert.equal(negotiateLocale('en;q=0.4,zh-TW;q=0.9'), 'zh-CN', 'every Chinese variant uses simplified Chinese');
  assert.equal(negotiateLocale(['zh-Hans-CN', 'en']), 'zh-CN');
  assert.equal(negotiateLocale('fr', 'zh-CN'), 'zh-CN', 'the fallback is configurable (DEFAULT_LOCALE)');
});

const fakeBrowser: BrowserServiceLike = {
  async open(options) { return { sessionId: 'b', image: '', width: 1, height: 1, viewportHeight: 1, documentHeight: 1, url: options.url, title: 't' }; },
  async snapshot() { return this.open({ url: 'https://example.test', waitMs: 0 }); },
  async scroll() { return this.snapshot('b'); }, async click() { return this.snapshot('b'); },
  async pick() { return { selector: '.item', rects: [], count: 0, sampleText: '' }; },
  async extract() { return []; }, async detect() { return { candidates: [], recommendedId: null, warnings: [] }; },
  async scrape() { return [{ title: 'one', link: 'https://example.test/one' }]; },
  async close() {}, async dispose() {},
};

test('API errors carry a stable code and follow the account language, then Accept-Language, then English', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-i18n-'));
  const app = await createApp({ dataDir, publicOrigin: 'http://127.0.0.1:4321', browserService: fakeBrowser, startScheduler: false });
  const host = '127.0.0.1:4321';
  try {
    const wrongHost = (headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: 'evil.example', ...headers } });
    assert.deepEqual((await wrongHost()).json(), { code: 'forbidden', message: 'Request host not allowed.', error: 'Request host not allowed.', messageKey: 'error.hostForbidden' });
    assert.equal((await wrongHost({ 'accept-language': 'zh-CN,zh;q=0.9' })).json().message, '请求主机不被允许');
    assert.equal((await wrongHost({ 'accept-language': 'fr' })).json().message, 'Request host not allowed.');

    // Validation errors keep their params, so a client can render the message itself.
    const status = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { host } });
    assert.equal(status.json().defaultLocale, 'en');
    const setupToken = readFileSync(join(dataDir, 'setup-token'), 'utf8').trim();
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1', 'accept-language': 'en-US' }, payload: { setupToken, username: 'admin', password: 'password123' } });
    const cookie = `${setup.cookies[0].name}=${setup.cookies[0].value}`, csrf = setup.json().csrfToken as string;
    assert.equal(setup.json().locale, null, 'a new account follows its browser');
    const write = { host, cookie, 'x-feedlantern': '1', 'x-csrf-token': csrf };
    const bad = await app.inject({ method: 'POST', url: '/api/tokens', headers: { ...write, 'accept-language': 'zh-CN' }, payload: { name: '', scope: 'read' } });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(bad.json(), { code: 'validation', message: '令牌名称不能为空且长度不能超过 100', error: '令牌名称不能为空且长度不能超过 100', messageKey: 'error.fieldRequired', params: { label: { key: 'label.tokenName' }, max: 100 } });

    // A chosen language beats Accept-Language and is shared by every device.
    const saved = await app.inject({ method: 'PUT', url: '/api/auth/locale', headers: write, payload: { locale: 'zh-CN' } });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().locale, 'zh-CN');
    const missing = await app.inject({ method: 'GET', url: '/api/feeds/nope', headers: { host, cookie, 'accept-language': 'en' } });
    assert.deepEqual([missing.statusCode, missing.json().code, missing.json().messageKey, missing.json().message], [404, 'not_found', 'error.feedNotFound', '订阅不存在']);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/auth/locale', headers: write, payload: { locale: 'xx' } })).json().messageKey, 'error.localeInvalid');
    await app.inject({ method: 'PUT', url: '/api/auth/locale', headers: { ...write, 'accept-language': 'en' }, payload: { locale: null } });
    const followed = await app.inject({ method: 'GET', url: '/api/feeds/nope', headers: { host, cookie, 'accept-language': 'en' } });
    assert.equal(followed.json().message, 'Feed not found.');

    // The browser page of a feed address speaks the visitor's language; the feed itself the owner's.
    const created = await app.inject({ method: 'POST', url: '/api/feeds', headers: write, payload: { name: 'News', url: 'https://example.test/news', rules: { item: 'x', title: 'x', link: 'a' } } });
    const path = new URL(created.json().feedUrl).pathname;
    const page = (language: string) => app.inject({ method: 'GET', url: path, headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: 'text/html', 'accept-language': language } });
    const [zhPage, enPage] = [await page('zh-CN,zh;q=0.9'), await page('en-US')];
    assert.match(zhPage.body, /<html lang="zh-CN">[\s\S]*复制地址/);
    assert.match(enPage.body, /<html lang="en">[\s\S]*Copy address/);
    assert.notEqual(zhPage.headers.etag, enPage.headers.etag);
    assert.match(String(enPage.headers.vary), /Accept-Language/);
    const xml = await app.inject({ method: 'GET', url: path, headers: { 'accept-language': 'zh-CN' } });
    assert.match(xml.body, /Feed generated by FeedLantern from web pages on example\.test/, 'the owner (an English browser) reads the feed text in English');
    assert.doesNotMatch(xml.body, /<language>/, 'untranslated feeds still declare no language')
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('non-feed and NCBI errors are translatable and keep English logs', () => {
  const page = '<!DOCTYPE html><html><body><div class="g-recaptcha"></div></body></html>';
  const reason = nonFeedReason(page, 403, 'text/html');
  assert.deepEqual(reason, { key: 'source.challengeStatus', params: { status: '403', marker: 'reCAPTCHA' } });
  const english = withLocale('en', () => new NotAFeedError(reason!));
  assert.match(english.message, /^Couldn't fetch RSS \(HTTP 403\): the source returned a bot check/);
  const chinese = withLocale('zh-CN', () => new NcbiError(sourceMessages.pubmed.httpError(502), 502));
  assert.equal(chinese.message, 'NCBI E-utilities 请求失败（HTTP 502），请稍后重试。');
  assert.equal(chinese.englishMessage, 'The NCBI E-utilities request failed (HTTP 502). Try again later.');
});

test('migration 21 keeps existing accounts in Chinese; new accounts and old backups are handled explicitly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedlantern-i18n-migrate-'));
  try {
    let store = new Store(dir);
    store.createAdmin('admin', 'password123');
    store.close();
    // Roll the database back to the layout before migration 21.
    const db = new DatabaseSync(join(dir, 'app.db'));
    db.exec('ALTER TABLE users DROP COLUMN locale; ALTER TABLE users DROP COLUMN detected_locale; PRAGMA user_version=19;');
    db.close();
    store = new Store(dir);
    assert.equal(store.userLocale('admin'), 'zh-CN', 'an upgraded account keeps the Chinese interface it had');
    assert.equal(store.ownerLocale('admin'), 'zh-CN');
    const user = store.createUser('alice', 'password123');
    assert.equal(store.userLocale(user.id), null, 'a new account follows its browser');
    assert.equal(store.ownerLocale(user.id), 'en');
    store.noteDetectedLocale(user.id, 'zh-CN');
    assert.equal(store.ownerLocale(user.id), 'zh-CN', 'alerts follow the language the browser last asked for');
    assert.ok(!('detected_locale' in store.exportTables().users[0]), 'the browser hint is not part of a backup');
    store.close();
    const legacy = backupTables.users.parse([{ id: 'admin', role: 'admin', enabled: 1, generation: 0, username: 'admin', password_hash: `scrypt$16384$8$1$${'a'.repeat(22)}$${'b'.repeat(86)}`, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }]);
    assert.equal(legacy[0].locale, 'zh-CN', 'backups from the Chinese-only versions restore in Chinese');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('notifications and the browser preview page are written in the reader’s language; feed output keeps its own', () => {
  const titles = (locale: Locale) => withLocale(locale, () => [alertTitle('fetch.failed'), deliveryError('webhook', new Error('x'))]);
  assert.deepEqual(titles('en'), ['FeedLantern: feed fetch failed', "Couldn't send through Webhook. Check the network and your channel settings."]);
  assert.deepEqual(titles('zh-CN'), ['订阅灯：订阅抓取失败', 'Webhook 推送失败，请检查网络及私有配置']);
  const feed = { id: 'f', name: 'Feed', url: 'https://example.test/', sourceType: 'website', enabled: true, intervalMinutes: 30, lastSuccessAt: null, rules: { item: 'a', title: 'a', link: 'a' } } as unknown as Feed;
  const english = withLocale('en', () => renderRssPreview(feed, [], 'https://h.test/feeds/f/t.xml').html);
  assert.match(english, /<html lang="en">/);
  assert.match(english, /Copy address/);
  assert.match(english, /checked every 30 minutes/);
  const chinese = withLocale('zh-CN', () => renderRssPreview(feed, [], 'https://h.test/feeds/f/t.xml').html);
  assert.match(chinese, /<html lang="zh-CN">/);
  assert.match(chinese, /复制地址/);
  for (const locale of locales) assert.ok(translate(locale, 'preview.copy'));
});
