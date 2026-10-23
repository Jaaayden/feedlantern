/**
 * Readable fetch timeouts. A timeout names only the host and the waiting
 * time, never the full address, so query parameters stay hidden in fetch
 * logs, the feed list and alerts.
 */

/** Shown with a timeout on a direct connection; the most common cause is a local proxy app. */
const DIRECT_HINT = '如果本机开启了代理软件的增强模式或 Fake-IP，FeedLantern 不读取系统代理：请开启 TUN/增强模式并打开 DNS-over-HTTPS，或为该订阅配置网络代理。';
const PROXY_HINT = '请检查该订阅网络配置中的代理是否可用。';

export class FetchTimeoutError extends Error {
  override name = 'FetchTimeoutError';
  constructor(readonly host: string, readonly seconds: number, viaProxy = false) {
    super(`连接 ${host} 超时（${seconds} 秒未响应）。${viaProxy ? PROXY_HINT : DIRECT_HINT}`);
  }
}

/** The host of an address for a message, without port, path or query. */
export function hostOf(raw: string): string {
  try { return new URL(raw).hostname.replace(/^\[|\]$/g, '') || '目标网站'; } catch { return '目标网站'; }
}

/**
 * Whether an error is an abort or timeout from an AbortSignal, a Node
 * request or Playwright rather than an answer from the site.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Run `operation` with its own timeout next to the caller's signal. Only our
 * timer firing becomes a FetchTimeoutError; a caller abort (a user canceling,
 * the service stopping) is rethrown unchanged so it is never reported as a
 * timeout.
 */
export async function withFetchTimeout<T>(seconds: number, signal: AbortSignal | undefined, host: () => string, viaProxy: boolean, operation: (combined: AbortSignal) => Promise<T>): Promise<T> {
  const timer = AbortSignal.timeout(seconds * 1000);
  const combined = signal ? AbortSignal.any([timer, signal]) : timer;
  try {
    return await operation(combined);
  } catch (error) {
    if (timer.aborted && !signal?.aborted) throw new FetchTimeoutError(host(), seconds, viaProxy);
    throw error;
  }
}
