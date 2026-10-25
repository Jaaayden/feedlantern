// The interface language. Order of preference: the language the signed-in
// account chose (saved on the server, so every device agrees), then a choice
// made on this device before signing in, then the browser's languages, then
// the server's default (English unless DEFAULT_LOCALE is set).
import { useSyncExternalStore } from 'react';
import { formatDateTime, formatList, formatNumber, formatRelative, intlTag, isLocale, isMessageKey, locales, localeNames, negotiateLocale, translate, type Locale, type LocalizedText, type Params, type Translator } from '../shared/i18n';

export { isLocale as isLocaleValue, localeNames, locales, type Locale };

const storageKey = 'feedlantern:locale';
const listeners = new Set<() => void>();

function stored(): Locale | null {
  try { const value = localStorage.getItem(storageKey); return isLocale(value) ? value : null; } catch { return null; }
}

/** The best language for the browser's preferences; `fallback` when none is supported. */
export function browserLocale(fallback?: Locale): Locale {
  return negotiateLocale(typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language], fallback);
}

let current: Locale = stored() ?? browserLocale();

function apply(locale: Locale) {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = intlTag(locale);
    document.title = translate(locale, 'app.documentTitle');
  }
}
apply(current);

export function getLocale(): Locale { return current; }

/** Forget this device's choice, so the sign-in page follows the browser again. */
export function forgetDeviceLocale() {
  try { localStorage.removeItem(storageKey); } catch { /* nothing stored */ }
}

/** Change the language for this page; `remember` keeps it on this device for the sign-in page. */
export function setLocale(locale: Locale, { remember = false }: { remember?: boolean } = {}) {
  if (remember) { try { localStorage.setItem(storageKey, locale); } catch { /* the choice then lasts for this page only */ } }
  if (locale === current) return;
  current = locale;
  apply(locale);
  for (const listener of listeners) listener();
}

/**
 * After sign-in: the account's saved choice wins; without one, a choice made
 * on this device, then the browser, then the server's default.
 */
export function adoptAccountLocale(saved: Locale | null | undefined, serverDefault?: Locale) {
  setLocale(saved ?? stored() ?? browserLocale(serverDefault));
}

/** Before sign-in there is no account: a device choice, then the browser, then the server's default. */
export function adoptGuestLocale(serverDefault?: Locale) {
  setLocale(stored() ?? browserLocale(serverDefault));
}

/** Translate in the current interface language. */
export const t = ((key: string, params?: Params) => translate(current, key, params)) as Translator;

/** Text from the server that may be a message key with params. */
export const tx = (text: LocalizedText | string) => typeof text === 'string' ? text : translate(current, text.key, text.params);
/** A key known only at run time (an error code, a warning key); unknown keys come back as `fallback`. */
export const tKey = (key: string, params?: Params, fallback = key) => isMessageKey(key) ? translate(current, key, params) : fallback;

export const fmt = {
  date: (value: string | number | Date | null | undefined, options?: Intl.DateTimeFormatOptions) => formatDateTime(current, value, options),
  number: (value: number, options?: Intl.NumberFormatOptions) => formatNumber(current, value, options),
  relative: (value: string | number | Date | null | undefined, now?: number) => formatRelative(current, value, now),
  list: (items: readonly string[], type?: 'conjunction' | 'unit') => formatList(current, items, type),
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-render when the language changes. The app root calls this, so the whole tree follows. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}
