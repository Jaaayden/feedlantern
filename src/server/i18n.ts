import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_LOCALE, isLocale, isLocalizedText, isMessageKey, localize, msg, negotiateLocale, translate, type ErrorKey, type Locale, type LocalizedText, type MessageKey, type ParamName, type TArgs } from '../shared/i18n.js';

export { localize, msg, translate, translator, type Locale, type LocalizedText } from '../shared/i18n.js';

/*
 * The language of the work in progress. A request runs in its reader's
 * language (account preference, then Accept-Language); background work such
 * as refreshes, translation and notifications runs in the feed owner's.
 * Text that is stored (fetch logs, alerts, batch results) is written in that
 * language, so it reads the same later.
 */
const localeContext = new AsyncLocalStorage<() => Locale>();

/**
 * The instance's fallback language (`DEFAULT_LOCALE`, English unless set):
 * used when a request has no usable Accept-Language and for accounts that
 * have neither chosen a language nor signed in since languages existed.
 */
export function instanceLocale(): Locale {
  const value = process.env.DEFAULT_LOCALE;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Run `operation` in `locale`; a function is evaluated lazily, at most once. */
export function withLocale<T>(locale: Locale | (() => Locale), operation: () => T): T {
  if (typeof locale === 'string') return localeContext.run(() => locale, operation);
  let cached: Locale | undefined;
  return localeContext.run(() => cached ??= locale(), operation);
}

export function currentLocale(): Locale {
  return localeContext.getStore()?.() ?? instanceLocale();
}

/** Translate in the current locale. */
export function tl<K extends MessageKey>(key: K, ...args: TArgs<K>): string {
  return translate(currentLocale(), key, args[0]);
}

/** Localized text, or a plain string, in the current locale. */
export function lt(text: LocalizedText | string): string {
  return localize(currentLocale(), text);
}

/**
 * An error whose text is translated again wherever it is shown. `message`
 * is in the language of the work that raised it; server logs use
 * `englishMessage` so they read the same on every instance.
 */
export class LocalizedError extends Error {
  readonly text: LocalizedText;
  constructor(text: LocalizedText) {
    super(translate(currentLocale(), text.key, text.params));
    this.text = text;
  }
  get englishMessage(): string {
    return translate(DEFAULT_LOCALE, this.text.key, this.text.params);
  }
}

type ParamlessKey<K extends MessageKey> = K extends unknown ? ([ParamName<K>] extends [never] ? K : never) : never;
/** An error key that needs no params; anything with params goes through `msg()`. */
export type SimpleErrorKey = ParamlessKey<ErrorKey>;

/** Arbitrary text from another system (a parser, a remote service) shown as is. */
export const rawText = (message: string): LocalizedText => msg('error.raw', { message });

export function textOf(value: LocalizedText | SimpleErrorKey): LocalizedText {
  return typeof value === 'string' ? { key: value } : value;
}

/** The localized text an error carries, if any. */
export function errorText(error: unknown): LocalizedText | undefined {
  return error instanceof LocalizedError ? error.text : undefined;
}

/** Parse `Accept-Language`; requests without a supported language get the instance default. */
export function headerLocale(header: string | string[] | undefined): Locale {
  return negotiateLocale(Array.isArray(header) ? header.join(',') : header, instanceLocale());
}

/** Zod issue messages are message keys; anything else is shown as is. */
export function issueText(message: string | undefined, params?: Record<string, unknown>): LocalizedText | undefined {
  if (!message) return undefined;
  if (!isMessageKey(message)) return rawText(message);
  const cleaned = Object.fromEntries(Object.entries(params ?? {}).filter(([, value]) => typeof value === 'string' || typeof value === 'number' || isLocalizedText(value))) as LocalizedText['params'];
  return cleaned && Object.keys(cleaned).length ? { key: message, params: cleaned } : { key: message };
}
