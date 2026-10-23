import { NetworkPolicy } from './network.js';
import { postJson } from './outbound.js';

export type BarkSender = (url: string, body: string, signal: AbortSignal, title?: string) => Promise<void>;

export function validateBarkUrl(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.split('/').filter(Boolean).length) throw Error();
    if (!/^[a-zA-Z0-9_-]+$/.test(decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1)!))) throw Error();
    return url.href;
  } catch { throw new Error('Bark 地址必须是包含设备密钥的 HTTPS 推送地址，不支持查询参数'); }
}

/** Sends through the network policy like every other channel (see `postJson`). */
export async function sendBark(url: string, body: string, signal: AbortSignal, title = '订阅灯：订阅抓取失败', policy = new NetworkPolicy()): Promise<void> {
  // Convert the App's device URL into the documented V2 JSON endpoint.
  // Keeping the key in the body also avoids putting it in proxy access paths.
  const endpoint = new URL(url);
  const segments = endpoint.pathname.split('/').filter(Boolean);
  const deviceKey = decodeURIComponent(segments.pop()!);
  endpoint.pathname = `/${[...segments, 'push'].join('/')}`;
  const response = await postJson(endpoint.href, JSON.stringify({ device_key: deviceKey, title, body, group: 'FeedLantern' }), { signal, policy });
  if (response.status < 200 || response.status >= 300) throw new Error('Bark 推送失败');
  let result: { code?: number } = {};
  try { result = JSON.parse(response.text); } catch { /* handled below */ }
  if (result.code !== 200) throw new Error('Bark 推送失败');
}
