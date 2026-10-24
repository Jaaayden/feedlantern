import { execFile } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test, expect } from './fixtures';
import { e2eBaseUrl, FIXTURE_URLS, STATIC_RULES, loginAsAdmin, protocolHeaders } from './support';

// The published bundle, built by `pnpm build` before the backend starts.
const BIN = path.resolve('packages/cli/dist/feedlantern.js');

function feedlantern(args: string[], env: Record<string, string>, stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string; json(): any; error(): any }> {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 120_000 }, (_error, stdout, stderr) => {
      resolve({ code: child.exitCode, stdout, stderr, json: () => JSON.parse(stdout), error: () => JSON.parse(stderr).error });
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

async function mcp(env: Record<string, string>) {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], env: { PATH: process.env.PATH ?? '', ...env }, stderr: 'pipe' }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: !!result.isError, body: JSON.parse(result.content[0].text) };
  };
  return { client, call };
}

test('Agent CLI 与 MCP server：detect → preview → create → refresh → logs/items，只读令牌与 --dry-run', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const auth = await loginAsAdmin(page.request), headers = protocolHeaders(auth.csrfToken);
  const mint = async (scope: 'read' | 'write') => {
    const response = await page.request.post('/api/tokens', { headers, data: { name: `agent-cli e2e ${scope}`, scope, expiresInDays: 1 } });
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as { token: { id: string }; secret: string };
  };
  const write = await mint('write'), read = await mint('read');
  const base = { FEEDLANTERN_URL: e2eBaseUrl, FEEDLANTERN_CONFIG: testInfo.outputPath('cli-config.json') };
  const writer = { ...base, FEEDLANTERN_TOKEN: write.secret }, reader = { ...base, FEEDLANTERN_TOKEN: read.secret };
  const feedIds: string[] = [];
  try {
    const health = await feedlantern(['health'], writer);
    expect(health.code, health.stderr).toBe(0);
    expect(health.json()).toMatchObject({ ok: true, compatible: true, token: { valid: true, scope: 'write' } });

    // 1. Detection in the real Chromium on the fixture page.
    const detected = await feedlantern(['detect', FIXTURE_URLS.static], writer);
    expect(detected.code, detected.stderr).toBe(0);
    const detection = detected.json();
    expect(detection.candidates.length).toBeGreaterThan(0);
    expect(detection.suggestion.rules.item).toBeTruthy();
    expect(detection.candidates[0].samples.length).toBeGreaterThan(0);

    // 2. Preview the rules an agent would tune.
    const preview = await feedlantern(['preview', '--url', FIXTURE_URLS.static, '--rules', JSON.stringify(STATIC_RULES), '--limit', '2'], writer);
    expect(preview.code, preview.stderr).toBe(0);
    const previewed = preview.json();
    expect(previewed.count).toBeGreaterThanOrEqual(3);
    expect(previewed.items).toHaveLength(2);
    expect(previewed.coverage.title).toBe(previewed.count);
    expect(previewed.coverage.link).toBe(previewed.count);

    // --dry-run creates nothing.
    const before = (await feedlantern(['feeds', 'list'], writer)).json().length;
    const dry = await feedlantern(['feeds', 'create', '--url', FIXTURE_URLS.static, '--name', 'Agent CLI dry', '--rules', JSON.stringify(STATIC_RULES), '--dry-run'], writer);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.json().requests[0]).toMatchObject({ method: 'POST', url: `${e2eBaseUrl}/api/feeds` });
    expect((await feedlantern(['feeds', 'list'], writer)).json()).toHaveLength(before);

    // 3. Create (fetches once), 4. refresh, then read logs and items.
    const created = await feedlantern(['feeds', 'create', '--url', FIXTURE_URLS.static, '--name', 'Agent CLI 验收', '--rules', JSON.stringify(STATIC_RULES), '--wait-ms', '0'], writer);
    expect(created.code, created.stderr).toBe(0);
    const id = created.json().feed.id as string;
    feedIds.push(id);
    expect(created.json().feed.itemCount).toBeGreaterThanOrEqual(3);
    const refreshed = await feedlantern(['feeds', 'refresh', id], writer);
    expect(refreshed.code, refreshed.stderr).toBe(0);
    expect(refreshed.json().ok).toBe(true);
    const logs = await feedlantern(['feeds', 'logs', id], writer);
    expect(logs.json().logs.map((log: { source: string }) => log.source)).toEqual(['manual', 'create']);
    const items = await feedlantern(['feeds', 'items', id, '--limit', '2', '--table'], writer);
    expect(items.code).toBe(0);
    expect(items.stdout).toMatch(/outputStatus/);

    // A read-only token is refused with code token_read_only and exit code 3; nothing changes.
    const denied = await feedlantern(['feeds', 'update', id, '--name', '改不了'], reader);
    expect(denied.code).toBe(3);
    expect(denied.error()).toMatchObject({ code: 'token_read_only', status: 403 });
    expect((await feedlantern(['feeds', 'get', id], reader)).json().feed.name).toBe('Agent CLI 验收');
    const own = await feedlantern(['tokens', 'logs', '--status', 'denied'], reader);
    expect(own.json().calls[0]).toMatchObject({ method: 'PATCH', route: '/api/feeds/:id', status: 403 });

    // The same operations as MCP tools over stdio.
    const agent = await mcp(writer);
    try {
      const tools = (await agent.client.listTools()).tools.map(tool => tool.name);
      expect(tools).toEqual(expect.arrayContaining(['detect_feed', 'preview_rules', 'feed_create', 'feed_refresh', 'feed_logs', 'feed_items']));
      const cards = await agent.call('detect_feed', { url: FIXTURE_URLS.divCards, samples: 1 });
      expect(cards.isError, JSON.stringify(cards.body)).toBe(false);
      expect(cards.body.candidates.length).toBeGreaterThan(0);
      const tuned = await agent.call('preview_rules', { feedId: id, rules: { description: '' } });
      expect(tuned.isError, JSON.stringify(tuned.body)).toBe(false);
      expect(tuned.body.coverage.description).toBe(0);
      expect(tuned.body.count).toBeGreaterThanOrEqual(3);
      const unconfirmed = await agent.call('feed_delete', { id });
      expect(unconfirmed).toMatchObject({ isError: true, body: { error: { code: 'usage' } } });
    } finally { await agent.client.close(); }
    const readOnlyAgent = await mcp(reader);
    try {
      const refused = await readOnlyAgent.call('feed_refresh', { id });
      expect(refused).toMatchObject({ isError: true, body: { error: { code: 'token_read_only', status: 403 } } });
    } finally { await readOnlyAgent.client.close(); }

    // Deleting needs --yes.
    expect((await feedlantern(['feeds', 'delete', id], writer)).code).toBe(2);
    const deleted = await feedlantern(['feeds', 'delete', id, '--yes'], writer);
    expect(deleted.code, deleted.stderr).toBe(0);
    feedIds.length = 0;
    expect((await feedlantern(['feeds', 'get', id], writer)).code).toBe(4);
  } finally {
    for (const id of feedIds) await page.request.delete(`/api/feeds/${encodeURIComponent(id)}`, { headers });
    for (const token of [write, read]) await page.request.delete(`/api/tokens/${encodeURIComponent(token.token.id)}`, { headers });
  }
});
