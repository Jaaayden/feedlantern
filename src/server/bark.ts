import type { FetchHistory } from './fetch-history.js';
import { defaultApplicationSettings, type ApplicationSettings } from '../shared/types.js';

export type BarkSender = (url: string, body: string, signal: AbortSignal) => Promise<void>;

export function validateBarkUrl(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.split('/').filter(Boolean).length) throw Error();
    if (!/^[a-zA-Z0-9_-]+$/.test(decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1)!))) throw Error();
    return url.href;
  } catch { throw new Error('Bark 地址必须是包含设备密钥的 HTTPS 推送地址，不支持查询参数'); }
}

export const sendBark: BarkSender = async (url, body, signal) => {
  // Convert the App's device URL into the documented V2 JSON endpoint.
  // Keeping the key in the body also avoids putting it in proxy access paths.
  const endpoint = new URL(url);
  const segments = endpoint.pathname.split('/').filter(Boolean);
  const deviceKey = decodeURIComponent(segments.pop()!);
  endpoint.pathname = `/${[...segments, 'push'].join('/')}`;
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_key: deviceKey, title: '订阅灯：订阅抓取失败', body, group: 'FeedLantern' }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Bark 推送失败'); }
  const result = await response.json() as { code?: number };
  if (result.code !== 200) throw new Error('Bark 推送失败');
};

/** A single independent worker; failures never propagate into feed refresh jobs. */
export class BarkWorker {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private paused = true;
  private controller?: AbortController;
  private activeId?: string;
  constructor(private history: FetchHistory, private config?: string | (() => ApplicationSettings['bark']), private send: BarkSender = sendBark) {}

  private options(): ApplicationSettings['bark'] {
    return typeof this.config === 'function' ? this.config() : { ...defaultApplicationSettings.bark, enabled: !!this.config, url: this.config ?? '' };
  }

  start(): void {
    if (!this.options().enabled || !this.options().url || !this.paused) return;
    this.paused = false;
    this.timer = setInterval(() => this.wake(), 5_000);
    this.timer.unref();
    this.wake();
  }

  wake(): void {
    if (this.activeId && !this.history.isPending(this.activeId)) this.controller?.abort();
    if (this.paused || this.running || !this.options().enabled || !this.options().url) return;
    this.running = this.run().catch(() => {
      // Do not expose URLs, keys or raw fetch errors in process logs.
      console.error('Bark 后台队列处理失败，将自动重试');
    }).finally(() => { this.running = undefined; });
  }

  private async run(): Promise<void> {
    while (!this.paused) {
      const options = this.options();
      if (!options.enabled || !options.url) return;
      const job = this.history.nextAlert();
      if (!job) return;
      if (job.attempts >= options.maxAttempts) { this.history.finishAttempt(job.id, false); continue; }
      if (!this.history.beginAttempt(job.id)) continue;
      this.activeId = job.id;
      this.controller = new AbortController();
      let ok = false;
      try { await this.send(options.url, job.body, AbortSignal.any([this.controller.signal, AbortSignal.timeout(options.timeoutSeconds * 1000)])); ok = true; }
      catch { /* Only a fixed, sanitized error is persisted. */ }
      finally { this.activeId = undefined; this.controller = undefined; }
      this.history.finishAttempt(job.id, ok);
    }
  }

  async stop(): Promise<void> {
    this.paused = true;
    if (this.timer) clearInterval(this.timer);
    this.controller?.abort();
    await this.running;
  }
}
