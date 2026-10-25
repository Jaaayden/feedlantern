import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { digest, parseSource, type SourceFetcher } from '../src/server/rss-source.js';
import { NetworkPolicy } from '../src/server/network.js';
import { NCBI_INTERVAL_MS, NcbiRateLimiter, fetchPubmedSearch, parseEfetch, parseEsearch, previewPubmed, pubmedItemKey, pubmedRssDate, withPubmedRssHint, type NcbiContext } from '../src/server/pubmed.js';
import { NcbiError, NotAFeedError, sourceMessages } from '../src/server/fetch-errors.js';
import { friendlyError } from '../src/server/validation.js';
import { lt, rawText } from '../src/server/i18n.js';
import { pubmedDefaultName, pubmedSearchUrl } from '../src/shared/pubmed.js';
import { startHttpProxy, startTarget } from './proxy-fixtures.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/pubmed/${name}`, import.meta.url), 'utf8');
const JOURNAL = 'https://pubmed.ncbi.nlm.nih.gov/rss/journals/101238921/?limit=3&name=PLoS%20Pathog&utm_campaign=journals';
const SEARCH = { query: '("cryo-EM"[Title/Abstract]) AND ("ShanghaiTech"[Affiliation])', limit: 20 };

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
    const fallback: Answer = name === 'esearch' ? { type: 'application/json', body: fixture('esearch-search.json') }
      : name === 'efetch' ? { type: 'text/xml', body: fixture('efetch-journal.xml') } : { status: 404, type: 'text/plain', body: 'unknown' };
    const reply = custom ?? fallback;
    response.writeHead(reply.status ?? 200, { 'content-type': reply.type ?? 'application/json', ...reply.headers });
    response.end(reply.body);
  });
  return { ...target, seen, endpoint: `http://${target.host}/entrez/eutils` };
}
const context = (endpoint: string, settings = { apiKey: '', email: '' }): NcbiContext => ({ limiter: new NcbiRateLimiter(), settings: () => settings, endpoint });

test('条目 key 连续：E-utilities 生成的 key 与 PubMed RSS（guid pubmed:<PMID>）完全一致', () => {
  // parseSource is what produced the keys stored for PubMed RSS subscriptions.
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

test('efetch 解析：标题、链接、日期、作者、期刊、摘要放进正文，标记安全；预览摘要单独给出', () => {
  const { items, articles } = parseEfetch(fixture('efetch-journal.xml'));
  const structured = items.get('42883926')!;
  assert.equal(structured.title, 'A Fixture virus and CD4+ T cells');
  assert.equal(structured.link, 'https://pubmed.ncbi.nlm.nih.gov/42883926/');
  assert.equal(structured.publishedAt, '2026-10-16T10:00:00.000Z');
  assert.match(structured.html, /^<div><p>PLoS Pathog\. 2026 Oct 6;22\(10\):e1012345\. doi: 10\.0000\/fixture\.0001\.<\/p>/);
  assert.match(structured.html, /<p>One A, Two B, Three C, Four D, Five E, Six F, Seven G, Eight H, Nine I, Ten J, et al\.<\/p>/);
  assert.match(structured.html, /<p><b>ABSTRACT<\/b><\/p><p>BACKGROUND: Fixture viruses use IL-1β and 5-HT<sub>7<\/sub> receptors\.<\/p><p>METHODS: We counted 10 mg of cells at 37 °C\.<\/p><p>RESULTS: Cells glowed\.<\/p>/);
  assert.match(structured.html, /PMID:<a href="https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/42883926\/">42883926<\/a> \| PMC:<a href="https:\/\/www\.ncbi\.nlm\.nih\.gov\/pmc\/PMC13665381\/">PMC13665381<\/a> \| DOI:<a href="https:\/\/doi\.org\/10\.0000\/fixture\.0001">/);
  const summary = articles.get('42883926')!;
  assert.deepEqual({ ...summary, authors: summary.authors.length }, { pmid: '42883926', title: 'A Fixture virus and CD4+ T cells', link: 'https://pubmed.ncbi.nlm.nih.gov/42883926/', journal: 'PLoS Pathog', pubDate: '2026 Oct 6', authors: 12, addedAt: '2026-10-16T10:00:00.000Z' });
  assert.deepEqual(summary.authors.slice(0, 2), ['One A', 'Two B']);

  const plain = items.get('41714066')!;
  assert.equal(plain.title, 'Fixture article about lantern fungi');
  assert.match(plain.html, /<p>PLoS Pathog\. 2026;22:1-76\. doi: 10\.0000\/fixture\.0002\. Epub 2025 Dec 26\.<\/p><p>Çiçek R<\/p>/);
  assert.match(plain.html, /<p>Lantern fungi glow in the dark\. They grow in &lt;wet&gt; soil &amp; leaves\.<\/p>/);
  assert.doesNotMatch(plain.html, /script|alert/);
  assert.deepEqual(articles.get('41714066')!.authors, ['Çiçek R']);

  const ahead = items.get('42900001')!;
  assert.equal(ahead.title, 'A translated fixture title');
  assert.match(ahead.html, /<p>PLoS Pathog\. 2026 Oct 22:S0000-0000\(26\)00001-0\. Online ahead of print\.<\/p><p>Fixture Study Group<\/p><p><b>NO ABSTRACT<\/b><\/p>/);

  // Only efetch's own DTD reference is accepted; any internal subset or entity is refused.
  assert.throws(() => parseEfetch('<?xml version="1.0"?><!DOCTYPE PubmedArticleSet [<!ENTITY x SYSTEM "file:///etc/passwd">]><PubmedArticleSet/>'), (error: Error) => error instanceof NcbiError && /无法解析/.test(error.message));
  assert.throws(() => parseEfetch('<eFetchResult><ERROR>ID list is empty! Possibly it has no correct IDs.</ERROR></eFetchResult>'), /NCBI E-utilities 返回错误：ID list is empty!/);
});

test('esearch 解析：匹配总数、PMID、NCBI 的实际查询式和提示；错误 JSON、空结果', () => {
  const found = parseEsearch(fixture('esearch-search.json'));
  assert.equal(found.count, 172);
  assert.deepEqual(found.ids, ['42900001', '42883926', '41714066']);
  assert.equal(found.queryTranslation, '"cryo-EM"[Title/Abstract] AND "ShanghaiTech"[Affiliation]');
  // "No items found." repeats the count and is left out.
  assert.deepEqual(found.warnings, [{ kind: 'quotedPhraseNotFound', text: '"zzqx glowfungus"[All Fields]' }, { kind: 'phraseIgnored', text: 'the' }, { kind: 'message', text: 'Unknown sort schema \'x\' ignored' }]);
  const empty = parseEsearch(fixture('esearch-empty.json'));
  assert.deepEqual([empty.count, empty.ids], [0, []]);
  assert.deepEqual(parseEsearch(fixture('esearch-unknown-journal.json')).warnings, [{ kind: 'phraseNotFound', text: '99999999' }]);
  assert.throws(() => parseEsearch('{"error":"API key invalid"}'), /NCBI 拒绝了 API Key/);
  assert.throws(() => parseEsearch('{"esearchresult":{"ERROR":"Invalid query"}}'), /NCBI E-utilities 返回错误：Invalid query/);
  for (const broken of ['not json', '{}', '{"esearchresult":{"count":"x","idlist":[]}}', '{"esearchresult":{"count":"1"}}']) assert.throws(() => parseEsearch(broken), /返回的数据无法解析/, broken);
});

test('NCBI 限流器：调用顺序排队，不带 Key 每 350 毫秒一个，带 Key 每 110 毫秒一个；429 后整体后移', async () => {
  let now = 1000;
  const waits: number[] = [];
  const limiter = new NcbiRateLimiter(() => now, async ms => { waits.push(ms); });
  await Promise.all([1, 2, 3, 4].map(() => limiter.acquire(NCBI_INTERVAL_MS.anonymous)));
  assert.deepEqual(waits, [350, 700, 1050]);
  // The next request would wait for the fifth slot.
  assert.equal(limiter.backlog(), 1400);
  // Any one second holds at most three request starts without a key, ten with one.
  assert.ok(1000 / NCBI_INTERVAL_MS.anonymous < 3 && 1000 / NCBI_INTERVAL_MS.withKey < 10);
  now = 10_000; waits.length = 0;
  assert.equal(limiter.backlog(), 0);
  await Promise.all([1, 2, 3].map(() => limiter.acquire(NCBI_INTERVAL_MS.withKey)));
  assert.deepEqual(waits, [110, 220]);
  limiter.pause(2000); waits.length = 0;
  await limiter.acquire(NCBI_INTERVAL_MS.withKey);
  assert.deepEqual(waits, [2000]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(limiter.acquire(NCBI_INTERVAL_MS.anonymous, controller.signal));
});

test('检索订阅走 esearch（默认的 Most recent 排序）+ efetch：参数、顺序、tool/email/api_key', async () => {
  const eutils = await startEutils();
  try {
    const policy = new NetworkPolicy({ allowedHosts: [eutils.host] });
    const result = await fetchPubmedSearch(SEARCH, policy, context(eutils.endpoint, { apiKey: 'abc123def456', email: 'admin@example.org' }));
    assert.equal(result.title, SEARCH.query);
    assert.deepEqual(result.items.map(item => item.link), ['42900001', '42883926', '41714066'].map(id => `https://pubmed.ncbi.nlm.nih.gov/${id}/`));
    assert.deepEqual(result.items.map(item => item.key), ['42900001', '42883926', '41714066'].map(pubmedItemKey));
    assert.deepEqual(eutils.seen.map(row => row.name), ['esearch', 'efetch']);
    const [search, records] = eutils.seen.map(row => row.params);
    // No `sort`: esearch's PubMed default is "Most recent", the order PubMed's RSS used.
    assert.deepEqual(Object.fromEntries(search), { db: 'pubmed', term: SEARCH.query, retmax: '20', retmode: 'json', tool: 'feedlantern', email: 'admin@example.org', api_key: 'abc123def456' });
    assert.deepEqual(Object.fromEntries(records), { db: 'pubmed', id: '42900001,42883926,41714066', retmode: 'xml', tool: 'feedlantern', email: 'admin@example.org', api_key: 'abc123def456' });

    // Without settings: no email and no key.
    eutils.seen.length = 0;
    await fetchPubmedSearch({ query: 'cancer', limit: 10 }, policy, context(eutils.endpoint));
    assert.deepEqual(Object.fromEntries(eutils.seen[0].params), { db: 'pubmed', term: 'cancer', retmax: '10', retmode: 'json', tool: 'feedlantern' });

    // An empty result is a successful fetch without items, and efetch is not called.
    const none = await startEutils(name => name === 'esearch' ? { body: fixture('esearch-empty.json') } : undefined);
    try {
      const empty = await fetchPubmedSearch(SEARCH, new NetworkPolicy({ allowedHosts: [none.host] }), context(none.endpoint));
      assert.deepEqual(empty.items, []);
      assert.deepEqual(none.seen.map(row => row.name), ['esearch']);
      const preview = await previewPubmed('"zzqx lantern glowfungus"[All Fields]', new NetworkPolicy({ allowedHosts: [none.host] }), context(none.endpoint));
      assert.deepEqual({ count: preview.count, items: preview.items, warnings: preview.warnings }, { count: 0, items: [], warnings: [{ kind: 'quotedPhraseNotFound', text: '"zzqx lantern glowfungus"[All Fields]' }] });
    } finally { await none.close(); }
  } finally { await eutils.close(); }
});

test('所有 NCBI 请求共用一个队列：批量刷新时任意 1 秒内不超过 3 个请求（带 Key 时 10 个）', async () => {
  const eutils = await startEutils();
  try {
    const policy = new NetworkPolicy({ allowedHosts: [eutils.host] });
    const perSecond = () => Math.max(...eutils.seen.map(first => eutils.seen.filter(row => row.at >= first.at && row.at < first.at + 1000).length));
    const anonymous = context(eutils.endpoint);
    await Promise.all(['a', 'b', 'c'].map(term => fetchPubmedSearch({ query: term, limit: 20 }, policy, anonymous)));
    assert.equal(eutils.seen.length, 6);
    assert.ok(perSecond() <= 3, `at most 3 per second, saw ${perSecond()}`);
    eutils.seen.length = 0;
    const keyed = context(eutils.endpoint, { apiKey: 'abc123', email: '' });
    // Previews and refreshes share the queue as well.
    await Promise.all(Array.from({ length: 7 }, (_, i) => i % 2 ? previewPubmed(`q${i}`, policy, keyed) : fetchPubmedSearch({ query: `q${i}`, limit: 20 }, policy, keyed)));
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
    if (mode === 'fetch-error' && name === 'efetch') return { status: 400, type: 'text/xml', body: '<?xml version="1.0" encoding="UTF-8" ?>\n<!DOCTYPE eEfetchResult PUBLIC "-//NLM//DTD efetch 20131226//EN" "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20131226/efetch.dtd">\n<eFetchResult>\n\t<ERROR>ID list is empty! Possibly it has no correct IDs.</ERROR>\n</eFetchResult>' };
    if (mode === 'server' && name === 'efetch') return { status: 502, type: 'text/plain', body: 'Bad Gateway' };
    return undefined;
  });
  const policy = new NetworkPolicy({ allowedHosts: [eutils.host] });
  const run = (settings = { apiKey: '', email: '' }) => fetchPubmedSearch(SEARCH, policy, context(eutils.endpoint, settings));
  const failure = async (settings?: { apiKey: string; email: string }) => {
    const error = await run(settings).then(() => null, (reason: unknown) => reason);
    assert.ok(error instanceof NcbiError, String(error));
    assert.equal(lt(friendlyError(error, rawText('fallback'))), error.message);
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
    mode = 'fetch-error'; assert.equal(await failure(), 'NCBI E-utilities 返回错误：ID list is empty! Possibly it has no correct IDs.');
    mode = 'server'; assert.equal(await failure(), 'NCBI E-utilities 请求失败（HTTP 502），请稍后重试。');
  } finally { await eutils.close(); }
});

test('E-utilities 请求同样经过网络安全策略和订阅的网络配置代理；订阅的自定义请求头不会发给 NCBI', async () => {
  const eutils = await startEutils();
  const proxy = await startHttpProxy();
  try {
    await assert.rejects(fetchPubmedSearch(SEARCH, new NetworkPolicy(), context(eutils.endpoint)), /阻止/);
    assert.equal(eutils.seen.length, 0);
    const policy = new NetworkPolicy({ allowedHosts: [eutils.host, `127.0.0.1:${proxy.port}`] });
    const network = { proxy: { type: 'http' as const, host: '127.0.0.1', port: proxy.port }, userAgent: 'ProfileUA/3', headers: [{ name: 'X-Site-Token', value: 'for-pubmed-only' }] };
    const result = await fetchPubmedSearch(SEARCH, policy, context(eutils.endpoint), { network });
    assert.equal(result.items.length, 3);
    assert.deepEqual(proxy.log.map(entry => entry.target), [eutils.host, eutils.host]);
    assert.equal(eutils.seen[0].headers['user-agent'], 'ProfileUA/3');
    assert.equal(eutils.seen[0].headers['x-site-token'], undefined);
  } finally { await eutils.close(); await proxy.close(); }
});

test('期刊 RSS 不再被后台改写：地址原样交给 RSS 抓取，被 NCBI 拦截时报 source_not_feed 并说明原因', async () => {
  const blocked = new NotAFeedError(sourceMessages.challengePage(203, 'cookies-required'));
  const asked: string[] = [];
  const fetcher = withPubmedRssHint(async url => { asked.push(url); throw blocked; });
  const error = await fetcher(JOURNAL).then(() => null, (reason: unknown) => reason);
  assert.deepEqual(asked, [JOURNAL]);
  assert.ok(error instanceof NotAFeedError, String(error));
  assert.equal(error.message, 'NCBI 用验证页拦截了这个 PubMed 期刊 RSS 地址（HTTP 203, cookies-required），FeedLantern 不会尝试绕过。可以在订阅面板中把它转换为 PubMed 检索订阅（保留订阅地址、已存条目和译文），或改用检索式 RSS 链接。');
  // Short enough to be stored whole as a feed's last error, in both languages.
  assert.ok(error.message.length < 300 && error.englishMessage.length < 300, error.englishMessage);
  // Other addresses, a search RSS link and other errors keep their own message.
  for (const url of ['https://example.com/feed.xml', 'https://pubmed.ncbi.nlm.nih.gov/rss/search/1PW-O5V9EIr5/?limit=15']) assert.equal(await fetcher(url).catch((reason: unknown) => reason), blocked);
  const timeout = new Error('socket hang up');
  assert.equal(await withPubmedRssHint(async () => { throw timeout; })(JOURNAL).catch((reason: unknown) => reason), timeout);

  // In the app: the RSS preview and a refresh read the journal RSS address itself; NCBI E-utilities are never asked.
  const eutils = await startEutils();
  const dir = mkdtempSync(join(tmpdir(), 'fl-pubmed-rss-')), store = new Store(dir);
  const fetched: string[] = [];
  const rssFetcher: SourceFetcher = async url => { fetched.push(url); throw blocked; };
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false, allowedHosts: [eutils.host], ncbiEndpoint: eutils.endpoint, rssFetcher });
  try {
    const headers = await signIn(app, store);
    const preview = await app.inject({ method: 'POST', url: '/api/rss/preview', headers, payload: { url: JOURNAL } });
    assert.equal(preview.statusCode, 400);
    assert.equal(preview.json().code, 'source_not_feed');
    assert.equal(preview.json().messageKey, 'pubmed.journalRssBlocked');
    assert.match(preview.json().error, /转换为 PubMed 检索订阅/);
    const { feed } = store.createFeed({ name: 'PLoS Pathog', url: JOURNAL, sourceType: 'rss', translationMode: 'original', rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 30, waitMs: 0 }, store.listUsers()[0].id);
    await app.inject({ method: 'POST', url: `/api/feeds/${feed.id}/refresh`, headers, payload: {} });
    assert.match(store.getFeed(feed.id)!.lastError!, /PubMed 期刊 RSS 地址（HTTP 203, cookies-required）.*改用检索式 RSS 链接。$/);
    assert.deepEqual(fetched, [JOURNAL, JOURNAL]);
    assert.equal(store.getFeed(feed.id)!.sourceType, 'rss');
    assert.equal(eutils.seen.length, 0);
  } finally { await app.close(); store.close(); await eutils.close(); rmSync(dir, { recursive: true, force: true }); }
});

const browser = { dispose: async () => {}, scrape: async () => { throw Error('PubMed must not launch browser'); } } as unknown as BrowserServiceLike;
async function signIn(app: Awaited<ReturnType<typeof createApp>>, store: Store) {
  const host = '127.0.0.1:4321';
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: store.getSetupToken(), username: 'admin', password: 'password123' } });
  return { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken as string };
}
const waitFor = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(check(), label);
};

test('PubMed 检索预览接口：匹配总数和最新文章、NCBI 提示、相同查询一分钟内不重复请求、查询式校验', async () => {
  const eutils = await startEutils((name, params) => name === 'esearch' && params.get('term')?.includes('limited') ? { status: 429, body: '{"error":"API rate limit exceeded"}' } : undefined);
  const dir = mkdtempSync(join(tmpdir(), 'fl-pubmed-preview-')), store = new Store(dir);
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false, allowedHosts: [eutils.host], ncbiEndpoint: eutils.endpoint });
  try {
    const headers = await signIn(app, store);
    const preview = await app.inject({ method: 'POST', url: '/api/pubmed/preview', headers, payload: { query: SEARCH.query } });
    assert.equal(preview.statusCode, 200, preview.body);
    const body = preview.json();
    assert.equal(body.count, 172);
    assert.equal(body.queryTranslation, '"cryo-EM"[Title/Abstract] AND "ShanghaiTech"[Affiliation]');
    assert.equal(body.pubmedUrl, pubmedSearchUrl({ query: SEARCH.query, limit: 20 }));
    assert.deepEqual(body.items.map((item: { title: string; journal: string; pubDate: string }) => [item.title, item.journal, item.pubDate]), [['A translated fixture title', 'PLoS Pathog', '2026 Oct 22'], ['A Fixture virus and CD4+ T cells', 'PLoS Pathog', '2026 Oct 6'], ['Fixture article about lantern fungi', 'PLoS Pathog', '2026']]);
    assert.equal(body.warnings[0].kind, 'quotedPhraseNotFound');
    // The preview asks for five articles only.
    assert.equal(eutils.seen[0].params.get('retmax'), '5');
    const requests = eutils.seen.length;
    assert.equal((await app.inject({ method: 'POST', url: '/api/pubmed/preview', headers, payload: { query: `  ${SEARCH.query} ` } })).json().count, 172);
    assert.equal(eutils.seen.length, requests, 'the same query is answered from memory');

    for (const [query, key] of [['', 'error.pubmedQueryRequired'], ['"cancer', 'error.pubmedQueryInvalid'], ['cancer AND', 'error.pubmedQueryInvalid'], [42, 'error.pubmedQueryRequired']] as const) {
      const invalid = await app.inject({ method: 'POST', url: '/api/pubmed/preview', headers, payload: { query } });
      assert.equal(invalid.statusCode, 400, String(query));
      assert.deepEqual([invalid.json().code, invalid.json().messageKey], ['pubmed_query_invalid', key]);
    }
    assert.match((await app.inject({ method: 'POST', url: '/api/pubmed/preview', headers, payload: { query: '(a' } })).json().error, /^无法发送这个 PubMed 查询式：括号不配对。$/);
    assert.equal(eutils.seen.length, requests, 'invalid queries never reach NCBI');
    const limited = await app.inject({ method: 'POST', url: '/api/pubmed/preview', headers, payload: { query: 'limited' } });
    assert.deepEqual([limited.statusCode, limited.json().code], [429, 'rate_limited']);
  } finally { await app.close(); store.close(); await eutils.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('创建 PubMed 检索订阅：保存检索条件，抓取后条目、输出、翻译、规则预警都按 RSS 类来源处理', async () => {
  const eutils = await startEutils();
  const dir = mkdtempSync(join(tmpdir(), 'fl-pubmed-create-')), store = new Store(dir);
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false, allowedHosts: [eutils.host], ncbiEndpoint: eutils.endpoint, translator: async text => `译：${text}`, translationIntervalMs: 0 });
  try {
    const headers = await signIn(app, store);
    const base = { sourceType: 'pubmed', name: pubmedDefaultName(SEARCH.query), translationMode: 'bilingual', intervalMinutes: 120 };
    for (const [payload, code] of [[{ ...base }, 'pubmed_query_invalid'], [{ ...base, pubmed: { query: '(cryo' } }, 'pubmed_query_invalid'], [{ ...base, pubmed: { query: 'x', limit: 15 } }, 'validation']] as const) {
      const rejected = await app.inject({ method: 'POST', url: '/api/feeds', headers, payload });
      assert.deepEqual([rejected.statusCode, rejected.json().code], [400, code], rejected.body);
    }
    const created = await app.inject({ method: 'POST', url: '/api/feeds', headers, payload: { ...base, pubmed: SEARCH, url: 'https://ignored.example/', rules: { item: 'ignored', title: 'x', link: 'y' } } });
    assert.equal(created.statusCode, 200, created.body);
    const feed = created.json().feed;
    assert.equal(feed.sourceType, 'pubmed');
    assert.deepEqual(feed.pubmed, SEARCH);
    assert.equal(feed.url, pubmedSearchUrl(SEARCH));
    assert.equal(feed.credentialId, null);
    await waitFor(() => store.getFeed(feed.id)!.itemCount === 3, 'the first fetch runs in the background');
    const items = store.exportTables().feed_items.filter(row => row.feed_id === feed.id);
    assert.deepEqual(new Set(items.map(row => row.normalized_key)), new Set(['42900001', '42883926', '41714066'].map(pubmedItemKey)));
    assert.equal(store.getFeed(feed.id)!.ruleHealth, undefined);
    await waitFor(() => store.translations.stats(feed.id).success === 3, 'articles are translated like RSS items');
    const detail = (await app.inject({ url: `/api/feeds/${feed.id}`, headers })).json();
    assert.ok(detail.items.every((item: { translatedTitle?: string }) => item.translatedTitle?.startsWith('译：')));
    const output = await app.inject({ url: new URL(created.json().feedUrl).pathname });
    // Readers show the feed's name, the query + " - PubMed", in all three formats.
    const title = `${SEARCH.query} - PubMed`;
    assert.equal(feed.name, title);
    const xmlTitle = title.replaceAll('"', '&quot;').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    assert.match(output.body, new RegExp(`<channel><title>${xmlTitle}</title>`));
    const path = new URL(created.json().feedUrl).pathname;
    assert.match((await app.inject({ url: path.replace(/\.xml$/, '.atom') })).body, new RegExp(`</id><title type="text">${xmlTitle}</title>`));
    assert.equal(JSON.parse((await app.inject({ url: path.replace(/\.xml$/, '.json') })).body).title, title);
    assert.match(output.body, /<description>FeedLantern 通过 NCBI E-utilities 生成的 PubMed 检索：\(&quot;cryo-EM&quot;\[Title\/Abstract\]\) AND/);
    assert.match(output.body, /<title>译：A Fixture virus and CD4\+ T cells \/ A Fixture virus and CD4\+ T cells<\/title>/);

    // Changing the query keeps the stored articles (keys are PMIDs); the next fetch adds only new ones.
    const editing = await app.inject({ method: 'PUT', url: `/api/feeds/${feed.id}`, headers, payload: { ...base, pubmed: { query: '"PLoS Pathog"[Journal]', limit: 50 } } });
    assert.equal(editing.statusCode, 200, editing.body);
    assert.deepEqual(editing.json().feed.pubmed, { query: '"PLoS Pathog"[Journal]', limit: 50 });
    assert.deepEqual(store.exportTables().feed_items.filter(row => row.feed_id === feed.id).map(row => row.id).sort(), items.map(row => row.id).sort());
    assert.equal((await app.inject({ url: `/api/feeds/${feed.id}/logs`, headers })).json().logs[0].newItemCount, 0);

    // Configuration export and import carry the search in the stored address.
    const config = (await app.inject({ url: '/api/backups/config', headers })).json();
    const exported = config.feeds.find((entry: { name: string }) => entry.name === base.name);
    assert.deepEqual([exported.sourceType, exported.url], ['pubmed', pubmedSearchUrl({ query: '"PLoS Pathog"[Journal]', limit: 50 })]);
    const imported = await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: config } });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.deepEqual(imported.json().entries.map((entry: { duplicate: boolean }) => entry.duplicate), [true]);
  } finally { await app.close(); store.close(); await eutils.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('期刊 RSS 订阅一键转换为 PubMed 检索订阅：订阅 ID、RSS 地址、已存条目和译文保留，已有文章不算新文章', async () => {
  const eutils = await startEutils();
  const dir = mkdtempSync(join(tmpdir(), 'fl-pubmed-convert-')), store = new Store(dir);
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false, allowedHosts: [eutils.host], ncbiEndpoint: eutils.endpoint, translator: async text => `译：${text}`, translationIntervalMs: 0 });
  try {
    const headers = await signIn(app, store);
    const owner = store.listUsers()[0].id;
    // A subscription that has been reading the journal's RSS address: two stored articles with translations.
    const { feed } = store.createFeed({ name: 'PLoS Pathog', url: JOURNAL, sourceType: 'rss', translationMode: 'translated', rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 30, waitMs: 0 }, owner);
    const fromRss = parseSource(fixture('rss-journal.xml'), JOURNAL);
    store.transaction(() => { store.translations.upsert(feed, store.translations.incoming(feed.id, fromRss.items)); store.translations.saveSource(feed.id, fromRss); });
    await waitFor(() => store.translations.stats(feed.id).success === 2, 'the RSS articles are translated');
    const stored = () => store.exportTables().feed_items.filter(row => row.feed_id === feed.id);
    const before = new Map(stored().map(item => [item.title, item.id]));
    const translatedBefore = store.exportTables().translations.filter(row => row.feed_id === feed.id).map(row => row.item_id);
    const addressBefore = (await app.inject({ url: `/api/feeds/${feed.id}`, headers })).json().feedUrl;

    const converted = await app.inject({ method: 'PUT', url: `/api/feeds/${feed.id}`, headers, payload: { sourceType: 'pubmed', pubmed: { query: '("PLoS Pathog"[Journal])', limit: 20 }, name: 'PLoS Pathog', translationMode: 'translated', intervalMinutes: 30 } });
    assert.equal(converted.statusCode, 200, converted.body);
    assert.equal(converted.json().feed.id, feed.id);
    assert.equal(converted.json().feed.sourceType, 'pubmed');
    assert.equal(converted.json().feedUrl, addressBefore, 'the RSS address (and its token) is unchanged');
    // The edit fetches right away: only the article the RSS never listed is new.
    const log = (await app.inject({ url: `/api/feeds/${feed.id}/logs`, headers })).json().logs[0];
    assert.deepEqual([log.source, log.status, log.newItemCount], ['edit', 'success', 1], log.error);
    assert.deepEqual(eutils.seen.map(row => row.name), ['esearch', 'efetch']);
    assert.equal(eutils.seen[0].params.get('term'), '("PLoS Pathog"[Journal])');
    const after = stored();
    assert.equal(after.length, 3);
    for (const [title, id] of before) assert.equal(after.find(item => item.title === title)?.id, id, `${title} keeps its item`);
    await waitFor(() => store.translations.stats(feed.id).success === 3, 'the new article is translated');
    const translations = () => store.exportTables().translations.filter(row => row.feed_id === feed.id);
    assert.equal(translations().length, 3, 'one translation per article, none duplicated');
    for (const itemId of translatedBefore) assert.ok(translations().some(row => row.item_id === itemId), 'existing articles keep their translation record');
    // Later fetches find nothing new and translate nothing again.
    const settled = translations().map(row => [row.item_id, row.body_json]);
    await app.inject({ method: 'POST', url: `/api/feeds/${feed.id}/refresh`, headers, payload: {} });
    assert.equal((await app.inject({ url: `/api/feeds/${feed.id}/logs`, headers })).json().logs[0].newItemCount, 0);
    assert.deepEqual(translations().map(row => [row.item_id, row.body_json]), settled);

    // A website or other RSS feed changed to a PubMed search starts empty, as any source change does.
    const other = store.createFeed({ name: 'Other', url: 'https://example.com/feed.xml', sourceType: 'rss', translationMode: 'original', rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 30, waitMs: 0 }, owner).feed;
    store.transaction(() => store.translations.upsert(other, fromRss.items));
    store.updateFeed(other.id, { sourceType: 'pubmed', pubmed: SEARCH, url: pubmedSearchUrl(SEARCH), name: 'Other', translationMode: 'original', rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 30, waitMs: 0 });
    assert.equal(store.exportTables().feed_items.filter(row => row.feed_id === other.id).length, 0);
  } finally { await app.close(); store.close(); await eutils.close(); rmSync(dir, { recursive: true, force: true }); }
});
