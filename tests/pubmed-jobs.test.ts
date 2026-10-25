import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { parseSource, type SourceFetcher } from '../src/server/rss-source.js';
import { NCBI_INTERVAL_MS } from '../src/server/pubmed.js';
import { closedPort, startTarget } from './proxy-fixtures.js';

const browser = { dispose: async () => {}, scrape: async () => { throw Error('no browser'); } } as unknown as BrowserServiceLike;
const search = (id: string) => `https://pubmed.ncbi.nlm.nih.gov/rss/search/${id}/?limit=15`;
const rss = (title: string, pmids: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${pmids.map(pmid => `<item><title>A ${pmid}</title><link>https://pubmed.ncbi.nlm.nih.gov/${pmid}/</link><guid isPermaLink="false">pubmed:${pmid}</guid></item>`).join('')}</channel></rss>`;
const wait = async (check: () => boolean, label: string, ms = 20_000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(check(), label);
};

/** E-utilities stand-in: each feed's query `(q<N>[Title])` matches PMIDs 1000+N and 2000+N; answers take `delay` ms. */
async function startEutils(delay = 0) {
  const seen: Array<{ start: number; end: number; term: string }> = [];
  let inFlight = 0, maxInFlight = 0;
  const target = await startTarget(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    const term = url.searchParams.get('term') ?? '';
    const entry = { start: performance.now(), end: 0, term };
    seen.push(entry);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, delay));
    inFlight--; entry.end = performance.now();
    const n = /^\(q(\d+)\[Title\]\)$/.exec(term)?.[1];
    const ids = n ? [String(1000 + Number(n)), String(2000 + Number(n))] : [];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ esearchresult: { count: String(ids.length), idlist: ids, querytranslation: term } }));
  });
  return { ...target, seen, maxInFlight: () => maxInFlight, endpoint: `http://${target.host}/entrez/eutils` };
}

async function open(dir: string, store: Store, eutils: { host: string; endpoint: string }, rssFetcher?: SourceFetcher) {
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false, allowedHosts: [eutils.host], ncbiEndpoint: eutils.endpoint, rssFetcher: rssFetcher ?? (async () => { throw new Error('RSS should not be read'); }) });
  const host = '127.0.0.1:4321';
  let headers: Record<string, string>;
  if (store.getSetupToken()) {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: store.getSetupToken(), username: 'admin', password: 'password123' } });
    headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken };
  } else {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host, 'x-feedlantern': '1' }, payload: { username: 'admin', password: 'password123' } });
    headers = { host, cookie: `${login.cookies[0].name}=${login.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': login.json().csrfToken };
  }
  return { app, headers };
}

/** `count` search RSS feeds named after their query, each holding its two articles. */
function seed(store: Store, count: number) {
  const owner = store.listUsers()[0].id;
  return Array.from({ length: count }, (_, i) => {
    const feed = store.createFeed({ name: `(q${i}[Title])`, url: search(`s${i}`), sourceType: 'rss', translationMode: 'original', rules: { item: '', title: '', link: '' }, credentialId: null, intervalMinutes: 60, waitMs: 0 }, owner).feed;
    store.transaction(() => store.translations.upsert(feed, parseSource(rss(feed.name, [String(1000 + i), String(2000 + i)]), feed.url).items));
    return feed;
  });
}

test('批量验证：同时验证多个订阅，但所有 NCBI 请求仍走全局限流；只用已存条目，不访问 PubMed 网页', async () => {
  const eutils = await startEutils(600);
  const dir = mkdtempSync(join(tmpdir(), 'fl-pubmed-jobs-')), store = new Store(dir);
  const { app, headers } = await open(dir, store, eutils);
  try {
    const feeds = seed(store, 9);
    const started = await app.inject({ method: 'POST', url: '/api/pubmed-checks', headers, payload: {} });
    assert.equal(started.statusCode, 200, started.body);
    const job = started.json();
    assert.deepEqual([job.state, job.progress.total, job.ncbiKeyConfigured], ['running', 9, false]);
    // Nobody polls: the job runs on its own.
    await wait(() => store.pubmedChecks.job(job.id)!.state === 'done', 'the job finishes in the background');
    const done = (await app.inject({ url: `/api/pubmed-checks/${job.id}`, headers })).json();
    assert.deepEqual([done.progress.done, done.progress.verified, done.progress.review], [9, 9, 0]);
    assert.ok(done.entries.every((entry: { check: { coverage: { source: string } } }) => entry.check.coverage.source === 'stored'));
    // One esearch per feed, several waiting for answers at once…
    assert.equal(eutils.seen.length, feeds.length);
    assert.ok(eutils.maxInFlight() >= 2, `checks overlap (max in flight ${eutils.maxInFlight()})`);
    assert.ok(eutils.maxInFlight() <= 5, `at most 5 at once (max in flight ${eutils.maxInFlight()})`);
    // …but never more than 3 request starts in any second without an API key.
    const perSecond = Math.max(...eutils.seen.map(first => eutils.seen.filter(row => row.start >= first.start && row.start < first.start + 1000).length));
    assert.ok(perSecond <= 3, `at most 3 per second, saw ${perSecond}`);
    const starts = eutils.seen.map(row => row.start).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= NCBI_INTERVAL_MS.anonymous - 30, 'requests stay spaced');

    // Unchanged feeds reuse their results; "check again" asks NCBI again.
    const cached = (await app.inject({ method: 'POST', url: '/api/pubmed-checks', headers, payload: {} })).json();
    assert.deepEqual([cached.state, cached.entries.every((entry: { cached: boolean }) => entry.cached)], ['done', true]);
    assert.equal(eutils.seen.length, feeds.length);
    // A renamed feed is checked again.
    store.setChannelTitle(feeds[0].id, '(q0[Title]) renamed');
    const partly = (await app.inject({ method: 'POST', url: '/api/pubmed-checks', headers, payload: {} })).json();
    assert.equal(partly.entries.filter((entry: { cached?: boolean }) => !entry.cached).length, 1);
    await wait(() => store.pubmedChecks.job(partly.id)!.state === 'done', 'the renamed feed is checked');
    const recheck = (await app.inject({ method: 'POST', url: '/api/pubmed-checks', headers, payload: { recheck: true } })).json();
    assert.equal(recheck.state, 'running');
    await wait(() => store.pubmedChecks.job(recheck.id)!.state === 'done', 'the recheck finishes');
    assert.equal(eutils.seen.length, feeds.length * 2 + 1);
  } finally { await app.close(); store.close(); await eutils.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('批量验证：重启后继续；可以取消和重试失败项；验证中途即可转换已验证的，转换可重复调用', async () => {
  const eutils = await startEutils(400);
  const dir = mkdtempSync(join(tmpdir(), 'fl-pubmed-jobs-')), store = new Store(dir);
  let { app, headers } = await open(dir, store, eutils);
  try {
    const feeds = seed(store, 8);
    const job = (await app.inject({ method: 'POST', url: '/api/pubmed-checks', headers, payload: {} })).json();
    // Convert the first verified feeds while the others are still being checked.
    await wait(() => store.pubmedChecks.job(job.id)!.entries.some(entry => entry.state === 'done'), 'a first result');
    const early = store.pubmedChecks.job(job.id)!.entries.filter(entry => entry.state === 'done').map(entry => entry.feedId);
    const converted = await app.inject({ method: 'POST', url: `/api/pubmed-checks/${job.id}/convert`, headers, payload: { feedIds: early } });
    assert.equal(converted.statusCode, 200, converted.body);
    assert.ok(converted.json().results.every((result: { ok: boolean }) => result.ok));
    assert.equal(converted.json().job.state, 'running');
    for (const id of early) assert.equal(store.getFeed(id)!.sourceType, 'pubmed');
    // Conversion keeps each feed's own name unless renaming was asked for.
    for (const id of early) assert.equal(store.getFeed(id)!.name, feeds.find(feed => feed.id === id)!.name);
    // Converting again is safe.
    assert.ok((await app.inject({ method: 'POST', url: `/api/pubmed-checks/${job.id}/convert`, headers, payload: { feedIds: early } })).json().results.every((result: { ok: boolean }) => result.ok));

    // The service stops mid-way; the job continues where it was after a restart.
    await app.close();
    assert.equal(store.pubmedChecks.job(job.id)!.state, 'running');
    ({ app, headers } = await open(dir, store, eutils));
    await wait(() => store.pubmedChecks.job(job.id)!.state === 'done', 'the job resumes after a restart');
    const after = store.pubmedChecks.job(job.id)!;
    assert.ok(after.entries.every(entry => entry.state === 'done' || entry.state === 'converted'));

    // Cancel stops what is queued; retry checks it again.
    const second = (await app.inject({ method: 'POST', url: '/api/pubmed-checks', headers, payload: { recheck: true } })).json();
    const canceled = (await app.inject({ method: 'POST', url: `/api/pubmed-checks/${second.id}/cancel`, headers, payload: {} })).json();
    await wait(() => store.pubmedChecks.job(second.id)!.state !== 'running', 'the job stops');
    const stopped = store.pubmedChecks.job(second.id)!;
    assert.equal(stopped.state, 'canceled');
    assert.ok(stopped.entries.some(entry => entry.state === 'canceled'), JSON.stringify(canceled.progress));
    const retried = (await app.inject({ method: 'POST', url: `/api/pubmed-checks/${second.id}/retry`, headers, payload: {} })).json();
    assert.equal(retried.state, 'running');
    await wait(() => store.pubmedChecks.job(second.id)!.state === 'done', 'the retried job finishes');
    // Feeds converted meanwhile fail with a clear reason; the rest are checked.
    const finished = (await app.inject({ url: `/api/pubmed-checks/${second.id}`, headers })).json();
    assert.equal(finished.entries.filter((entry: { state: string }) => entry.state === 'done').length, feeds.length - early.length);
    assert.ok(finished.entries.filter((entry: { state: string }) => entry.state === 'failed').every((entry: { error: string }) => /不是 PubMed RSS/.test(entry.error)));
    // An unknown job (or another account's) is not found.
    assert.equal((await app.inject({ url: '/api/pubmed-checks/pmc_unknown', headers })).statusCode, 404);
  } finally { await app.close(); store.close(); await eutils.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('NCBI 设置测试：按 NCBI 的实际返回区分有效、无效、格式不对、限流、网络不通和其他错误；Key 不回显', async () => {
  let reply: { status: number; body: string; limit?: string } = { status: 200, body: '{"esearchresult":{"count":"1","idlist":[]}}', limit: '10' };
  const keys: string[] = [];
  const eutils = await startTarget((request: IncomingMessage, response: ServerResponse) => {
    keys.push(new URL(request.url ?? '/', 'http://fixture').searchParams.get('api_key') ?? '');
    response.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.limit ? { 'x-ratelimit-limit': reply.limit } : {}) });
    response.end(reply.body);
  });
  const dir = mkdtempSync(join(tmpdir(), 'fl-ncbi-test-')), store = new Store(dir);
  const { app, headers } = await open(dir, store, { host: eutils.host, endpoint: `http://${eutils.host}/entrez/eutils` });
  const run = async (payload: Record<string, unknown>) => { const response = await app.inject({ method: 'POST', url: '/api/settings/ncbi/test', headers, payload }); assert.equal(response.statusCode, 200, response.body); assert.ok(!response.body.includes('abc123secretKEY')); return response.json(); };
  try {
    const valid = await run({ apiKey: 'abc123secretKEY', email: 'admin@example.org' });
    assert.deepEqual([valid.result, valid.rateLimit, valid.email], ['valid', 10, 'ok']);
    assert.equal(keys.at(-1), 'abc123secretKEY');
    reply = { status: 200, body: '{"esearchresult":{"count":"1","idlist":[]}}', limit: '3' };
    assert.deepEqual(Object.values((({ result, rateLimit, email }) => ({ result, rateLimit, email }))(await run({ apiKey: null, email: '' }))), ['noKey', 3, 'missing']);
    assert.equal(keys.at(-1), '', 'no api_key is sent when testing without a key');
    reply = { status: 400, body: '{"error":"API key invalid","api-key":"abc123secretKEY","type":"invalid",\n"status":"unknown"}', limit: '3' };
    const invalid = await run({ apiKey: 'abc123secretKEY', email: 'not-an-email' });
    assert.deepEqual([invalid.result, invalid.detail, invalid.email], ['invalidKey', 'API key invalid', 'invalid']);
    reply = { status: 400, body: '{"error":"API key not wellformed","api-key":"abc123secretKEY","type":"api-key-fake",\n"status":"unknown"}' };
    assert.deepEqual(((test: { result: string; detail: string }) => [test.result, test.detail])(await run({ apiKey: 'abc123secretKEY' })), ['badFormat', 'API key not wellformed']);
    // Checked locally before anything is sent.
    const sent = keys.length;
    assert.equal((await run({ apiKey: 'has spaces!' })).result, 'badFormat');
    assert.equal(keys.length, sent);
    reply = { status: 429, body: '{"error":"API rate limit exceeded"}', limit: '3' };
    assert.equal((await run({ apiKey: 'abc123secretKEY' })).result, 'rateLimited');
    reply = { status: 502, body: '{"error":"Backend down"}' };
    assert.deepEqual(((test: { result: string; detail: string }) => [test.result, test.detail])(await run({ apiKey: 'abc123secretKEY' })), ['error', 'Backend down']);
    reply = { status: 500, body: 'not json' };
    assert.deepEqual(((test: { result: string; detail: string }) => [test.result, test.detail])(await run({ apiKey: 'abc123secretKEY' })), ['error', 'HTTP 500']);

    // The saved key's last test is shown with the settings, never the key itself.
    reply = { status: 200, body: '{"esearchresult":{"count":"1","idlist":[]}}', limit: '10' };
    await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { ncbi: { apiKey: 'abc123secretKEY' } } });
    assert.deepEqual((await app.inject({ url: '/api/settings/ncbi/status', headers })).json().lastTest.result, 'error');
    await run({});
    const status = await app.inject({ url: '/api/settings/ncbi/status', headers });
    assert.deepEqual([status.json().apiKeyConfigured, status.json().lastTest.result, status.json().lastTest.rateLimit], [true, 'valid', 10]);
    assert.ok(!status.body.includes('abc123secretKEY'));
    // Testing another key doesn't change what is shown for the saved one.
    await run({ apiKey: 'otherKey9' });
    assert.equal((await app.inject({ url: '/api/settings/ncbi/status', headers })).json().lastTest, undefined);
  } finally { await app.close(); store.close(); await eutils.close(); rmSync(dir, { recursive: true, force: true }); }

  // NCBI can't be reached.
  const dir2 = mkdtempSync(join(tmpdir(), 'fl-ncbi-test-')), store2 = new Store(dir2);
  const port = await closedPort();
  const offline = await open(dir2, store2, { host: `127.0.0.1:${port}`, endpoint: `http://127.0.0.1:${port}/entrez/eutils` });
  try {
    const test = (await offline.app.inject({ method: 'POST', url: '/api/settings/ncbi/test', headers: offline.headers, payload: { apiKey: 'abc123', email: '' } })).json();
    assert.equal(test.result, 'network');
    assert.ok(test.detail);
  } finally { await offline.app.close(); store2.close(); rmSync(dir2, { recursive: true, force: true }); }
});
