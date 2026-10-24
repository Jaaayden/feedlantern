import type { DatabaseSync } from 'node:sqlite';
import { isLocale, negotiateLocale, type Locale } from '../shared/i18n.js';
import { instanceLocale } from './i18n.js';
import type { TargetLanguage } from '../shared/types.js';

/**
 * The language for work done on a user's behalf while they are away (alerts,
 * stored fetch errors, batch results): their chosen language, else the one
 * their browser last asked for, else the instance default (English unless DEFAULT_LOCALE is set).
 */
export function ownerLocale(db: DatabaseSync, userId: string | undefined): Locale {
  if (!userId) return instanceLocale();
  try {
    const row = db.prepare('SELECT locale, detected_locale FROM users WHERE id=?').get(userId) as { locale?: unknown; detected_locale?: unknown } | undefined;
    if (isLocale(row?.locale)) return row.locale;
    if (isLocale(row?.detected_locale)) return row.detected_locale;
  } catch { /* the columns are added by migration 21 */ }
  return instanceLocale();
}

/** Notes inside a translated feed follow the feed's target language when the UI has it. */
export function targetLocale(target: TargetLanguage | undefined): Locale {
  return negotiateLocale(target ?? 'zh-CN');
}
