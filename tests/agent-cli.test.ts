import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import type { ExtractedItem, SelectionRules } from '../src/shared/types.js';
import { run, type Io } from '../packages/cli/src/cli.js';
import type { Connection } from '../packages/cli/src/config.js';
import { createMcpServer, toolNames } from '../packages/cli/src/mcp.js';
import { has, messageKeys } from '../packages/cli/src/messages.js';
import { CLI_VERSION } from '../packages/cli/src/version.js';

const PAGE = 'https://example.test/articles';
const RULES: SelectionRules = { item: 'article', title: 'h2', link: 'a', date: 'time' };
const items = (rules: SelectionRules): ExtractedItem[] => [1, 2, 3].map(n => ({
  title: `Story ${n}`, link: `https://example.test/story-${n}`, ...(rules.date ? { publishedAt: `2026-10-0${n}T00:00:00.000Z`, publishedAtSource: 'absolute' as const } : {}),
}));
const frame = (id: string) => ({ sessionId: id, image: '', width: 1, height: 1, viewportHeight: 1, documentHeight: 1, url: PAGE, title: 'Example articles' });
const opened = new Set<string>();
const browser: BrowserServiceLike = {
  open: async () => { const id = randomUUID(); opened.add(id); return frame(id); },
  snapshot: async id => frame(id),
  async scroll(id) { return this.snapshot(id); }, async click(id) { return this.snapshot(id); },
  pick: async () => ({ selector: 'article', rects: [], count: 3, sampleText: '' }),
  extract: async (_id, rules) => items(rules),
  scrape: async options => items(options.rules),
  detect: async () => ({
    recommendedId: 'c1', warnings: [],
    candidates: [{ id: 'c1', label: '文章列表', rules: RULES, confidence: 'high', score: 0.9, count: 3, items: items(RULES), rects: [], warnings: [] }],
  }),
  close: async id => { opened.delete(id); }, dispose: async () => {},
};

interface Result { code: number; stdout: string; stderr: string; json(): any; error(): any }

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fl-agent-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const alice = store.createUser('alice', 'alice-password');
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const write = store.tokens.create(alice.id, { name: 'agent', scope: 'write', expiresAt: null });
  const read = store.tokens.create(alice.id, { name: 'reader', scope: 'read', expiresAt: null });
  const configFile = join(dir, 'cli', 'config.json');
  const baseEnv = { FEEDLANTERN_CONFIG: configFile, FEEDLANTERN_URL: url };
  const cli = async (args: string[], env: Record<string, string | undefined> = { FEEDLANTERN_TOKEN: write.secret }, stdin = ''): Promise<Result> => {
    const out: string[] = [], err: string[] = [];
    const io: Io = { stdout: text => out.push(text), stderr: text => err.push(text), env: { ...baseEnv, ...env }, readStdin: async () => stdin };
    const code = await run(args, io);
    return { code, stdout: out.join('\n'), stderr: err.join('\n'), json: () => JSON.parse(out.join('\n')), error: () => JSON.parse(err.join('\n')).error };
  };
  return {
    dir, store, app, url, alice, write: write.secret, read: read.secret, configFile, cli,
    close: async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('CLI 覆盖订阅的完整生命周期，默认输出可解析的 JSON', async () => {
  const t = await setup();
  try {
    const who = await t.cli(['whoami']);
    assert.equal(who.code, 0, who.stderr);
    assert.equal(who.json().user.username, 'alice');
    assert.equal(who.json().token.scope, 'write');
    assert.equal(who.json().token.name, 'agent');
    assert.equal(who.json().compatible, true);
    const health = await t.cli(['health']);
    assert.equal(health.code, 0, health.stderr);
    assert.deepEqual([health.json().ok, health.json().token.valid, health.json().compatible], [true, true, true]);
    assert.ok(health.json().serverVersion.startsWith(CLI_VERSION));

    const created = await t.cli(['feeds', 'create', '--url', PAGE, '--name', '示例', '--rules', JSON.stringify(RULES), '--interval', '120']);
    assert.equal(created.code, 0, created.stderr);
    const feed = created.json().feed;
    assert.equal(feed.name, '示例');
    assert.equal(feed.itemCount, 3);
    assert.match(created.json().feedUrls.atom, /\.atom$/);
    const id = feed.id as string;

    const listed = await t.cli(['feeds', 'list']);
    assert.deepEqual(listed.json().map((entry: { id: string }) => entry.id), [id]);
    const table = await t.cli(['feeds', 'list', '--table']);
    assert.match(table.stdout, /^id\s+name/);
    assert.match(table.stdout, /示例/);
    assert.equal((await t.cli(['feeds', 'get', id])).json().storedItems, 3);

    // Only output settings: PATCH, the rules stay.
    const renamed = await t.cli(['feeds', 'update', id, '--name', '改名', '--output-limit', '50']);
    assert.equal(renamed.code, 0, renamed.stderr);
    assert.deepEqual([renamed.json().feed.name, renamed.json().feed.outputLimit, renamed.json().feed.rules.date], ['改名', 50, 'time']);
    // A rule change merges into the saved rules and refetches; "" removes a rule.
    const rules = await t.cli(['feeds', 'update', id, '--title', 'h3', '--date', '']);
    assert.equal(rules.code, 0, rules.stderr);
    assert.deepEqual(rules.json().feed.rules, { item: 'article', title: 'h3', link: 'a' });
    assert.equal(rules.json().feed.name, '改名');

    assert.equal((await t.cli(['feeds', 'pause', id])).json().changed, true);
    const again = await t.cli(['feeds', 'pause', id]);
    assert.deepEqual([again.json().changed, again.json().feed.enabled], [false, false]);
    assert.equal((await t.cli(['feeds', 'resume', id])).json().feed.enabled, true);
    const refreshed = await t.cli(['feeds', 'refresh', id]);
    assert.deepEqual([refreshed.code, refreshed.json().ok], [0, true]);

    const itemList = await t.cli(['feeds', 'items', id, '--limit', '2']);
    assert.deepEqual([itemList.json().total, itemList.json().returned], [3, 2]);
    assert.equal(itemList.json().items[0].outputStatus, 'published');
    const logs = await t.cli(['feeds', 'logs', id, '--status', 'success']);
    assert.ok(logs.json().logs.length >= 3);
    assert.ok(logs.json().logs.every((log: { status: string }) => log.status === 'success'));

    // Deleting needs --yes; --dry-run shows the request and changes nothing.
    const unconfirmed = await t.cli(['feeds', 'delete', id]);
    assert.deepEqual([unconfirmed.code, unconfirmed.error().code], [2, 'usage']);
    const dry = await t.cli(['feeds', 'delete', id, '--dry-run']);
    assert.equal(dry.code, 0);
    assert.deepEqual(dry.json().requests.map((r: { method: string; url: string }) => [r.method, r.url]), [['DELETE', `${t.url}/api/feeds/${id}`]]);
    assert.ok(t.store.getFeed(id));
    const deleted = await t.cli(['feeds', 'delete', id, '--yes']);
    assert.deepEqual([deleted.code, deleted.json()], [0, { ok: true }]);
    assert.equal(t.store.getFeed(id), null);
    const missing = await t.cli(['feeds', 'get', id]);
    assert.deepEqual([missing.code, missing.error().code, missing.error().status], [4, 'not_found', 404]);
  } finally { await t.close(); }
});

test('--dry-run 只打印请求，不产生副作用，也不泄露令牌', async () => {
  const t = await setup();
  try {
    const dry = await t.cli(['feeds', 'create', '--url', PAGE, '--item', 'article', '--title', 'h2', '--link', 'a', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    const [request] = dry.json().requests;
    assert.equal(dry.json().dryRun, true);
    assert.deepEqual([request.method, request.url, request.body.name, request.body.rules], ['POST', `${t.url}/api/feeds`, 'example.test', { item: 'article', title: 'h2', link: 'a' }]);
    assert.equal(request.headers.Authorization, 'Bearer fl_…');
    assert.ok(!dry.stdout.includes(t.write));
    assert.equal(t.store.listFeeds(t.alice.id).length, 0);
    // Detection opens no browser session in dry-run mode.
    const before = opened.size;
    const detect = await t.cli(['detect', PAGE, '--dry-run']);
    assert.deepEqual(detect.json().requests.map((r: { method: string }) => r.method), ['POST', 'POST', 'DELETE']);
    assert.equal(opened.size, before);
    // A read-only token may dry-run a write: nothing is sent, so nothing is denied.
    assert.equal((await t.cli(['bundles', 'create', '--name', 'x', '--dry-run'], { FEEDLANTERN_TOKEN: t.read })).code, 0);
    assert.equal(t.store.bundles.list(t.alice.id).length, 0);
  } finally { await t.close(); }
});

test('只读令牌写操作返回 token_read_only 和退出码 3，其他错误各有退出码', async () => {
  const t = await setup();
  try {
    const reader = { FEEDLANTERN_TOKEN: t.read };
    assert.equal((await t.cli(['feeds', 'list'], reader)).code, 0);
    const denied = await t.cli(['feeds', 'create', '--url', PAGE, '--rules', JSON.stringify(RULES)], reader);
    assert.equal(denied.code, 3);
    assert.equal(denied.stdout, '');
    assert.deepEqual([denied.error().code, denied.error().status, denied.error().method, denied.error().path], ['token_read_only', 403, 'POST', '/api/feeds']);
    assert.match(denied.error().hint, /write 令牌/);
    assert.equal(t.store.listFeeds(t.alice.id).length, 0);
    assert.equal((await t.cli(['detect', PAGE], reader)).error().code, 'token_read_only');
    const table = await t.cli(['bulk', 'pause', 'x', '--table'], reader);
    assert.match(table.stderr, /token_read_only/);

    const invalid = await t.cli(['feeds', 'list'], { FEEDLANTERN_TOKEN: `fl_${'a'.repeat(43)}` });
    assert.deepEqual([invalid.code, invalid.error().code], [3, 'unauthorized']);
    const noToken = await t.cli(['whoami'], {});
    assert.deepEqual([noToken.code, noToken.error().code], [2, 'not_configured']);
    const offline = await t.cli(['feeds', 'list'], { FEEDLANTERN_TOKEN: t.write, FEEDLANTERN_URL: 'http://127.0.0.1:9' });
    assert.deepEqual([offline.code, offline.error().code], [6, 'network']);
    const badInput = await t.cli(['feeds', 'create', '--url', PAGE, '--rules', '{oops']);
    assert.deepEqual([badInput.code, badInput.error().code], [2, 'usage']);
    const rejected = await t.cli(['feeds', 'create', '--url', PAGE, '--rules', JSON.stringify(RULES), '--data', '{"waitMs":99999}']);
    assert.deepEqual([rejected.code, rejected.error().code, rejected.error().status], [4, 'validation', 400]);
    assert.equal((await t.cli(['feeds', 'nope'])).code, 2);
    assert.equal((await t.cli(['feeds', 'get'])).code, 2);
    assert.equal((await t.cli(['feeds', 'list', '--bogus'])).code, 2);
    assert.match((await t.cli(['help', 'preview'])).stdout, /--feed/);

    // The token's own call log shows the denied call.
    const calls = await t.cli(['tokens', 'logs', '--status', 'denied'], reader);
    assert.equal(calls.code, 0, calls.stderr);
    assert.ok(calls.json().calls.some((call: { route: string; status: number }) => call.route === '/api/feeds' && call.status === 403));
  } finally { await t.close(); }
});

test('detect 返回候选和可直接创建的建议，preview 报告字段覆盖并释放浏览器会话', async () => {
  const t = await setup();
  try {
    const detected = await t.cli(['detect', PAGE, '--samples', '1']);
    assert.equal(detected.code, 0, detected.stderr);
    const result = detected.json();
    assert.equal(result.recommendedId, 'c1');
    assert.equal(result.candidates[0].samples.length, 1);
    assert.deepEqual(result.candidates[0].coverage, { items: 3, title: 3, link: 3, description: 0, image: 0, date: 3, duplicateLinks: 0 });
    assert.deepEqual(result.suggestion, { name: 'Example articles', url: PAGE, rules: RULES });
    assert.equal(opened.size, 0);

    const preview = await t.cli(['preview', '--url', PAGE, '--rules', JSON.stringify({ item: 'article', title: 'h2', link: 'a' }), '--limit', '2']);
    assert.equal(preview.code, 0, preview.stderr);
    assert.deepEqual([preview.json().count, preview.json().items.length, preview.json().coverage.date], [3, 2, 0]);
    assert.equal(opened.size, 0);
    assert.equal((await t.cli(['preview', '--url', PAGE, '--item', 'article'])).code, 2);

    // From a suggestion straight to a feed, then preview a tweak on its page.
    const created = await t.cli(['feeds', 'create', '--data', '-'], { FEEDLANTERN_TOKEN: t.write }, JSON.stringify(result.suggestion));
    assert.equal(created.code, 0, created.stderr);
    const onFeed = await t.cli(['preview', '--feed', created.json().feed.id, '--date', '']);
    assert.equal(onFeed.code, 0, onFeed.stderr);
    assert.deepEqual(onFeed.json().rules, { item: 'article', title: 'h2', link: 'a' });
  } finally { await t.close(); }
});

test('聚合订阅、批量操作与部分失败的退出码', async () => {
  const t = await setup();
  try {
    const a = t.store.createFeed({ name: 'a', url: PAGE, rules: RULES, credentialId: null, intervalMinutes: 60, waitMs: 0 }, t.alice.id).feed;
    const b = t.store.createFeed({ name: 'b', url: PAGE, rules: RULES, credentialId: null, intervalMinutes: 60, waitMs: 0 }, t.alice.id).feed;
    const created = await t.cli(['bundles', 'create', '--name', '合集', '--feeds', a.id]);
    assert.equal(created.code, 0, created.stderr);
    const bundleId = created.json().bundle.id;
    assert.deepEqual((await t.cli(['bundles', 'update', bundleId, '--add-feeds', b.id, '--item-limit', '20'])).json().bundle.feedIds, [a.id, b.id]);
    assert.equal((await t.cli(['bundles', 'get', bundleId])).json().bundle.itemLimit, 20);
    assert.equal((await t.cli(['bundles', 'list'])).json().length, 1);
    assert.equal((await t.cli(['bundles', 'delete', bundleId])).code, 2);
    assert.equal((await t.cli(['bundles', 'delete', bundleId, '-y'])).code, 0);

    const paused = await t.cli(['bulk', 'pause', a.id, b.id]);
    assert.deepEqual([paused.code, paused.json().succeeded, paused.json().failed], [0, 2, 0]);
    assert.equal(t.store.getFeed(a.id)!.enabled, false);
    const partial = await t.cli(['bulk', 'resume', a.id, 'missing']);
    assert.deepEqual([partial.code, partial.json().failed], [7, 1]);
    assert.equal((await t.cli(['bulk', 'delete', a.id])).code, 2);
    const settings = await t.cli(['bulk', 'settings', a.id, b.id, '--settings', '{"intervalMinutes":240}']);
    assert.equal(settings.code, 0, settings.stderr);
    assert.equal(t.store.getFeed(b.id)!.intervalMinutes, 240);
    const raw = await t.cli(['api', 'GET', `/api/feeds/${a.id}/logs`, '--query', 'limit=1']);
    assert.equal(raw.code, 0, raw.stderr);
    assert.ok(Array.isArray(raw.json().logs));
  } finally { await t.close(); }
});

test('login 校验令牌并以 0600 权限写入配置文件，之后的命令直接使用', async () => {
  const t = await setup();
  try {
    const saved = await t.cli(['login', '--server', t.url, '--token-stdin', '--profile', 'test'], {}, `${t.read}\n`);
    assert.equal(saved.code, 0, saved.stderr);
    assert.deepEqual([saved.json().profile, saved.json().tokenScope, saved.json().username], ['test', 'read', 'alice']);
    if (process.platform !== 'win32') assert.equal(statSync(t.configFile).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(t.configFile, 'utf8')).profiles.test.token, t.read);
    assert.deepEqual(await readdir(join(t.dir, 'cli')), ['config.json']);

    const env = { FEEDLANTERN_URL: undefined };
    const who = await t.cli(['whoami', '--profile', 'test'], env);
    assert.equal(who.code, 0, who.stderr);
    assert.equal(who.json().token.scope, 'read');
    // The first saved profile becomes the default.
    assert.equal((await t.cli(['whoami'], env)).json().user.username, 'alice');
    const shown = await t.cli(['config'], env);
    assert.deepEqual([shown.json().serverSource, shown.json().tokenSource, shown.json().token], ['config', 'config', `${t.read.slice(0, 11)}…`]);
    assert.ok(!shown.stdout.includes(t.read));

    assert.equal((await t.cli(['login', '--server', t.url, '--token-stdin'], {}, 'not-a-token')).code, 2);
    assert.equal((await t.cli(['login', '--server', t.url, '--token-stdin'], {}, `fl_${'b'.repeat(43)}`)).code, 3);
    assert.equal((await t.cli(['logout', '--profile', 'test'], env)).json().removed, true);
    assert.equal((await t.cli(['whoami', '--profile', 'test'], env)).error().code, 'not_configured');
  } finally { await t.close(); }
});

const connection = (url: string, token: string): Connection => ({ url, token, profile: 'default', configPath: '', sources: { url: 'env', token: 'env' } });
async function mcpClient(launch: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(launch);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    return { isError: !!result.isError, body: JSON.parse(result.content[0].text) };
  };
  return { client, call, close: () => client.close() };
}

test('MCP 工具：写工具在只读令牌下返回清晰错误，危险操作需要 confirm，dryRun 不产生副作用', async () => {
  const t = await setup();
  const writer = await mcpClient({ connection: connection(t.url, t.write), readOnly: false });
  const reader = await mcpClient({ connection: connection(t.url, t.read), readOnly: false });
  const readOnly = await mcpClient({ connection: connection(t.url, t.read), readOnly: true });
  try {
    const { tools } = await writer.client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), toolNames);
    for (const tool of tools) assert.ok(tool.description && tool.description.length > 20 && !tool.description.includes('mcp.tool'), tool.name);
    assert.equal(tools.find(tool => tool.name === 'feed_delete')!.annotations?.destructiveHint, true);
    assert.equal(tools.find(tool => tool.name === 'feeds_list')!.annotations?.readOnlyHint, true);
    const readTools = (await readOnly.client.listTools()).tools.map(tool => tool.name);
    assert.ok(readTools.includes('feeds_list') && !readTools.includes('feed_create') && !readTools.includes('detect_feed'));

    assert.equal((await writer.call('whoami')).body.token.scope, 'write');
    const detected = await writer.call('detect_feed', { url: PAGE });
    assert.equal(detected.isError, false);
    const created = await writer.call('feed_create', detected.body.suggestion);
    assert.equal(created.isError, false, JSON.stringify(created.body));
    const id = created.body.feed.id as string;
    assert.equal((await writer.call('preview_rules', { feedId: id, rules: { title: 'h3' } })).body.rules.title, 'h3');
    assert.equal((await writer.call('feed_update', { id, changes: { intervalMinutes: 30 } })).body.feed.intervalMinutes, 30);
    assert.equal((await writer.call('feed_items', { id, limit: 1 })).body.items.length, 1);

    const denied = await reader.call('feed_refresh', { id });
    assert.equal(denied.isError, true);
    assert.deepEqual([denied.body.error.code, denied.body.error.status], ['token_read_only', 403]);
    assert.match(denied.body.error.hint, /write 令牌/);
    assert.equal((await reader.call('feeds_list')).body.length, 1);

    const unconfirmed = await writer.call('feed_delete', { id });
    assert.deepEqual([unconfirmed.isError, unconfirmed.body.error.code], [true, 'usage']);
    const dry = await writer.call('feed_delete', { id, dryRun: true });
    assert.deepEqual([dry.isError, dry.body.requests[0].method], [false, 'DELETE']);
    assert.ok(t.store.getFeed(id));
    const invalid = await writer.call('feed_create', { url: PAGE });
    assert.deepEqual([invalid.isError, invalid.body.error.code], [true, 'usage']);
    assert.equal((await writer.call('feed_delete', { id, confirm: true })).isError, false);
    assert.equal(t.store.getFeed(id), null);
    assert.equal((await writer.call('token_logs', { limit: 5 })).body.calls.length, 5);
  } finally { await writer.close(); await reader.close(); await readOnly.close(); await t.close(); }
});

test('通过 stdio 启动的 MCP server 与 CLI 进程返回约定的结果', { timeout: 60_000 }, async () => {
  const t = await setup();
  const env = { ...process.env, FEEDLANTERN_URL: t.url, FEEDLANTERN_TOKEN: t.read, FEEDLANTERN_CONFIG: t.configFile } as Record<string, string>;
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'packages/cli/src/bin.ts', 'mcp', '--read-only'], env, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'whoami', arguments: {} }) as { content: Array<{ text: string }> };
    assert.equal(JSON.parse(result.content[0].text).token.scope, 'read');
    assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'feed_create'));
  } finally { await client.close(); }
  try {
    const { execFile } = await import('node:child_process');
    const child = await new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
      const process_ = execFile(process.execPath, ['--import', 'tsx', 'packages/cli/src/bin.ts', 'bundles', 'create', '--name', 'x'], { env, encoding: 'utf8' }, (_error, stdout, stderr) => resolve({ status: process_.exitCode, stdout, stderr }));
    });
    assert.equal(child.status, 3, child.stderr);
    assert.equal(child.stdout, '');
    assert.equal(JSON.parse(child.stderr).error.code, 'token_read_only');
  } finally { await t.close(); }
});

test('CLI 与服务端版本号一致，所有消息集中在 messages 模块且无缺失', async () => {
  const root = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  assert.equal(CLI_VERSION, root.version, 'packages/cli/package.json 的版本应与服务端一致');
  const sources = (await readdir('packages/cli/src')).filter(name => name.endsWith('.ts') && name !== 'messages.ts');
  const used = new Set<string>();
  for (const name of sources) {
    const text = readFileSync(join('packages/cli/src', name), 'utf8');
    for (const [, key] of text.matchAll(/\bt\('([a-zA-Z][\w.-]*)'/g)) used.add(key);
    // No user-facing Chinese text outside the messages module.
    assert.ok(!/[一-鿿]/.test(text), `${name} 中有未集中到 messages.ts 的中文文案`);
  }
  for (const key of used) assert.ok(has(key), `缺少消息 ${key}`);
  for (const name of toolNames) assert.ok(has(`mcp.tool.${name}`) && has(`mcp.tool.${name}.title`), `缺少工具说明 ${name}`);
  const cli = readFileSync('packages/cli/src/cli.ts', 'utf8');
  for (const [, command] of cli.matchAll(/^\s*\{?\s*name: '([a-z ]+)'/gm)) assert.ok(has(`cmd.${command}`), `缺少命令说明 ${command}`);
  for (const [, option] of cli.matchAll(/'?([a-z][a-z-]*)'?: \{ type: '(?:string|boolean)'/g)) assert.ok(has(`opt.${option}`), `缺少选项说明 --${option}`);
  assert.ok(messageKeys().length > 100);
});
