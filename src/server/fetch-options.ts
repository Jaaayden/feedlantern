import { isIP } from 'node:net';
import { AppError } from './auth.js';
import type { ProxyType, UpstreamProxy } from './upstream-proxy.js';
import { forbiddenHeaderReason, HEADER_TOKEN as TOKEN, HEADER_VALUE, NETWORK_LIMITS } from '../shared/network-rules.js';

export { FORBIDDEN_HEADER_PREFIXES, FORBIDDEN_HEADERS, forbiddenHeaderReason, NETWORK_LIMITS, proxyUrl } from '../shared/network-rules.js';

export interface CustomHeader { name: string; value: string }

/**
 * Per-feed network options. Website feeds apply them in their Chromium
 * context; RSS feeds apply them in the Node HTTP fetch. Editor preview, batch
 * discovery and background refresh all receive the same object for a feed.
 */
export interface FetchNetworkOptions {
  proxy?: UpstreamProxy;
  userAgent?: string;
  referer?: string;
  headers?: CustomHeader[];
}

/** A saved network profile, decrypted. */
export interface NetworkProfileValue {
  name: string;
  proxy: UpstreamProxy | null;
  userAgent?: string;
  referer?: string;
  headers: CustomHeader[];
}

function text(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new AppError(400, `${label}必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new AppError(400, `${label}不能超过 ${max} 个字符`);
  if (!HEADER_VALUE.test(trimmed)) throw new AppError(400, `${label}只能包含可见 ASCII 字符`);
  return trimmed;
}

const defaultPorts: Record<ProxyType, number> = { http: 80, https: 443, socks5: 1080 };

/** Parses "type://host:port"; credentials embedded in the URL are returned separately. */
export function parseProxyUrl(raw: string): UpstreamProxy {
  let url: URL;
  const value = raw.trim();
  try { url = new URL(value); } catch { throw new AppError(400, '代理地址无效，格式例如 http://proxy.example.com:8080 或 socks5://127.0.0.1:1080'); }
  const type = url.protocol.slice(0, -1) as ProxyType;
  if (!['http', 'https', 'socks5'].includes(type)) throw new AppError(400, '代理只支持 http://、https:// 或 socks5://');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new AppError(400, '代理地址只能包含协议、主机和端口');
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (!host) throw new AppError(400, '代理地址缺少主机名');
  const port = url.port ? Number(url.port) : defaultPorts[type];
  const proxy: UpstreamProxy = { type, host: host.toLowerCase(), port };
  if (url.username || url.password) {
    proxy.username = decodeURIComponent(url.username);
    proxy.password = decodeURIComponent(url.password);
  }
  return proxy;
}

function credential(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new AppError(400, `${label}必须是字符串`);
  // RFC 1929 limits SOCKS5 user names and passwords to 255 bytes.
  if (Buffer.byteLength(value, 'utf8') > NETWORK_LIMITS.proxyUser) throw new AppError(400, `${label}不能超过 ${NETWORK_LIMITS.proxyUser} 字节`);
  if (/[\x00-\x1f\x7f]/.test(value)) throw new AppError(400, `${label}不能包含控制字符`);
  return value;
}

/**
 * Validates a create/update body. On update, omitted secrets keep their saved
 * values: `proxyUsername`/`proxyPassword` undefined keeps the saved login,
 * null removes it; a header given without `value` keeps its saved value.
 * Saved proxy logins are never moved to a different proxy server.
 */
export function parseNetworkProfileInput(body: Record<string, unknown>, existing?: NetworkProfileValue): NetworkProfileValue {
  const name = text(body.name, '网络配置名称', NETWORK_LIMITS.name);
  if (!name) throw new AppError(400, '网络配置名称不能为空');

  let proxy: UpstreamProxy | null = null;
  const rawProxy = body.proxyUrl;
  if (rawProxy !== undefined && rawProxy !== null && rawProxy !== '') {
    if (typeof rawProxy !== 'string' || rawProxy.length > 1024) throw new AppError(400, '代理地址无效');
    proxy = parseProxyUrl(rawProxy);
    const embedded = proxy.username !== undefined;
    if (embedded && (body.proxyUsername !== undefined || body.proxyPassword !== undefined)) throw new AppError(400, '代理用户名和密码请只填写一处');
    if (!embedded) {
      if (body.proxyUsername === null || body.proxyUsername === '') {
        // No login.
      } else if (body.proxyUsername !== undefined) {
        proxy.username = credential(body.proxyUsername, '代理用户名');
        proxy.password = body.proxyPassword === undefined || body.proxyPassword === null ? '' : credential(body.proxyPassword, '代理密码');
        if (!proxy.username) throw new AppError(400, '代理用户名不能为空');
      } else if (body.proxyPassword !== undefined && body.proxyPassword !== null && body.proxyPassword !== '') {
        throw new AppError(400, '填写代理密码时也需要填写用户名');
      } else if (existing?.proxy?.username !== undefined) {
        const saved = existing.proxy;
        if (saved.type !== proxy.type || saved.host !== proxy.host || saved.port !== proxy.port) {
          throw new AppError(400, '代理地址已更改，请重新填写代理用户名和密码，或选择不使用认证');
        }
        proxy.username = saved.username;
        proxy.password = saved.password;
      }
    } else {
      proxy.username = credential(proxy.username, '代理用户名');
      proxy.password = credential(proxy.password ?? '', '代理密码');
    }
  }

  const userAgent = text(body.userAgent, 'User-Agent', NETWORK_LIMITS.userAgent);
  const refererText = text(body.referer, 'Referer', NETWORK_LIMITS.referer);
  let referer: string | undefined;
  if (refererText) {
    let parsed: URL;
    try { parsed = new URL(refererText); } catch { throw new AppError(400, 'Referer 必须是完整的 HTTP(S) 网址'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new AppError(400, 'Referer 只能是不带账号密码的 HTTP(S) 网址');
    referer = parsed.href;
  }

  const headers: CustomHeader[] = [];
  if (body.headers !== undefined && body.headers !== null) {
    if (!Array.isArray(body.headers)) throw new AppError(400, '额外请求头格式无效');
    if (body.headers.length > NETWORK_LIMITS.headers) throw new AppError(400, `额外请求头最多 ${NETWORK_LIMITS.headers} 个`);
    const seen = new Set<string>();
    for (const raw of body.headers) {
      const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const headerName = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (!headerName || headerName.length > NETWORK_LIMITS.headerName || !TOKEN.test(headerName)) throw new AppError(400, `请求头名称无效：只能使用字母、数字和 - 等符号，最长 ${NETWORK_LIMITS.headerName} 个字符`);
      const reason = forbiddenHeaderReason(headerName);
      if (reason) throw new AppError(400, reason);
      const key = headerName.toLowerCase();
      if (seen.has(key)) throw new AppError(400, `请求头 ${headerName} 重复`);
      seen.add(key);
      let value: string | undefined;
      if (entry.value === undefined || entry.value === null) {
        value = existing?.headers.find(header => header.name.toLowerCase() === key)?.value;
        if (value === undefined) throw new AppError(400, `请填写请求头 ${headerName} 的值`);
      } else {
        if (typeof entry.value !== 'string') throw new AppError(400, `请求头 ${headerName} 的值必须是字符串`);
        if (entry.value.length > NETWORK_LIMITS.headerValue) throw new AppError(400, `请求头 ${headerName} 的值不能超过 ${NETWORK_LIMITS.headerValue} 个字符`);
        if (!HEADER_VALUE.test(entry.value)) throw new AppError(400, `请求头 ${headerName} 的值只能包含可见 ASCII 字符，不能换行`);
        value = entry.value.trim();
      }
      headers.push({ name: headerName, value });
    }
  }

  if (!proxy && !userAgent && !referer && !headers.length) throw new AppError(400, '请至少设置代理、User-Agent、Referer 或一个请求头');
  return { name, proxy, ...(userAgent ? { userAgent } : {}), ...(referer ? { referer } : {}), headers };
}

export function networkOptions(profile: NetworkProfileValue | null | undefined): FetchNetworkOptions | undefined {
  if (!profile) return undefined;
  return {
    ...(profile.proxy ? { proxy: profile.proxy } : {}),
    ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
    ...(profile.referer ? { referer: profile.referer } : {}),
    ...(profile.headers.length ? { headers: profile.headers } : {}),
  };
}

/**
 * Custom header values may be secrets (API keys). They go only to the feed's
 * own site: its host and subdomains (a leading "www." is ignored), never to
 * third-party scripts, images or redirects elsewhere, and never over plain
 * HTTP when the feed itself uses HTTPS.
 */
export function headerScopeMatches(requestUrl: string, feedUrl: string): boolean {
  let request: URL, feed: URL;
  try { request = new URL(requestUrl); feed = new URL(feedUrl); } catch { return false; }
  if (!['http:', 'https:'].includes(request.protocol)) return false;
  if (feed.protocol === 'https:' && request.protocol !== 'https:') return false;
  const host = request.hostname.toLowerCase();
  const feedHost = feed.hostname.toLowerCase();
  if (isIP(feedHost.replace(/^\[|\]$/g, ''))) return host === feedHost;
  const base = feedHost.replace(/^www\./, '');
  return host === base || host.endsWith(`.${base}`);
}

/** Header object for the Node HTTP fetch, lower-cased. */
export function scopedHeaders(network: FetchNetworkOptions | undefined, requestUrl: string, feedUrl: string): Record<string, string> {
  if (!network?.headers?.length || !headerScopeMatches(requestUrl, feedUrl)) return {};
  return Object.fromEntries(network.headers.map(header => [header.name.toLowerCase(), header.value]));
}
