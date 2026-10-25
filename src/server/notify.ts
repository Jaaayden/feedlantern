import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { NetworkPolicy, NetworkPolicyError } from './network.js';
import { postJson } from './outbound.js';
import { sendBark } from './bark.js';
import { barkObjectSchema } from './settings.js';
import { tl, withLocale, type Locale } from './i18n.js';
import type { MessageKey } from '../shared/i18n.js';
import type { FetchHistory, PendingAlert } from './fetch-history.js';
import {
  defaultNotificationChannels, notificationChannelLabels,
  type NotificationChannel, type NotificationChannelSettings, type NotificationPolicy,
} from '../shared/types.js';

/* ------------------------------------------------------------------ *
 * Channel settings
 * ------------------------------------------------------------------ */

const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'expect', 'accept-encoding', 'user-agent', 'x-feedlantern-event', 'x-feedlantern-signature-256']);
export const WEBHOOK_SIGNATURE_HEADER = 'X-FeedLantern-Signature-256';

function httpUrl(label: MessageKey, allowQuery: boolean) {
  return z.string().max(2048).transform((value, ctx) => {
    const trimmed = value.trim();
    if (!trimmed) return '';
    try {
      const url = new URL(trimmed);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || (!allowQuery && url.search)) throw Error();
      return url.href;
    } catch {
      ctx.addIssue({ code: 'custom', message: allowQuery ? 'error.channelUrl' : 'error.channelUrlNoQuery', params: { label } });
      return z.NEVER;
    }
  });
}

const headerSchema = z.object({
  name: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/, 'error.webhookHeaderName'),
  value: z.string().max(1024).regex(/^[^\r\n\0]*$/, 'error.webhookHeaderValue'),
}).strict().refine(header => !RESERVED_HEADERS.has(header.name.toLowerCase()) && !header.name.toLowerCase().startsWith('proxy-'), 'error.webhookHeaderReserved');

export const webhookSchema = z.object({
  enabled: z.boolean(),
  url: httpUrl('label.webhookUrl', true),
  secret: z.string().max(256),
  headers: z.array(headerSchema).max(10, 'error.webhookHeaderCount')
    .refine(list => new Set(list.map(h => h.name.toLowerCase())).size === list.length, 'error.webhookHeaderDuplicate'),
}).strict().refine(value => !value.enabled || !!value.url, 'error.webhookUrlRequired');

export const ntfySchema = z.object({
  enabled: z.boolean(),
  server: httpUrl('label.ntfyServer', false),
  topic: z.string().regex(/^(?:[-_A-Za-z0-9]{1,64})?$/, 'error.ntfyTopic'),
  token: z.string().max(256).regex(/^[\x21-\x7e]*$/, 'error.ntfyToken'),
}).strict().refine(value => !value.enabled || !!value.server && !!value.topic, 'error.ntfyRequired');

export const telegramSchema = z.object({
  enabled: z.boolean(),
  botToken: z.string().regex(/^(?:\d{1,20}:[A-Za-z0-9_-]{20,100})?$/, 'error.telegramToken'),
  chatId: z.string().regex(/^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,64})?$/, 'error.telegramChatId'),
}).strict().refine(value => !value.enabled || !!value.botToken && !!value.chatId, 'error.telegramRequired');

export const notificationChannelsSchema = z.object({
  webhook: webhookSchema.default(defaultNotificationChannels.webhook),
  ntfy: ntfySchema.default(defaultNotificationChannels.ntfy),
  telegram: telegramSchema.default(defaultNotificationChannels.telegram),
}).strict();

/**
 * The encrypted per-account `user_notifications.value`: the original Bark
 * object (so existing rows and backups stay valid) plus optional `channels`.
 */
export const storedNotificationSchema = barkObjectSchema.extend({ channels: notificationChannelsSchema.optional() }).strict()
  .refine(value => !value.enabled || !!value.url, 'error.barkUrlRequired');

/** Configuration needed to send through one channel; only enabled, complete channels are resolved. */
export interface ChannelConfigs {
  bark: { url: string };
  webhook: NotificationChannelSettings['webhook'];
  ntfy: NotificationChannelSettings['ntfy'];
  telegram: NotificationChannelSettings['telegram'];
}
/** `locale` is the language of the feed's owner, used for every message sent to them. */
export interface NotificationTarget { policy: NotificationPolicy; configs: Partial<ChannelConfigs>; locale?: Locale }

export function activeChannels(bark: { enabled: boolean; url: string }, channels: NotificationChannelSettings): Partial<ChannelConfigs> {
  const configs: Partial<ChannelConfigs> = {};
  if (bark.enabled && bark.url) configs.bark = { url: bark.url };
  if (channels.webhook.enabled && channels.webhook.url) configs.webhook = channels.webhook;
  if (channels.ntfy.enabled && channels.ntfy.server && channels.ntfy.topic) configs.ntfy = channels.ntfy;
  if (channels.telegram.enabled && channels.telegram.botToken && channels.telegram.chatId) configs.telegram = channels.telegram;
  return configs;
}

const maskUrl = (raw: string) => raw ? `${new URL(raw).origin}/••••••` : '';

/** API/preview view of the channels: secrets and full webhook URLs are never returned. */
export function channelsSummary(bark: { enabled: boolean; url: string }, channels: NotificationChannelSettings) {
  return {
    bark: { enabled: bark.enabled, configured: !!bark.url, maskedUrl: maskUrl(bark.url) },
    webhook: { enabled: channels.webhook.enabled, configured: !!channels.webhook.url, maskedUrl: maskUrl(channels.webhook.url), signed: !!channels.webhook.secret, headerNames: channels.webhook.headers.map(h => h.name) },
    ntfy: { enabled: channels.ntfy.enabled, configured: !!channels.ntfy.server && !!channels.ntfy.topic, server: channels.ntfy.server, topic: channels.ntfy.topic, tokenConfigured: !!channels.ntfy.token },
    telegram: { enabled: channels.telegram.enabled, configured: !!channels.telegram.botToken && !!channels.telegram.chatId, chatId: channels.telegram.chatId, tokenConfigured: !!channels.telegram.botToken },
  };
}

/* ------------------------------------------------------------------ *
 * Senders
 * ------------------------------------------------------------------ */

export type NotificationEvent = 'fetch.failed' | 'translation.failed' | 'rules.warning' | 'test';
export interface NotificationMessage {
  event: NotificationEvent; title: string; body: string;
  feedId: string | null; feedName: string | null; error: string | null; time: string; panelUrl: string;
}
export interface SendContext { signal: AbortSignal; policy: NetworkPolicy }
export type ChannelSender<K extends NotificationChannel> = (config: ChannelConfigs[K], message: NotificationMessage, context: SendContext) => Promise<void>;
export type NotificationSenders = { [K in NotificationChannel]: ChannelSender<K> };

const ok = (status: number) => status >= 200 && status < 300;

export const sendWebhook: ChannelSender<'webhook'> = async (config, message, { signal, policy }) => {
  const body = JSON.stringify({
    event: message.event, title: message.title, message: message.body, feedId: message.feedId, feedName: message.feedName,
    error: message.error, time: message.time, panelUrl: message.panelUrl,
  });
  const headers: Record<string, string> = Object.fromEntries(config.headers.map(h => [h.name, h.value]));
  headers['x-feedlantern-event'] = message.event;
  if (config.secret) headers[WEBHOOK_SIGNATURE_HEADER] = `sha256=${createHmac('sha256', config.secret).update(body).digest('hex')}`;
  const response = await postJson(config.url, body, { signal, policy, headers });
  if (!ok(response.status)) throw Error('Webhook push failed');
};

export const sendNtfy: ChannelSender<'ntfy'> = async (config, message, { signal, policy }) => {
  // JSON publishing goes to the server root and keeps UTF-8 titles intact.
  const endpoint = config.server.endsWith('/') ? config.server : `${config.server}/`;
  const body = JSON.stringify({ topic: config.topic, title: message.title, message: message.body, tags: [message.event === 'test' ? 'bell' : 'warning'], click: message.panelUrl });
  const response = await postJson(endpoint, body, { signal, policy, headers: config.token ? { authorization: `Bearer ${config.token}` } : {} });
  if (!ok(response.status)) throw Error('ntfy push failed');
};

export const TELEGRAM_API = 'https://api.telegram.org';
export function telegramSender(apiBase = TELEGRAM_API): ChannelSender<'telegram'> {
  return async (config, message, { signal, policy }) => {
    const body = JSON.stringify({ chat_id: config.chatId, text: `${message.title}\n${message.body}\n${message.panelUrl}`, disable_web_page_preview: true });
    const response = await postJson(`${apiBase}/bot${config.botToken}/sendMessage`, body, { signal, policy });
    let result: { ok?: boolean } = {};
    try { result = JSON.parse(response.text); } catch { /* handled below */ }
    if (!ok(response.status) || result.ok !== true) throw Error('Telegram push failed');
  };
}

export const defaultSenders: NotificationSenders = {
  bark: (config, message, { signal, policy }) => sendBark(config.url, message.body, signal, message.title, policy),
  webhook: sendWebhook,
  ntfy: sendNtfy,
  telegram: telegramSender(),
};

const alertTitles = {
  test: 'notify.title.test', 'translation.failed': 'notify.title.translationFailed', 'rules.warning': 'notify.title.rulesWarning', 'fetch.failed': 'notify.title.fetchFailed',
} as const satisfies Record<NotificationEvent, MessageKey>;

/** The title in the current language (the owner's, inside the worker). */
export function alertTitle(event: NotificationEvent): string {
  return tl(alertTitles[event]);
}

/** Fixed error text: neither URLs, tokens nor raw network errors are ever shown or stored. */
export function deliveryError(channel: NotificationChannel, error: unknown): string {
  return tl(error instanceof NetworkPolicyError ? 'notify.blocked' : 'notify.failed', { channel: notificationChannelLabels[channel] });
}

/* ------------------------------------------------------------------ *
 * Background worker
 * ------------------------------------------------------------------ */

export interface NotificationWorkerOptions {
  /** Policy and enabled channels of the account that owns the feed. */
  target: (feedId: string) => NotificationTarget;
  senders?: Partial<NotificationSenders>;
  network?: () => NetworkPolicy;
  panelUrl?: (feedId: string, event: NotificationEvent) => string;
}

/**
 * A single independent worker that delivers every pending channel delivery.
 * Failures never propagate into feed refresh jobs.
 */
export class NotificationWorker {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private paused = true;
  private controller?: AbortController;
  private activeId?: string;
  private senders: NotificationSenders;

  constructor(private history: FetchHistory, private options: NotificationWorkerOptions) {
    this.senders = { ...defaultSenders, ...options.senders };
  }

  start(): void {
    if (!this.paused) return;
    this.paused = false;
    this.timer = setInterval(() => this.wake(), 5_000);
    this.timer.unref();
    this.wake();
  }

  wake(): void {
    if (this.activeId && !this.history.isPending(this.activeId)) this.controller?.abort();
    if (this.paused || this.running) return;
    this.running = this.run().catch(() => {
      // Do not expose URLs, keys or raw fetch errors in process logs.
      console.error('Notification queue failed; it will retry automatically');
    }).finally(() => { this.running = undefined; });
  }

  private message(job: PendingAlert): NotificationMessage {
    const event: NotificationEvent = job.kind === 'translation' ? 'translation.failed' : job.kind === 'health' ? 'rules.warning' : 'fetch.failed';
    return {
      event, title: alertTitle(event), body: job.body, feedId: job.feedId,
      feedName: job.payload?.feedName ?? job.body.split('\n')[0], error: job.payload?.error ?? null,
      time: job.payload?.time ?? new Date().toISOString(), panelUrl: this.options.panelUrl?.(job.feedId, event) ?? '',
    };
  }

  private async run(): Promise<void> {
    while (!this.paused) {
      const job = this.history.nextAlert();
      if (!job) return;
      const target = this.options.target(job.feedId);
      const config = target.configs[job.channel];
      if (!config) { this.history.cancelDelivery(job.id); continue; }
      // Rule-health alerts were switched off after this one was raised.
      if (job.kind === 'health' && target.policy.ruleHealthAlerts === false) { this.history.cancelDelivery(job.id); continue; }
      if (job.attempts >= target.policy.maxAttempts) { this.history.finishAttempt(job.id, false); continue; }
      if (!this.history.beginAttempt(job.id)) continue;
      await withLocale(target.locale ?? 'en', () => this.deliver(job, target, config));
    }
  }

  private async deliver(job: PendingAlert, target: NotificationTarget, config: ChannelConfigs[NotificationChannel]): Promise<void> {
    this.activeId = job.id;
    this.controller = new AbortController();
    let failure: unknown = undefined, ok = false;
    try {
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(target.policy.timeoutSeconds * 1000)]);
      const send = this.senders[job.channel] as ChannelSender<typeof job.channel>;
      await send(config as never, this.message(job), { signal, policy: this.options.network?.() ?? new NetworkPolicy() });
      ok = true;
    } catch (error) { failure = error; }
    finally { this.activeId = undefined; this.controller = undefined; }
    this.history.finishAttempt(job.id, ok, Date.now(), ok ? undefined : deliveryError(job.channel, failure));
  }

  async stop(): Promise<void> {
    this.paused = true;
    if (this.timer) clearInterval(this.timer);
    this.controller?.abort();
    await this.running;
  }
}
