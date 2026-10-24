import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { parseSource, type SourceFetcher } from '../src/server/rss-source.js';
import { NotAFeedError, sourceMessages } from '../src/server/fetch-errors.js';
import { pubmedItemKey } from '../src/server/pubmed.js';
import { PUBMED_COVERAGE, pubmedCoverage, pubmedPmidOf, pubmedQueryFromRssTitle, pubmedSearchUrl } from '../src/shared/pubmed.js';
import { run, type Io } from '../packages/cli/src/cli.js';
import { createMcpServer } from '../packages/cli/src/mcp.js';
import { startTarget } from './proxy-fixtures.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/pubmed/${name}`, import.meta.url), 'utf8');
const SUN = '((Shandong University[Affiliation]) OR (Peking University[Affiliation])) AND (Sun Jin-peng[Author])';
const HU = '(Hu wanlong[Author]) AND (The University of Hong Kong[Affiliation]';
const search = (id: string, limit = 15) => `https://pubmed.ncbi.nlm.nih.gov/rss/search/${id}/?limit=${limit}&utm_campaign=pubmed-2&fc=20250101000000`;
const JOURNAL = 'https://pubmed.ncbi.nlm.nih.gov/rss/journals/101238921/?limit=15&name=PLoS%20Pathog&utm_campaign=journals';
const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
/** A PubMed search RSS document: the channel title is the query, items carry `pubmed:<PMID>` guids. */
const rssDocument = (title: string, pmids: string[]) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xml(title)}</title><link>https://pubmed.ncbi.nlm.nih.gov/</link><description>${xml(title)}: Latest results from PubMed</description>${pmids.map((pmid, index) => `<item><title>Article ${pmid}</title><link>https://pubmed.ncbi.nlm.nih.gov/${pmid}/?utm_source=Other&amp;utm_medium=rss</link><description>&lt;p&gt;Abstract ${pmid}&lt;/p&gt;</description><guid isPermaLink="false">pubmed:${pmid}</guid><pubDate>Thu, ${String(22 - index).padStart(2, '0')} Oct 2026 06:00:00 -0400</pubDate></item>`).join('')}</channel></rss>`;

test('从检索式 RSS 标题还原查询式：去掉后缀、补齐括号、识别截断', () => {
  assert.deepEqual(pubmedQueryFromRssTitle(SUN), { query: SUN, repaired: false, truncated: false });
  assert.deepEqual(pubmedQueryFromRssTitle(`${SUN}: Latest results from PubMed`), { query: SUN, repaired: false, truncated: false });
  assert.deepEqual(pubmedQueryFromRssTitle('pubmed: cancer AND  stem cells'), { query: 'cancer AND stem cells', repaired: false, truncated: false });
  // A missing closing parenthesis is closed; an extra one gets its opening one. Both still need the comparison.
  assert.deepEqual(pubmedQueryFromRssTitle(HU), { query: `${HU})`, repaired: true, truncated: false });
  assert.deepEqual(pubmedQueryFromRssTitle('Hu W[Author]) AND (HKU[Affiliation])'), { query: '(Hu W[Author]) AND (HKU[Affiliation])', repaired: true, truncated: false });
  // Brackets inside quotes don't count.
  assert.deepEqual(pubmedQueryFromRssTitle('"a (b"[ti] AND c'), { query: '"a (b"[ti] AND c', repaired: false, truncated: false });
  // Looks cut off: an ellipsis, a trailing operator, an open quote. Never repaired.
  for (const title of [`${SUN.slice(0, 60)}...`, `${SUN.slice(0, 60)}…`, '(cancer[ti]) AND', '"breast canc']) assert.equal(pubmedQueryFromRssTitle(title).truncated, true, title);
  assert.equal(pubmedQueryFromRssTitle('(a[ti]) AND (b…').repaired, false);

  assert.equal(pubmedPmidOf('https://pubmed.ncbi.nlm.nih.gov/42883926/?utm_source=Other'), '42883926');
  assert.equal(pubmedPmidOf('https://example.com/42883926/'), null);
  assert.deepEqual(pubmedCoverage(['1', '2', '3', '4', '5'], ['5', '4', '3', '2', '9']), { matched: 4, total: 5, ratio: 0.8 });
  assert.deepEqual(pubmedCoverage([], ['1']), { matched: 0, total: 0, ratio: 0 });
  // Only the newest `sample` items are compared.
  assert.equal(pubmedCoverage(Array.from({ length: 40 }, (_, i) => String(i)), ['0']).total, PUBMED_COVERAGE.sample);
});

const browser = { dispose: async () => {}, scrape: async () => { throw Error('PubMed must not launch browser'); } } as unknown as BrowserServiceLike;

/** E-utilities stand-in: esearch answers by query; efetch returns the three fixture records. */
async function setup(rss: Record<string, string | Error>, results: Record<string, string[]>) {
  const terms: string[] = [];
  const eutils = await startTarget((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    if (url.pathname.endsWith('/esearch.fcgi')) {
      const term = url.searchParams.get('term') ?? '';
      terms.push(term);
      const ids = results[term] ?? [];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ esearchresult: { count: String(ids.length * 10), retmax: String(ids.length), idlist: ids, querytranslation: term } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/xml' }); response.end(fixture('efetch-journal.xml'));
  });
  const fetched: string[] = [];
  const rssFetcher: SourceFetcher = async url => {
    fetched.push(url);
    const id = /\/rss\/(?:search|journals)\/([^/]+)/.exec(url)?.[1] ?? '';
    const answer = rss[id];
    if (!answer) throw new NotAFeedError(sourceMessages.challengePage(203, 'cookies-required'));
    if (answer instanceof Error) throw answer;
    return parseSource(answer, url);
  };
  const dir = mkdtempSync(join(tmpdir(), 'fl-pubmed-convert-')), store = new Store(dir);
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false, allowedHosts: [eutils.host], ncbiEndpoint: `http://${eutils.host}/entrez/eutils`, rssFetcher, translator: async text => `译：${text}`, translationIntervalMs: 0 });
  const host = '127.0.0.1:4321';
  const setupResponse = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: store.getSetupToken(), username: 'admin', password: 'password123' } });
  const headers = { host, cookie: `${setupResponse.cookies[0].name}=${setupResponse.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setupResponse.json().csrfToken as string };
  const owner = store.listUsers()[0].id;
  const rssFeed = (name: string, url: string, extra: Partial<Parameters<Store['createFeed']>[0]> = {}) => store.createFeed({ name, url, sourceType: 'rss', translationMode: 'original', rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 45, waitMs: 0, ...extra }, owner).feed;
  const check = async (id: string) => { const response = await app.inject({ method: 'POST', url: `/api/feeds/${id}/pubmed-check`, headers, payload: {} }); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  return { app, store, headers, owner, terms, fetched, rssFeed, check, close: async () => { await app.close(); store.close(); await eutils.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('转换前的验证：还原查询式并与 RSS 最新条目对比，覆盖率高才判定为可直接转换', async () => {
  const t = await setup({
    sun: rssDocument(SUN, ['42883926', '41714066']),
    hu: rssDocument(HU, ['42883926', '41714066']),
    cut: rssDocument(`${SUN.slice(0, 50)}…`, ['42883926']),
    low: rssDocument('"lantern fungi"[Title]', ['42883926', '41714066', '40000001', '40000002', '40000003']),
    empty: rssDocument('"nothing yet"[Title]', []),
    gone: new Error('socket hang up'),
  }, {
    [SUN]: ['42900001', '42883926', '41714066'],
    [`${HU})`]: ['42883926', '41714066'],
    '"lantern fungi"[Title]': ['42883926', '41714066', '49999999'],
    '"nothing yet"[Title]': [],
    '("PLoS Pathog"[Journal])': ['42900001', '42883926', '41714066'],
  });
  try {
    const verified = await t.check(t.rssFeed('Sun', search('sun')).id);
    assert.deepEqual({ status: verified.status, query: verified.query, coverage: verified.coverage, count: verified.count, limit: verified.limit, kind: verified.kind, ncbiKeyConfigured: verified.ncbiKeyConfigured },
      { status: 'verified', query: SUN, coverage: { matched: 2, total: 2, ratio: 1, source: 'rss' }, count: 30, limit: 20, kind: 'search', ncbiKeyConfigured: false });
    assert.equal(verified.sourceTitle, SUN);
    // The esearch of the check compares the newest 200 matches.
    assert.equal(t.terms.at(-1), SUN);

    const repaired = await t.check(t.rssFeed('Hu', search('hu', 50)).id);
    assert.deepEqual([repaired.status, repaired.query, repaired.repaired, repaired.limit], ['verified', `${HU})`, true, 50]);

    const searched = t.terms.length;
    const cut = await t.check(t.rssFeed('Cut', search('cut')).id);
    assert.deepEqual([cut.status, cut.reason, cut.truncated], ['review', 'truncated', true]);
    assert.equal(t.terms.length, searched, 'a cut-off title is never sent to NCBI');

    const low = await t.check(t.rssFeed('Low', search('low')).id);
    assert.deepEqual([low.status, low.reason, low.coverage.matched, low.coverage.total], ['review', 'lowCoverage', 2, 5]);
    const empty = await t.check(t.rssFeed('Empty', search('empty')).id);
    assert.deepEqual([empty.status, empty.reason], ['review', 'noItems']);

    // The address can't be read: the query comes from the feed's name and stays a suggestion.
    const gone = t.rssFeed(SUN, search('gone'));
    t.store.transaction(() => t.store.translations.upsert(gone, parseSource(rssDocument(SUN, ['42883926', '41714066']), search('gone')).items));
    const failed = await t.check(gone.id);
    assert.deepEqual([failed.status, failed.reason, failed.query, failed.coverage.source], ['review', 'fetchFailed', SUN, 'stored']);
    assert.match(failed.error, /socket hang up/);

    // A journal RSS (blocked by NCBI) is checked against the items it already holds.
    const journal = t.rssFeed('PLoS Pathog', JOURNAL);
    t.store.transaction(() => t.store.translations.upsert(journal, parseSource(fixture('rss-journal.xml'), JOURNAL).items));
    const byJournal = await t.check(journal.id);
    assert.deepEqual([byJournal.kind, byJournal.status, byJournal.query, byJournal.coverage.source, byJournal.coverage.ratio], ['journal', 'verified', '("PLoS Pathog"[Journal])', 'stored', 1]);

    const website = t.store.createFeed({ name: 'Site', url: 'https://example.com/', rules: { item: 'a', title: 'b', link: 'c' }, credentialId: null, intervalMinutes: 60, waitMs: 0 }, t.owner).feed;
    const other = await t.app.inject({ method: 'POST', url: `/api/feeds/${website.id}/pubmed-check`, headers: t.headers, payload: {} });
    assert.deepEqual([other.statusCode, other.json().messageKey], [400, 'error.notPubmedRss']);
    // Every check read the RSS address itself, unchanged.
    assert.ok(t.fetched.every(url => url.startsWith('https://pubmed.ncbi.nlm.nih.gov/rss/')));
  } finally { await t.close(); }
});

test('转换后订阅 ID、RSS 地址、条目、译文、翻译设置、过滤、输出与保留条数、聚合成员资格、刷新间隔全部不变，条目不重复推送', async () => {
  const t = await setup({ sun: rssDocument(SUN, ['42883926', '41714066']) }, { [SUN]: ['42900001', '42883926', '41714066'] });
  try {
    const profile = (await t.app.inject({ method: 'POST', url: '/api/network-profiles', headers: t.headers, payload: { name: 'UA', userAgent: 'Lantern/1' } })).json();
    const feed = t.rssFeed(SUN, search('sun'), { translationMode: 'translated', targetLanguage: 'ja', translationProvider: 'google', networkProfileId: profile.id });
    const settings = await t.app.inject({ method: 'PATCH', url: `/api/feeds/${feed.id}`, headers: t.headers, payload: { itemFilter: { include: [], exclude: ['Erratum'], regex: false }, outputLimit: 50, retentionLimit: 300 } });
    assert.equal(settings.statusCode, 200, settings.body);
    const bundle = (await t.app.inject({ method: 'POST', url: '/api/bundles', headers: t.headers, payload: { name: 'Lab', feedIds: [feed.id] } })).json();
    // The RSS already delivered two articles, both translated.
    await t.app.inject({ method: 'POST', url: `/api/feeds/${feed.id}/refresh`, headers: t.headers, payload: {} });
    for (let i = 0; i < 100 && t.store.translations.stats(feed.id).success < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const before = (await t.app.inject({ url: `/api/feeds/${feed.id}`, headers: t.headers })).json();
    assert.equal(before.items.length, 2);
    const translations = t.store.exportTables().translations.filter(row => row.feed_id === feed.id).map(row => [row.item_id, row.body_json]);

    const checked = await t.check(feed.id);
    assert.equal(checked.status, 'verified');
    const converted = await t.app.inject({ method: 'POST', url: `/api/feeds/${feed.id}/pubmed-convert`, headers: t.headers, payload: { query: checked.query } });
    assert.equal(converted.statusCode, 200, converted.body);
    const after = converted.json().feed;
    assert.equal(converted.json().feedUrl, before.feedUrl);
    assert.deepEqual(after.pubmed, { query: SUN, limit: 20 });
    assert.equal(after.url, pubmedSearchUrl({ query: SUN, limit: 20 }));
    for (const key of ['id', 'name', 'channelTitle', 'translationMode', 'targetLanguage', 'translationProvider', 'networkProfileId', 'itemFilter', 'outputLimit', 'retentionLimit', 'intervalMinutes', 'enabled'] as const) assert.deepEqual(after[key], before.feed[key], key);
    assert.deepEqual((await t.app.inject({ url: `/api/bundles/${bundle.bundle.id}`, headers: t.headers })).json().bundle.feedIds, [feed.id]);

    // The first E-utilities fetch runs in the background: only the article the RSS never listed is new.
    for (let i = 0; i < 100 && (t.store.getFeed(feed.id)!.itemCount < 3); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const log = (await t.app.inject({ url: `/api/feeds/${feed.id}/logs`, headers: t.headers })).json().logs[0];
    assert.deepEqual([log.source, log.status, log.newItemCount], ['edit', 'success', 1], log.error);
    const items = (await t.app.inject({ url: `/api/feeds/${feed.id}`, headers: t.headers })).json().items as Array<{ id: string; link: string }>;
    for (const item of before.items as Array<{ id: string; link: string }>) assert.ok(items.some(entry => entry.id === item.id), `${item.link} keeps its item`);
    assert.deepEqual(new Set(t.store.exportTables().feed_items.filter(row => row.feed_id === feed.id).map(row => row.normalized_key)), new Set(['42900001', '42883926', '41714066'].map(pubmedItemKey)));
    // Existing translations are reused, not duplicated; a second refresh adds nothing.
    const rows = () => t.store.exportTables().translations.filter(row => row.feed_id === feed.id);
    for (const [itemId] of translations) assert.ok(rows().some(row => row.item_id === itemId));
    assert.equal(rows().length, 3);
    await t.app.inject({ method: 'POST', url: `/api/feeds/${feed.id}/refresh`, headers: t.headers, payload: {} });
    assert.equal((await t.app.inject({ url: `/api/feeds/${feed.id}/logs`, headers: t.headers })).json().logs[0].newItemCount, 0);

    // Only PubMed RSS feeds convert; a query must be sendable.
    const again = await t.app.inject({ method: 'POST', url: `/api/feeds/${feed.id}/pubmed-convert`, headers: t.headers, payload: { query: SUN } });
    assert.deepEqual([again.statusCode, again.json().code], [400, 'validation']);
    const other = t.rssFeed('Other', search('other'));
    const broken = await t.app.inject({ method: 'POST', url: `/api/feeds/${other.id}/pubmed-convert`, headers: t.headers, payload: { query: HU } });
    assert.deepEqual([broken.statusCode, broken.json().code], [400, 'pubmed_query_invalid']);
    assert.equal(t.store.getFeed(other.id)!.sourceType, 'rss');
  } finally { await t.close(); }
});

test('CLI pubmed convert 默认只出报告；--all-verified --yes 只转换验证通过的，需要核对的用 --query 逐个转换；MCP 需要 confirm', async () => {
  const t = await setup({
    sun: rssDocument(SUN, ['42883926', '41714066']),
    low: rssDocument('"lantern fungi"[Title]', ['40000001', '40000002']),
  }, { [SUN]: ['42883926', '41714066'], '"lantern fungi"[Title]': ['42883926'], '"lantern fungi"[Title] AND 2020:2026[dp]': ['40000001'] });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const address = t.app.server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const token = t.store.tokens.create(t.owner, { name: 'agent', scope: 'write', expiresAt: null }).secret;
  const cli = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const io: Io = { stdout: text => out.push(text), stderr: text => err.push(text), env: { FEEDLANTERN_CONFIG: join(tmpdir(), 'fl-none.json'), FEEDLANTERN_URL: url, FEEDLANTERN_TOKEN: token }, readStdin: async () => '' };
    const code = await run(args, io);
    return { code, json: () => JSON.parse(out.join('\n')), stderr: err.join('\n'), stdout: out.join('\n') };
  };
  try {
    const sun = t.rssFeed('Sun', search('sun')), low = t.rssFeed('Low', search('low'));
    const report = await cli(['pubmed', 'convert', '--all-verified']);
    assert.equal(report.code, 0, report.stderr);
    assert.deepEqual([report.json().checked, report.json().verified, report.json().review, report.json().converted], [2, 1, 1, 0]);
    assert.deepEqual(report.json().feeds.map((row: { name: string; status: string; reason: string | null; coverage: string }) => [row.name, row.status, row.reason, row.coverage]), [['Sun', 'verified', null, '2/2'], ['Low', 'review', 'lowCoverage', '0/2']]);
    assert.match(report.json().hint, /没有改动任何订阅/);
    assert.equal(t.store.getFeed(sun.id)!.sourceType, 'rss');
    assert.match((await cli(['pubmed', 'convert', '--all-verified', '--table'])).stdout, /feedId\s+name\s+status/);

    // --dry-run still checks (nothing changes) and only lists the conversion it would send.
    const dry = await cli(['pubmed', 'convert', '--all-verified', '--yes', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(dry.json().requests.map((request: { method: string; url: string }) => request.method), ['POST']);
    assert.match(dry.json().requests[0].url, new RegExp(`/api/feeds/${sun.id}/pubmed-convert$`));
    assert.equal(t.store.getFeed(sun.id)!.sourceType, 'rss');

    const done = await cli(['pubmed', 'convert', '--all-verified', '--yes']);
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual([done.json().converted, done.json().failed], [1, 0]);
    assert.equal(t.store.getFeed(sun.id)!.sourceType, 'pubmed');
    assert.equal(t.store.getFeed(low.id)!.sourceType, 'rss');
    assert.match(done.json().feeds.find((row: { name: string }) => row.name === 'Low').error, /需要核对/);

    assert.equal((await cli(['pubmed', 'convert'])).code, 2);
    assert.equal((await cli(['pubmed', 'convert', low.id, '--all-verified'])).code, 2);

    // MCP: the check lists the result, the conversion needs confirm: true.
    const server = createMcpServer({ connection: { url, token, profile: 'default', configPath: '', sources: { url: 'env', token: 'env' } }, readOnly: false });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown>) => { const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> }; return { isError: !!result.isError, body: JSON.parse(result.content[0].text) }; };
    const checked = await call('pubmed_convert_check', { feedIds: [low.id] });
    assert.deepEqual([checked.isError, checked.body.review, checked.body.feeds[0].reason], [false, 1, 'lowCoverage']);
    const reviewed = '"lantern fungi"[Title] AND 2020:2026[dp]';
    const unconfirmed = await call('pubmed_convert', { id: low.id, query: reviewed });
    assert.deepEqual([unconfirmed.isError, unconfirmed.body.error.code], [true, 'usage']);
    const confirmed = await call('pubmed_convert', { id: low.id, query: reviewed, confirm: true });
    assert.equal(confirmed.isError, false, JSON.stringify(confirmed.body));
    assert.deepEqual(confirmed.body.feed.pubmed, { query: reviewed, limit: 20 });
    await client.close();
  } finally { await t.close(); }
});
