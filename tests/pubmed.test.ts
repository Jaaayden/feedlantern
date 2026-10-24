import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { digest, parseSource } from '../src/server/rss-source.js';
import { NetworkPolicy } from '../src/server/network.js';
import { NCBI_INTERVAL_MS, NcbiRateLimiter, fetchPubmedJournal, parseEfetch, pubmedItemKey, pubmedRssDate, sourceFetcher, type NcbiContext } from '../src/server/pubmed.js';
import { NcbiError } from '../src/server/fetch-errors.js';
import { friendlyError } from '../src/server/validation.js';
import { pubmedJournalSource } from '../src/shared/pubmed.js';
import { startHttpProxy, startTarget } from './proxy-fixtures.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/pubmed/${name}`, import.meta.url), 'utf8');
const JOURNAL = 'https://pubmed.ncbi.nlm.nih.gov/rss/journals/101238921/?limit=3&name=PLoS%20Pathog&utm_campaign=journals';

type Answer = { status?: number; type?: string; body: string; headers?: Record<string, string> };
interface Seen { at: number; name: string; params: URLSearchParams; headers: IncomingMessage['headers'] }
/** A local stand-in for eutils.ncbi.nlm.nih.gov that records every request. */
async function startEutils(answer: (name: string, params: URLSearchParams, count: number) => Answer | undefined = () => undefined) {
  const seen: Seen[] = [];
  const target = await startTarget((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    const name = /\/entrez\/eutils\/(\w+)\.fcgi$/.exec(url.pathname)?.[1] ?? url.pathname;
    seen.push({ at: performance.now(), name, params: url.searchParams, headers: request.headers });
    const custom = answer(name, url.searchParams, seen.filter(row => row.name === name).length);
    const fallback: Answer = name === 'esearch' ? { type: 'application/json', body: fixture('esearch-journal.json') }
      : name === 'efetch' ? { type: 'text/xml', body: fixture('efetch-journal.xml') } : { status: 404, type: 'text/plain', body: 'unknown' };
    const reply = custom ?? fallback;
    response.writeHead(reply.status ?? 200, { 'content-type': reply.type ?? 'application/json', ...reply.headers });
    response.end(reply.body);
  });
  return { ...target, seen, endpoint: `http://${target.host}/entrez/eutils` };
}
const context = (endpoint: string, settings = { apiKey: '', email: '' }): NcbiContext => ({ limiter: new NcbiRateLimiter(), settings: () => settings, endpoint });

test('识别 PubMed 期刊 RSS 地址：NLM ID、limit 默认 15 上限 100、name；其他地址不受影响', () => {
  assert.deepEqual(pubmedJournalSource('https://pubmed.ncbi.nlm.nih.gov/rss/journals/101238921/?limit=15&name=PLoS%20Pathog&utm_campaign=journals'), { nlmId: '101238921', limit: 15, name: 'PLoS Pathog' });
  assert.deepEqual(pubmedJournalSource('https://pubmed.ncbi.nlm.nih.gov/rss/journals/101579614/'), { nlmId: '101579614', limit: 15 });
  assert.deepEqual(pubmedJournalSource('https://pubmed.ncbi.nlm.nih.gov/rss/journals/0372516r?limit=500'), { nlmId: '0372516R', limit: 100 });
  assert.equal(pubmedJournalSource('https://pubmed.ncbi.nlm.nih.gov/rss/journals/101238921/?limit=abc')?.limit, 15);
  for (const other of ['https://pubmed.ncbi.nlm.nih.gov/rss/search/1PW-O5V9EIr5/?limit=15', 'https://example.com/rss/journals/101238921/', 'https://pubmed.ncbi.nlm.nih.gov/rss/journals/../search/1/', 'https://user:pw@pubmed.ncbi.nlm.nih.gov/rss/journals/101238921/', 'not a url']) {
    assert.equal(pubmedJournalSource(other), null, other);
  }
});

test('条目 key 连续：E-utilities 生成的 key 与原 PubMed RSS（guid pubmed:<PMID>）完全一致', () => {
  // parseSource is what produced the keys already stored for PubMed journal subscriptions.
  const fromRss = parseSource(fixture('rss-journal.xml'), JOURNAL).items;
  const { items } = parseEfetch(fixture('efetch-journal.xml'));
  assert.deepEqual(fromRss.map(item => item.key), ['42883926', '41714066'].map(pmid => items.get(pmid)!.key));
  // The same value an instance stored from the real RSS feed for PMID 42883926.
  assert.equal(items.get('42883926')!.key, 'e12cb537adfff630850d1b872d3525796706a886ca3958a2ed41ae29fd4114cb');
  assert.equal(pubmedItemKey('42883926'), digest('id:pubmed:42883926'));
  // Dates match too: 06:00 New York time on the Entrez date, summer and winter.
  assert.deepEqual(fromRss.map(item => item.publishedAt), ['42883926', '41714066'].map(pmid => items.get(pmid)!.publishedAt));
  assert.equal(pubmedRssDate(2026, 10, 16), '2026-10-16T10:00:00.000Z');
  assert.equal(pubmedRssDate(2026, 2, 19), '2026-02-19T11:00:00.000Z');
  assert.equal(pubmedRssDate(2026, 13, 1), undefined);
});

test('efetch 解析：标题、链接、日期、作者、期刊、摘要放进正文，标记安全', () => {
  const { items, journal } = parseEfetch(fixture('efetch-journal.xml'));
  assert.equal(journal, 'PLoS Pathog');
  const structured = items.get('42883926')!;
  assert.equal(structured.title, 'A Fixture virus and CD4+ T cells');
  assert.equal(structured.link, 'https://pubmed.ncbi.nlm.nih.gov/42883926/');
  assert.equal(structured.publishedAt, '2026-10-16T10:00:00.000Z');
  assert.match(structured.html, /^<div><p>PLoS Pathog\. 2026 Oct 6;22\(10\):e1012345\. doi: 10\.0000\/fixture\.0001\.<\/p>/);
  assert.match(structured.html, /<p>One A, Two B, Three C, Four D, Five E, Six F, Seven G, Eight H, Nine I, Ten J, et al\.<\/p>/);
  assert.match(structured.html, /<p><b>ABSTRACT<\/b><\/p><p>BACKGROUND: Fixture viruses use IL-1β and 5-HT<sub>7<\/sub> receptors\.<\/p><p>METHODS: We counted 10 mg of cells at 37 °C\.<\/p><p>RESULTS: Cells glowed\.<\/p>/);
  assert.match(structured.html, /PMID:<a href="https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/42883926\/">42883926<\/a> \| PMC:<a href="https:\/\/www\.ncbi\.nlm\.nih\.gov\/pmc\/PMC13665381\/">PMC13665381<\/a> \| DOI:<a href="https:\/\/doi\.org\/10\.0000\/fixture\.0001">/);

  const plain = items.get('41714066')!;
  assert.equal(plain.title, 'Fixture article about lantern fungi');
  assert.match(plain.html, /<p>PLoS Pathog\. 2026;22:1-76\. doi: 10\.0000\/fixture\.0002\. Epub 2025 Dec 26\.<\/p><p>Çiçek R<\/p>/);
  assert.match(plain.html, /<p>Lantern fungi glow in the dark\. They grow in &lt;wet&gt; soil &amp; leaves\.<\/p>/);
  assert.doesNotMatch(plain.html, /script|alert/);

  const ahead = items.get('42900001')!;
  assert.equal(ahead.title, 'A translated fixture title');
  assert.match(ahead.html, /<p>PLoS Pathog\. 2026 Oct 22:S0000-0000\(26\)00001-0\. Online ahead of print\.<\/p><p>Fixture Study Group<\/p><p><b>NO ABSTRACT<\/b><\/p>/);

  // Only efetch's own DTD reference is accepted; any internal subset or entity is refused.
  assert.throws(() => parseEfetch('<?xml version="1.0"?><!DOCTYPE PubmedArticleSet [<!ENTITY x SYSTEM "file:///etc/passwd">]><PubmedArticleSet/>'), (error: Error) => error instanceof NcbiError && /无法解析/.test(error.message));
  assert.throws(() => parseEfetch('<eFetchResult><ERROR>ID list is empty! Possibly it has no correct IDs.</ERROR></eFetchResult>'), /NCBI E-utilities 返回错误：ID list is empty!/);
});

test('NCBI 限流器：调用顺序排队，不带 Key 每 350 毫秒一个，带 Key 每 110 毫秒一个；429 后整体后移', async () => {
  let now = 1000;
  const waits: number[] = [];
  const limiter = new NcbiRateLimiter(() => now, async ms => { waits.push(ms); });
  await Promise.all([1, 2, 3, 4].map(() => limiter.acquire(NCBI_INTERVAL_MS.anonymous)));
  assert.deepEqual(waits, [350, 700, 1050]);
  // Any one second holds at most three request starts without a key, ten with one.
  assert.ok(1000 / NCBI_INTERVAL_MS.anonymous < 3 && 1000 / NCBI_INTERVAL_MS.withKey < 10);
  now = 10_000; waits.length = 0;
  await Promise.all([1, 2, 3].map(() => limiter.acquire(NCBI_INTERVAL_MS.withKey)));
  assert.deepEqual(waits, [110, 220]);
  limiter.pause(2000); waits.length = 0;
  await limiter.acquire(NCBI_INTERVAL_MS.withKey);
  assert.deepEqual(waits, [2000]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(limiter.acquire(NCBI_INTERVAL_MS.anonymous, controller.signal));
});

test('期刊订阅改走 esearch + efetch：参数、顺序、标题，且从不请求原 RSS 地址', async () => {
  const eutils = await startEutils();
  try {
    const policy = new NetworkPolicy({ allowedHosts: [eutils.host] });
    const result = await fetchPubmedJournal(pubmedJournalSource(JOURNAL)!, JOURNAL, policy, context(eutils.endpoint, { apiKey: 'abc123def456', email: 'admin@example.org' }));
    assert.equal(result.title, 'PLoS Pathog');
    assert.deepEqual(result.items.map(item => item.link), ['42900001', '42883926', '41714066'].map(id => `https://pubmed.ncbi.nlm.nih.gov/${id}/`));
    assert.deepEqual(eutils.seen.map(row => row.name), ['esearch', 'efetch']);
    const [search, records] = eutils.seen.map(row => row.params);
    assert.deepEqual(Object.fromEntries(search), { db: 'pubmed', term: '101238921[jid]', sort: 'pub_date', retmax: '3', retmode: 'json', tool: 'feedlantern', email: 'admin@example.org', api_key: 'abc123def456' });
    assert.deepEqual(Object.fromEntries(records), { db: 'pubmed', id: '42900001,42883926,41714066', retmode: 'xml', tool: 'feedlantern', email: 'admin@example.org', api_key: 'abc123def456' });

    // Without settings: no email and no key; the limit defaults to 15; the title falls back to the journal.
    eutils.seen.length = 0;
    const bare = 'https://pubmed.ncbi.nlm.nih.gov/rss/journals/101238921/';
    const fetcher = sourceFetcher(() => policy, context(eutils.endpoint));
    assert.equal((await fetcher(bare)).title, 'PLoS Pathog');
    assert.deepEqual(Object.fromEntries(eutils.seen[0].params), { db: 'pubmed', term: '101238921[jid]', sort: 'pub_date', retmax: '15', retmode: 'json', tool: 'feedlantern' });
    // The pubmed.ncbi.nlm.nih.gov address itself is never requested (the policy would block it anyway).
    assert.ok(eutils.seen.every(row => ['esearch', 'efetch'].includes(row.name)));
  } finally { await eutils.close(); }
});

test('所有 NCBI 请求共用一个队列：批量刷新时任意 1 秒内不超过 3 个请求（带 Key 时 10 个）', async () => {
  const eutils = await startEutils();
  try {
    const policy = new NetworkPolicy({ allowedHosts: [eutils.host] });
    const perSecond = () => Math.max(...eutils.seen.map(first => eutils.seen.filter(row => row.at >= first.at && row.at < first.at + 1000).length));
    const anonymous = sourceFetcher(() => policy, context(eutils.endpoint));
    await Promise.all(['101238921', '101579614', '101231360'].map(id => anonymous(`https://pubmed.ncbi.nlm.nih.gov/rss/journals/${id}/`)));
    assert.equal(eutils.seen.length, 6);
    assert.ok(perSecond() <= 3, `at most 3 per second, saw ${perSecond()}`);
    eutils.seen.length = 0;
    const keyed = sourceFetcher(() => policy, context(eutils.endpoint, { apiKey: 'abc123', email: '' }));
    await Promise.all(Array.from({ length: 7 }, (_, i) => keyed(`https://pubmed.ncbi.nlm.nih.gov/rss/journals/10123892${i}/`)));
    assert.equal(eutils.seen.length, 14);
    assert.ok(perSecond() <= 10, `at most 10 per second, saw ${perSecond()}`);
    // Spaced, not fired at once: 14 requests 110 ms apart take more than a second.
    assert.ok(eutils.seen.at(-1)!.at - eutils.seen[0].at >= 13 * NCBI_INTERVAL_MS.withKey - 50);
  } finally { await eutils.close(); }
});

test('NCBI 返回 429、错误 JSON、网页或无效数据时给出可读报错，不泄露 API Key 和地址', async () => {
  let mode = '';
  const eutils = await startEutils((name, _params, count) => {
    if (mode === '429-once' && name === 'esearch' && count === 1) return { status: 429, headers: { 'retry-after': '1' }, body: '{"error":"API rate limit exceeded","api-key":"abc123","count":"4","limit":"3"}' };
    if (mode === '429') return { status: 429, body: '{"error":"API rate limit exceeded"}' };
    if (mode === 'bad-key') return { status: 400, body: '{"error":"API key invalid","api-key":"secret-key-123","type":"invalid","status":"unknown"}' };
    if (mode === 'search-error' && name === 'esearch') return { body: '{"esearchresult":{"ERROR":"Invalid query syntax near https://example.com/x"}}' };
    if (mode === 'html') return { status: 203, type: 'text/html', body: fixture('journal-challenge.html') };
    if (mode === 'garbage') return { body: 'not json' };
    if (mode === 'unknown' && name === 'esearch') return { body: fixture('esearch-unknown-journal.json') };
    if (mode === 'fetch-error' && name === 'efetch') return { status: 400, type: 'text/xml', body: '<?xml version="1.0" encoding="UTF-8" ?>\n<!DOCTYPE eEfetchResult PUBLIC "-//NLM//DTD efetch 20131226//EN" "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20131226/efetch.dtd">\n<eFetchResult>\n\t<ERROR>ID list is empty! Possibly it has no correct IDs.</ERROR>\n</eFetchResult>' };
    if (mode === 'server' && name === 'efetch') return { status: 502, type: 'text/plain', body: 'Bad Gateway' };
    return undefined;
  });
  const policy = new NetworkPolicy({ allowedHosts: [eutils.host] });
  const run = (settings = { apiKey: '', email: '' }) => fetchPubmedJournal(pubmedJournalSource(JOURNAL)!, JOURNAL, policy, context(eutils.endpoint, settings));
  const failure = async (settings?: { apiKey: string; email: string }) => {
    const error = await run(settings).then(() => null, (reason: unknown) => reason);
    assert.ok(error instanceof NcbiError, String(error));
    assert.equal(friendlyError(error, 'fallback'), error.message);
    assert.ok(!error.message.includes('secret-key-123') && !error.message.includes('http'), error.message);
    return error.message;
  };
  try {
    mode = '429-once'; const started = performance.now();
    assert.equal((await run()).items.length, 3);
    assert.deepEqual(eutils.seen.map(row => row.name), ['esearch', 'esearch', 'efetch']);
    assert.ok(eutils.seen[1].at - eutils.seen[0].at >= 950, 'the retry waits for Retry-After');
    assert.ok(performance.now() - started < 5000);
    mode = '429'; assert.match(await failure(), /^NCBI E-utilities 请求过于频繁（HTTP 429），请稍后重试；管理员可以在“设置 → PubMed（NCBI）”中填写 NCBI API Key 提高限额。$/);
    mode = 'bad-key'; assert.match(await failure({ apiKey: 'secret-key-123', email: '' }), /^NCBI 拒绝了 API Key/);
    mode = 'search-error'; assert.equal(await failure(), 'NCBI E-utilities 返回错误：Invalid query syntax near');
    mode = 'html'; assert.match(await failure(), /^NCBI E-utilities 返回的是网页而不是数据（HTTP 203）/);
    mode = 'garbage'; assert.match(await failure(), /返回的数据无法解析/);
    mode = 'unknown'; assert.equal(await failure(), 'PubMed 中没有找到 NLM ID 为 101238921 的期刊，请检查订阅地址。');
    mode = 'fetch-error'; assert.equal(await failure(), 'NCBI E-utilities 返回错误：ID list is empty! Possibly it has no correct IDs.');
    mode = 'server'; assert.equal(await failure(), 'NCBI E-utilities 请求失败（HTTP 502），请稍后重试。');
  } finally { await eutils.close(); }
});

test('E-utilities 请求同样经过网络安全策略和订阅的网络配置代理；订阅的自定义请求头不会发给 NCBI', async () => {
  const eutils = await startEutils();
  const proxy = await startHttpProxy();
  try {
    await assert.rejects(fetchPubmedJournal(pubmedJournalSource(JOURNAL)!, JOURNAL, new NetworkPolicy(), context(eutils.endpoint)), /阻止/);
    assert.equal(eutils.seen.length, 0);
    const policy = new NetworkPolicy({ allowedHosts: [eutils.host, `127.0.0.1:${proxy.port}`] });
    const network = { proxy: { type: 'http' as const, host: '127.0.0.1', port: proxy.port }, userAgent: 'ProfileUA/3', headers: [{ name: 'X-Site-Token', value: 'for-pubmed-only' }] };
    const result = await fetchPubmedJournal(pubmedJournalSource(JOURNAL)!, JOURNAL, policy, context(eutils.endpoint), { network });
    assert.equal(result.items.length, 3);
    assert.deepEqual(proxy.log.map(entry => entry.target), [eutils.host, eutils.host]);
    assert.equal(eutils.seen[0].headers['user-agent'], 'ProfileUA/3');
    assert.equal(eutils.seen[0].headers['x-site-token'], undefined);
  } finally { await eutils.close(); await proxy.close(); }
});

const browser = { dispose: async () => {}, scrape: async () => { throw Error('RSS must not launch browser'); } } as unknown as BrowserServiceLike;

test('已有 PubMed 期刊订阅切到 E-utilities：已存条目和译文原样保留，只有新文章入库；预览、设置接口正常', async () => {
  const eutils = await startEutils();
  const dir = mkdtempSync(join(tmpdir(), 'fl-pubmed-')), store = new Store(dir);
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false, allowedHosts: [eutils.host], ncbiEndpoint: eutils.endpoint, translator: async text => `译：${text}`, translationIntervalMs: 0 });
  try {
    const host = '127.0.0.1:4321';
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: store.getSetupToken(), username: 'admin', password: 'password123' } });
    const headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken };
    const owner = store.listUsers()[0].id;

    // Settings: the key is write-only and encrypted with the other settings; the email is validated.
    const saved = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { ncbi: { apiKey: 'abc123def456', email: 'admin@example.org' } } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().ncbi, { apiKey: '', apiKeyConfigured: true, email: 'admin@example.org' });
    assert.deepEqual((await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { ncbi: { email: 'admin@example.org' } } })).json().ncbi.apiKeyConfigured, true);
    const invalid = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { ncbi: { email: 'not an email' } } });
    assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().error, 'NCBI 联系邮箱格式无效');
    const exported = await app.inject({ url: '/api/backups/config', headers });
    assert.deepEqual(exported.json().settings.ncbi, { apiKey: '', email: 'admin@example.org' });
    for (const file of ['app.db', 'app.db-wal']) if (existsSync(join(dir, file))) assert.ok(!readFileSync(join(dir, file)).includes('abc123def456'), `the key is stored encrypted (${file})`);

    // Pasting the journal address previews through E-utilities.
    const preview = await app.inject({ method: 'POST', url: '/api/rss/preview', headers, payload: { url: JOURNAL } });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().title, 'PLoS Pathog');
    assert.deepEqual(preview.json().items.map((item: { title: string }) => item.title), ['A translated fixture title', 'A Fixture virus and CD4+ T cells', 'Fixture article about lantern fungi']);
    assert.match(preview.json().items[1].contentHtml, /BACKGROUND: Fixture viruses/);
    assert.equal(eutils.seen.at(-1)!.params.get('api_key'), 'abc123def456');
    assert.equal(eutils.seen.at(-1)!.params.get('email'), 'admin@example.org');

    // A subscription that has been reading the journal's RSS address: two stored articles with translations.
    const { feed } = store.createFeed({ name: 'PLoS Pathog', url: JOURNAL, sourceType: 'rss', translationMode: 'translated', rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 30, waitMs: 0 }, owner);
    const fromRss = parseSource(fixture('rss-journal.xml'), JOURNAL);
    store.transaction(() => { store.translations.upsert(feed, store.translations.incoming(feed.id, fromRss.items)); store.translations.saveSource(feed.id, fromRss); });
    const stored = () => store.exportTables().feed_items.filter(row => row.feed_id === feed.id);
    const before = new Map(stored().map(item => [item.title, item.id]));
    assert.equal(before.size, 2);

    const refreshed = await app.inject({ method: 'POST', url: `/api/feeds/${feed.id}/refresh`, headers, payload: {} });
    assert.ok(refreshed.statusCode < 500, refreshed.body);
    const log = (await app.inject({ url: `/api/feeds/${feed.id}/logs`, headers })).json().logs[0];
    assert.equal(log.status, 'success', log.error);
    assert.equal(log.newItemCount, 1, 'only the article the RSS never listed is new');
    const after = stored();
    assert.equal(after.length, 3);
    for (const [title, id] of before) assert.equal(after.find(item => item.title === title)?.id, id, `${title} keeps its item and translation`);
    assert.equal(after.find(item => item.title === 'A Fixture virus and CD4+ T cells')!.link, 'https://pubmed.ncbi.nlm.nih.gov/42883926/');
    const translations = store.exportTables().translations.filter(row => row.feed_id === feed.id);
    assert.equal(translations.length, 3, 'one translation per article, none duplicated');
    assert.deepEqual(new Set(translations.map(row => row.item_id)), new Set(after.map(item => item.id)));
  } finally { await app.close(); store.close(); await eutils.close(); rmSync(dir, { recursive: true, force: true }); }
});
