import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { ApiTokenCallFilter, BulkFeedSettingsInput, FeedInput, FetchStatus, ItemFilter, ItemOutputStatus, PaginationRules, SelectionRules } from '../../../src/shared/types.js';
import { FeedLanternClient, type BulkAction, type HttpMethod, type ImportJobInput } from './client.js';
import { maskToken, readConfig, resolveConnection, writeConfig, type Connection, type Env } from './config.js';
import { asFeedLanternError, EXIT, FeedLanternError, usageError } from './errors.js';
import { has, t } from './messages.js';
import * as ops from './operations.js';
import { formatError, formatResult, type OutputMode, type TableSpec } from './output.js';
import { CLI_VERSION, compatibleWith } from './version.js';

/** Where the CLI reads and writes; tests pass their own. */
export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Env;
  /** All of standard input (for `-` arguments and `login --token-stdin`). */
  readStdin(): Promise<string>;
  /** Asks on the terminal without echoing; absent when stdin is not a terminal. */
  promptSecret?(question: string): Promise<string>;
  /** Runs the MCP server on stdio until the client disconnects. */
  serveMcp?(options: McpLaunch): Promise<void>;
}
export interface McpLaunch { connection: Connection; workspaceUser?: string; timeoutMs?: number; readOnly: boolean; warn(message: string): void }

type Option = { type: 'string' | 'boolean'; short?: string; multiple?: boolean };
type Values = Record<string, string | boolean | string[] | undefined>;

interface Context {
  args: Record<string, string | string[] | undefined>;
  opts: Values;
  io: Io;
  client(): Promise<FeedLanternClient>;
  connection(): Promise<Connection>;
  warn(message: string): void;
}

interface Command {
  name: string;
  /** Positional arguments: `id` required, `[url]` optional, `ids...` one or more. */
  args?: string[];
  options?: Record<string, Option>;
  /** Changes data: `--dry-run` prints the requests instead of sending them. */
  write?: boolean;
  /** Needs `--yes` (or `--dry-run`) because it cannot be undone. */
  confirm?: (ctx: Context) => boolean;
  table?: TableSpec;
  run(ctx: Context): Promise<unknown>;
}

const GLOBAL_OPTIONS: Record<string, Option> = {
  server: { type: 'string' }, profile: { type: 'string' }, workspace: { type: 'string' }, timeout: { type: 'string' },
  pretty: { type: 'boolean' }, table: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
};
const RULE_OPTIONS: Record<string, Option> = {
  rules: { type: 'string' }, item: { type: 'string' }, title: { type: 'string' }, link: { type: 'string' },
  description: { type: 'string' }, image: { type: 'string' }, date: { type: 'string' },
};
const PAGE_OPTIONS: Record<string, Option> = {
  'wait-ms': { type: 'string' }, 'wait-for': { type: 'string' }, credential: { type: 'string' }, 'network-profile': { type: 'string' },
};
const FEED_OPTIONS: Record<string, Option> = {
  url: { type: 'string' }, name: { type: 'string' }, ...RULE_OPTIONS, ...PAGE_OPTIONS, rss: { type: 'boolean' }, interval: { type: 'string' },
  pagination: { type: 'string' }, translation: { type: 'string' }, 'target-language': { type: 'string' }, 'translation-provider': { type: 'string' }, data: { type: 'string' },
};
const LOG_OPTIONS: Record<string, Option> = { status: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' } };

// Argument helpers

const str = (opts: Values, name: string): string | undefined => typeof opts[name] === 'string' ? opts[name] as string : undefined;

function int(opts: Values, name: string, min: number, max: number): number | undefined {
  const raw = str(opts, name);
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw usageError(t('usage.badInteger', { name: `--${name}`, min, max }));
  return Number(raw);
}

function oneOf<T extends string>(opts: Values, name: string, allowed: readonly T[]): T | undefined {
  const raw = str(opts, name);
  if (raw !== undefined && !allowed.includes(raw as T)) throw usageError(t('usage.badChoice', { name: `--${name}`, allowed: allowed.join(' | ') }));
  return raw as T | undefined;
}

const list = (value: string | undefined): string[] | undefined => value === undefined ? undefined : value.split(',').map(entry => entry.trim()).filter(Boolean);

/** A JSON value given inline, as `@file.json`, or as `-` for standard input. */
async function json<T = unknown>(ctx: Context, name: string): Promise<T | undefined> {
  const raw = str(ctx.opts, name);
  if (raw === undefined) return undefined;
  let text = raw;
  try {
    if (raw === '-') text = await ctx.io.readStdin();
    else if (raw.startsWith('@')) text = await readFile(raw.slice(1), 'utf8');
  } catch (error) { throw usageError(t('usage.unreadableFile', { name: `--${name}`, message: (error as Error).message })); }
  try { return JSON.parse(text) as T; } catch { throw usageError(t('usage.badJson', { name: `--${name}` })); }
}

const compact = <T extends Record<string, unknown>>(value: T): Partial<T> => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;

async function rulesFrom(ctx: Context): Promise<Partial<SelectionRules>> {
  const base = await json<Partial<SelectionRules>>(ctx, 'rules');
  if (base !== undefined && (typeof base !== 'object' || base === null || Array.isArray(base))) throw usageError(t('usage.badJson', { name: '--rules' }));
  return { ...base, ...compact({ item: str(ctx.opts, 'item'), title: str(ctx.opts, 'title'), link: str(ctx.opts, 'link'), description: str(ctx.opts, 'description'), image: str(ctx.opts, 'image'), date: str(ctx.opts, 'date') }) };
}

function pageOptions(ctx: Context): ops.PageOptions {
  return compact({ waitMs: int(ctx.opts, 'wait-ms', 0, 10_000), waitForSelector: str(ctx.opts, 'wait-for'), credentialId: str(ctx.opts, 'credential'), networkProfileId: str(ctx.opts, 'network-profile') });
}

const translationModes = ['original', 'translated', 'bilingual'] as const;

/** Feed fields given as flags, on top of `--data`. Only fields that were given. */
async function feedFieldsFrom(ctx: Context): Promise<ops.FeedChanges> {
  const data = await json<ops.FeedChanges>(ctx, 'data') ?? {};
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw usageError(t('usage.badJson', { name: '--data' }));
  const rules = { ...data.rules, ...await rulesFrom(ctx) };
  return {
    ...data,
    ...compact({
      url: str(ctx.opts, 'url'), name: str(ctx.opts, 'name'), sourceType: ctx.opts.rss ? 'rss' as const : undefined,
      intervalMinutes: int(ctx.opts, 'interval', 5, 1440), waitMs: int(ctx.opts, 'wait-ms', 0, 10_000), waitForSelector: str(ctx.opts, 'wait-for'),
      pagination: await json<PaginationRules | null>(ctx, 'pagination'), credentialId: str(ctx.opts, 'credential'), networkProfileId: str(ctx.opts, 'network-profile'),
      translationMode: oneOf(ctx.opts, 'translation', translationModes), targetLanguage: str(ctx.opts, 'target-language') as FeedInput['targetLanguage'],
      translationProvider: str(ctx.opts, 'translation-provider') as FeedInput['translationProvider'],
    }),
    ...(Object.keys(rules).length ? { rules } : {}),
  };
}

async function newFeedInput(ctx: Context): Promise<FeedInput> {
  const fields = await feedFieldsFrom(ctx);
  if (!fields.url) throw usageError(t('usage.missingOption', { name: '--url' }));
  let host: string;
  try { host = new URL(fields.url).hostname; } catch { throw usageError(t('usage.badUrl', { url: fields.url })); }
  const rss = fields.sourceType === 'rss';
  const rules = (fields.rules ?? {}) as Partial<SelectionRules>;
  if (!rss && (!rules.item || !rules.title || !rules.link)) throw usageError(t('usage.missingRules'));
  return { ...fields, name: fields.name ?? host, url: fields.url, rules: rss ? { item: '', title: '', link: '' } : rules as SelectionRules, credentialId: fields.credentialId ?? null, intervalMinutes: fields.intervalMinutes ?? (rss ? 30 : 60), waitMs: fields.waitMs ?? 1_000 } as FeedInput;
}

async function feedChanges(ctx: Context): Promise<ops.FeedChanges> {
  const fields = await feedFieldsFrom(ctx);
  const retention = str(ctx.opts, 'retention-limit');
  const filter = str(ctx.opts, 'filter');
  return {
    ...fields,
    ...compact({
      channelTitle: str(ctx.opts, 'channel-title'), outputLimit: int(ctx.opts, 'output-limit', 10, 500),
      retentionLimit: retention === 'auto' ? null : int(ctx.opts, 'retention-limit', 10, 1000),
      itemFilter: filter === 'none' ? null : await json<ItemFilter>(ctx, 'filter'),
    }),
  };
}

const enabledArg = (ctx: Context) => String(ctx.args.id);

// Commands

const outputStatuses = ['published', 'untranslated', 'excluded', 'not-included', 'over-limit'] as const;
const fetchStatuses = ['running', 'success', 'failure', 'interrupted'] as const;
const bulkActions = ['copy', 'pause', 'resume', 'refresh', 'delete', 'settings'] as const;
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const commands: Command[] = [
  {
    name: 'login', options: { token: { type: 'string' }, 'token-stdin': { type: 'boolean' } },
    async run(ctx) {
      const connection = await ctx.connection();
      if (!connection.url) throw usageError(t('usage.missingOption', { name: '--server' }));
      let token = str(ctx.opts, 'token');
      if (token) ctx.warn(t('login.tokenFlag'));
      if (!token) token = ctx.opts['token-stdin'] || !ctx.io.promptSecret ? await ctx.io.readStdin() : await ctx.io.promptSecret(t('login.prompt'));
      token = token.trim();
      if (!/^fl_[A-Za-z0-9_-]{43}$/.test(token)) throw usageError(t('login.badToken'));
      const client = new FeedLanternClient({ url: connection.url, token, timeoutMs: timeoutMs(ctx) });
      const status = await client.authStatus();
      if (!status.authenticated || !status.tokenScope) throw new FeedLanternError({ code: 'unauthorized', status: 401, message: t('errors.notAuthenticated') });
      const file = await readConfig(connection.configPath);
      file.profiles[connection.profile] = { url: client.url, token };
      file.defaultProfile ??= connection.profile;
      await writeConfig(connection.configPath, file);
      if (ctx.io.env.FEEDLANTERN_TOKEN) ctx.warn(t('login.envOverrides'));
      return { saved: true, configPath: connection.configPath, profile: connection.profile, server: client.url, username: status.username, role: status.role, tokenScope: status.tokenScope, serverVersion: status.version, compatible: compatibleWith(status.version) };
    },
  },
  {
    name: 'logout',
    async run(ctx) {
      const connection = await ctx.connection();
      const file = await readConfig(connection.configPath);
      const profile = file.profiles[connection.profile];
      const removed = !!profile?.token;
      if (profile) { delete profile.token; await writeConfig(connection.configPath, file); }
      return { removed, profile: connection.profile, configPath: connection.configPath };
    },
  },
  {
    name: 'config',
    async run(ctx) {
      const connection = await ctx.connection();
      return { configPath: connection.configPath, profile: connection.profile, server: connection.url || null, serverSource: connection.sources.url, token: maskToken(connection.token), tokenSource: connection.sources.token, cliVersion: CLI_VERSION };
    },
  },
  { name: 'whoami', run: async ctx => ops.whoami(await ctx.client()) },
  { name: 'health', run: async ctx => ops.health(await ctx.client()) },

  {
    name: 'feeds list', options: { status: { type: 'string' } },
    table: { rows: '', columns: ['id', 'name', 'sourceType', 'enabled', 'itemCount', 'lastSuccessAt', 'lastError'] },
    run: async ctx => ops.listFeeds(await ctx.client(), oneOf(ctx.opts, 'status', ['active', 'paused', 'failing', 'warning'] as const)),
  },
  { name: 'feeds get', args: ['id'], run: async ctx => ops.getFeed(await ctx.client(), String(ctx.args.id)) },
  {
    name: 'feeds create', options: FEED_OPTIONS, write: true,
    run: async ctx => { const input = await newFeedInput(ctx); return ops.createFeed(await ctx.client(), input); },
  },
  {
    name: 'feeds update', args: ['id'], write: true,
    options: { ...FEED_OPTIONS, 'channel-title': { type: 'string' }, 'output-limit': { type: 'string' }, 'retention-limit': { type: 'string' }, filter: { type: 'string' } },
    run: async ctx => { const changes = await feedChanges(ctx); return ops.updateFeed(await ctx.client(), String(ctx.args.id), changes); },
  },
  { name: 'feeds delete', args: ['id'], write: true, confirm: () => true, run: async ctx => ops.deleteFeed(await ctx.client(), String(ctx.args.id)) },
  { name: 'feeds pause', args: ['id'], write: true, run: async ctx => ops.setFeedEnabled(await ctx.client(), enabledArg(ctx), false) },
  { name: 'feeds resume', args: ['id'], write: true, run: async ctx => ops.setFeedEnabled(await ctx.client(), enabledArg(ctx), true) },
  { name: 'feeds refresh', args: ['id'], write: true, run: async ctx => ops.refreshFeed(await ctx.client(), String(ctx.args.id)) },
  {
    name: 'feeds items', args: ['id'], options: { limit: { type: 'string' }, status: { type: 'string' } },
    table: { rows: 'items', columns: ['id', 'outputStatus', 'publishedAt', 'title', 'link'] },
    run: async ctx => ops.feedItems(await ctx.client(), String(ctx.args.id), compact({ limit: int(ctx.opts, 'limit', 1, 1000), status: oneOf<ItemOutputStatus>(ctx.opts, 'status', outputStatuses) })),
  },
  {
    name: 'feeds logs', args: ['id'], options: LOG_OPTIONS,
    table: { rows: 'logs', columns: ['id', 'source', 'status', 'startedAt', 'durationMs', 'itemCount', 'newItemCount', 'error'] },
    run: async ctx => ops.feedLogs(await ctx.client(), String(ctx.args.id), compact({ status: oneOf<FetchStatus>(ctx.opts, 'status', fetchStatuses), limit: int(ctx.opts, 'limit', 1, 100), cursor: str(ctx.opts, 'cursor') })),
  },

  {
    name: 'detect', args: ['url'], options: { ...PAGE_OPTIONS, samples: { type: 'string' } }, write: true,
    table: { rows: 'candidates', columns: ['id', 'label', 'confidence', 'score', 'count', 'rules.item', 'rules.title', 'rules.link'] },
    run: async ctx => ops.detect(await ctx.client(), String(ctx.args.url), { ...pageOptions(ctx), ...compact({ samples: int(ctx.opts, 'samples', 0, 50) }) }),
  },
  {
    name: 'preview', options: { url: { type: 'string' }, feed: { type: 'string' }, ...RULE_OPTIONS, ...PAGE_OPTIONS, pagination: { type: 'string' }, limit: { type: 'string' } }, write: true,
    table: { rows: 'items', columns: ['title', 'link', 'publishedAt', 'image'] },
    async run(ctx) {
      const url = str(ctx.opts, 'url'), feedId = str(ctx.opts, 'feed');
      if (!url === !feedId) throw usageError(t('usage.previewTarget'));
      const rules = await rulesFrom(ctx);
      if (url && (!rules.item || !rules.title || !rules.link)) throw usageError(t('usage.missingRules'));
      if (feedId && !Object.keys(rules).length) throw usageError(t('usage.missingOption', { name: '--rules' }));
      return ops.previewRules(await ctx.client(), { ...pageOptions(ctx), ...compact({ url, feedId, limit: int(ctx.opts, 'limit', 1, 1000), pagination: await json<PaginationRules>(ctx, 'pagination') }), rules });
    },
  },
  {
    name: 'rss preview', args: ['url'], options: { 'network-profile': { type: 'string' } }, write: true,
    table: { rows: 'items', columns: ['title', 'link'] },
    run: async ctx => ops.rssPreview(await ctx.client(), String(ctx.args.url), str(ctx.opts, 'network-profile')),
  },

  { name: 'bundles list', table: { rows: '', columns: ['bundle.id', 'bundle.name', 'bundle.feedIds.length', 'bundle.itemLimit', 'bundleUrl'] }, run: async ctx => ops.listBundles(await ctx.client()) },
  { name: 'bundles get', args: ['id'], run: async ctx => ops.getBundle(await ctx.client(), String(ctx.args.id)) },
  {
    name: 'bundles create', options: { name: { type: 'string' }, feeds: { type: 'string' }, 'item-limit': { type: 'string' } }, write: true,
    async run(ctx) {
      const name = str(ctx.opts, 'name');
      if (!name) throw usageError(t('usage.missingOption', { name: '--name' }));
      return ops.createBundle(await ctx.client(), { name, feedIds: list(str(ctx.opts, 'feeds')) ?? [], ...compact({ itemLimit: int(ctx.opts, 'item-limit', 10, 500) }) });
    },
  },
  {
    name: 'bundles update', args: ['id'], options: { name: { type: 'string' }, feeds: { type: 'string' }, 'add-feeds': { type: 'string' }, 'item-limit': { type: 'string' } }, write: true,
    run: async ctx => ops.updateBundle(await ctx.client(), String(ctx.args.id), compact({ name: str(ctx.opts, 'name'), feedIds: list(str(ctx.opts, 'feeds')), addFeedIds: list(str(ctx.opts, 'add-feeds')), itemLimit: int(ctx.opts, 'item-limit', 10, 500) })),
  },
  { name: 'bundles delete', args: ['id'], write: true, confirm: () => true, run: async ctx => ops.deleteBundle(await ctx.client(), String(ctx.args.id)) },

  {
    name: 'bulk', args: ['action', 'ids...'], options: { settings: { type: 'string' } }, write: true,
    confirm: ctx => ctx.args.action === 'delete',
    table: { rows: 'results', columns: ['id', 'ok', 'error', 'feedUrl'] },
    async run(ctx) {
      const action = String(ctx.args.action) as BulkAction;
      if (!bulkActions.includes(action)) throw usageError(t('usage.badChoice', { name: 'action', allowed: bulkActions.join(' | ') }));
      const settings = await json<BulkFeedSettingsInput>(ctx, 'settings');
      if (action === 'settings' && !settings) throw usageError(t('usage.missingOption', { name: '--settings' }));
      return ops.bulk(await ctx.client(), action, ctx.args.ids as string[], settings);
    },
  },
  { name: 'imports list', table: { rows: '', columns: ['id', 'createdAt', 'entries.length'] }, run: async ctx => ops.listImports(await ctx.client()) },
  {
    name: 'imports create', args: ['urls...'], write: true,
    options: { rss: { type: 'boolean' }, interval: { type: 'string' }, translation: { type: 'string' }, 'target-language': { type: 'string' }, 'translation-provider': { type: 'string' }, credential: { type: 'string' }, 'network-profile': { type: 'string' } },
    async run(ctx) {
      const credentialId = str(ctx.opts, 'credential') ?? null, networkProfileId = str(ctx.opts, 'network-profile') ?? null;
      const input: ImportJobInput = {
        entries: (ctx.args.urls as string[]).map(url => ({ url, credentialId, networkProfileId })),
        ...compact({
          sourceType: ctx.opts.rss ? 'rss' as const : undefined, intervalMinutes: int(ctx.opts, 'interval', 5, 1440),
          translationMode: oneOf(ctx.opts, 'translation', ['translated', 'bilingual'] as const), targetLanguage: str(ctx.opts, 'target-language'), translationProvider: str(ctx.opts, 'translation-provider'),
        }),
      };
      return ops.createImport(await ctx.client(), input);
    },
  },
  { name: 'imports cancel', args: ['id'], options: { entry: { type: 'string' } }, write: true, run: async ctx => ops.updateImport(await ctx.client(), String(ctx.args.id), 'cancel', str(ctx.opts, 'entry')) },
  { name: 'imports retry', args: ['id'], options: { entry: { type: 'string' } }, write: true, run: async ctx => ops.updateImport(await ctx.client(), String(ctx.args.id), 'retry', str(ctx.opts, 'entry')) },

  {
    name: 'tokens logs', options: { status: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' } },
    table: { rows: 'calls', columns: ['id', 'at', 'method', 'route', 'status', 'durationMs'] },
    run: async ctx => ops.tokenLogs(await ctx.client(), compact({ status: oneOf<ApiTokenCallFilter>(ctx.opts, 'status', ['success', 'denied', 'error'] as const), limit: int(ctx.opts, 'limit', 1, 100), cursor: str(ctx.opts, 'cursor') })),
  },
  {
    name: 'api', args: ['method', 'path'], options: { data: { type: 'string' }, query: { type: 'string', multiple: true } }, write: true,
    confirm: ctx => String(ctx.args.method).toUpperCase() === 'DELETE',
    async run(ctx) {
      const method = String(ctx.args.method).toUpperCase() as HttpMethod;
      if (!methods.includes(method)) throw usageError(t('usage.badChoice', { name: 'method', allowed: methods.join(' | ') }));
      const query = Object.fromEntries(((ctx.opts.query as string[] | undefined) ?? []).map(pair => {
        const index = pair.indexOf('=');
        if (index < 1) throw usageError(t('usage.badQuery', { pair }));
        return [pair.slice(0, index), pair.slice(index + 1)];
      }));
      return ops.rawRequest(await ctx.client(), method, String(ctx.args.path), await json(ctx, 'data'), query);
    },
  },
  {
    name: 'mcp', options: { 'read-only': { type: 'boolean' } },
    async run(ctx) {
      if (!ctx.io.serveMcp) throw usageError(t('usage.mcpUnavailable'));
      await ctx.io.serveMcp({ connection: await ctx.connection(), workspaceUser: workspaceUser(ctx), timeoutMs: timeoutMs(ctx), readOnly: !!ctx.opts['read-only'], warn: ctx.warn });
      return undefined;
    },
  },
];

const commandNames = commands.map(command => command.name);

function timeoutMs(ctx: Context): number | undefined {
  const raw = str(ctx.opts, 'timeout') ?? ctx.io.env.FEEDLANTERN_TIMEOUT;
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 3600) throw usageError(t('usage.badInteger', { name: '--timeout', min: 1, max: 3600 }));
  return Number(raw) * 1000;
}

const workspaceUser = (ctx: Context) => str(ctx.opts, 'workspace') ?? ctx.io.env.FEEDLANTERN_WORKSPACE;

// Help

function usageLine(command: Command): string {
  const args = (command.args ?? []).map(arg => arg.endsWith('...') ? `<${arg.slice(0, -3)}>...` : arg.startsWith('[') ? arg : `<${arg}>`);
  const options = Object.keys(command.options ?? {}).map(name => `[--${name}${command.options![name].type === 'string' ? ' …' : ''}]`);
  return ['feedlantern', command.name, ...args, ...options].join(' ');
}

function helpText(command?: Command): string {
  if (command) {
    const options = { ...command.options, ...GLOBAL_OPTIONS };
    return [
      usageLine(command), '', t(`cmd.${command.name}`), '',
      t('help.options'),
      ...Object.keys(options).map(name => `  --${name.padEnd(22)}${t(has(`opt.${command.name}.${name}`) ? `opt.${command.name}.${name}` : `opt.${name}`)}`),
      ...(command.write ? ['', t('help.writeNote')] : []),
      ...(command.confirm ? [t('help.confirmNote')] : []),
    ].join('\n');
  }
  return [
    t('help.title', { version: CLI_VERSION }), '', t('help.usage'), '', t('help.commands'),
    ...commands.map(entry => `  ${entry.name.padEnd(18)}${t(`cmd.${entry.name}`)}`),
    '', t('help.globalOptions'),
    ...Object.keys(GLOBAL_OPTIONS).map(name => `  --${name.padEnd(22)}${t(`opt.${name}`)}`),
    '', t('help.environment'), '', t('help.exitCodes'), '', t('help.more'),
  ].join('\n');
}

// Entry point

/** Runs one command line and returns the process exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  let mode: OutputMode = 'json';
  try {
    const all: Record<string, Option> = { ...GLOBAL_OPTIONS };
    for (const command of commands) Object.assign(all, command.options);
    const loose = parseArgs({ args: argv, options: all, strict: false, allowPositionals: true });
    mode = loose.values.table ? 'table' : loose.values.pretty ? 'pretty' : 'json';
    if (loose.values.version && !loose.positionals.length) { io.stdout(CLI_VERSION); return EXIT.ok; }
    const words = loose.positionals;
    const helpRequested = words[0] === 'help';
    const lookup = helpRequested ? words.slice(1) : words;
    const command = [...commands].sort((a, b) => b.name.length - a.name.length)
      .find(entry => entry.name.split(' ').every((part, index) => lookup[index] === part));
    if (helpRequested || loose.values.help || !words.length) {
      io.stdout(helpText(command));
      return words.length || loose.values.help ? EXIT.ok : EXIT.usage;
    }
    if (!command) {
      const prefix = commandNames.filter(name => name.startsWith(`${words[0]} `));
      throw usageError(prefix.length ? t('usage.unknownSubcommand', { group: words[0], commands: prefix.join(', ') }) : t('usage.unknownCommand', { command: words.join(' ') }));
    }
    let parsed: ReturnType<typeof parseArgs>;
    try { parsed = parseArgs({ args: argv, options: { ...GLOBAL_OPTIONS, ...command.options }, strict: true, allowPositionals: true }); }
    catch (error) { throw usageError(`${(error as Error).message}\n${usageLine(command)}`); }
    const positionals = parsed.positionals.slice(command.name.split(' ').length);
    const args: Context['args'] = {};
    for (const [index, spec] of (command.args ?? []).entries()) {
      if (spec.endsWith('...')) {
        const rest = positionals.slice(index);
        if (!rest.length) throw usageError(t('usage.missingArgument', { name: spec.slice(0, -3), usage: usageLine(command) }));
        args[spec.slice(0, -3)] = rest;
        positionals.length = index;
        break;
      }
      const name = spec.replace(/[[\]]/g, '');
      if (positionals[index] === undefined && !spec.startsWith('[')) throw usageError(t('usage.missingArgument', { name, usage: usageLine(command) }));
      args[name] = positionals[index];
    }
    const extra = command.args?.some(spec => spec.endsWith('...')) ? [] : positionals.slice(command.args?.length ?? 0);
    if (extra.length) throw usageError(t('usage.extraArguments', { args: extra.join(' '), usage: usageLine(command) }));

    let connection: Connection | undefined;
    let client: FeedLanternClient | undefined;
    const warn = (message: string) => io.stderr(t('output.warning', { message }));
    const ctx: Context = {
      args, opts: parsed.values as Values, io, warn,
      async connection() {
        connection ??= await resolveConnection({ url: str(ctx.opts, 'server'), profile: str(ctx.opts, 'profile') }, io.env, warn);
        return connection;
      },
      async client() {
        if (client) return client;
        const resolved = await ctx.connection();
        if (!resolved.url) throw new FeedLanternError({ code: 'not_configured', status: 0, message: t('config.noUrl') });
        client = new FeedLanternClient({ url: resolved.url, token: resolved.token, workspaceUser: workspaceUser(ctx), timeoutMs: timeoutMs(ctx), dryRun: !!(command.write && ctx.opts['dry-run']) });
        return client;
      },
    };
    if (command.confirm?.(ctx) && !ctx.opts.yes && !ctx.opts['dry-run']) throw usageError(t('usage.confirm'));
    let result = await command.run(ctx);
    if (command.name === 'mcp') return EXIT.ok;
    if (client?.dryRun) result = { dryRun: true, requests: client.planned, ...(client.planned.length ? {} : { result }) };
    io.stdout(formatResult(result, mode, command.table));
    const failed = (result as { failed?: unknown } | null)?.failed;
    return typeof failed === 'number' && failed > 0 ? EXIT.partial : EXIT.ok;
  } catch (thrown) {
    const error = asFeedLanternError(thrown);
    io.stderr(formatError(error, mode));
    return error.exitCode;
  }
}
