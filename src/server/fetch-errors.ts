/**
 * Readable fetch timeouts. A timeout names only the host and the waiting
 * time, never the full address, so query parameters stay hidden in fetch
 * logs, the feed list and alerts.
 */
import { LocalizedError, msg } from './i18n.js';
import type { Param } from '../shared/i18n.js';

export class FetchTimeoutError extends LocalizedError {
  override name = 'FetchTimeoutError';
  constructor(readonly host: Param, readonly seconds: number, viaProxy = false) {
    // On a direct connection the most common cause is a local proxy app.
    super(msg('error.fetchTimeout', { host, seconds, hint: msg(viaProxy ? 'error.fetchTimeoutProxyHint' : 'error.fetchTimeoutDirectHint') }));
  }
}

/** The host of an address for a message, without port, path or query. */
export function hostOf(raw: string): Param {
  try { return new URL(raw).hostname.replace(/^\[|\]$/g, '') || msg('label.targetSite'); } catch { return msg('label.targetSite'); }
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
export async function withFetchTimeout<T>(seconds: number, signal: AbortSignal | undefined, host: () => Param, viaProxy: boolean, operation: (combined: AbortSignal) => Promise<T>): Promise<T> {
  const timer = AbortSignal.timeout(seconds * 1000);
  const combined = signal ? AbortSignal.any([timer, signal]) : timer;
  try {
    return await operation(combined);
  } catch (error) {
    if (timer.aborted && !signal?.aborted) throw new FetchTimeoutError(host(), seconds, viaProxy);
    throw error;
  }
}
