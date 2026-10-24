import { z } from 'zod';
import { validateBarkUrl } from './bark.js';
import ipaddr from 'ipaddr.js';
import { defaultApplicationSettings, type ApplicationSettings } from '../shared/types.js';
import type { ServerConfig } from './config.js';

const rate = { concurrency: z.number().int().min(1).max(16), requestIntervalMs: z.number().int().min(0).max(5000) };
// Keys travel in an HTTP header: printable ASCII only, so CR/LF can never reach it.
const apiKey = z.string().max(500).regex(/^[\x21-\x7e]*$/, 'error.apiKeyInvalid').default('');
/** `apiKeyConfigured` is a read-only flag the API returns instead of the key; accept and drop it. */
const withoutFlag = <T extends { apiKeyConfigured?: boolean }>({ apiKeyConfigured: _flag, ...rest }: T) => rest;
const defaults = defaultApplicationSettings.translation;
export const translationSettingsSchema = z.object({
  ...rate,
  defaultProvider: z.enum(['google', 'deepl', 'openai']).default('google'),
  deepl: z.object({ ...rate, apiKey, apiKeyConfigured: z.boolean().optional(), plan: z.enum(['auto', 'free', 'pro']).default('auto') })
    .strict().transform(withoutFlag).default(defaults.deepl),
  openai: z.object({
    ...rate, apiKey, apiKeyConfigured: z.boolean().optional(),
    baseUrl: z.string().max(2048).refine(value => {
      if (!value) return true;
      try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
    }, 'error.openaiUrlInvalid').transform(value => value.replace(/\/+$/, '')).default(''),
    model: z.string().max(200).regex(/^[^\u0000-\u001f\u007f]*$/, 'error.modelInvalid').transform(value => value.trim()).default(''),
    systemPrompt: z.string().max(4000).default(''),
  }).strict().transform(withoutFlag).default(defaults.openai),
}).strict();
/** Bark fields plus the alert policy (threshold, retries, cooldown) that every channel shares. */
export const barkObjectSchema = z.object({
  enabled: z.boolean(),
  url: z.string().max(2048).transform((value, ctx) => {
    try { return validateBarkUrl(value) ?? ''; }
    catch { ctx.addIssue({ code: 'custom', message: 'error.barkUrlInvalid' }); return z.NEVER; }
  }),
  failureThreshold: z.number().int().min(1).max(1000).default(defaultApplicationSettings.bark.failureThreshold),
  timeoutSeconds: z.number().int().min(1).max(60),
  maxAttempts: z.number().int().min(1).max(5),
  retryDelaySeconds: z.number().int().min(1).max(3600),
  laterRetryDelaySeconds: z.number().int().min(1).max(3600),
  cooldownMinutes: z.number().int().min(1).max(1440),
  /** Also alert when a feed's rules may have stopped matching (deduplicated apart from failures). */
  ruleHealthAlerts: z.boolean().default(defaultApplicationSettings.bark.ruleHealthAlerts),
}).strict();
const barkSchema = barkObjectSchema.refine(value => !value.enabled || !!value.url, 'error.barkUrlRequired');

export const applicationSettingsSchema = z.object({
  translation: translationSettingsSchema.default(defaults),
  feedView: z.enum(['list', 'cards']),
  logRetentionDays: z.number().int().min(1).max(365),
  bark: barkSchema,
  server: z.object({
    backgroundConcurrency: z.number().int().min(1).max(4),
    allowedHosts: z.array(z.string().max(300).refine(value => {
      try {
        if (!/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):\d+$/.test(value)) return false;
        const url = new URL(`http://${value}`);
        const port = Number(value.slice(value.lastIndexOf(':') + 1));
        return !!url.hostname && port >= 1 && port <= 65535;
      } catch { return false; }
    }, 'error.allowedHostFormat')).max(100),
    dnsOverHttps: z.boolean(),
    trustedProxies: z.array(z.string().max(100).refine(value => {
      try { if (value.includes('/')) ipaddr.parseCIDR(value); else ipaddr.parse(value); return true; } catch { return false; }
    }, 'error.trustedProxyFormat')).max(100),
    publicOrigin: z.string().max(2048).refine(value => {
      try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash; } catch { return false; }
    }, 'error.publicOriginFormat').transform(value => new URL(value).origin),
    cookieSecure: z.boolean(),
    sessionTtlDays: z.number().int().min(1).max(365),
    host: z.string().max(253).refine(value => ipaddr.isValid(value) || value === 'localhost', 'error.hostFormat'),
    port: z.number().int().min(1).max(65535),
  }).strict().default(defaultApplicationSettings.server),
}).strict();

export function settingsFromConfig(config: ServerConfig): ApplicationSettings {
  return applicationSettingsSchema.parse({
    ...structuredClone(defaultApplicationSettings),
    bark: { ...defaultApplicationSettings.bark, enabled: !!config.barkUrl, url: config.barkUrl ?? '' },
    server: { backgroundConcurrency: config.backgroundConcurrency, allowedHosts: config.allowedHosts, dnsOverHttps: config.dnsOverHttps ?? false,
      trustedProxies: config.trustedProxies ?? [], publicOrigin: config.publicOrigin, cookieSecure: config.cookieSecure,
      sessionTtlDays: Math.max(1, Math.ceil(config.sessionTtlMs / 86400_000)), host: config.host, port: config.port },
  });
}

export function applyRuntimeSettings(config: ServerConfig, settings: ApplicationSettings): void {
  Object.assign(config, settings.server, { sessionTtlMs: settings.server.sessionTtlDays * 86400_000 });
}

export function isApplicationSettingsJson(value: string): boolean {
  try { return applicationSettingsSchema.safeParse(JSON.parse(value)).success; }
  catch { return false; }
}
