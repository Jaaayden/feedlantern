import type { Cookie } from 'playwright';

export type CookieFormat = 'header' | 'json';

/**
 * Playwright deliberately exposes a smaller cookie shape than the formats
 * exported by Chromium extensions.  Keep the source metadata on the object
 * while returning a normal Playwright-compatible cookie.  BrowserService
 * strips the metadata before passing the object to context.addCookies().
 */
export type FeedLanternCookie = Cookie & {
  hostOnly?: boolean;
  expirationDate?: number;
  session?: boolean;
  partitioned?: boolean;
};

interface RawCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  url?: unknown;
  expires?: unknown;
  expirationDate?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  sameSite?: unknown;
  hostOnly?: unknown;
  session?: unknown;
  partitionKey?: unknown;
  partitioned?: unknown;
}

const COOKIE_NAME = /^[^\s;,=]+$/;
const COOKIE_DOMAIN = /^[a-z0-9._:-]+$/i;

export class CookieParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CookieParseError';
  }
}

function targetUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CookieParseError('Cookie 绑定目标 URL 无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CookieParseError('Cookie 绑定目标只能使用 HTTP 或 HTTPS');
  }
  return parsed;
}

function asString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new CookieParseError(`Cookie 字段 ${field} 必须是字符串`);
  return value;
}

function asBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new CookieParseError(`Cookie 字段 ${field} 必须是布尔值`);
}

function parseExpires(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '' || value === 0) return undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) value = numeric;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CookieParseError(`Cookie 字段 ${field} 必须是 Unix 秒数`);
  }
  // A few exporters write milliseconds despite calling the field expires.
  // Treat values above 10^11 as milliseconds, while retaining seconds in the
  // public expirationDate metadata.
  const seconds = value > 100_000_000_000 ? value / 1000 : value;
  if (seconds <= 0) return undefined;
  return Math.floor(seconds);
}

function normalizeSameSite(value: unknown): Cookie['sameSite'] | undefined {
  if (value === undefined || value === null || value === '' || value === 'unspecified') return undefined;
  if (typeof value !== 'string') throw new CookieParseError('Cookie 字段 sameSite 必须是字符串');
  switch (value.toLowerCase()) {
    case 'strict':
      return 'Strict';
    case 'lax':
      return 'Lax';
    case 'none':
    case 'no_restriction':
    case 'no-restriction':
      return 'None';
    default:
      throw new CookieParseError(`不支持的 Cookie sameSite 值：${value}`);
  }
}

function hostFromCookie(raw: RawCookie): { domain?: string; hostOnly: boolean; url?: string } {
  const sourceUrl = asString(raw.url, 'url');
  let domain = asString(raw.domain, 'domain');
  let url = sourceUrl;
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new CookieParseError('Cookie url 只能使用 HTTP 或 HTTPS');
      }
      if (!domain) domain = parsed.hostname;
    } catch (error) {
      if (error instanceof CookieParseError) throw error;
      throw new CookieParseError('Cookie url 无效');
    }
  }
  if (domain) {
    domain = domain.trim().toLowerCase();
    if (domain.startsWith('http://') || domain.startsWith('https://')) {
      try {
        domain = new URL(domain).hostname;
      } catch {
        throw new CookieParseError('Cookie domain 无效');
      }
    }
    if (domain.startsWith('[') && domain.endsWith(']')) domain = domain.slice(1, -1);
    if (!COOKIE_DOMAIN.test(domain) || domain === '.') throw new CookieParseError('Cookie domain 无效');
  }
  const explicitHostOnly = asBoolean(raw.hostOnly, 'hostOnly');
  const hostOnly = explicitHostOnly ?? !domain?.startsWith('.');
  if (explicitHostOnly === false && domain && !domain.startsWith('.')) domain = `.${domain}`;
  if (domain?.startsWith('.') && explicitHostOnly === true) {
    // Preserve the caller's intent by removing the subdomain marker.  A
    // leading dot is what makes a Chromium cookie apply to subdomains.
    domain = domain.slice(1);
  }
  return { domain, hostOnly, url };
}

function domainMatches(hostname: string, domain: string, hostOnly: boolean): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const normalized = domain.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  return hostOnly ? host === normalized : host === normalized || host.endsWith(`.${normalized}`);
}

function pathMatches(pathname: string, cookiePath: string): boolean {
  if (!cookiePath.startsWith('/')) return false;
  if (pathname === cookiePath) return true;
  if (!pathname.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || pathname[cookiePath.length] === '/';
}

function normalizeCookie(raw: RawCookie, target: URL): FeedLanternCookie | undefined {
  const partitioned = asBoolean(raw.partitioned, 'partitioned') ?? false;
  if (raw.partitionKey !== undefined || partitioned) {
    throw new CookieParseError('暂不支持 partitioned/CHIPS Cookie，请导出普通 Cookie');
  }
  const name = asString(raw.name, 'name');
  const value = asString(raw.value, 'value');
  if (!name || !COOKIE_NAME.test(name)) throw new CookieParseError('Cookie name 无效');
  if (value === undefined) throw new CookieParseError(`Cookie ${name} 缺少 value`);

  const host = hostFromCookie(raw);
  const domain = host.domain ?? target.hostname;
  const path = asString(raw.path, 'path') ?? '/';
  if (!path.startsWith('/')) throw new CookieParseError(`Cookie ${name} 的 path 必须以 / 开头`);
  if (!domainMatches(target.hostname, domain, host.hostOnly)) return undefined;
  // Keep cookies for other paths on the same host: a page at /feed often
  // obtains its data from /api, and the browser must be able to send that
  // cookie after navigation or XHR.  Domain filtering is the cross-site
  // boundary; path is enforced by Chromium itself.

  const expirationDate = parseExpires(raw.expirationDate ?? raw.expires, 'expirationDate');
  const session = asBoolean(raw.session, 'session') ?? expirationDate === undefined;
  const sameSite = normalizeSameSite(raw.sameSite);
  const secure = asBoolean(raw.secure, 'secure') ?? false;
  const httpOnly = asBoolean(raw.httpOnly, 'httpOnly') ?? false;

  const result: FeedLanternCookie = {
    name,
    value,
    domain: domain.startsWith('.') && !host.hostOnly ? domain : domain.replace(/^\./, ''),
    path,
    expires: session ? -1 : expirationDate ?? -1,
    httpOnly,
    secure,
    sameSite: sameSite ?? 'Lax',
    hostOnly: host.hostOnly,
    expirationDate,
    session,
  };
  if (host.url) {
    try {
      const cookieUrl = new URL(host.url);
      if (!domainMatches(cookieUrl.hostname, domain, host.hostOnly)) return undefined;
      result.domain = domain;
    } catch {
      throw new CookieParseError(`Cookie ${name} 的 url 无效`);
    }
  }
  return result;
}

function parseHeader(header: string, target: URL): FeedLanternCookie[] {
  const normalized = header.trim().replace(/^Cookie\s*:\s*/i, '');
  if (!normalized) return [];
  const result: FeedLanternCookie[] = [];
  for (const part of normalized.split(';').map(item => item.trim()).filter(Boolean)) {
    const separator = part.indexOf('=');
    if (separator <= 0) throw new CookieParseError('Cookie header 中存在缺少 name 或 value 的片段');
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    const cookie = normalizeCookie({ name, value, domain: target.hostname, path: '/' }, target);
    if (cookie) {
      // A pasted Cookie header has already been observed on this origin. On
      // HTTPS, retaining it as Secure prevents an accidental downgrade; the
      // prefix rules also require Secure for these cookies.
      cookie.secure = target.protocol === 'https:' || name.startsWith('__Secure-') || name.startsWith('__Host-');
      if (name.startsWith('__Host-')) cookie.path = '/';
      result.push(cookie);
    }
  }
  return result;
}

function parseJson(value: string, target: URL): FeedLanternCookie[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CookieParseError('OpenCookie JSON 无法解析');
  }
  const records = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown }).cookies)
      ? (parsed as { cookies: unknown[] }).cookies
      : null;
  if (!records) throw new CookieParseError('OpenCookie JSON 必须是 Cookie 数组或 { cookies: [...] }');
  const result: FeedLanternCookie[] = [];
  for (const entry of records) {
    if (!entry || typeof entry !== 'object') throw new CookieParseError('OpenCookie JSON 中存在无效 Cookie');
    const cookie = normalizeCookie(entry as RawCookie, target);
    if (cookie) result.push(cookie);
  }
  return result;
}

/**
 * Parse a browser Cookie header or OpenCookie/Chromium JSON export.
 * Cookies belonging to another domain are silently filtered to prevent a
 * credential accidentally being reused for a different target.
 */
export function parseCookies(value: string, format: CookieFormat, url: string): Cookie[] {
  const target = targetUrl(url);
  const cookies = format === 'header' ? parseHeader(value, target) : parseJson(value, target);
  return cookies as Cookie[];
}

/** Filter a caller-provided Playwright cookie list to the target URL. */
export function cookiesForUrl(cookies: readonly Cookie[], url: string): Cookie[] {
  const target = targetUrl(url);
  const result: FeedLanternCookie[] = [];
  for (const input of cookies) {
    const raw = input as FeedLanternCookie;
    const normalized = normalizeCookie(
      {
        name: raw.name,
        value: raw.value,
        domain: raw.domain,
        path: raw.path,
        expires: raw.expires,
        httpOnly: raw.httpOnly,
        secure: raw.secure,
        sameSite: raw.sameSite,
        hostOnly: raw.hostOnly,
        expirationDate: raw.expirationDate,
        session: raw.session,
        partitionKey: raw.partitionKey,
        partitioned: raw.partitioned,
      },
      target,
    );
    if (normalized) result.push(normalized);
  }
  return result as Cookie[];
}

/** Remove extension-only metadata before handing a cookie to Playwright. */
export function toPlaywrightCookies(cookies: readonly Cookie[]): Array<{
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}> {
  return cookies.map(cookie => {
    const item = cookie as FeedLanternCookie;
    const output: {
      name: string;
      value: string;
      domain?: string;
      path?: string;
      expires?: number;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: 'Strict' | 'Lax' | 'None';
    } = {
      name: item.name,
      value: item.value,
      domain: item.domain,
      path: item.path,
      expires: item.session ? -1 : item.expires,
      httpOnly: item.httpOnly,
      secure: item.secure,
      sameSite: item.sameSite,
    };
    return output;
  });
}
