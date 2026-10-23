import { useEffect, useState } from 'react';
import { OUTPUT_LIMIT, translationEnabled, type AuthState, type BulkFeedSettingsInput, type Feed } from '../shared/types';
import { api } from './api';
import { Copy, FileDown, LayoutGrid, List, Settings2, X } from 'lucide-react';
import { absoluteTime, avatarHue, buildOpml, copyText, downloadText, initial, relativeTime } from './format';

export type StatusFilter = 'all' | 'attention';
type SortKey = 'default' | 'name' | 'updated' | 'attention';
const sortLabels: Record<SortKey, string> = { default: '添加顺序', name: '名称', updated: '最近更新', attention: '需要检查优先' };

function readSort(): SortKey {
  try { const value = localStorage.getItem('feedlantern:sort'); return value && value in sortLabels ? value as SortKey : 'default'; } catch { return 'default'; }
}

function sortFeeds(feeds: Feed[], key: SortKey): Feed[] {
  if (key === 'default') return feeds;
  const list = [...feeds];
  if (key === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  if (key === 'updated') list.sort((a, b) => (b.lastSuccessAt ?? '').localeCompare(a.lastSuccessAt ?? ''));
  if (key === 'attention') list.sort((a, b) => Number(!!b.lastError) - Number(!!a.lastError) || Number(!a.enabled) - Number(!b.enabled));
  return list;
}

export function FeedCollection({ auth, feeds, query, status, onStatus, detail, settings, logs, changed, notify }: {
  auth: AuthState; feeds: Feed[]; query: string; status: StatusFilter; onStatus: (status: StatusFilter) => void;
  detail: (id: string) => void; settings: (id: string) => void; logs: (id: string) => void;
  changed: () => void; notify: (text: string) => void;
}) {
  const [sourceFilter, setSourceFilter] = useState('all');
  const [outputFilter, setOutputFilter] = useState('all');
  const statusFilter = status;
  const [sort, setSort] = useState<SortKey>(readSort);
  const visible = sortFeeds(feeds.filter(feed => (statusFilter === 'all' || !!feed.lastError) && (sourceFilter === 'all' || (feed.sourceType ?? 'website') === sourceFilter) && (outputFilter === 'all' || (translationEnabled(feed) ? 'translated' : 'original') === outputFilter)), sort);
  const [view, setView] = useState<'list' | 'cards'>('list');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<NonNullable<BulkFeedSettingsInput['translationMode']> | ''>('');
  const [interval, setInterval] = useState('');
  const [outputLimit, setOutputLimit] = useState('');
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
    if (action === 'delete' && !confirm(`删除选中的 ${ids.length} 个订阅及其历史条目？`)) return;
    setBusy(true); setError('');
    try {
      const { results } = await api.feeds.bulk(ids, action, patch);
      if (action === 'copy') await copyText(results.filter(r => r.ok).map(r => r.feedUrl).join('\n'));
      const failures = results.filter(r => !r.ok);
      setSelected(failures.map(r => r.id));
      if (!failures.length) setEditing(false);
      setError(failures.map(r => `${feeds.find(f => f.id === r.id)?.name ?? r.id}：${r.error}`).join('；'));
      notify(`${action === 'copy' ? '已复制' : '已完成'} ${results.length - failures.length} 项${failures.length ? `，失败 ${failures.length} 项` : ''}`);
      changed();
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  }
  async function exportOpml(ids: string[]) {
    if (!ids.length) return;
    setBusy(true); setError('');
    try {
      const { results } = await api.feeds.bulk(ids, 'copy');
      const entries = results.flatMap(result => {
        const feed = feeds.find(item => item.id === result.id);
        return result.ok && result.feedUrl && feed ? [{ name: feed.name, feedUrl: result.feedUrl, siteUrl: feed.url }] : [];
      });
      downloadText(buildOpml('FeedLantern 订阅', entries), `feedlantern-${new Date().toISOString().slice(0, 10)}.opml`, 'text/x-opml;charset=utf-8');
      notify(`已导出 ${entries.length} 个订阅的 OPML`);
    } catch (e) { setError(e instanceof Error ? e.message : '导出失败'); } finally { setBusy(false); }
  }
  function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    const patch: BulkFeedSettingsInput = {};
    if (mode) patch.translationMode = mode;
    if (interval.trim()) patch.intervalMinutes = Number(interval);
    if (outputLimit.trim()) patch.outputLimit = Number(outputLimit);
    if (!Object.keys(patch).length) return;
    void operate('settings', selected, patch);
  }
  function clearFilters() { setSourceFilter('all'); setOutputFilter('all'); onStatus('all'); }
  const filtered = sourceFilter !== 'all' || outputFilter !== 'all' || statusFilter !== 'all';
  const all = visible.length > 0 && visible.every(f => selected.includes(f.id));
  return <section aria-label="订阅集合">
    <div className="collection-toolbar collection-filters"><div className="inline filter-group"><label>来源 <select aria-label="筛选订阅来源" value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}><option value="all">全部来源</option><option value="website">网页抓取</option><option value="rss">RSS 来源</option></select></label><label>输出 <select aria-label="筛选订阅输出" value={outputFilter} onChange={e => setOutputFilter(e.target.value)}><option value="all">全部输出</option><option value="translated">翻译订阅</option><option value="original">原文订阅</option></select></label><label>状态 <select aria-label="筛选订阅状态" value={statusFilter} onChange={e => onStatus(e.target.value as StatusFilter)}><option value="all">全部状态</option><option value="attention">需要检查</option></select></label><label>排序 <select aria-label="排序订阅" value={sort} onChange={e => changeSort(e.target.value as SortKey)}>{(Object.keys(sortLabels) as SortKey[]).map(key => <option key={key} value={key}>{sortLabels[key]}</option>)}</select></label></div>
      <div className="inline"><button className="button small" aria-pressed={view === 'list'} onClick={() => void changeView('list')}><List size={14} />列表</button><button className="button small" aria-pressed={view === 'cards'} onClick={() => void changeView('cards')}><LayoutGrid size={14} />卡片</button></div>
    </div>
    {selected.length > 0 && <div className="collection-toolbar"><span>已选择 {selected.length} 项</span><div className="detail-actions"><button className="button small" disabled={busy} onClick={() => { setMode(''); setInterval(''); setOutputLimit(''); setEditing(true); setError(''); }}>批量修改设置</button>{[['copy', '复制 RSS 地址'], ['pause', '暂停'], ['resume', '恢复'], ['refresh', '立即刷新']].map(([action, label]) => <button className="button small" key={action} disabled={busy} onClick={() => void operate(action)}>{label}</button>)}<button className="button small" disabled={busy} onClick={() => void exportOpml(selected)}>导出 OPML</button><button className="button small" disabled={busy} onClick={() => void operate('delete')}>删除</button></div><button className="icon-button bulk-clear" aria-label="取消选择" disabled={busy} onClick={() => { setSelected([]); setEditing(false); }}><X size={16} /></button></div>}
    {editing && selected.length > 0 && <form className="panel settings-form" aria-label="批量修改订阅设置" onSubmit={saveSettings}>
      <h3>修改选中的 {selected.length} 个订阅</h3>
      <p className="hint">只应用填写的设置，其他设置保持原值。</p>
      <fieldset disabled={busy}>
        <label className="field"><span>翻译输出模式</span><select value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="">保持原值</option><option value="bilingual">双语</option><option value="chinese">仅中文</option><option value="original">原文（不翻译）</option></select></label>
        <label className="field"><span>刷新间隔（分钟）</span><input type="number" min={5} max={1440} step={1} placeholder="留空保持原值" value={interval} onChange={e => setInterval(e.target.value)} /></label>
        <label className="field"><span>输出条数</span><input type="number" min={OUTPUT_LIMIT.min} max={OUTPUT_LIMIT.max} step={1} placeholder="留空保持原值" value={outputLimit} onChange={e => setOutputLimit(e.target.value)} /></label>
        <div className="detail-actions"><button className="button" type="submit" disabled={!mode && !interval.trim() && !outputLimit.trim()}>应用到所选订阅</button><button className="button secondary" type="button" onClick={() => setEditing(false)}>取消</button></div>
      </fieldset>
    </form>}
    {error && <div className="error-note" role="alert">{error}</div>}
    {visible.length === 0 && <div className="filter-empty"><p className="muted">当前筛选条件下没有订阅。</p>{filtered && <button className="button small" onClick={clearFilters}>清除筛选</button>}</div>}
    {visible.length > 0 && <div className={`collection-head ${view === 'cards' ? 'is-cards' : ''}`}><label className="feed-select"><input type="checkbox" aria-label="全选当前结果" checked={all} disabled={busy} onChange={e => setSelected(e.target.checked ? visible.map(f => f.id) : [])} /></label><span className="collection-count">{visible.length} 个订阅</span><button className="button small collection-export" disabled={busy} title="导出当前结果，可导入任意 RSS 阅读器" onClick={() => void exportOpml(visible.map(feed => feed.id))}><FileDown size={14} />导出 OPML</button></div>}
    <div className={view === 'cards' ? 'feed-grid' : 'feed-list'}>{visible.map(feed => <article className={view === 'cards' ? 'feed-card' : 'feed-row'} key={feed.id} data-state={feed.lastError ? 'error' : feed.enabled ? 'active' : 'paused'}>
      <label className="feed-select"><input type="checkbox" aria-label={`选择订阅 ${feed.name}`} disabled={busy} checked={selected.includes(feed.id)} onChange={e => setSelected(previous => e.target.checked ? [...previous, feed.id] : previous.filter(id => id !== feed.id))} /></label>
      <div className="feed-identity"><span className="feed-avatar" aria-hidden="true" style={{ '--hue': avatarHue(feed.name) } as React.CSSProperties}>{initial(feed.name)}</span><div className="feed-text"><button className="card-title" aria-label={`查看订阅 ${feed.name}`} onClick={() => detail(feed.id)}>{feed.name}</button><div className="inline feed-kind"><span className="badge">{feed.sourceType === 'rss' ? 'RSS 来源' : '网页抓取'}</span><span className={`badge ${translationEnabled(feed) ? 'good' : ''}`}>{translationEnabled(feed) ? feed.translationMode === 'chinese' ? '中文翻译' : '双语翻译' : '原文'}</span></div><p className="feed-host" title={feed.url}>{feed.url}</p>{feed.lastError && <button className="card-error" title={`${feed.lastError}（点击查看抓取日志）`} onClick={() => logs(feed.id)}>{feed.lastError}</button>}</div></div>
      {feed.lastError ? <button type="button" className="badge bad badge-button" title={statusFilter === 'attention' ? '已只显示需要检查的订阅' : '只看需要检查的订阅'} onClick={() => onStatus('attention')}>需要检查</button> : <span className={`badge ${feed.enabled ? 'good' : ''}`}>{feed.enabled ? '更新中' : '已暂停'}</span>}
      <div className="feed-metrics"><span>{feed.itemCount} 条内容 · 每 {feed.intervalMinutes} 分钟</span><small title={absoluteTime(feed.lastSuccessAt)}>最近成功：{feed.lastSuccessAt ? relativeTime(feed.lastSuccessAt) : '尚未更新'}</small></div>
      <div className="detail-actions"><button className="button small" disabled={busy} aria-label={`复制 RSS 地址 ${feed.name}`} onClick={() => void operate('copy', [feed.id])}><Copy size={14} />复制 RSS</button><button className="button small" aria-label={`订阅设置 ${feed.name}`} onClick={() => settings(feed.id)}><Settings2 size={14} />订阅设置</button></div>
    </article>)}</div>
  </section>;
}
