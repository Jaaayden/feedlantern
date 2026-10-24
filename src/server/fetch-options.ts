import { isIP } from 'node:net';
import { AppError } from './auth.js';
import { msg } from './i18n.js';
import type { Param } from '../shared/i18n.js';
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

function text(value: unknown, label: Param, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new AppError(400, msg('error.mustBeString', { label }));
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new AppError(400, msg('error.maxChars', { label, max }));
  if (!HEADER_VALUE.test(trimmed)) throw new AppError(400, msg('error.visibleAscii', { label }));
  return trimmed;
}

const defaultPorts: Record<ProxyType, number> = { http: 80, https: 443, socks5: 1080 };

/** Parses "type://host:port"; credentials embedded in the URL are returned separately. */
export function parseProxyUrl(raw: string): UpstreamProxy {
  let url: URL;
  const value = raw.trim();
  try { url = new URL(value); } catch { throw new AppError(400, 'error.proxyUrlFormat'); }
  const type = url.protocol.slice(0, -1) as ProxyType;
  if (!['http', 'https', 'socks5'].includes(type)) throw new AppError(400, 'error.proxyScheme');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new AppError(400, 'error.proxyUrlExtra');
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (!host) throw new AppError(400, 'error.proxyHostMissing');
  const port = url.port ? Number(url.port) : defaultPorts[type];
  const proxy: UpstreamProxy = { type, host: host.toLowerCase(), port };
  if (url.username || url.password) {
    proxy.username = decodeURIComponent(url.username);
    proxy.password = decodeURIComponent(url.password);
  }
  return proxy;
}

function credential(value: unknown, label: Param): string {
  if (typeof value !== 'string') throw new AppError(400, msg('error.mustBeString', { label }));
  // RFC 1929 limits SOCKS5 user names and passwords to 255 bytes.
  if (Buffer.byteLength(value, 'utf8') > NETWORK_LIMITS.proxyUser) throw new AppError(400, msg('error.maxBytes', { label, max: NETWORK_LIMITS.proxyUser }));
  if (/[\x00-\x1f\x7f]/.test(value)) throw new AppError(400, msg('error.controlChars', { label }));
  return value;
}

/**
 * Validates a create/update body. On update, omitted secrets keep their saved
 * values: `proxyUsername`/`proxyPassword` undefined keeps the saved login,
 * null removes it; a header given without `value` keeps its saved value.
 * Saved proxy logins are never moved to a different proxy server.
 */
export function parseNetworkProfileInput(body: Record<string, unknown>, existing?: NetworkProfileValue): NetworkProfileValue {
  const name = text(body.name, msg('label.networkProfileName'), NETWORK_LIMITS.name);
  if (!name) throw new AppError(400, 'error.networkProfileNameRequired');

  let proxy: UpstreamProxy | null = null;
  const rawProxy = body.proxyUrl;
  if (rawProxy !== undefined && rawProxy !== null && rawProxy !== '') {
    if (typeof rawProxy !== 'string' || rawProxy.length > 1024) throw new AppError(400, 'error.proxyInvalid');
    proxy = parseProxyUrl(rawProxy);
    const embedded = proxy.username !== undefined;
    if (embedded && (body.proxyUsername !== undefined || body.proxyPassword !== undefined)) throw new AppError(400, 'error.proxyCredentialsTwice');
    if (!embedded) {
      if (body.proxyUsername === null || body.proxyUsername === '') {
        // No login.
      } else if (body.proxyUsername !== undefined) {
        proxy.username = credential(body.proxyUsername, msg('label.proxyUsername'));
        proxy.password = body.proxyPassword === undefined || body.proxyPassword === null ? '' : credential(body.proxyPassword, msg('label.proxyPassword'));
        if (!proxy.username) throw new AppError(400, 'error.proxyUserEmpty');
      } else if (body.proxyPassword !== undefined && body.proxyPassword !== null && body.proxyPassword !== '') {
        throw new AppError(400, 'error.proxyUserRequired');
      } else if (existing?.proxy?.username !== undefined) {
        const saved = existing.proxy;
        if (saved.type !== proxy.type || saved.host !== proxy.host || saved.port !== proxy.port) {
          throw new AppError(400, 'error.proxyChanged');
        }
        proxy.username = saved.username;
        proxy.password = saved.password;
      }
    } else {
      proxy.username = credential(proxy.username, msg('label.proxyUsername'));
      proxy.password = credential(proxy.password ?? '', msg('label.proxyPassword'));
    }
  }

  const userAgent = text(body.userAgent, 'User-Agent', NETWORK_LIMITS.userAgent);
  const refererText = text(body.referer, 'Referer', NETWORK_LIMITS.referer);
  let referer: string | undefined;
  if (refererText) {
    let parsed: URL;
    try { parsed = new URL(refererText); } catch { throw new AppError(400, 'error.refererInvalid'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new AppError(400, 'error.refererCredentials');
    referer = parsed.href;
  }

  const headers: CustomHeader[] = [];
  if (body.headers !== undefined && body.headers !== null) {
    if (!Array.isArray(body.headers)) throw new AppError(400, 'error.headersInvalid');
    if (body.headers.length > NETWORK_LIMITS.headers) throw new AppError(400, msg('error.tooManyHeaders', { max: NETWORK_LIMITS.headers }));
    const seen = new Set<string>();
    for (const raw of body.headers) {
      const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const headerName = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (!headerName || headerName.length > NETWORK_LIMITS.headerName || !TOKEN.test(headerName)) throw new AppError(400, msg('error.headerNameInvalid', { max: NETWORK_LIMITS.headerName }));
      const reason = forbiddenHeaderReason(headerName);
      if (reason) throw new AppError(400, reason);
      const key = headerName.toLowerCase();
      if (seen.has(key)) throw new AppError(400, msg('error.headerDuplicate', { name: headerName }));
      seen.add(key);
      let value: string | undefined;
      if (entry.value === undefined || entry.value === null) {
        value = existing?.headers.find(header => header.name.toLowerCase() === key)?.value;
        if (value === undefined) throw new AppError(400, msg('error.headerValueRequired', { name: headerName }));
      } else {
        if (typeof entry.value !== 'string') throw new AppError(400, msg('error.headerValueString', { name: headerName }));
        if (entry.value.length > NETWORK_LIMITS.headerValue) throw new AppError(400, msg('error.headerValueLong', { name: headerName, max: NETWORK_LIMITS.headerValue }));
        if (!HEADER_VALUE.test(entry.value)) throw new AppError(400, msg('error.headerValueAscii', { name: headerName }));
        value = entry.value.trim();
      }
      headers.push({ name: headerName, value });
    }
  }

  if (!proxy && !userAgent && !referer && !headers.length) throw new AppError(400, 'error.networkProfileEmpty');
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
