import { useEffect, useState } from 'react';
import { translationLabel, type CredentialSummary, type ImportEntry, type ImportJob, type TargetLanguage, type TranslationProviderId } from '../shared/types';
import { LanguageOptions, ProviderOptions, useTranslationProviders } from './TranslationFields';
import { api } from './api';
import { Editor } from './App';
import { ArrowLeft, FileUp } from 'lucide-react';
import { copyText, parseOpmlUrls } from './format';
import { NetworkProfileSelect, useNetworkProfiles } from './NetworkProfiles';
import { fmt, t } from './i18n';
const states = ['queued', 'running', 'created', 'existing', 'review', 'failed', 'canceled'] as const;
const stateLabel = (state: (typeof states)[number]) => t(`batch.state.${state}`);
export function BatchView({ notify, changed, back }: { notify: (s: string) => void; changed: () => void; back: () => void }) {
  const [sourceType, setSourceType] = useState<'website' | 'rss'>('website');
  const [mode, setMode] = useState<'translated' | 'bilingual'>('bilingual');
  const [language, setLanguage] = useState<TargetLanguage>('zh-CN');
  const [provider, setProvider] = useState<TranslationProviderId | ''>('');
  const providers = useTranslationProviders();
  const [text, setText] = useState('');
  const [interval, setRefreshInterval] = useState(60);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [networkProfileId, setNetworkProfileId] = useState('');
  const profiles = useNetworkProfiles(message => setError(message));
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ job: ImportJob; entry: ImportEntry } | null>(null);
  async function load() { try { setJobs(await api.jobs.list()); } catch (e) { setError(String(e)); } }
  useEffect(() => { void load(); void api.credentials.list().then(setCredentials).catch(e => setError(String(e))); const timer = setInterval(() => void load(), 2000); return () => clearInterval(timer); }, []);
  const seen = new Set<string>();
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean).map(raw => {
    try { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error(); url.hash = ''; const duplicate = seen.has(url.href); seen.add(url.href); return { raw, url: url.href, error: duplicate ? t('batch.duplicate') : '' }; }
    catch { return { raw, url: '', error: t('batch.invalidUrl') }; }
  });
  if (editing) return <Editor draft={{ name: editing.entry.title ?? '', url: editing.entry.url, credentialId: editing.entry.credentialId, networkProfileId: editing.entry.networkProfileId ?? null, intervalMinutes: editing.entry.intervalMinutes, waitMs: 1000, rules: { item: '', title: '', link: '' } }} submitFeed={input => api.jobs.confirm(editing.job.id, editing.entry.id, input)} cancel={() => setEditing(null)} saved={() => { setEditing(null); void load(); changed(); notify(t('feed.saved')); }} />;
  async function run(fn: () => Promise<unknown>) { setError(''); setBusy(true); try { await fn(); await load(); changed(); } catch (e) { setError(e instanceof Error ? e.message : t('error.actionFailed')); } finally { setBusy(false); } }
  return <><button className="back-link" onClick={back}><ArrowLeft size={16} />{t('common.backToFeeds')}</button><div className="page-heading"><div><span className="section-kicker">ADD IN BULK</span><h1>{t('batch.title')}</h1><p>{sourceType === 'rss' ? t('batch.leadRss') : t('batch.leadWebsite')} {t('batch.leadContinue')}</p></div></div>
    <form className="panel settings-form" onSubmit={e => { e.preventDefault(); void run(async () => { await api.jobs.create(lines.filter(l => !l.error).map(l => ({ url: l.url, credentialId: sourceType === 'rss' ? null : bindings[l.url] || null, networkProfileId: networkProfileId || null })), interval, sourceType, { translationMode: mode, targetLanguage: language, translationProvider: provider || null }); setText(''); }); }}>
      <label className="field"><span>{t('batch.type')}</span><select disabled={busy} value={sourceType} onChange={e => setSourceType(e.target.value as 'website' | 'rss')}><option value="website">{t('batch.typeWebsite')}</option><option value="rss">{t('batch.typeRss')}</option></select></label>
      {sourceType === 'rss' && <div className="form-row">
        <label className="field"><span>{t('translation.outputModeLong')}</span><select disabled={busy} value={mode} onChange={e => setMode(e.target.value as 'translated' | 'bilingual')}><option value="bilingual">{t('translation.mode.bilingual')}</option><option value="translated">{t('translation.mode.translated')}</option></select></label>
        <label className="field"><span>{t('translation.targetLanguageLong')}</span><select disabled={busy} value={language} onChange={e => setLanguage(e.target.value as TargetLanguage)}><LanguageOptions /></select></label>
        <label className="field"><span>{t('translation.service')}</span><select disabled={busy} value={provider} onChange={e => setProvider(e.target.value as TranslationProviderId | '')}><ProviderOptions info={providers} /></select></label>
      </div>}
      <label className="field"><span>{t('batch.urls')}</span><textarea rows={6} required value={text} onChange={e => setText(e.target.value)} placeholder={sourceType === 'rss' ? 'https://example.com/feed.xml\nhttps://example.org/atom.xml' : 'https://example.com/news\nhttps://example.org/blog'} spellCheck={false} /></label>
      {sourceType === 'rss' && <label className="button small opml-import"><FileUp size={14} />{t('batch.importOpml')}<input type="file" accept=".opml,.xml,text/x-opml,application/xml,text/xml" className="visually-hidden" disabled={busy} onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; try { if (file.size > 2_000_000) throw Error(t('batch.opmlTooLarge')); const urls = parseOpmlUrls(await file.text()); if (!urls.length) throw Error(t('batch.opmlEmpty')); setText(previous => [previous.trim(), ...urls].filter(Boolean).join('\n')); notify(t('batch.opmlRead', { count: urls.length })); } catch (error) { setError(error instanceof Error ? error.message : t('batch.opmlUnreadable')); } }} /></label>}
      <NetworkProfileSelect label={t('batch.networkProfile')} value={networkProfileId} onChange={setNetworkProfileId} profiles={profiles} disabled={busy} />
      <label className="field"><span>{t('label.intervalMinutes')}</span><input type="number" min={5} max={1440} value={interval} onChange={e => setRefreshInterval(Number(e.target.value))} /></label>
      {lines.map((line, i) => <div className="collection-toolbar" key={i} data-issue={!line.url ? 'invalid' : line.error ? 'duplicate' : undefined}><span>{line.raw} {line.error}</span>{sourceType === 'website' && !line.error && <select aria-label={`Cookie ${line.url}`} value={bindings[line.url] ?? ''} onChange={e => setBindings({ ...bindings, [line.url]: e.target.value })}><option value="">{t('batch.noCookie')}</option>{credentials.filter(c => c.domains.some(d => { const host = new URL(line.url).hostname; return d.startsWith('.') ? host === d.slice(1) || host.endsWith(d) : host === d; })).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</div>)}
      <button className="button primary" disabled={busy || !lines.length || lines.length > 100 || lines.some(l => !l.url)}>{sourceType === 'rss' ? t('batch.startRss') : t('batch.startWebsite')}</button>
    </form>{error && <div className="error-note" role="alert">{error}</div>}
    {jobs.map(job => {
      const counts = states.map(state => [state, job.entries.filter(entry => entry.state === state).length] as const).filter(([, count]) => count > 0);
      return <section className="panel settings-form batch-job" key={job.id}><div className="collection-toolbar"><div className="batch-job-title"><h2>{fmt.date(job.createdAt)}</h2><div className="inline batch-counts">{counts.map(([state, count]) => <span key={state} className="batch-count" data-state={state}>{stateLabel(state)} {count}</span>)}</div></div><div className="inline"><button className="button small" disabled={busy} onClick={() => void run(() => api.jobs.action(job.id, 'cancel'))}>{t('batch.cancelQueued')}</button><button className="button small" disabled={busy} onClick={() => void run(async () => { const ids = job.entries.flatMap(e => e.feedId ? [e.feedId] : []); if (!ids.length) throw Error(t('batch.noFeedUrls')); const result = await api.feeds.bulk(ids, 'copy'); await copyText(result.results.filter(r => r.ok).map(r => r.feedUrl).join('\n')); notify(t('feed.urlCopied')); })}>{t('batch.copyAll')}</button></div></div>
      {job.entries.map(entry => <article key={entry.id} className="batch-entry" data-state={entry.state}><div className="batch-entry-main"><strong>{entry.title || entry.url}</strong><p>{entry.url} · {entry.sourceType === 'rss' ? `RSS ${translationLabel({ translationMode: (entry.translationMode as string) === 'chinese' ? 'translated' : entry.translationMode, targetLanguage: entry.targetLanguage }, t)} · ${entry.state === 'running' ? t('batch.readingSource') : entry.state === 'created' ? t('batch.createdRss') : stateLabel(entry.state)}` : stateLabel(entry.state)}</p>{entry.error && <p role="alert">{entry.error}</p>}{entry.detection?.candidates.map(c => <p key={c.id} className="batch-candidate">{t('batch.candidate', { label: c.label, count: c.count, titles: fmt.list(c.items.slice(0, 2).map(i => i.title), 'unit') })}</p>)}</div><div className="inline batch-entry-actions">{entry.feedId && <button className="button small" disabled={busy} onClick={() => void run(async () => { const result = (await api.feeds.bulk([entry.feedId!], 'copy')).results[0]; if (!result?.ok || !result.feedUrl) throw Error(result?.error ?? t('batch.feedUrlUnavailable')); await copyText(result.feedUrl); notify(t('feed.urlCopied')); })}>{t('batch.copyOne')}</button>}{entry.sourceType !== 'rss' && ['review', 'failed'].includes(entry.state) && <button className="button small" onClick={() => setEditing({ job, entry })}>{t('batch.adjust')}</button>}{['failed', 'canceled'].includes(entry.state) && <button className="button small" disabled={busy} onClick={() => void run(() => api.jobs.action(job.id, 'retry', entry.id))}>{t('common.retry')}</button>}</div></article>)}
    </section>;
    })}
  </>;
}
