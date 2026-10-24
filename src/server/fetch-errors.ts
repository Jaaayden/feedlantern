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

/**
 * User-visible messages for sources that do not answer with a feed, and for
 * PubMed sources fetched through NCBI E-utilities. Kept together here so
 * they can move to the language files in one place. None of them contains
 * an address, so they are safe in fetch logs, the feed list and alerts.
 */
export const sourceMessages = {
  /** An HTML page where a feed was expected. */
  htmlPage: (status?: number) => `来源返回的是网页而不是 RSS/Atom${status ? `（HTTP ${status}）` : ''}。可能是对方的反爬验证页或登录页，FeedLantern 不会尝试绕过；请确认地址是订阅源地址。`,
  /** An HTML page that looks like a bot or cookie check. `marker` is the recognised keyword. */
  challengePage: (status: number | undefined, marker: string) => `来源返回的是反爬验证页而不是 RSS/Atom（${status ? `HTTP ${status}，` : ''}页面含 ${marker} 标记）。FeedLantern 不会尝试绕过对方的验证，请改用对方提供的官方接口或稍后重试。`,
  /** A 2xx answer other than 200 that is not an HTML page. */
  unexpectedStatus: (status: number) => `来源返回 HTTP ${status}，不是正常的订阅响应（应为 HTTP 200）${status === 203 ? '：内容可能被中间代理或对方的验证机制替换' : ''}。`,
  /** A non-2xx answer whose body is a bot check. */
  challengeStatus: (status: number, marker: string) => `RSS 获取失败（HTTP ${status}）：来源返回了反爬验证页（页面含 ${marker} 标记），FeedLantern 不会尝试绕过。`,
  pubmed: {
    rateLimited: 'NCBI E-utilities 请求过于频繁（HTTP 429），请稍后重试；管理员可以在“设置 → PubMed（NCBI）”中填写 NCBI API Key 提高限额。',
    invalidKey: 'NCBI 拒绝了 API Key，请管理员在“设置 → PubMed（NCBI）”中检查或删除它。',
    httpError: (status: number) => `NCBI E-utilities 请求失败（HTTP ${status}），请稍后重试。`,
    htmlPage: (status: number) => `NCBI E-utilities 返回的是网页而不是数据（HTTP ${status}），请稍后重试。`,
    serviceError: (detail: string) => `NCBI E-utilities 返回错误：${detail}`,
    unreadable: 'NCBI E-utilities 返回的数据无法解析，请稍后重试。',
    journalNotFound: (nlmId: string) => `PubMed 中没有找到 NLM ID 为 ${nlmId} 的期刊，请检查订阅地址。`,
  },
} as const;

/** The source answered, but not with a feed (an HTML page, a bot check, an unusual status). */
export class NotAFeedError extends Error {
  override name = 'NotAFeedError';
}

/** A readable failure from NCBI E-utilities; the message never contains the request address or the API key. */
export class NcbiError extends Error {
  override name = 'NcbiError';
  constructor(message: string, readonly status?: number) { super(message); }
}

/**
 * Keywords of common bot checks and cookie walls, matched case-insensitively
 * in the first part of an HTML page. The first match is named in the message.
 */
const CHALLENGE_MARKERS: ReadonlyArray<[RegExp, string]> = [
  [/cookies-required/i, 'cookies-required'],
  [/identity_pow|proof[-_ ]of[-_ ]work/i, 'proof-of-work'],
  [/g-recaptcha|recaptcha/i, 'reCAPTCHA'],
  [/h-captcha|hcaptcha/i, 'hCaptcha'],
  [/cf-turnstile|challenges\.cloudflare\.com|cf_chl_|cf-chl-|cf-browser-verification/i, 'Cloudflare challenge'],
  [/captcha/i, 'captcha'],
  [/challenge/i, 'challenge'],
  [/verify (?:that )?you are (?:a )?human|are you a robot|checking your browser/i, 'human verification'],
  [/人机验证|安全验证|滑动验证/, '人机验证'],
];

/** The recognised bot-check keyword in an HTML page, if any. */
export function challengeMarker(html: string): string | undefined {
  const head = html.slice(0, 100_000);
  return CHALLENGE_MARKERS.find(([pattern]) => pattern.test(head))?.[1];
}

/** Whether a response body starts as an HTML document (after a BOM, an XML declaration or comments). */
export function looksLikeHtml(body: string): boolean {
  const start = body.slice(0, 4096).replace(/^﻿/, '').replace(/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*/i, '');
  return /^<!doctype\s+html[\s>]/i.test(start) || /^<html[\s>/]/i.test(start);
}

/** Whether a body starts with an XML declaration or a feed root element. */
function looksLikeXml(body: string): boolean {
  return /^\uFEFF?\s*<(?:\?xml|rss[\s>]|feed[\s>]|rdf:RDF[\s>])/i.test(body.slice(0, 4096));
}

/**
 * Why a response is not a feed, checked before any XML parsing: an HTML
 * content type or body, or a 2xx status other than 200. `status` and
 * `contentType` are unknown when only the body is checked. A non-2xx status
 * is reported here only when the page is a recognisable bot check.
 */
export function nonFeedReason(body: string, status?: number, contentType?: string): string | undefined {
  // Some servers label a valid feed text/html: the label counts only when the body does not start like XML.
  const html = looksLikeHtml(body) || /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType ?? '') && !looksLikeXml(body);
  const marker = html ? challengeMarker(body) : undefined;
  if (status !== undefined && (status < 200 || status > 299)) return marker ? sourceMessages.challengeStatus(status, marker) : undefined;
  if (marker) return sourceMessages.challengePage(status, marker);
  if (html) return sourceMessages.htmlPage(status);
  if (status !== undefined && status !== 200) return sourceMessages.unexpectedStatus(status);
  return undefined;
}
