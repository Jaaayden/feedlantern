import { useEffect, useState } from 'react';
import { OUTPUT_LIMIT, RETENTION_LIMIT, translationEnabled, translationLabel, type AuthState, type BulkFeedSettingsInput, type BundlePayload, type Feed, type TargetLanguage, type TranslationProviderId } from '../shared/types';
import { LanguageOptions, ProviderOptions, useTranslationProviders } from './TranslationFields';
import { api } from './api';
import { Copy, FileDown, LayoutGrid, List, Settings2, X } from 'lucide-react';
import { absoluteTime, avatarHue, buildOpml, copyText, downloadText, initial, relativeTime } from './format';
import { needsAttention, ruleHealthSummary } from './RuleHealth';
import { t } from './i18n';

export type StatusFilter = 'all' | 'attention' | 'failing' | 'rule-health';
const statusMatches: Record<StatusFilter, (feed: Feed) => boolean> = { all: () => true, attention: needsAttention, failing: feed => !!feed.lastError, 'rule-health': feed => !!feed.ruleHealth };
type SortKey = 'default' | 'name' | 'updated' | 'attention';
const sortKeys: SortKey[] = ['default', 'name', 'updated', 'attention'];
const sortLabel = (key: SortKey) => t(`collection.sort.${key}`);

function readSort(): SortKey {
  try { const value = localStorage.getItem('feedlantern:sort'); return value && sortKeys.includes(value as SortKey) ? value as SortKey : 'default'; } catch { return 'default'; }
}

function sortFeeds(feeds: Feed[], key: SortKey): Feed[] {
  if (key === 'default') return feeds;
  const list = [...feeds];
  if (key === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  if (key === 'updated') list.sort((a, b) => (b.lastSuccessAt ?? '').localeCompare(a.lastSuccessAt ?? ''));
  if (key === 'attention') list.sort((a, b) => Number(!!b.lastError) - Number(!!a.lastError) || Number(needsAttention(b)) - Number(needsAttention(a)) || Number(!a.enabled) - Number(!b.enabled));
  return list;
}

export function FeedCollection({ auth, feeds, bundles = [], addToBundle, query, status, onStatus, detail, settings, logs, changed, notify }: {
  auth: AuthState; feeds: Feed[]; bundles?: BundlePayload[]; addToBundle?: (ids: string[]) => void; query: string; status: StatusFilter; onStatus: (status: StatusFilter) => void;
  detail: (id: string) => void; settings: (id: string) => void; logs: (id: string) => void;
  changed: () => void; notify: (text: string) => void;
}) {
  const [sourceFilter, setSourceFilter] = useState('all');
  const [outputFilter, setOutputFilter] = useState('all');
  const statusFilter = status;
  const [sort, setSort] = useState<SortKey>(readSort);
  const visible = sortFeeds(feeds.filter(feed => statusMatches[statusFilter](feed) && (sourceFilter === 'all' || (feed.sourceType ?? 'website') === sourceFilter) && (outputFilter === 'all' || (translationEnabled(feed) ? 'translated' : 'original') === outputFilter)), sort);
  const [view, setView] = useState<'list' | 'cards'>('list');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<NonNullable<BulkFeedSettingsInput['translationMode']> | ''>('');
  const [interval, setInterval] = useState('');
  const [language, setLanguage] = useState<TargetLanguage | ''>('');
  const [provider, setProvider] = useState<TranslationProviderId | 'default' | ''>('');
  const providers = useTranslationProviders();
  const [outputLimit, setOutputLimit] = useState('');
  const [retentionMode, setRetentionMode] = useState<'' | 'auto' | 'set'>('');
  const [retention, setRetention] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (auth.role === 'admin') { void api.settings.get().then(s => setView(s.feedView)).catch(e => setError(e.message)); } else { try { setView(localStorage.getItem(`feedlantern:view:${auth.userId}`) === 'cards' ? 'cards' : 'list'); } catch {} } }, [auth.userId, auth.role]);
  useEffect(() => { setSelected([]); setEditing(false); }, [query, sourceFilter, outputFilter, statusFilter]);
  useEffect(() => setSelected(previous => previous.filter(id => feeds.some(f => f.id === id))), [feeds]);
  async function changeView(next: 'list' | 'cards') {
    try { if (auth.role === 'admin') await api.settings.update(next); else localStorage.setItem(`feedlantern:view:${auth.userId}`, next); setView(next); } catch (e) { setError(String(e)); }
  }
  function changeSort(next: SortKey) {
    setSort(next);
    try { localStorage.setItem('feedlantern:sort', next); } catch { /* per-browser preference only */ }
  }
  async function operate(action: string, ids = selected, patch?: BulkFeedSettingsInput) {
    if (action === 'delete' && !confirm(t('collection.confirmDelete', { count: ids.length }))) return;
    setBusy(true); setError('');
    try {
      const { results } = await api.feeds.bulk(ids, action, patch);
      if (action === 'copy') await copyText(results.filter(r => r.ok).map(r => r.feedUrl).join('\n'));
      const failures = results.filter(r => !r.ok);
      setSelected(failures.map(r => r.id));
      if (!failures.length) setEditing(false);
      setError(failures.map(r => t('collection.failure', { name: feeds.find(f => f.id === r.id)?.name ?? r.id, error: r.error ?? '' })).join(t('punctuation.semicolon')));
      const done = results.length - failures.length;
      notify(failures.length ? t(action === 'copy' ? 'collection.copiedPartly' : 'collection.donePartly', { count: done, failed: failures.length }) : t(action === 'copy' ? 'collection.copied' : 'collection.done', { count: done }));
      changed();
    } catch (e) { setError(e instanceof Error ? e.message : t('error.actionFailed')); } finally { setBusy(false); }
  }
  // The list-wide export also carries every bundle; exporting a selection only the selected feeds.
  async function exportOpml(ids: string[], withBundles = false) {
    if (!ids.length) return;
    setBusy(true); setError('');
    try {
      const { results } = await api.feeds.bulk(ids, 'copy');
      const entries = results.flatMap(result => {
        const feed = feeds.find(item => item.id === result.id);
        return result.ok && result.feedUrl && feed ? [{ name: feed.name, feedUrl: result.feedUrl, siteUrl: feed.url }] : [];
      });
      const bundleEntries = withBundles ? bundles.map(({ bundle, bundleUrl }) => ({ name: bundle.name, feedUrl: bundleUrl })) : [];
      downloadText(buildOpml(t('collection.opmlTitle'), entries, bundleEntries), `feedlantern-${new Date().toISOString().slice(0, 10)}.opml`, 'text/x-opml;charset=utf-8');
      notify(bundleEntries.length ? t('collection.exportedWithBundles', { count: entries.length, bundles: bundleEntries.length }) : t('collection.exported', { count: entries.length }));
    } catch (e) { setError(e instanceof Error ? e.message : t('collection.exportFailed')); } finally { setBusy(false); }
  }
  function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    const patch: BulkFeedSettingsInput = {};
    if (mode) patch.translationMode = mode;
    if (language) patch.targetLanguage = language;
    if (provider) patch.translationProvider = provider === 'default' ? null : provider;
    if (interval.trim()) patch.intervalMinutes = Number(interval);
    if (outputLimit.trim()) patch.outputLimit = Number(outputLimit);
    if (retentionMode === 'auto') patch.retentionLimit = null;
    if (retentionMode === 'set' && retention.trim()) patch.retentionLimit = Number(retention);
    if (!Object.keys(patch).length) return;
    void operate('settings', selected, patch);
  }
  function clearFilters() { setSourceFilter('all'); setOutputFilter('all'); onStatus('all'); }
  const filtered = sourceFilter !== 'all' || outputFilter !== 'all' || statusFilter !== 'all';
  const all = visible.length > 0 && visible.every(f => selected.includes(f.id));
  return <section className="feed-collection" aria-label={t('collection.label')}>
    <div className="collection-toolbar collection-filters"><div className="inline filter-group"><label>{t('collection.source')} <select aria-label={t('collection.filterSource')} value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}><option value="all">{t('collection.allSources')}</option><option value="website">{t('feedKind.website')}</option><option value="rss">{t('feedKind.rss')}</option><option value="pubmed">{t('feedKind.pubmed')}</option></select></label><label>{t('collection.output')} <select aria-label={t('collection.filterOutput')} value={outputFilter} onChange={e => setOutputFilter(e.target.value)}><option value="all">{t('collection.allOutputs')}</option><option value="translated">{t('collection.translated')}</option><option value="original">{t('collection.originals')}</option></select></label><label>{t('collection.status')} <select aria-label={t('collection.filterStatus')} value={statusFilter} onChange={e => onStatus(e.target.value as StatusFilter)}><option value="all">{t('fetchLog.allStatuses')}</option><option value="attention">{t('collection.attention')}</option><option value="failing">{t('collection.failing')}</option><option value="rule-health">{t('health.badge')}</option></select></label><label>{t('collection.sort')} <select aria-label={t('collection.sortFeeds')} value={sort} onChange={e => changeSort(e.target.value as SortKey)}>{sortKeys.map(key => <option key={key} value={key}>{sortLabel(key)}</option>)}</select></label></div>
      <div className="inline"><button className="button small" aria-pressed={view === 'list'} onClick={() => void changeView('list')}><List size={14} />{t('collection.list')}</button><button className="button small" aria-pressed={view === 'cards'} onClick={() => void changeView('cards')}><LayoutGrid size={14} />{t('collection.cards')}</button></div>
    </div>
    {selected.length > 0 && <div className="collection-toolbar"><span>{t('collection.selected', { count: selected.length })}</span><div className="detail-actions"><button className="button small" disabled={busy} onClick={() => { setMode(''); setInterval(''); setOutputLimit(''); setRetentionMode(''); setRetention(''); setLanguage(''); setProvider(''); setEditing(true); setError(''); }}>{t('collection.bulkSettings')}</button>{[['copy', t('collection.copyRss')], ['pause', t('collection.pause')], ['resume', t('collection.resume')], ['refresh', t('collection.refresh')]].map(([action, label]) => <button className="button small" key={action} disabled={busy} onClick={() => void operate(action)}>{label}</button>)}{addToBundle && <button className="button small" disabled={busy} onClick={() => addToBundle(selected)}>{t('collection.addToBundle')}</button>}<button className="button small" disabled={busy} onClick={() => void exportOpml(selected)}>{t('collection.exportOpml')}</button><button className="button small" disabled={busy} onClick={() => void operate('delete')}>{t('common.delete')}</button></div><button className="icon-button bulk-clear" aria-label={t('collection.clearSelection')} disabled={busy} onClick={() => { setSelected([]); setEditing(false); }}><X size={16} /></button></div>}
    {editing && selected.length > 0 && <form className="panel settings-form" aria-label={t('collection.bulkSettingsLabel')} onSubmit={saveSettings}>
      <h3>{t('collection.bulkTitle', { count: selected.length })}</h3>
      <p className="hint">{t('collection.bulkHint')}</p>
      <fieldset disabled={busy}>
        <label className="field"><span>{t('translation.outputModeLong')}</span><select value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="">{t('collection.keep')}</option><option value="bilingual">{t('translation.mode.bilingual')}</option><option value="translated">{t('translation.mode.translated')}</option><option value="original">{t('translation.mode.original')}</option></select></label>
        <label className="field"><span>{t('translation.targetLanguageLong')}</span><select value={language} onChange={e => setLanguage(e.target.value as typeof language)}><option value="">{t('collection.keep')}</option><LanguageOptions /></select></label>
        <label className="field"><span>{t('translation.service')}</span><select value={provider} onChange={e => setProvider(e.target.value as typeof provider)}><option value="">{t('collection.keep')}</option><ProviderOptions info={providers} followValue="default" /></select></label>
        <label className="field"><span>{t('label.intervalMinutes')}</span><input type="number" min={5} max={1440} step={1} placeholder={t('collection.emptyKeeps')} value={interval} onChange={e => setInterval(e.target.value)} /></label>
        <label className="field"><span>{t('output.limit')}</span><input type="number" min={OUTPUT_LIMIT.min} max={OUTPUT_LIMIT.max} step={1} placeholder={t('collection.emptyKeeps')} value={outputLimit} onChange={e => setOutputLimit(e.target.value)} /></label>
        <div className="form-row"><label className="field"><span>{t('output.retention')}</span><select aria-label={t('output.retention')} value={retentionMode} onChange={e => setRetentionMode(e.target.value as typeof retentionMode)}><option value="">{t('collection.keep')}</option><option value="auto">{t('output.retentionAuto', { website: RETENTION_LIMIT.websiteAuto, rss: RETENTION_LIMIT.rssAuto })}</option><option value="set">{t('output.retentionSet')}</option></select></label>
          {retentionMode === 'set' && <label className="field"><span>{t('output.retentionRange', { min: RETENTION_LIMIT.min, max: RETENTION_LIMIT.max })}</span><input type="number" required min={Math.max(RETENTION_LIMIT.min, Number(outputLimit) || RETENTION_LIMIT.min)} max={RETENTION_LIMIT.max} step={1} value={retention} onChange={e => setRetention(e.target.value)} /></label>}</div>
        <p className="hint">{t('collection.retentionHint')}</p>
        <div className="detail-actions"><button className="button" type="submit" disabled={!mode && !interval.trim() && !outputLimit.trim() && !retentionMode && !language && !provider}>{t('collection.apply')}</button><button className="button secondary" type="button" onClick={() => setEditing(false)}>{t('common.cancel')}</button></div>
      </fieldset>
    </form>}
    {error && <div className="error-note" role="alert">{error}</div>}
    {visible.length === 0 && <div className="filter-empty"><p className="muted">{t('collection.noMatch')}</p>{filtered && <button className="button small" onClick={clearFilters}>{t('collection.clearFilters')}</button>}</div>}
    {visible.length > 0 && <div className={`collection-head ${view === 'cards' ? 'is-cards' : ''}`}><label className="feed-select"><input type="checkbox" aria-label={t('collection.selectAll')} checked={all} disabled={busy} onChange={e => setSelected(e.target.checked ? visible.map(f => f.id) : [])} /></label><span className="collection-count">{t('users.feedCount', { count: visible.length })}</span><button className="button small collection-export" disabled={busy} title={bundles.length ? t('collection.exportHintBundles') : t('collection.exportHint')} onClick={() => void exportOpml(visible.map(feed => feed.id), true)}><FileDown size={14} />{t('collection.exportOpml')}</button></div>}
    <div className={view === 'cards' ? 'feed-grid' : 'feed-list'}>{visible.map(feed => <article className={view === 'cards' ? 'feed-card' : 'feed-row'} key={feed.id} data-state={feed.lastError ? 'error' : feed.ruleHealth ? 'warning' : feed.enabled ? 'active' : 'paused'}>
      <label className="feed-select"><input type="checkbox" aria-label={t('collection.selectFeed', { name: feed.name })} disabled={busy} checked={selected.includes(feed.id)} onChange={e => setSelected(previous => e.target.checked ? [...previous, feed.id] : previous.filter(id => id !== feed.id))} /></label>
      <div className="feed-identity"><span className="feed-avatar" aria-hidden="true" style={{ '--hue': avatarHue(feed.name) } as React.CSSProperties}>{initial(feed.name)}</span><div className="feed-text"><button className="card-title" aria-label={t('collection.viewFeed', { name: feed.name })} onClick={() => detail(feed.id)}>{feed.name}</button><div className="inline feed-kind"><span className="badge">{feed.sourceType === 'pubmed' ? t('feedKind.pubmed') : feed.sourceType === 'rss' ? t('feedKind.rss') : t('feedKind.website')}</span><span className={`badge ${translationEnabled(feed) ? 'good' : ''}`}>{translationEnabled(feed) ? translationLabel(feed, t) : t('feedKind.original')}</span></div><p className="feed-host" title={feed.pubmed?.query ?? feed.url}>{feed.pubmed?.query ?? feed.url}</p>{!feed.lastError && feed.ruleHealth && <button className="card-warning" title={t('collection.healthTitle', { summary: ruleHealthSummary(feed) })} onClick={() => detail(feed.id)}>{ruleHealthSummary(feed)}</button>}{feed.lastError && <button className="card-error" title={t('collection.errorTitle', { error: feed.lastError })} onClick={() => logs(feed.id)}>{feed.lastError}</button>}</div></div>
      {feed.lastError ? <button type="button" className="badge bad badge-button" title={statusFilter === 'attention' ? t('collection.attentionShown') : t('collection.attentionOnly')} onClick={() => onStatus('attention')}>{t('collection.attention')}</button> : feed.ruleHealth ? <button type="button" className="badge warn badge-button" title={statusFilter === 'rule-health' ? t('collection.healthShown') : t('collection.healthOnly')} onClick={() => onStatus('rule-health')}>{t('health.badge')}</button> : <span className={`badge ${feed.enabled ? 'good' : ''}`}>{feed.enabled ? t('feed.active') : t('feed.paused')}</span>}
      <div className="feed-metrics"><span>{t('collection.metrics', { count: feed.itemCount, minutes: feed.intervalMinutes })}</span><small title={absoluteTime(feed.lastSuccessAt)}>{t('collection.lastSuccess', { time: feed.lastSuccessAt ? relativeTime(feed.lastSuccessAt) : t('feed.neverUpdated') })}</small></div>
      <div className="detail-actions"><button className="button small" disabled={busy} aria-label={t('collection.copyRssOf', { name: feed.name })} onClick={() => void operate('copy', [feed.id])}><Copy size={14} />{t('collection.copyRssShort')}</button><button className="button small" aria-label={t('collection.settingsOf', { name: feed.name })} onClick={() => settings(feed.id)}><Settings2 size={14} />{t('feed.settings')}</button></div>
    </article>)}</div>
  </section>;
}
