import { z } from 'zod';
import { validateBarkUrl } from './bark.js';
import ipaddr from 'ipaddr.js';
import { defaultApplicationSettings, type ApplicationSettings } from '../shared/types.js';
import type { ServerConfig } from './config.js';

export const applicationSettingsSchema = z.object({
  feedView: z.enum(['list', 'cards']),
  logRetentionDays: z.number().int().min(1).max(365),
  bark: z.object({
    enabled: z.boolean(),
    url: z.string().max(2048).transform((value, ctx) => {
      try { return validateBarkUrl(value) ?? ''; }
      catch { ctx.addIssue({ code: 'custom', message: 'Bark 地址必须是包含设备密钥的 HTTPS 地址' }); return z.NEVER; }
    }),
    timeoutSeconds: z.number().int().min(1).max(60),
    maxAttempts: z.number().int().min(1).max(5),
    retryDelaySeconds: z.number().int().min(1).max(3600),
    laterRetryDelaySeconds: z.number().int().min(1).max(3600),
    cooldownMinutes: z.number().int().min(1).max(1440),
  }).strict().refine(value => !value.enabled || !!value.url, '启用 Bark 时请填写推送地址'),
  server: z.object({
    backgroundConcurrency: z.number().int().min(1).max(4),
    allowedHosts: z.array(z.string().max(300).refine(value => {
      try {
        if (!/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):\d+$/.test(value)) return false;
        const url = new URL(`http://${value}`);
        const port = Number(value.slice(value.lastIndexOf(':') + 1));
        return !!url.hostname && port >= 1 && port <= 65535;
      } catch { return false; }
    }, '白名单使用精确的 hostname:port')).max(100),
    dnsOverHttps: z.boolean(),
    trustedProxies: z.array(z.string().max(100).refine(value => {
      try { if (value.includes('/')) ipaddr.parseCIDR(value); else ipaddr.parse(value); return true; } catch { return false; }
    }, '可信代理使用 IP 或 CIDR')).max(100),
    publicOrigin: z.string().max(2048).refine(value => {
      try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash; } catch { return false; }
    }, '公开访问地址必须是 HTTP(S) 源地址').transform(value => new URL(value).origin),
    cookieSecure: z.boolean(),
    sessionTtlDays: z.number().int().min(1).max(365),
    host: z.string().max(253).refine(value => ipaddr.isValid(value) || value === 'localhost', '监听地址使用 IP 或 localhost'),
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
