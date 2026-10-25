import { useEffect, useState } from 'react';
import { targetLanguages, translationProviders, type TargetLanguage, type TranslationProviderId, type TranslationProvidersInfo } from '../shared/types';
import { api } from './api';
import { t } from './i18n';

/** Which services exist, which are configured, and the instance default (any signed-in user may read this). */
export function useTranslationProviders(): TranslationProvidersInfo | undefined {
  const [info, setInfo] = useState<TranslationProvidersInfo>();
  useEffect(() => {
    let live = true;
    void api.translation.providers().then(value => { if (live) setInfo(value); }).catch(() => { /* the select still offers "follow default" */ });
    return () => { live = false; };
  }, []);
  return info;
}

export function LanguageOptions() {
  return <>{(Object.keys(targetLanguages) as TargetLanguage[]).map(id => <option key={id} value={id}>{t(`targetLanguage.${id}`)}</option>)}</>;
}

/** "" follows the instance default; services without settings stay visible but cannot be picked. */
export function ProviderOptions({ info, current, followValue = '' }: { info?: TranslationProvidersInfo; current?: TranslationProviderId | null; followValue?: string }) {
  const providers = info?.providers ?? translationProviders.map(id => ({ id, configured: true }));
  return <>
    <option value={followValue}>{info ? t('provider.followNamed', { name: t(`provider.${info.defaultProvider}`) }) : t('provider.follow')}</option>
    {providers.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.configured && provider.id !== current}>{provider.configured ? t(`provider.${provider.id}`) : t('provider.notConfigured', { name: t(`provider.${provider.id}`) })}</option>)}
  </>;
}
