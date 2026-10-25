import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ImportJobInput } from './client.js';
import { FeedLanternClient } from './client.js';
import type { McpLaunch } from './cli.js';
import { asFeedLanternError, usageError } from './errors.js';
import { t } from './messages.js';
import * as ops from './operations.js';
import { CLI_VERSION } from './version.js';

/**
 * The CLI's operations as MCP tools over stdio. Tool results are the same JSON
 * the CLI prints; failures come back as `isError` results carrying the same
 * structured error (`code`, `status`, `message`, `hint`).
 */

const d = (key: string) => t(`mcp.param.${key}`);

const rulesShape = {
  item: z.string().min(1).describe(d('rules.item')),
  title: z.string().min(1).describe(d('rules.title')),
  link: z.string().min(1).describe(d('rules.link')),
  description: z.string().optional().describe(d('rules.description')),
  image: z.string().optional().describe(d('rules.image')),
  date: z.string().optional().describe(d('rules.date')),
};
const rules = z.object(rulesShape).describe(d('rules'));
const partialRules = z.object(rulesShape).partial().describe(d('partialRules'));
const pagination = z.object({
  mode: z.enum(['next', 'template', 'loadMore']),
  maxPages: z.number().int().min(1).max(10),
  delayMs: z.number().int().min(2000).max(30000),
  nextSelector: z.string().optional(),
  urlTemplate: z.string().optional(),
  start: z.number().int().optional(),
  step: z.number().int().optional(),
}).describe(d('pagination'));
const page = {
  waitMs: z.number().int().min(0).max(10000).optional().describe(d('waitMs')),
  waitForSelector: z.string().optional().describe(d('waitForSelector')),
  credentialId: z.string().optional().describe(d('credentialId')),
  networkProfileId: z.string().optional().describe(d('networkProfileId')),
};
const id = z.string().min(1).describe(d('feedId'));
const dryRun = z.boolean().optional().describe(d('dryRun'));
const confirm = z.boolean().optional().describe(d('confirm'));
const translationMode = z.enum(['original', 'translated', 'bilingual']).optional().describe(d('translationMode'));
const targetLanguage = z.enum(['zh-CN', 'zh-TW', 'en', 'ja', 'ko']).optional();
const translationProvider = z.enum(['google', 'deepl', 'openai']).nullable().optional();
const pubmedConditions = {
  query: z.string().min(1).max(4000).optional().describe(d('pubmedQuery')),
  conditions: z.array(z.object({
    field: z.enum(['all', 'tiab', 'title', 'author', 'firstAuthor', 'lastAuthor', 'journal', 'affiliation', 'mesh', 'pubType', 'language', 'nlmId']).describe(d('pubmedField')),
    term: z.string().min(1).max(500), op: z.enum(['AND', 'OR', 'NOT']).optional().describe(d('pubmedOp')), phrase: z.boolean().optional().describe(d('pubmedPhrase')),
  })).max(20).optional().describe(d('pubmedConditions')),
  filters: z.object({
    days: z.number().int().min(1).max(36500).optional(), from: z.string().regex(/^\d{4}(\/\d{1,2}(\/\d{1,2})?)?$/).optional(), to: z.string().regex(/^\d{4}(\/\d{1,2}(\/\d{1,2})?)?$/).optional(),
    hasAbstract: z.boolean().optional(), types: z.array(z.enum(['Review', 'Systematic Review', 'Meta-Analysis', 'Clinical Trial', 'Randomized Controlled Trial', 'Case Reports'])).optional(),
  }).optional().describe(d('pubmedFilters')),
};
const itemFilter = z.object({ include: z.array(z.string()), exclude: z.array(z.string()), regex: z.boolean() }).nullable().optional().describe(d('itemFilter'));

const read: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const fetches: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
const write: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const idempotent: ToolAnnotations = { ...write, idempotentHint: true };
const destructive: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

interface ToolDef {
  name: string;
  /** Token scope the tool needs; `read` tools are the only ones served with `--read-only`. */
  scope: 'read' | 'write';
  annotations: ToolAnnotations;
  input: z.ZodRawShape;
  /** Destructive: refused unless `confirm: true` (or `dryRun: true`). */
  confirm?: (args: Record<string, unknown>) => boolean;
  run(client: FeedLanternClient, args: Record<string, unknown>): Promise<unknown>;
}

const s = (value: unknown) => value as string;

const tools: ToolDef[] = [
  { name: 'whoami', scope: 'read', annotations: read, input: {}, run: client => ops.whoami(client) },
  { name: 'health', scope: 'read', annotations: read, input: {}, run: client => ops.health(client) },
  {
    name: 'feeds_list', scope: 'read', annotations: read, input: { status: z.enum(['active', 'paused', 'failing', 'warning']).optional().describe(d('feedStatus')) },
    run: (client, args) => ops.listFeeds(client, args.status as ops.FeedListFilter | undefined),
  },
  { name: 'feed_get', scope: 'read', annotations: read, input: { id }, run: (client, args) => ops.getFeed(client, s(args.id)) },
  {
    name: 'feed_items', scope: 'read', annotations: read,
    input: { id, limit: z.number().int().min(1).max(1000).optional().describe(d('limit')), status: z.enum(['published', 'untranslated', 'excluded', 'not-included', 'over-limit']).optional().describe(d('outputStatus')) },
    run: (client, args) => ops.feedItems(client, s(args.id), { limit: args.limit as number | undefined, status: args.status as never }),
  },
  {
    name: 'feed_logs', scope: 'read', annotations: read,
    input: { id, status: z.enum(['running', 'success', 'failure', 'interrupted']).optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional().describe(d('cursor')) },
    run: (client, args) => ops.feedLogs(client, s(args.id), { status: args.status as never, limit: args.limit as number | undefined, cursor: args.cursor as string | undefined }),
  },
  {
    name: 'detect_feed', scope: 'write', annotations: fetches,
    input: { url: z.string().url().describe(d('pageUrl')), samples: z.number().int().min(0).max(50).optional().describe(d('samples')), ...page },
    run: (client, args) => { const { url, ...rest } = args; return ops.detect(client, s(url), rest as never); },
  },
  {
    name: 'preview_rules', scope: 'write', annotations: fetches,
    input: {
      url: z.string().url().optional().describe(d('previewUrl')), feedId: z.string().optional().describe(d('previewFeed')),
      rules: partialRules, pagination: pagination.optional(), limit: z.number().int().min(1).max(1000).optional().describe(d('limit')), ...page,
    },
    async run(client, args) {
      if (!args.url === !args.feedId) throw usageError(t('usage.previewTarget'));
      const given = args.rules as Record<string, string | undefined>;
      if (args.url && (!given.item || !given.title || !given.link)) throw usageError(t('usage.missingRules'));
      return ops.previewRules(client, args as never);
    },
  },
  {
    name: 'rss_preview', scope: 'write', annotations: fetches, input: { url: z.string().url().describe(d('rssUrl')), networkProfileId: page.networkProfileId },
    run: (client, args) => ops.rssPreview(client, s(args.url), args.networkProfileId as string | undefined),
  },
  {
    name: 'pubmed_preview', scope: 'write', annotations: fetches, input: { ...pubmedConditions, networkProfileId: page.networkProfileId },
    run: (client, args) => { const { networkProfileId, ...search } = args; return ops.pubmedPreview(client, search as ops.PubmedSearchInput, networkProfileId as string | undefined); },
  },
  {
    name: 'pubmed_convert_check', scope: 'write', annotations: fetches,
    input: { feedIds: z.array(z.string().min(1)).max(1000).optional().describe(d('pubmedCheckIds')), recheck: z.boolean().optional().describe(d('pubmedRecheck')), waitSeconds: z.number().int().min(0).max(300).optional().describe(d('pubmedWait')) },
    run: (client, args) => ops.pubmedChecks(client, { feedIds: args.feedIds as string[] | undefined, recheck: args.recheck as boolean | undefined, waitMs: ((args.waitSeconds as number | undefined) ?? 0) * 1000 }),
  },
  {
    name: 'pubmed_check_status', scope: 'read', annotations: read,
    input: { jobId: z.string().optional().describe(d('pubmedJobId')), waitSeconds: z.number().int().min(0).max(300).optional().describe(d('pubmedWait')) },
    run: (client, args) => ops.pubmedCheckStatus(client, { jobId: args.jobId as string | undefined, waitMs: ((args.waitSeconds as number | undefined) ?? 0) * 1000 }),
  },
  {
    name: 'pubmed_convert_verified', scope: 'write', annotations: idempotent,
    input: { jobId: z.string().min(1).describe(d('pubmedJobId')), feedIds: z.array(z.string().min(1)).optional().describe(d('pubmedConvertIds')), confirm, dryRun },
    confirm: () => true,
    run: (client, args) => ops.pubmedConvertVerified(client, s(args.jobId), args.feedIds as string[] | undefined),
  },
  {
    name: 'pubmed_convert', scope: 'write', annotations: idempotent,
    input: { id, query: z.string().min(1).max(4000).describe(d('pubmedConvertQuery')), limit: z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]).optional().describe(d('pubmedLimit')), confirm, dryRun },
    confirm: () => true,
    run: async (client, args) => { const payload = await client.pubmedConvert(s(args.id), s(args.query), args.limit as number | undefined); return client.dryRun ? ops.dryRunResult(client) : { converted: true, ...payload }; },
  },
  {
    name: 'pubmed_create', scope: 'write', annotations: write,
    input: {
      ...pubmedConditions, name: z.string().min(1).max(200).optional().describe(d('pubmedName')), limit: z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]).optional().describe(d('pubmedLimit')),
      intervalMinutes: z.number().int().min(5).max(1440).optional().describe(d('pubmedInterval')), translationMode, targetLanguage, translationProvider, networkProfileId: page.networkProfileId, dryRun,
    },
    run: (client, args) => { const { dryRun: _dryRun, ...input } = args; return ops.createPubmedFeed(client, input as ops.PubmedFeedInput); },
  },
  {
    name: 'feed_create', scope: 'write', annotations: write,
    input: {
      url: z.string().url().describe(d('feedUrl')), name: z.string().min(1).max(200).optional().describe(d('feedName')),
      sourceType: z.enum(['website', 'rss']).optional().describe(d('sourceType')), rules: rules.optional(),
      intervalMinutes: z.number().int().min(5).max(1440).optional().describe(d('interval')), pagination: pagination.nullable().optional(),
      translationMode, targetLanguage, translationProvider, ...page, dryRun,
    },
    async run(client, args) {
      const { dryRun: _dryRun, ...input } = args as Record<string, unknown> & { url: string; sourceType?: string; rules?: unknown };
      const rss = input.sourceType === 'rss';
      if (!rss && !input.rules) throw usageError(t('usage.missingRules'));
      return ops.createFeed(client, {
        ...input, name: (input.name as string | undefined) ?? new URL(input.url).hostname,
        rules: rss ? { item: '', title: '', link: '' } : input.rules, credentialId: (input.credentialId as string | undefined) ?? null,
        intervalMinutes: (input.intervalMinutes as number | undefined) ?? (rss ? 30 : 60), waitMs: (input.waitMs as number | undefined) ?? 1000,
      } as never);
    },
  },
  {
    name: 'feed_update', scope: 'write', annotations: write,
    input: {
      id,
      changes: z.object({
        name: z.string().min(1).max(200).optional(), url: z.string().url().optional(), rules: partialRules.optional(),
        pubmed: z.object({ query: z.string().min(1).max(4000), limit: z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]).optional() }).optional().describe(d('pubmedChange')),
        intervalMinutes: z.number().int().min(5).max(1440).optional(), pagination: pagination.nullable().optional(),
        waitMs: page.waitMs, waitForSelector: page.waitForSelector, credentialId: z.string().nullable().optional(), networkProfileId: z.string().nullable().optional(),
        translationMode, targetLanguage, translationProvider, itemFilter,
        outputLimit: z.number().int().min(10).max(500).optional(), retentionLimit: z.number().int().min(10).max(1000).nullable().optional().describe(d('retentionLimit')),
      }).describe(d('changes')),
      dryRun,
    },
    run: (client, args) => ops.updateFeed(client, s(args.id), args.changes as ops.FeedChanges),
  },
  { name: 'feed_delete', scope: 'write', annotations: destructive, input: { id, confirm, dryRun }, confirm: () => true, run: (client, args) => ops.deleteFeed(client, s(args.id)) },
  { name: 'feed_pause', scope: 'write', annotations: idempotent, input: { id, dryRun }, run: (client, args) => ops.setFeedEnabled(client, s(args.id), false) },
  { name: 'feed_resume', scope: 'write', annotations: idempotent, input: { id, dryRun }, run: (client, args) => ops.setFeedEnabled(client, s(args.id), true) },
  { name: 'feed_refresh', scope: 'write', annotations: write, input: { id, dryRun }, run: (client, args) => ops.refreshFeed(client, s(args.id)) },
  {
    name: 'feeds_bulk', scope: 'write', annotations: destructive,
    input: {
      action: z.enum(['copy', 'pause', 'resume', 'refresh', 'delete', 'settings']).describe(d('bulkAction')),
      ids: z.array(z.string().min(1)).min(1).max(200).describe(d('feedIds')),
      settings: z.object({
        translationMode, targetLanguage, translationProvider, itemFilter,
        intervalMinutes: z.number().int().min(5).max(1440).optional(), outputLimit: z.number().int().min(10).max(500).optional(), retentionLimit: z.number().int().min(10).max(1000).nullable().optional(),
      }).optional().describe(d('bulkSettings')),
      confirm, dryRun,
    },
    confirm: args => args.action === 'delete',
    run: (client, args) => ops.bulk(client, args.action as never, args.ids as string[], args.settings as never),
  },
  { name: 'bundles_list', scope: 'read', annotations: read, input: {}, run: client => ops.listBundles(client) },
  { name: 'bundle_get', scope: 'read', annotations: read, input: { id: z.string().min(1).describe(d('bundleId')) }, run: (client, args) => ops.getBundle(client, s(args.id)) },
  {
    name: 'bundle_create', scope: 'write', annotations: write,
    input: { name: z.string().min(1).max(200), feedIds: z.array(z.string()).max(200).describe(d('feedIds')), itemLimit: z.number().int().min(10).max(500).optional(), dryRun },
    run: (client, args) => { const { dryRun: _dryRun, ...input } = args; return ops.createBundle(client, input as never); },
  },
  {
    name: 'bundle_update', scope: 'write', annotations: write,
    input: {
      id: z.string().min(1).describe(d('bundleId')), name: z.string().min(1).max(200).optional(), feedIds: z.array(z.string()).max(200).optional().describe(d('bundleFeeds')),
      addFeedIds: z.array(z.string()).max(200).optional().describe(d('bundleAddFeeds')), itemLimit: z.number().int().min(10).max(500).optional(), dryRun,
    },
    run: (client, args) => { const { id: bundleId, dryRun: _dryRun, ...changes } = args; return ops.updateBundle(client, s(bundleId), changes as never); },
  },
  { name: 'bundle_delete', scope: 'write', annotations: destructive, input: { id: z.string().min(1).describe(d('bundleId')), confirm, dryRun }, confirm: () => true, run: (client, args) => ops.deleteBundle(client, s(args.id)) },
  { name: 'imports_list', scope: 'read', annotations: read, input: {}, run: client => ops.listImports(client) },
  {
    name: 'import_create', scope: 'write', annotations: write,
    input: {
      urls: z.array(z.string().url()).min(1).max(100).describe(d('importUrls')), sourceType: z.enum(['website', 'rss']).optional(),
      intervalMinutes: z.number().int().min(5).max(1440).optional(), translationMode: z.enum(['translated', 'bilingual']).optional(), targetLanguage, translationProvider,
      credentialId: page.credentialId, networkProfileId: page.networkProfileId, dryRun,
    },
    run(client, args) {
      const { urls, credentialId, networkProfileId, dryRun: _dryRun, ...rest } = args;
      const input: ImportJobInput = { ...rest, entries: (urls as string[]).map(url => ({ url, credentialId: (credentialId as string | undefined) ?? null, networkProfileId: (networkProfileId as string | undefined) ?? null })) };
      return ops.createImport(client, input);
    },
  },
  {
    name: 'token_logs', scope: 'read', annotations: read,
    input: { status: z.enum(['success', 'denied', 'error']).optional().describe(d('callStatus')), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional().describe(d('cursor')) },
    run: (client, args) => ops.tokenLogs(client, args as never),
  },
];

/** Names of every tool, in registration order (tests and docs check against this). */
export const toolNames = tools.map(tool => tool.name);

const text = (value: unknown, isError = false): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });

export function createMcpServer(launch: Omit<McpLaunch, 'warn'>): McpServer {
  const server = new McpServer({ name: 'feedlantern', version: CLI_VERSION }, { instructions: t('mcp.instructions') });
  for (const tool of tools) {
    if (launch.readOnly && tool.scope !== 'read') continue;
    server.registerTool(tool.name, {
      title: t(`mcp.tool.${tool.name}.title`),
      description: [t(`mcp.tool.${tool.name}`), tool.scope === 'write' ? t('mcp.needsWrite') : '', tool.confirm ? t('mcp.needsConfirm') : ''].filter(Boolean).join('\n\n'),
      inputSchema: tool.input,
      annotations: { title: t(`mcp.tool.${tool.name}.title`), ...tool.annotations },
    }, async (args: Record<string, unknown>) => {
      try {
        const dry = args.dryRun === true;
        if (tool.confirm?.(args) && args.confirm !== true && !dry) throw usageError(t('mcp.confirmRequired'));
        const client = new FeedLanternClient({ url: launch.connection.url, token: launch.connection.token, workspaceUser: launch.workspaceUser, timeoutMs: launch.timeoutMs, dryRun: dry });
        const result = await tool.run(client, args);
        return text(dry ? { dryRun: true, requests: client.planned, ...(client.planned.length ? {} : { result }) } : result);
      } catch (thrown) {
        return text({ error: asFeedLanternError(thrown).toJSON() }, true);
      }
    });
  }
  return server;
}

/** Serves on stdin/stdout until the client closes the connection. */
export async function serveStdio(launch: McpLaunch): Promise<void> {
  if (!launch.connection.url) launch.warn(t('config.noUrl'));
  else if (!launch.connection.token) launch.warn(t('config.noToken'));
  const server = createMcpServer(launch);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>(resolve => { server.server.onclose = resolve; });
  process.stdin.once('end', () => { void server.close(); });
  await server.connect(transport);
  await closed;
}
