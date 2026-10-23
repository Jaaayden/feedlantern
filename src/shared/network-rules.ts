/** Limits and header rules for network profiles, shared by the API and the editor. */
export const NETWORK_LIMITS = {
  headers: 20,
  headerName: 64,
  headerValue: 2048,
  userAgent: 512,
  referer: 2048,
  proxyUser: 255,
  name: 200,
} as const;

/**
 * Request headers a profile may not set. Host and the hop-by-hop headers
 * would change how the request is routed; Cookie has its own encrypted
 * credential; Proxy-* would talk to the proxy instead of the site; User-Agent
 * and Referer have their own fields. The browser owns the Sec-* headers.
 */
export const FORBIDDEN_HEADERS: readonly string[] = [
  'host', 'cookie', 'cookie2', 'set-cookie',
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'content-length', 'content-encoding', 'expect', 'http2-settings', 'accept-encoding',
  'user-agent', 'referer',
];
export const FORBIDDEN_HEADER_PREFIXES: readonly string[] = ['proxy-', 'sec-', 'x-feedlantern'];

export const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Visible ASCII, space and tab. No CR, LF or NUL, so a value cannot split a header.
export const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

export function forbiddenHeaderReason(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower === 'cookie' || lower === 'cookie2' || lower === 'set-cookie') return `不能设置 ${name} 请求头，请改用 Cookie 凭据`;
  if (lower === 'user-agent' || lower === 'referer') return `${name} 请使用网络配置中的专用字段`;
  if (FORBIDDEN_HEADERS.includes(lower) || FORBIDDEN_HEADER_PREFIXES.some(prefix => lower.startsWith(prefix))) return `不允许设置 ${name} 请求头`;
  return undefined;
}

export function proxyUrl(proxy: { type: string; host: string; port: number }): string {
  return `${proxy.type}://${proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host}:${proxy.port}`;
}

