import { useState, type FormEvent } from 'react';
import type { Feed, ExtractedItem, TargetLanguage, TranslationMode, TranslationProviderId } from '../shared/types';
import { LanguageOptions, ProviderOptions, useTranslationProviders } from './TranslationFields';
import { api } from './api';
import { ArrowLeft } from 'lucide-react';
import { sameAddress } from './format';
import { NetworkProfileSelect, useNetworkProfiles } from './NetworkProfiles';
import { ArticleFrame } from './ItemList';
import { t } from './i18n';
import { pubmedJournalSource } from '../shared/pubmed';

export function RssEditor({ initial, existing = [], saved, cancel }: { initial?: Feed; existing?: Feed[]; saved: (id: string) => void; cancel: () => void }) {
  const [url, setUrl] = useState(initial?.url ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [interval, setInterval] = useState(initial?.intervalMinutes ?? 30);
  const [mode, setMode] = useState<TranslationMode>(initial?.translationMode ?? 'bilingual');
  const [language, setLanguage] = useState<TargetLanguage>(initial?.targetLanguage ?? 'zh-CN');
  const [provider, setProvider] = useState<TranslationProviderId | ''>(initial?.translationProvider ?? '');
  const providers = useTranslationProviders();
  const [preview, setPreview] = useState<{ url: string; items: ExtractedItem[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [networkProfileId, setNetworkProfileId] = useState(initial?.networkProfileId ?? '');
  const profiles = useNetworkProfiles(setError);
  async function inspect() {
    setBusy(true); setError('');
    try { const result = await api.feeds.previewRss(url, networkProfileId || null); setPreview({ url: `${networkProfileId}\n${url}`, items: result.items }); if (!name) setName(result.title); }
    catch (e) { setError(e instanceof Error ? e.message : t('rssEditor.previewFailed')); } finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const body = { sourceType: 'rss' as const, translationMode: mode, targetLanguage: language, translationProvider: provider || null, name, url, intervalMinutes: interval, rules: { item: '', title: '', link: '' }, credentialId: null, networkProfileId: networkProfileId || null, waitMs: 0 };
      const result = initial ? await api.feeds.update(initial.id, body) : await api.feeds.create(body);
      saved(result.feed.id);
    } catch (e) { setError(e instanceof Error ? e.message : t('common.saveFailed')); } finally { setBusy(false); }
  }
  return <><button className="back-link" onClick={cancel}><ArrowLeft size={16} />{t('common.backToFeeds')}</button><div className="page-heading"><div><span className="section-kicker">TRANSLATE A FEED</span><h1>{initial ? t('rssEditor.editTitle') : t('rssEditor.title')}</h1><p>{t('rssEditor.lead')}</p></div></div>
    <div className="notice">{t('rssEditor.notice')}</div>
    <form className="panel settings-form rss-editor-form" onSubmit={submit}>
      <label className="field"><span>{t('rssEditor.url')}</span><input type="url" required value={url} disabled={busy} onChange={e => { setUrl(e.target.value); setPreview(undefined); }} onKeyDown={e => { if (e.key === 'Enter' && url && preview?.url !== `${networkProfileId}\n${url}`) { e.preventDefault(); void inspect(); } }} placeholder="https://example.com/feed.xml" /></label>
      {pubmedJournalSource(url) && <p className="hint" data-testid="pubmed-eutils-hint">{t('pubmed.eutilsHint')}</p>}
      <NetworkProfileSelect value={networkProfileId} disabled={busy} onChange={id => { setNetworkProfileId(id); setPreview(undefined); }} profiles={profiles} />
      <button type="button" className="button" disabled={busy || !url} onClick={() => void inspect()}>{busy ? t('common.working') : t('rssEditor.preview')}</button>
      <label className="field"><span>{t('label.feedName')}</span><input required maxLength={200} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
      <label className="field"><span>{t('translation.outputMode')}</span><select value={mode} disabled={busy} onChange={e => setMode(e.target.value as typeof mode)}><option value="original">{t('translation.mode.original')}</option><option value="bilingual">{t('translation.mode.bilingual')}</option><option value="translated">{t('translation.mode.translated')}</option></select></label>
      {mode !== 'original' && <div className="form-row">
        <label className="field"><span>{t('translation.targetLanguage')}</span><select value={language} disabled={busy} onChange={e => setLanguage(e.target.value as TargetLanguage)}><LanguageOptions /></select></label>
        <label className="field"><span>{t('translation.service')}</span><select value={provider} disabled={busy} onChange={e => setProvider(e.target.value as TranslationProviderId | '')}><ProviderOptions info={providers} current={initial?.translationProvider} /></select></label>
      </div>}
      <label className="field"><span>{t('label.intervalMinutes')}</span><input type="number" min={5} max={1440} required value={interval} disabled={busy} onChange={e => setInterval(Number(e.target.value))} /></label>
      <p className="hint">{t('rssEditor.hint')}</p>
      {initial && url !== initial.url && <p className="notice">{t('rssEditor.urlChanged')}</p>}
      {!initial && (() => { const duplicate = existing.find(feed => feed.sourceType === 'rss' && sameAddress(feed.url, url)); return duplicate ? <p className="notice">{t('rssEditor.duplicate', { name: duplicate.name })}</p> : null; })()}
      {error && <div className="error-note" role="alert">{error}</div>}
      <button className="button primary" disabled={busy || (!initial && preview?.url !== `${networkProfileId}\n${url}`)}>{busy ? t('common.working') : t('rssEditor.save')}</button>
    </form>
    {preview && <section className="panel rss-source-preview"><h2>{t('rssEditor.sourcePreview')}</h2>{!preview.items.length && <p>{t('rssEditor.noItems')}</p>}{preview.items.map((item, index) => <article key={index}><h3>{item.title}</h3><ArticleFrame title={t('rssEditor.sourcePreviewItem', { n: index + 1 })} html={item.contentHtml ?? ''} /></article>)}</section>}
  </>;
}
