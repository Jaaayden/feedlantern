import { NetworkPolicy } from './network.js';
import { postJson } from './outbound.js';
import { LocalizedError, msg } from './i18n.js';

export type BarkSender = (url: string, body: string, signal: AbortSignal, title?: string) => Promise<void>;

export function validateBarkUrl(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.split('/').filter(Boolean).length) throw Error();
    if (!/^[a-zA-Z0-9_-]+$/.test(decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1)!))) throw Error();
    return url.href;
  } catch { throw new LocalizedError(msg('error.barkUrlInvalid')); }
}

/** Sends through the network policy like every other channel (see `postJson`). */
export async function sendBark(url: string, body: string, signal: AbortSignal, title = 'FeedLantern: feed fetch failed', policy = new NetworkPolicy()): Promise<void> {
  // Convert the App's device URL into the documented V2 JSON endpoint.
  // Keeping the key in the body also avoids putting it in proxy access paths.
  const endpoint = new URL(url);
  const segments = endpoint.pathname.split('/').filter(Boolean);
  const deviceKey = decodeURIComponent(segments.pop()!);
  endpoint.pathname = `/${[...segments, 'push'].join('/')}`;
  const response = await postJson(endpoint.href, JSON.stringify({ device_key: deviceKey, title, body, group: 'FeedLantern' }), { signal, policy });
  if (response.status < 200 || response.status >= 300) throw new Error('Bark push failed');
  let result: { code?: number } = {};
  try { result = JSON.parse(response.text); } catch { /* handled below */ }
  if (result.code !== 200) throw new Error('Bark push failed');
}
