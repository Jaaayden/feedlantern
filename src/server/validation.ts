import { ZodError } from 'zod';
import { FetchTimeoutError } from './fetch-errors.js';
import type { Cookie } from 'playwright';
import { isTargetLanguage, isTranslationProvider, paginationLimits, type FeedInput, type PaginationRules, type SelectionRules, type TargetLanguage, type TranslationMode, type TranslationProviderId } from '../shared/types.js';
import { AppError } from './auth.js';
import { CookieParseError } from './cookies.js';
import { redactForLog } from './log.js';
import type { CredentialValue } from './store.js';

interface FeedBody {
  pagination?: unknown;
  sourceType?: unknown;
  translationMode?: unknown;
  targetLanguage?: unknown;
  translationProvider?: unknown;
  name?: unknown;
  url?: unknown;
  rules?: unknown;
  ruleOrigins?: unknown;
  credentialId?: unknown;
  networkProfileId?: unknown;
  intervalMinutes?: unknown;
  waitMs?: unknown;
  waitForSelector?: unknown;
}

interface CredentialBody {
  name?: unknown;
  url?: unknown;
  format?: unknown;
  value?: unknown;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function asNonEmptyString(value: unknown, label: string, max = 20_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(400, `${label}不能为空且长度不能超过 ${max}`);
  return value.trim();
}

export function asOptionalString(value: unknown, label: string, max = 20_000): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return asNonEmptyString(value, label, max);
}

function asOptionalSelector(value: unknown, label: string, max = 4_000): string | undefined {
  // The editor sends an empty string when a user deliberately clears an
  // optional field. Treat it as absent instead of rejecting the whole form.
  if (value === undefined || value === null || value === '') return undefined;
  return asNonEmptyString(value, label, max);
}

export function asInteger(value: unknown, label: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new AppError(400, `${label}必须是 ${min} 到 ${max} 之间的整数`);
  return number;
}

export function parseHttpUrl(value: unknown, label: string): string {
  const text = asNonEmptyString(value, label, 4_000);
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new AppError(400, `${label}不是有效 URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new AppError(400, `${label}只能使用不带账号密码的 HTTP 或 HTTPS URL`);
  return parsed.toString();
}

export function parseRules(value: unknown): SelectionRules {
  const record = asRecord(value);
  return {
    item: asNonEmptyString(record.item, 'item selector', 4_000),
    title: asNonEmptyString(record.title, 'title selector', 4_000),
    link: asNonEmptyString(record.link, 'link selector', 4_000),
    ...(asOptionalSelector(record.description, 'description selector') ? { description: asOptionalSelector(record.description, 'description selector') } : {}),
    ...(asOptionalSelector(record.image, 'image selector') ? { image: asOptionalSelector(record.image, 'image selector') } : {}),
    ...(asOptionalSelector(record.date, 'date selector') ? { date: asOptionalSelector(record.date, 'date selector') } : {}),
  };
}

/** Rules being edited in the picker: every field optional, empty means absent. */
export function parsePartialRules(value: unknown): Partial<SelectionRules> {
  const record = asRecord(value);
  const output: Partial<SelectionRules> = {};
  for (const key of ['item', 'title', 'link', 'description', 'image', 'date'] as const) {
    const selector = asOptionalSelector(record[key], `${key} selector`);
    if (selector) output[key] = selector;
  }
  return output;
}

function parseRuleOrigins(value: unknown): FeedInput['ruleOrigins'] {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  const output: NonNullable<FeedInput['ruleOrigins']> = {};
  for (const key of ['item', 'title', 'link', 'description', 'image', 'date'] as const) {
    if (record[key] === undefined) continue;
    if (record[key] !== 'auto' && record[key] !== 'manual') throw new AppError(400, 'ruleOrigins 只能使用 auto 或 manual');
    output[key] = record[key];
  }
  return output;
}

/** `chinese` is the pre-0.7 name of `translated` and is still accepted from older clients and files. */
export function parseTranslationMode(value: unknown): TranslationMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'chinese') return 'translated';
  if (value === 'original' || value === 'translated' || value === 'bilingual') return value;
  throw new AppError(400, '翻译输出模式无效');
}
export function parseTargetLanguage(value: unknown): TargetLanguage | undefined {
  if (value === undefined) return undefined;
  if (!isTargetLanguage(value)) throw new AppError(400, '翻译目标语言无效');
  return value;
}
/** `null` (or an empty string) follows the instance default service. */
export function parseTranslationProvider(value: unknown): TranslationProviderId | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!isTranslationProvider(value)) throw new AppError(400, '翻译服务无效');
  return value;
}

/** Fill `{n}` of a pagination URL template. */
export function templateUrl(template: string, n: number): string {
  return template.replaceAll('{n}', String(n));
}

/**
 * Multi-page settings. Absent stays undefined (keep the saved setting), null or
 * mode "none" means a single page. Limits keep collection gentle on the site.
 */
export function parsePagination(value: unknown): PaginationRules | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const record = asRecord(value);
  if (record.mode === undefined || record.mode === 'none') return null;
  if (!['next', 'template', 'loadMore'].includes(String(record.mode))) throw new AppError(400, '翻页方式无效');
  const mode = record.mode as PaginationRules['mode'];
  const maxPages = asInteger(record.maxPages, '最多翻页数', 1, paginationLimits.maxPages, 3);
  const delayMs = asInteger(record.delayMs, '翻页间隔（毫秒）', paginationLimits.minDelayMs, paginationLimits.maxDelayMs, paginationLimits.defaultDelayMs);
  if (mode === 'template') {
    const urlTemplate = asNonEmptyString(record.urlTemplate, 'URL 模板', 4_000);
    if (!urlTemplate.includes('{n}')) throw new AppError(400, 'URL 模板需要包含页码占位符 {n}');
    const start = asInteger(record.start, '起始页码', 0, 1_000_000, 2);
    const step = asInteger(record.step, '页码步长', 1, 10_000, 1);
    parseHttpUrl(templateUrl(urlTemplate, start), 'URL 模板');
    return { mode, maxPages, delayMs, urlTemplate, start, step };
  }
  const nextSelector = asNonEmptyString(record.nextSelector, mode === 'next' ? '下一页选择器' : '加载更多按钮选择器', 4_000);
  return { mode, maxPages, delayMs, nextSelector };
}

export function parseFeedInput(value: unknown): FeedInput {
  const record = asRecord(value) as FeedBody;
  if (record.sourceType !== undefined && !['website','rss'].includes(String(record.sourceType))) throw new AppError(400, '订阅来源类型无效');
  const mode = parseTranslationMode(record.translationMode);
  const targetLanguage = parseTargetLanguage(record.targetLanguage);
  const translationProvider = parseTranslationProvider(record.translationProvider);
  const rss = record.sourceType === 'rss';
  const credentialId = record.credentialId === undefined || record.credentialId === null || record.credentialId === '' ? null : asNonEmptyString(record.credentialId, 'credentialId', 200);
  const pagination = rss ? null : parsePagination(record.pagination);
  return {
    ...(pagination !== undefined ? { pagination } : {}),
    sourceType: rss ? 'rss' : 'website',
    translationMode: mode ?? (rss ? 'bilingual' : undefined),
    ...(targetLanguage ? { targetLanguage } : {}),
    ...(translationProvider !== undefined ? { translationProvider } : {}),
    name: asNonEmptyString(record.name, 'feed name', 200),
    url: parseHttpUrl(record.url, 'feed URL'),
    rules: rss ? { item: '', title: '', link: '' } : parseRules(record.rules),
    ruleOrigins: parseRuleOrigins(record.ruleOrigins),
    credentialId: rss ? null : credentialId,
    // Omitted keeps the saved profile on update; null or '' removes it.
    ...(record.networkProfileId === undefined ? {} : { networkProfileId: record.networkProfileId === null || record.networkProfileId === '' ? null : asNonEmptyString(record.networkProfileId, 'networkProfileId', 200) }),
    intervalMinutes: asInteger(record.intervalMinutes, 'intervalMinutes', 5, 1_440, rss ? 30 : 60),
    waitMs: asInteger(record.waitMs, 'waitMs', 0, 10_000, 1_000),
    ...(record.waitForSelector ? { waitForSelector: asNonEmptyString(record.waitForSelector, 'waitForSelector', 4_000) } : {}),
  };
}

export function parseCredentialInput(value: unknown): CredentialValue {
  const record = asRecord(value) as CredentialBody;
  if (record.format !== 'header' && record.format !== 'json') throw new AppError(400, 'Cookie 格式必须是 header 或 json');
  const url = parseHttpUrl(record.url, 'Cookie 绑定 URL');
  const name = asNonEmptyString(record.name, 'Cookie 凭据名称', 200);
  const cookieValue = asNonEmptyString(record.value, 'Cookie 内容', 2_000_000);
  return { name, url, format: record.format, value: cookieValue };
}

export function friendlyError(error: unknown, fallback: string): string {
  if (error instanceof CookieParseError) return error.message;
  if (error instanceof AppError) return error.message;
  // Names only the host, so it is safe to show as is.
  if (error instanceof FetchTimeoutError) return error.message;
  // Node and Playwright report these in English ("The operation was aborted").
  if (error instanceof Error && error.name === 'TimeoutError') return '请求超时，目标网站长时间未响应';
  if (error instanceof Error && error.name === 'AbortError') return '操作已中止（已取消或服务正在停止）';
  if (error instanceof Error) {
    const message = error.message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi, '[已隐藏]@').replace(/https?:\/\/[^\s)]+/gi, '[目标页面]').replace(/(?:cookie|authorization|set-cookie)\s*[:=][^\n]*/gi, '[敏感请求头已隐藏]');
    if (message && message.length <= 300 && !/\n|stack|at\s+/.test(message)) return message;
  }
  return fallback;
}

/** Log the original error when the user only sees a summary of it. */
export function logHiddenError(where: string, error: unknown, shown: string): void {
  if (error instanceof Error && error.message === shown) return;
  console.error(`${where}：${redactForLog(describeError(error))}`);
}

export function frameError(error: unknown, action = '网页操作'): AppError {
  const shown = friendlyError(error, '网页操作失败，请检查目标页面和等待条件');
  logHiddenError(`${action}失败`, error, shown);
  return new AppError(400, shown);
}

export function cookieMetadata(cookies: readonly Cookie[], url: string): { domains: string[]; count: number; expiresAt: string | null } {
  const target = new URL(url);
  const domains = Array.from(new Set(cookies.map((cookie) => cookie.domain || target.hostname).filter(Boolean))).sort();
  const expirations = cookies.map((cookie) => cookie.expires).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  const expiresAt = expirations.length ? new Date(Math.min(...expirations) * 1000).toISOString() : null;
  return { domains, count: cookies.length, expiresAt };
}

/** Summarize an error for logs and operator-facing messages without echoing any data values. */
export function describeError(error: unknown): string {
  if (error instanceof ZodError) {
    const issues = error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || '(root)'}（${issue.code}）`);
    return issues.join('；') + (error.issues.length > 5 ? `；另有 ${error.issues.length - 5} 处` : '');
  }
  if (error instanceof Error) return `${error.name}: ${error.message}${error.stack ? ' | ' + error.stack.split('\n').slice(1, 4).map(line => line.trim()).join(' <- ') : ''}`;
  return String(error);
}
