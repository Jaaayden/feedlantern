/**
 * Readable fetch timeouts. A timeout names only the host and the waiting
 * time, never the full address, so query parameters stay hidden in fetch
 * logs, the feed list and alerts.
 */
import { LocalizedError, msg, type LocalizedText } from './i18n.js';
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

/**
 * User-visible messages for sources that do not answer with a feed, and for
 * PubMed sources fetched through NCBI E-utilities. None of them contains an
 * address, so they are safe in fetch logs, the feed list and alerts.
 */
export const sourceMessages = {
  /** An HTML page where a feed was expected. */
  htmlPage: (status?: number): LocalizedText => status ? msg('source.htmlPageStatus', { status: String(status) }) : msg('source.htmlPage'),
  /** An HTML page that looks like a bot or cookie check. `marker` is the recognised keyword. */
  challengePage: (status: number | undefined, marker: string): LocalizedText => status ? msg('source.challengePageStatus', { status: String(status), marker }) : msg('source.challengePage', { marker }),
  /** A 2xx answer other than 200 that is not an HTML page. */
  unexpectedStatus: (status: number): LocalizedText => status === 203 ? msg('source.status203') : msg('source.unexpectedStatus', { status: String(status) }),
  /** A non-2xx answer whose body is a bot check. */
  challengeStatus: (status: number, marker: string): LocalizedText => msg('source.challengeStatus', { status: String(status), marker }),
  pubmed: {
    rateLimited: msg('ncbi.rateLimited'),
    invalidKey: msg('ncbi.invalidKey'),
    httpError: (status: number): LocalizedText => msg('ncbi.httpError', { status: String(status) }),
    htmlPage: (status: number): LocalizedText => msg('ncbi.htmlPage', { status: String(status) }),
    serviceError: (detail: string): LocalizedText => msg('ncbi.serviceError', { detail }),
    unreadable: msg('ncbi.unreadable'),
    journalNotFound: (nlmId: string): LocalizedText => msg('ncbi.journalNotFound', { nlmId }),
  },
} as const;

/** The source answered, but not with a feed (an HTML page, a bot check, an unusual status). */
export class NotAFeedError extends LocalizedError {
  override name = 'NotAFeedError';
}

/** A readable failure from NCBI E-utilities; the message never contains the request address or the API key. */
export class NcbiError extends LocalizedError {
  override name = 'NcbiError';
  constructor(text: LocalizedText, readonly status?: number) { super(text); }
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
export function nonFeedReason(body: string, status?: number, contentType?: string): LocalizedText | undefined {
  // Some servers label a valid feed text/html: the label counts only when the body does not start like XML.
  const html = looksLikeHtml(body) || /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType ?? '') && !looksLikeXml(body);
  const marker = html ? challengeMarker(body) : undefined;
  if (status !== undefined && (status < 200 || status > 299)) return marker ? sourceMessages.challengeStatus(status, marker) : undefined;
  if (marker) return sourceMessages.challengePage(status, marker);
  if (html) return sourceMessages.htmlPage(status);
  if (status !== undefined && status !== 200) return sourceMessages.unexpectedStatus(status);
  return undefined;
}
