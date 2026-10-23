import { useEffect, useState } from 'react';
import { targetLanguages, translationProviderLabels, type TargetLanguage, type TranslationProviderId, type TranslationProvidersInfo } from '../shared/types';
import { api } from './api';

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
  return <>{(Object.keys(targetLanguages) as TargetLanguage[]).map(id => <option key={id} value={id}>{targetLanguages[id].label}</option>)}</>;
}

/** "" follows the instance default; services without settings stay visible but cannot be picked. */
export function ProviderOptions({ info, current, followValue = '' }: { info?: TranslationProvidersInfo; current?: TranslationProviderId | null; followValue?: string }) {
  const providers = info?.providers ?? (Object.keys(translationProviderLabels) as TranslationProviderId[]).map(id => ({ id, label: translationProviderLabels[id], configured: true }));
  return <>
    <option value={followValue}>{info ? `跟随默认（${translationProviderLabels[info.defaultProvider]}）` : '跟随默认'}</option>
    {providers.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.configured && provider.id !== current}>{provider.label}{provider.configured ? '' : '（未配置）'}</option>)}
  </>;
}
