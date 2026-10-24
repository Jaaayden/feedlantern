import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { run, type Io } from '../packages/cli/src/cli.js';
import { createMcpServer } from '../packages/cli/src/mcp.js';
import { pubmedSearchUrl } from '../src/shared/pubmed.js';
import { startTarget } from './proxy-fixtures.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/pubmed/${name}`, import.meta.url), 'utf8');
const browser = { dispose: async () => {}, scrape: async () => { throw Error('PubMed must not launch browser'); } } as unknown as BrowserServiceLike;

async function setup() {
  const terms: string[] = [];
  const eutils = await startTarget((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    if (url.pathname.endsWith('/esearch.fcgi')) { terms.push(url.searchParams.get('term') ?? ''); response.writeHead(200, { 'content-type': 'application/json' }); response.end(fixture('esearch-search.json')); return; }
    response.writeHead(200, { 'content-type': 'text/xml' }); response.end(fixture('efetch-journal.xml'));
  });
  const dir = mkdtempSync(join(tmpdir(), 'fl-agent-pubmed-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const alice = store.createUser('alice', 'alice-password');
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false, allowedHosts: [eutils.host], ncbiEndpoint: `http://${eutils.host}/entrez/eutils` });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const write = store.tokens.create(alice.id, { name: 'agent', scope: 'write', expiresAt: null }).secret;
  const read = store.tokens.create(alice.id, { name: 'reader', scope: 'read', expiresAt: null }).secret;
  const cli = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const io: Io = { stdout: text => out.push(text), stderr: text => err.push(text), env: { FEEDLANTERN_CONFIG: join(dir, 'config.json'), FEEDLANTERN_URL: url, FEEDLANTERN_TOKEN: write }, readStdin: async () => '' };
    const code = await run(args, io);
    return { code, stdout: out.join('\n'), stderr: err.join('\n'), json: () => JSON.parse(out.join('\n')), error: () => JSON.parse(err.join('\n')).error };
  };
  const mcp = async (token: string, readOnly = false) => {
    const server = createMcpServer({ connection: { url, token, profile: 'default', configPath: '', sources: { url: 'env', token: 'env' } }, readOnly });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: !!result.isError, body: JSON.parse(result.content[0].text) };
    };
    return { client, call };
  };
  return { store, terms, cli, mcp, write, read, close: async () => { await app.close(); store.close(); await eutils.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('CLI：pubmed preview 用检索条件或完整查询式预览，参数错误给出用法提示', async () => {
  const t = await setup();
  try {
    const built = await t.cli(['pubmed', 'preview', '--title-abstract', 'cryo-EM', '--affiliation', 'ShanghaiTech', '--days', '30', '--type', 'review']);
    assert.equal(built.code, 0, built.stderr);
    assert.equal(built.json().query, '(("cryo-EM"[Title/Abstract]) AND ("ShanghaiTech"[Affiliation])) AND ("last 30 days"[Date - Publication]) AND ("Review"[pt])');
    assert.equal(t.terms.at(-1), built.json().query);
    assert.equal(built.json().count, 172);
    assert.deepEqual(built.json().items.map((item: { pmid: string }) => item.pmid), ['42900001', '42883926', '41714066']);
    const table = await t.cli(['pubmed', 'preview', '--query', '"PLoS Pathog"[Journal]', '--table']);
    assert.equal(table.code, 0, table.stderr);
    assert.match(table.stdout, /^count\s+172$/m);
    assert.match(table.stdout, /^pmid\s+pubDate\s+journal\s+title/m);
    assert.match(table.stdout, /42883926\s+2026 Oct 6\s+PLoS Pathog\s+A Fixture virus/);

    const sent = t.terms.length;
    for (const args of [['pubmed', 'preview'], ['pubmed', 'preview', '--query', 'x', '--author', 'Zhang Y'], ['pubmed', 'preview', '--journal', 'Nature', '--type', 'Letter'], ['pubmed', 'preview', '--journal', 'Nature', '--from', '2020-01-01']]) {
      const usage = await t.cli(args);
      assert.deepEqual([usage.code, usage.error().code], [2, 'usage'], args.join(' '));
    }
    const invalid = await t.cli(['pubmed', 'preview', '--query', '("cryo-EM"[Title/Abstract]']);
    assert.deepEqual([invalid.code, invalid.error().code], [4, 'pubmed_query_invalid']);
    assert.match(invalid.error().hint, /PubMed 查询式无法发送/);
    assert.equal(t.terms.length, sent, 'nothing invalid reaches NCBI');
  } finally { await t.close(); }
});

test('CLI：pubmed create 保存检索订阅，dry-run 不创建；feeds update 修改查询式时保留篇数', async () => {
  const t = await setup();
  try {
    const dry = await t.cli(['pubmed', 'create', '--journal', 'PLoS Pathog', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.json().requests[0].body.sourceType, 'pubmed');
    assert.equal(t.store.listFeeds(t.store.listUsers().find(user => user.username === 'alice')!.id).length, 0);

    const created = await t.cli(['pubmed', 'create', '--journal', 'PLoS Pathog', '--has-abstract', '--limit', '50', '--translation', 'bilingual', '--interval', '180']);
    assert.equal(created.code, 0, created.stderr);
    const feed = created.json().feed;
    assert.deepEqual([feed.sourceType, feed.name, feed.translationMode, feed.intervalMinutes], ['pubmed', 'PubMed: PLoS Pathog', 'bilingual', 180]);
    assert.deepEqual(feed.pubmed, { query: '("PLoS Pathog"[Journal]) AND (hasabstract)', limit: 50 });
    assert.equal(feed.url, pubmedSearchUrl(feed.pubmed));
    assert.match(created.json().feedUrls.json, /\.json$/);
    assert.equal((await t.cli(['pubmed', 'create', '--journal', 'x', '--limit', '30'])).code, 2);

    const updated = await t.cli(['feeds', 'update', feed.id, '--data', JSON.stringify({ pubmed: { query: '"PLoS Pathog"[Journal] AND "last 7 days"[dp]' } })]);
    assert.equal(updated.code, 0, updated.stderr);
    assert.deepEqual(updated.json().feed.pubmed, { query: '"PLoS Pathog"[Journal] AND "last 7 days"[dp]', limit: 50 });
    assert.equal(updated.json().feed.id, feed.id);
  } finally { await t.close(); }
});

test('MCP：pubmed_preview / pubmed_create 支持条件或查询式，只读模式不提供', async () => {
  const t = await setup();
  const writer = await t.mcp(t.write), readOnly = await t.mcp(t.read, true);
  try {
    const names = (await writer.client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('pubmed_preview') && names.includes('pubmed_create'));
    assert.ok(!(await readOnly.client.listTools()).tools.some(tool => tool.name.startsWith('pubmed_')));
    const preview = await writer.call('pubmed_preview', { conditions: [{ field: 'author', term: 'Zhang Y' }, { field: 'lastAuthor', term: 'Li X', op: 'OR' }], filters: { hasAbstract: true } });
    assert.equal(preview.isError, false, JSON.stringify(preview.body));
    assert.equal(preview.body.query, '(("Zhang Y"[Author]) OR ("Li X"[Author - Last])) AND (hasabstract)');
    assert.equal(preview.body.items[0].journal, 'PLoS Pathog');
    const both = await writer.call('pubmed_preview', { query: 'x', conditions: [{ field: 'all', term: 'y' }] });
    assert.deepEqual([both.isError, both.body.error.code], [true, 'usage']);
    const created = await writer.call('pubmed_create', { query: '("cryo-EM"[Title/Abstract]) AND ("ShanghaiTech"[Affiliation])', name: 'Cryo-EM at ShanghaiTech', limit: 10 });
    assert.equal(created.isError, false, JSON.stringify(created.body));
    assert.deepEqual([created.body.feed.name, created.body.feed.pubmed.limit], ['Cryo-EM at ShanghaiTech', 10]);
    const dry = await writer.call('pubmed_create', { conditions: [{ field: 'journal', term: 'Nature' }], dryRun: true });
    assert.deepEqual([dry.isError, dry.body.requests[0].method, dry.body.requests[0].body.pubmed.query], [false, 'POST', '("Nature"[Journal])']);
  } finally { await writer.client.close(); await readOnly.client.close(); await t.close(); }
});
