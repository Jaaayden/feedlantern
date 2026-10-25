import { useState } from 'react';
import { Languages } from 'lucide-react';
import type { AuthState } from '../shared/types';
import { api } from './api';
import { browserLocale, forgetDeviceLocale, getLocale, isLocaleValue, localeNames, locales, setLocale, t, useLocale, type Locale } from './i18n';

/**
 * Interface language picker. Before sign-in the choice is kept on this
 * device; signed in, it is saved to the account so every device agrees.
 * `follow` adds “Use browser language”, which clears the account's choice.
 */
export function LanguageSelect({ compact = false, account, follow = false, onSaved, onError }: {
  compact?: boolean;
  /** The signed-in account; omitted on the sign-in and setup pages. */
  account?: AuthState;
  follow?: boolean;
  onSaved?: (state: AuthState) => void;
  onError?: (message: string) => void;
}) {
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const value = follow && account && !account.locale ? '' : locale;
  async function choose(next: string) {
    const chosen = isLocaleValue(next) ? next : null;
    if (!account) { if (chosen) setLocale(chosen, { remember: true }); return; }
    const previous = getLocale();
    // Switch at once; the server confirms (and the next requests use the new language).
    if (chosen) setLocale(chosen, { remember: true });
    else { forgetDeviceLocale(); setLocale(browserLocale(account.defaultLocale)); }
    setBusy(true);
    try { onSaved?.(await api.auth.locale(chosen)); }
    catch (error) { setLocale(previous); onError?.(error instanceof Error ? error.message : t('common.saveFailed')); }
    finally { setBusy(false); }
  }
  const select = <select aria-label={t('language.label')} value={value} disabled={busy} onChange={e => void choose(e.target.value)}>
    {follow && <option value="">{t('language.follow', { name: localeNames[browserLocale(account?.defaultLocale)] })}</option>}
    {locales.map((code: Locale) => <option key={code} value={code} lang={code}>{localeNames[code]}</option>)}
  </select>;
  if (compact) return <label className="language-select" title={t('language.label')}><Languages size={15} aria-hidden="true" />{select}</label>;
  return <label className="field"><span>{t('language.label')}</span>{select}<small>{account ? t('language.accountHint') : t('language.deviceHint')}</small></label>;
}
