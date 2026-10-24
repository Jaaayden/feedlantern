/**
 * A small, dependency-free i18n layer shared by the server and the web UI.
 *
 * - `en` is the reference catalog: its keys define `MessageKey`, and every
 *   other catalog must provide the same keys (`LocaleMessages` makes a missing
 *   key a type error; `tests/i18n.test.ts` also checks placeholders).
 * - `{name}` placeholders are filled from params. A param can itself be a
 *   `LocalizedText` (see `msg`), which is translated in the same language.
 * - A message can have plural forms (`{ one, other }`), chosen with
 *   `Intl.PluralRules` from the `count` param.
 * - Dates, numbers, lists and relative times are formatted with `Intl`.
 *
 * Adding a language: copy `locales/en.ts`, translate it, and register it in
 * `locales/index.ts`.
 */
import type en from './locales/en.js';
import { catalogs } from './locales/index.js';

export type PluralMessage = { readonly zero?: string; readonly one?: string; readonly two?: string; readonly few?: string; readonly many?: string; readonly other: string };
export type MessageValue = string | PluralMessage;
type Reference = typeof en;
export type MessageKey = keyof Reference & string;
/** A complete catalog for one language. */
export type LocaleMessages = { readonly [K in MessageKey]: MessageValue };
export type ErrorKey = Extract<MessageKey, `error.${string}`>;

export interface LocaleCatalog {
  /** BCP 47 tag, also used for `Intl` and `<html lang>`. */
  code: string;
  /** The language's own name, shown in language pickers. */
  name: string;
  messages: LocaleMessages;
}

export type Locale = keyof typeof catalogs & string;
export const DEFAULT_LOCALE: Locale = 'en';
export const locales = Object.keys(catalogs) as Locale[];
export const localeNames = Object.fromEntries(locales.map(code => [code, catalogs[code].name])) as Record<Locale, string>;
export const isLocale = (value: unknown): value is Locale => typeof value === 'string' && Object.hasOwn(catalogs, value);
export const isMessageKey = (value: unknown): value is MessageKey => typeof value === 'string' && Object.hasOwn(catalogs.en.messages, value);

/** Text to translate later, in whichever language the reader uses. */
export interface LocalizedText { key: MessageKey; params?: Params }
export type Param = string | number | LocalizedText;
export type Params = Record<string, Param>;

type Placeholders<S> = S extends `${string}{${infer P}}${infer R}` ? P | Placeholders<R> : never;
type Template<K extends MessageKey> = Reference[K] extends { readonly other: infer O } ? O : Reference[K];
export type ParamName<K extends MessageKey> = Placeholders<Template<K>>;
/** Params are required exactly when the reference message has placeholders. */
export type TArgs<K extends MessageKey> = [ParamName<K>] extends [never] ? [params?: Params] : [params: { [P in ParamName<K>]: Param } & Params];
export type Translator = <K extends MessageKey>(key: K, ...args: TArgs<K>) => string;

export function msg<K extends MessageKey>(key: K, ...args: TArgs<K>): LocalizedText {
  return args[0] ? { key, params: args[0] } : { key };
}
export function isLocalizedText(value: unknown): value is LocalizedText {
  return !!value && typeof value === 'object' && isMessageKey((value as LocalizedText).key);
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
const numberFormats = new Map<Locale, Intl.NumberFormat>();
function numberFormat(locale: Locale): Intl.NumberFormat {
  let format = numberFormats.get(locale);
  // `min2` groups only from five digits, so ports and years stay as written.
  if (!format) numberFormats.set(locale, format = new Intl.NumberFormat(intlTag(locale), { useGrouping: 'min2' } as Intl.NumberFormatOptions));
  return format;
}

export function intlTag(locale: Locale): string {
  return catalogs[locale].code;
}

function pick(locale: Locale, value: MessageValue, params?: Params): string {
  if (typeof value === 'string') return value;
  const count = Number(params?.count);
  if (!Number.isFinite(count)) return value.other;
  if (count === 0 && value.zero !== undefined) return value.zero;
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, rules = new Intl.PluralRules(intlTag(locale)));
  return value[rules.select(count) as keyof PluralMessage] ?? value.other;
}

/** Translate any key; unknown keys come back unchanged so a stale code never breaks a page. */
export function translate(locale: Locale, key: string, params?: Params): string {
  const value = (catalogs[locale]?.messages as Record<string, MessageValue> | undefined)?.[key] ?? (catalogs.en.messages as Record<string, MessageValue>)[key];
  if (value === undefined) return key;
  return pick(locale, value, params).replace(/\{(\w+)\}/g, (match, name: string) => {
    const param = params?.[name];
    if (param === undefined) return match;
    if (typeof param === 'number') return numberFormat(locale).format(param);
    if (typeof param === 'string') return param;
    return translate(locale, param.key, param.params);
  });
}

export function localize(locale: Locale, text: LocalizedText | string): string {
  return typeof text === 'string' ? text : translate(locale, text.key, text.params);
}

export function translator(locale: Locale): Translator {
  return ((key: string, params?: Params) => translate(locale, key, params)) as Translator;
}

/**
 * The best supported language for an `Accept-Language` header or a list such
 * as `navigator.languages`. Every Chinese variant maps to simplified Chinese
 * until a traditional Chinese catalog exists.
 */
export function negotiateLocale(preferred: string | readonly string[] | undefined | null, fallback: Locale = DEFAULT_LOCALE): Locale {
  if (!preferred) return fallback;
  const ranked = typeof preferred === 'string'
    ? preferred.split(',').map((part, index) => {
      const [tag, ...attributes] = part.trim().split(';');
      const q = attributes.map(attribute => /^\s*q=([\d.]+)\s*$/.exec(attribute)?.[1]).find(Boolean);
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index };
    }).filter(entry => entry.tag && entry.q > 0).sort((a, b) => b.q - a.q || a.index - b.index).map(entry => entry.tag)
    : [...preferred];
  for (const tag of ranked) {
    const lower = tag.toLowerCase();
    const exact = locales.find(locale => locale.toLowerCase() === lower);
    if (exact) return exact;
    const base = lower.split('-')[0];
    const sameLanguage = locales.find(locale => locale.toLowerCase().split('-')[0] === base);
    if (sameLanguage) return sameLanguage;
  }
  return fallback;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

export function formatNumber(locale: Locale, value: number, options?: Intl.NumberFormatOptions): string {
  return options ? new Intl.NumberFormat(intlTag(locale), options).format(value) : numberFormat(locale).format(value);
}

export function formatDateTime(locale: Locale, value: string | number | Date | null | undefined, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  if (value === null || value === undefined || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(intlTag(locale), { hourCycle: 'h23', ...options }).format(date);
}

/** "a, b and c"; `unit` is a plain enumeration ("a, b, c" / "a、b、c") without a conjunction. */
export function formatList(locale: Locale, items: readonly string[], type: 'conjunction' | 'unit' = 'conjunction'): string {
  if (type === 'unit') return items.join(translate(locale, 'punctuation.listSeparator'));
  return new Intl.ListFormat(intlTag(locale), { style: 'long', type }).format(items);
}

/**
 * "just now / 3 minutes ago / in 2 hours / yesterday", then a short date for
 * anything more than a week away.
 */
export function formatRelative(locale: Locale, value: string | number | Date | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined || value === '') return '';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '';
  const diff = time - now, abs = Math.abs(diff);
  const minute = 60_000, hour = 60 * minute, day = 24 * hour;
  if (abs < 45_000) return translate(locale, diff > 0 ? 'time.soon' : 'time.justNow');
  const relative = new Intl.RelativeTimeFormat(intlTag(locale), { numeric: 'auto' });
  const sign = diff > 0 ? 1 : -1;
  if (abs < hour) return relative.format(sign * Math.max(1, Math.round(abs / minute)), 'minute');
  if (abs < day) return relative.format(sign * Math.round(abs / hour), 'hour');
  if (abs < 7 * day) return relative.format(sign * Math.max(1, Math.round(abs / day)), 'day');
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(intlTag(locale), sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}
