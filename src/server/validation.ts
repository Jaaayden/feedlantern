import { ZodError } from 'zod';
import type { Cookie } from 'playwright';
import type { FeedInput, SelectionRules } from '../shared/types.js';
import { AppError } from './auth.js';
import { CookieParseError } from './cookies.js';
import type { CredentialValue } from './store.js';

interface FeedBody {
  sourceType?: unknown;
  translationMode?: unknown;
  name?: unknown;
  url?: unknown;
  rules?: unknown;
  ruleOrigins?: unknown;
  credentialId?: unknown;
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

export function parseFeedInput(value: unknown): FeedInput {
  const record = asRecord(value) as FeedBody;
  if (record.sourceType !== undefined && !['website','rss'].includes(String(record.sourceType))) throw new AppError(400, '订阅来源类型无效');
  if (record.translationMode !== undefined && !['original','chinese','bilingual'].includes(String(record.translationMode))) throw new AppError(400, '翻译输出模式无效');
  const rss = record.sourceType === 'rss';
  const credentialId = record.credentialId === undefined || record.credentialId === null || record.credentialId === '' ? null : asNonEmptyString(record.credentialId, 'credentialId', 200);
  return {
    sourceType: rss ? 'rss' : 'website',
    translationMode: record.translationMode === 'original' ? 'original' : record.translationMode === 'chinese' ? 'chinese' : record.translationMode === 'bilingual' || rss ? 'bilingual' : undefined,
    name: asNonEmptyString(record.name, 'feed name', 200),
    url: parseHttpUrl(record.url, 'feed URL'),
    rules: rss ? { item: '', title: '', link: '' } : parseRules(record.rules),
    ruleOrigins: parseRuleOrigins(record.ruleOrigins),
    credentialId: rss ? null : credentialId,
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
  if (error instanceof Error) {
    const message = error.message.replace(/https?:\/\/[^\s)]+/gi, '[目标页面]').replace(/(?:cookie|authorization|set-cookie)\s*[:=][^\n]*/gi, '[敏感请求头已隐藏]');
    if (message && message.length <= 300 && !/\n|stack|at\s+/.test(message)) return message;
  }
  return fallback;
}

export function frameError(error: unknown): AppError {
  return new AppError(400, friendlyError(error, '网页操作失败，请检查目标页面和等待条件'));
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
