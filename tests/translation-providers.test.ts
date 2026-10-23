import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from '../src/server/rss-source.js';
import { NetworkPolicy } from '../src/server/network.js';
import { TranslationWorker } from '../src/server/rss-translation.js';
import { TranslationError, deeplEngine, openaiEngine, parseSegments, openaiSystemPrompt } from '../src/server/translation-providers.js';
import { Store, createApp, type BrowserServiceLike } from '../src/server/app.js';
import { renderRss } from '../src/server/rss.js';
import { defaultApplicationSettings } from '../src/shared/types.js';

const input = { name: 'RSS', url: 'https://example.test/rss', sourceType: 'rss' as const, translationMode: 'bilingual' as const, rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 30, waitMs: 0 };
const sourceItem = { key: digest('one'), title: 'Hello', link: 'https://example.test/one', html: '<p>Hello <strong>world</strong>.</p><pre>const x = 1;</pre>', publishedAt: '2026-09-12T00:00:00.000Z' };
async function until(check: () => boolean, timeout = 4000) { const deadline = Date.now() + timeout; while (!check()) { if (Date.now() > deadline) throw Error('condition timed out'); await delay(10); } }

type Handler = (request: IncomingMessage & { json: any }, response: ServerResponse) => void;
/** A local stand-in for DeepL and OpenAI-compatible APIs; no real service is called. */
async function fakeServices(handler: Handler) {
  const requests: Array<{ url: string; headers: IncomingMessage['headers']; json: any }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      requests.push({ url: request.url ?? '', headers: request.headers, json });
      handler(Object.assign(request, { json }), response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    host, origin: `http://${host}`, requests,
    policy: () => new NetworkPolicy({ allowedHosts: [host], dnsOverHttps: false }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
const send = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(body)); };
const deeplReply: Handler = (request, response) => send(response, 200, { translations: request.json.text.map((text: string) => ({ detected_source_language: 'EN', text: `DL:${text.trim()}` })) });
/** Echoes each `<seg>` back with a prefix, the way a well-behaved model answers. */
function chatReply(transform = (text: string) => `译:${text}`): Handler {
  return (request, response) => {
    const user = request.json.messages.find((m: { role: string }) => m.role === 'user').content as string;
    const content = [...user.matchAll(/<seg id="(\d+)">([\s\S]*?)<\/seg>/g)].map(m => `<seg id="${m[1]}">${transform(m[2])}</seg>`).join('\n');
    send(response, 200, { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
  };
}
const deeplSettings = (apiKey: string, plan: 'auto' | 'free' | 'pro' = 'auto') => ({ ...defaultApplicationSettings.translation.deepl, apiKey, plan });
const openaiSettings = (baseUrl: string, extra: Partial<typeof defaultApplicationSettings.translation.openai> = {}) => ({ ...defaultApplicationSettings.translation.openai, baseUrl, model: 'test-model', apiKey: 'sk-test', ...extra });

test('DeepL engine picks free/pro endpoints, sends the key in a header and keeps whitespace', async () => {
  const fake = await fakeServices(deeplReply);
  const endpoints = { free: `${fake.origin}/free/v2/translate`, pro: `${fake.origin}/pro/v2/translate` };
  const signal = new AbortController().signal;
  try {
    assert.deepEqual(await deeplEngine('ja', deeplSettings('key:fx'), fake.policy, endpoints).translate([' Hello ', 'World'], signal), [' DL:Hello ', 'DL:World']);
    assert.equal(fake.requests[0].url, '/free/v2/translate');
    assert.equal(fake.requests[0].headers.authorization, 'DeepL-Auth-Key key:fx');
    assert.deepEqual(fake.requests[0].json, { text: [' Hello ', 'World'], target_lang: 'JA' });
    await deeplEngine('zh-TW', deeplSettings('paid-key'), fake.policy, endpoints).translate(['Hi'], signal);
    assert.equal(fake.requests[1].url, '/pro/v2/translate'); assert.equal(fake.requests[1].json.target_lang, 'ZH-HANT');
    await deeplEngine('en', deeplSettings('key:fx', 'pro'), fake.policy, endpoints).translate(['Hi'], signal);
    assert.equal(fake.requests[2].url, '/pro/v2/translate'); assert.equal(fake.requests[2].json.target_lang, 'EN-US');
    assert.equal(deeplEngine('zh-CN', deeplSettings('k'), fake.policy).namespace, 'deepl:v1:zh-CN');
  } finally { await fake.close(); }
});

test('DeepL errors: rate limit and quota cool down, auth and mismatched counts fail without results', async () => {
  let reply: Handler = deeplReply;
  const fake = await fakeServices((request, response) => reply(request, response));
  const endpoints = { free: `${fake.origin}/free`, pro: `${fake.origin}/pro` };
  const engine = deeplEngine('zh-CN', deeplSettings('k'), fake.policy, endpoints);
  const signal = new AbortController().signal;
  try {
    reply = (_request, response) => send(response, 429, {}, { 'retry-after': '90' });
    await assert.rejects(engine.translate(['a'], signal), (error: unknown) => error instanceof TranslationError && error.rateLimited && error.retryAfterMs === 90_000);
    reply = (_request, response) => send(response, 456, {});
    await assert.rejects(engine.translate(['a'], signal), (error: unknown) => error instanceof TranslationError && error.rateLimited && /额度/.test(error.message));
    reply = (_request, response) => send(response, 403, {});
    await assert.rejects(engine.translate(['a'], signal), (error: unknown) => error instanceof TranslationError && !error.rateLimited && /API Key/.test(error.message));
    reply = (_request, response) => send(response, 200, { translations: [{ text: 'only one' }] });
    await assert.rejects(engine.translate(['a', 'b'], signal), /数量或格式不匹配/);
    reply = (_request, response) => { response.writeHead(200); response.end('<html>not json</html>'); };
    await assert.rejects(engine.translate(['a'], signal), /无法识别/);
  } finally { await fake.close(); }
});

test('outbound services go through the network policy: private hosts need an explicit allow-list entry', async () => {
  const fake = await fakeServices(deeplReply);
  const signal = new AbortController().signal;
  try {
    const blocked = () => new NetworkPolicy({ dnsOverHttps: false });
    await assert.rejects(deeplEngine('zh-CN', deeplSettings('k'), blocked, { free: `${fake.origin}/x`, pro: `${fake.origin}/x` }).translate(['a'], signal), (error: unknown) => error instanceof TranslationError && /阻止/.test(error.message));
    await assert.rejects(openaiEngine('zh-CN', openaiSettings(`${fake.origin}/v1`), blocked).translate(['a'], signal), /阻止/);
    await assert.rejects(openaiEngine('zh-CN', openaiSettings('http://localhost:11434/v1'), blocked).translate(['a'], signal), /阻止/);
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

test('OpenAI-compatible engine sends numbered escaped segments with a fixed reply contract', async () => {
  const fake = await fakeServices(chatReply());
  const signal = new AbortController().signal;
  try {
    const engine = openaiEngine('ko', openaiSettings(`${fake.origin}/v1`, { systemPrompt: 'Use a casual tone.' }), fake.policy);
    assert.deepEqual(await engine.translate([' Use <tag> & more ', 'Second'], signal), [' 译: Use <tag> & more ', '译:Second']);
    const request = fake.requests[0];
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, 'Bearer sk-test');
    assert.equal(request.json.model, 'test-model');
    assert.match(request.json.messages[0].content, /^Use a casual tone\./); assert.match(request.json.messages[0].content, /into Korean/); assert.match(request.json.messages[0].content, /<seg id="N">/);
    assert.equal(request.json.messages[1].content, '<seg id="1"> Use &lt;tag&gt; &amp; more </seg>\n<seg id="2">Second</seg>');
    const local = openaiEngine('zh-CN', openaiSettings(`${fake.origin}/v1`, { apiKey: '' }), fake.policy);
    await local.translate(['x'], signal); assert.equal(fake.requests[1].headers.authorization, undefined);
    assert.notEqual(local.namespace, openaiEngine('zh-CN', openaiSettings(`${fake.origin}/v1`, { model: 'other' }), fake.policy).namespace, 'a different model never reuses cached text');
    assert.match(openaiSystemPrompt('zh-CN', ''), /professional translator/);
  } finally { await fake.close(); }
});

test('segment parser rejects count, order, tag and stray-text mismatches', () => {
  const texts = ['One', 'Two'];
  assert.deepEqual(parseSegments('<think>reasoning</think>\n```xml\n<seg id="1">一</seg>\n<seg id="2">二 &amp; 三</seg>\n```', texts), ['一', '二 & 三']);
  for (const reply of [
    '<seg id="1">一</seg>',
    '<seg id="1">一</seg><seg id="2">二</seg><seg id="3">三</seg>',
    '<seg id="2">二</seg><seg id="1">一</seg>',
    '<seg id="1">一 <b>粗</b></seg><seg id="2">二</seg>',
    'Sure! <seg id="1">一</seg><seg id="2">二</seg>',
    '<seg id="1">一</seg><seg id="2">二</seg> Hope this helps',
    '<seg id="1">一<seg id="2">二</seg>',
    '<seg id="1"></seg><seg id="2">二</seg>',
    '一\n二',
  ]) assert.throws(() => parseSegments(reply, texts), TranslationError, reply);
});

test('OpenAI-compatible errors: truncated output and HTTP failures are retried, never published', async () => {
  let reply: Handler = chatReply();
  const fake = await fakeServices((request, response) => reply(request, response));
  const engine = openaiEngine('zh-CN', openaiSettings(`${fake.origin}/v1`), fake.policy);
  const signal = new AbortController().signal;
  try {
    reply = (_request, response) => send(response, 200, { choices: [{ message: { content: '<seg id="1">截</seg>' }, finish_reason: 'length' }] });
    await assert.rejects(engine.translate(['a'], signal), /截断/);
    reply = (_request, response) => send(response, 401, { error: { message: 'bad key sk-secret' } });
    await assert.rejects(engine.translate(['a'], signal), (error: unknown) => error instanceof TranslationError && /401/.test(error.message) && !/sk-secret/.test(error.message));
    reply = (_request, response) => send(response, 404, {});
    await assert.rejects(engine.translate(['a'], signal), /模型/);
    reply = (_request, response) => send(response, 429, {}, { 'retry-after': '5' });
    await assert.rejects(engine.translate(['a'], signal), (error: unknown) => error instanceof TranslationError && error.rateLimited);
  } finally { await fake.close(); }
});

test('worker translates with the feed service and language; caches never cross services or languages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-providers-')); const store = new Store(dir);
  const fake = await fakeServices(chatReply());
  let googleCalls = 0;
  const settings = { ...defaultApplicationSettings.translation, requestIntervalMs: 0, openai: openaiSettings(`${fake.origin}/v1`) };
  const worker = new TranslationWorker(store.translations, async (text, _signal, target) => { googleCalls++; return `G-${target}:${text}`; }, () => settings, undefined, { policy: fake.policy });
  try {
    store.translations.cache('Hello', '旧缓存');
    const google = store.createFeed(input).feed;
    const openai = store.createFeed({ ...input, name: 'ja', translationMode: 'translated', targetLanguage: 'ja', translationProvider: 'openai' }).feed;
    store.translations.upsert(google, [sourceItem]); store.translations.upsert(openai, [sourceItem]);
    worker.start();
    await until(() => store.translations.stats(google.id).success === 1 && store.translations.stats(openai.id).success === 1);
    assert.match(store.getItems(google.id)[0].title, /^旧缓存 \/ Hello$/, 'existing Google + zh-CN cache entries keep working');
    const translated = store.getItems(openai.id)[0];
    assert.equal(translated.title, '译:Hello'); assert.match(translated.contentHtml!, /译:Hello/); assert.match(translated.contentHtml!, /const x = 1;/);
    assert.doesNotMatch(JSON.stringify(fake.requests.map(r => r.json.messages[1].content)), /const x/, 'code is never sent');
    assert.equal(store.translations.cached('Hello'), '旧缓存');
    assert.equal(store.translations.cached('Hello', 'google-browser:v2:ja'), undefined);
    const xml = renderRss(store.getFeed(openai.id)!, store.getItems(openai.id), 'https://e.test/x.xml');
    assert.match(xml, /<language>ja<\/language>/); assert.match(xml, /<title>译:Hello<\/title>/);
    assert.match(renderRss(store.getFeed(google.id)!, store.getItems(google.id), 'https://e.test/y.xml'), /<language>zh-cn<\/language>/);

    // Switching language re-translates through the same service, keeping item identity.
    const id = translated.id; const before = googleCalls;
    store.updateFeedSettings(openai.id, { targetLanguage: 'en', translationProvider: 'google' });
    assert.equal(store.getItems(openai.id)[0].translationStatus, 'pending'); worker.wake();
    await until(() => store.translations.stats(openai.id).success === 1);
    assert.equal(store.getItems(openai.id)[0].id, id); assert.equal(store.getItems(openai.id)[0].title, 'G-en:Hello'); assert.ok(googleCalls > before);
    // Output mode alone does not re-translate.
    store.updateFeedSettings(openai.id, { translationMode: 'bilingual' });
    assert.equal(store.getItems(openai.id)[0].translationStatus, 'success');
  } finally { await worker.stop(); await fake.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('malformed model output fails the article, is not cached or published, and a later retry succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-providers-bad-')); const store = new Store(dir);
  let broken = true;
  const fake = await fakeServices((request, response) => broken ? send(response, 200, { choices: [{ message: { content: '<seg id="1">只有一段</seg>' } }] }) : chatReply()(request, response));
  const settings = { ...defaultApplicationSettings.translation, defaultProvider: 'openai' as const, openai: openaiSettings(`${fake.origin}/v1`) };
  const worker = new TranslationWorker(store.translations, async () => { throw Error('Google must not be used'); }, () => settings, undefined, { policy: fake.policy });
  try {
    const { feed } = store.createFeed(input);
    store.translations.upsert(feed, [{ ...sourceItem, html: '<p>One</p><p>Two</p>' }]);
    worker.start(); await until(() => store.translations.progress(feed.id).tasks[0].attempts === 1);
    assert.match(String(store.translations.progress(feed.id).tasks[0].error), /分段数量不匹配/);
    assert.equal(store.translations.stats(feed.id).success, 0);
    assert.doesNotMatch(renderRss(store.getFeed(feed.id)!, store.getItems(feed.id), input.url), /<item>/);
    broken = false; store.translations.retry(feed.id); worker.retry();
    await until(() => store.translations.stats(feed.id).success === 1);
    assert.match(store.getItems(feed.id)[0].contentHtml!, /译:One/);
  } finally { await worker.stop(); await fake.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('rate limits cool down only the affected service; unconfigured services fail with a clear message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-providers-limit-')); const store = new Store(dir);
  const fake = await fakeServices((_request, response) => send(response, 429, {}, { 'retry-after': '120' }));
  const settings = { ...defaultApplicationSettings.translation, requestIntervalMs: 0, deepl: deeplSettings('k') };
  const worker = new TranslationWorker(store.translations, async text => `G:${text}`, () => settings, undefined, { policy: fake.policy, deeplEndpoints: { free: `${fake.origin}/d`, pro: `${fake.origin}/d` } });
  try {
    const deepl = store.createFeed({ ...input, translationProvider: 'deepl' }).feed;
    const openai = store.createFeed({ ...input, name: 'o', translationProvider: 'openai' }).feed;
    store.translations.upsert(deepl, [sourceItem]); store.translations.upsert(openai, [sourceItem]);
    worker.start();
    await until(() => store.translations.progress(deepl.id).tasks[0]?.attempts === 1 && store.translations.progress(openai.id).tasks[0]?.attempts === 1);
    assert.ok(worker.status('deepl').cooldownUntil); assert.equal(worker.status('google').cooldownUntil, null);
    assert.match(String(store.translations.progress(openai.id).tasks[0].error), /OpenAI 兼容接口尚未配置/);
    const google = store.createFeed({ ...input, name: 'g' }).feed;
    store.translations.upsert(google, [sourceItem]); worker.wake();
    await until(() => store.translations.stats(google.id).success === 1);
    const calls = fake.requests.length; store.translations.retry(deepl.id); worker.retry(); await delay(30);
    assert.equal(fake.requests.length, calls, 'a cooling service is not called again');
  } finally { await worker.stop(); await fake.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('migration 13 turns `chinese` into translated + zh-CN and keeps output and item IDs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-migrate-13-'));
  let store = new Store(dir);
  const { feed } = store.createFeed({ ...input, translationMode: 'translated' });
  store.translations.upsert(feed, [sourceItem]);
  const worker = new TranslationWorker(store.translations, async text => `中文${text}`, 0);
  worker.start(); await until(() => store.translations.stats(feed.id).success === 1); await worker.stop();
  const before = renderRss(store.getFeed(feed.id)!, store.getItems(feed.id), 'https://e.test/x.xml');
  store.close();
  // Rewind the schema to version 8 as an older release wrote it.
  const db = new DatabaseSync(join(dir, 'app.db'));
  db.exec("ALTER TABLE feeds DROP COLUMN target_language; ALTER TABLE feeds DROP COLUMN translation_provider; UPDATE feeds SET translation_mode='chinese'; PRAGMA user_version=8;");
  db.close();
  store = new Store(dir);
  try {
    const migrated = store.getFeed(feed.id)!;
    assert.equal(migrated.translationMode, 'translated'); assert.equal(migrated.targetLanguage, 'zh-CN'); assert.equal(migrated.translationProvider, null);
    assert.equal(renderRss(migrated, store.getItems(feed.id), 'https://e.test/x.xml'), before);
    assert.match(before, /<language>zh-cn<\/language>/);
    const check = new DatabaseSync(join(dir, 'app.db'));
    assert.equal(Number((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), 13);
    check.close();
    store.close(); store = new Store(dir); assert.equal(store.getFeed(feed.id)!.translationMode, 'translated', 'reopening is a no-op');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

const fakeBrowser = { dispose: async () => {}, scrape: async () => { throw Error('no browser'); } } as unknown as BrowserServiceLike;
test('settings API stores keys encrypted, never returns or exports them, and feeds choose service and language', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-providers-api-')); const store = new Store(dir);
  const fake = await fakeServices(deeplReply);
  const app = await createApp({ store, dataDir: dir, browserService: fakeBrowser, startScheduler: false, translator: async text => `中文${text}`, translationIntervalMs: 0, allowedHosts: [fake.host], deeplEndpoints: { free: `${fake.origin}/free`, pro: `${fake.origin}/pro` },
    rssFetcher: async () => ({ title: 'News', items: [sourceItem] }) });
  try {
    const host = '127.0.0.1:4321';
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: store.getSetupToken(), username: 'admin', password: 'password123' } });
    const headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken };
    const put = (translation: unknown) => app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { translation } });

    assert.equal((await put({ defaultProvider: 'deepl' })).statusCode, 400, 'an unconfigured default is rejected');
    assert.equal((await put({ openai: { baseUrl: 'ftp://x' } })).statusCode, 400);
    assert.equal((await put({ deepl: { apiKey: 'bad\r\nkey' } })).statusCode, 400);
    const saved = await put({ defaultProvider: 'deepl', deepl: { apiKey: 'secret-deepl-key:fx', concurrency: 3 } });
    assert.equal(saved.statusCode, 200); assert.equal(saved.json().translation.deepl.apiKey, ''); assert.equal(saved.json().translation.deepl.apiKeyConfigured, true);
    const read = (await app.inject({ url: '/api/settings', headers })).json();
    assert.equal(read.translation.deepl.apiKey, ''); assert.equal(read.translation.deepl.concurrency, 3); assert.equal(read.translation.defaultProvider, 'deepl');
    assert.doesNotMatch(readFileSync(join(dir, 'app.db')).toString('latin1'), /secret-deepl-key/, 'the key is encrypted at rest');
    assert.equal(store.getSettings().translation.deepl.apiKey, 'secret-deepl-key:fx');
    // Saving the masked form back keeps the key.
    assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: read })).statusCode, 200);
    assert.equal(store.getSettings().translation.deepl.apiKey, 'secret-deepl-key:fx');

    const test = await app.inject({ method: 'POST', url: '/api/settings/translation/test', headers, payload: { provider: 'deepl', targetLanguage: 'ja' } });
    assert.equal(test.statusCode, 200); assert.match(test.json().text, /^DL:/); assert.equal(fake.requests.at(-1)!.url, '/free');

    const exported = (await app.inject({ url: '/api/backups/config', headers })).json();
    assert.equal(exported.settings.translation.deepl.apiKey, ''); assert.doesNotMatch(JSON.stringify(exported), /secret-deepl-key/);
    const imported = await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: exported, confirm: true } });
    assert.equal(imported.statusCode, 200); assert.equal(store.getSettings().translation.deepl.apiKey, 'secret-deepl-key:fx', 'importing a key-less file keeps the saved key');
    assert.match(JSON.stringify(store.exportTables().settings), /secret-deepl-key/, 'the encrypted full backup keeps it');

    const providers = (await app.inject({ url: '/api/translation/providers', headers })).json();
    assert.equal(providers.defaultProvider, 'deepl'); assert.deepEqual(providers.providers.map((p: { configured: boolean }) => p.configured), [true, true, false]);

    const created = await app.inject({ method: 'POST', url: '/api/feeds', headers, payload: { ...input, translationMode: 'chinese', targetLanguage: 'ko', translationProvider: 'google' } });
    assert.equal(created.statusCode, 200);
    const feed = created.json().feed;
    assert.equal(feed.translationMode, 'translated'); assert.equal(feed.targetLanguage, 'ko'); assert.equal(feed.translationProvider, 'google');
    await until(() => store.translations.stats(feed.id).success === 1);
    const rss = await app.inject({ url: new URL(created.json().feedUrl).pathname });
    assert.match(rss.body, /<language>ko<\/language>/); assert.match(rss.body, /<title>中文Hello<\/title>/);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/feeds/${feed.id}`, headers, payload: { targetLanguage: 'fr' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/feeds/${feed.id}`, headers, payload: { translationProvider: 'bing' } })).statusCode, 400);
    const followed = await app.inject({ method: 'PATCH', url: `/api/feeds/${feed.id}`, headers, payload: { translationProvider: null } });
    assert.equal(followed.json().feed.translationProvider, null);
    await until(() => store.translations.stats(feed.id).success === 1);
    assert.equal(fake.requests.at(-1)!.json.target_lang, 'KO', 'following the default now uses DeepL');
    const progress = (await app.inject({ url: `/api/feeds/${feed.id}/translation/progress`, headers })).json();
    assert.equal(progress.worker.provider, 'deepl');

    const exportedFeeds = (await app.inject({ url: '/api/backups/config', headers })).json().feeds;
    assert.equal(exportedFeeds[0].targetLanguage, 'ko'); assert.equal(exportedFeeds[0].translationProvider, null);
    assert.equal((await put({ deepl: { apiKey: null }, defaultProvider: 'google' })).statusCode, 200);
    assert.equal(store.getSettings().translation.deepl.apiKey, '', '`null` removes the key');
  } finally { await app.close(); await fake.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
