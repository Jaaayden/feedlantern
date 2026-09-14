import { useEffect, useState } from 'react';
import { translationEnabled, type AuthState, type BulkFeedSettingsInput, type Feed } from '../shared/types';
import { api } from './api';

export function FeedCollection({ auth, feeds, query, detail, settings, changed, notify }: {
  auth: AuthState; feeds: Feed[]; query: string; detail: (id: string) => void; settings: (id: string) => void;
  changed: () => void; notify: (text: string) => void;
}) {
  const [sourceFilter, setSourceFilter] = useState('all');
  const [outputFilter, setOutputFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const visible = feeds.filter(feed => (statusFilter === 'all' || !!feed.lastError) && (sourceFilter === 'all' || (feed.sourceType ?? 'website') === sourceFilter) && (outputFilter === 'all' || (translationEnabled(feed) ? 'translated' : 'original') === outputFilter));
  const [view, setView] = useState<'list' | 'cards'>('list');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<NonNullable<BulkFeedSettingsInput['translationMode']> | ''>('');
  const [interval, setInterval] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (auth.role === 'admin') { void api.settings.get().then(s => setView(s.feedView)).catch(e => setError(e.message)); } else { try { setView(localStorage.getItem(`feedlantern:view:${auth.userId}`) === 'cards' ? 'cards' : 'list'); } catch {} } }, [auth.userId, auth.role]);
  useEffect(() => { setSelected([]); setEditing(false); }, [query, sourceFilter, outputFilter, statusFilter]);
  useEffect(() => setSelected(previous => previous.filter(id => feeds.some(f => f.id === id))), [feeds]);
  async function changeView(next: 'list' | 'cards') {
    try { if (auth.role === 'admin') await api.settings.update(next); else localStorage.setItem(`feedlantern:view:${auth.userId}`, next); setView(next); } catch (e) { setError(String(e)); }
  }
  async function operate(action: string, ids = selected, patch?: BulkFeedSettingsInput) {
    if (action === 'delete' && !confirm(`删除选中的 ${ids.length} 个订阅及其历史条目？`)) return;
    setBusy(true); setError('');
    try {
      const { results } = await api.feeds.bulk(ids, action, patch);
      if (action === 'copy') await navigator.clipboard.writeText(results.filter(r => r.ok).map(r => r.feedUrl).join('\n'));
      const failures = results.filter(r => !r.ok);
      setSelected(failures.map(r => r.id));
      if (!failures.length) setEditing(false);
      setError(failures.map(r => `${feeds.find(f => f.id === r.id)?.name ?? r.id}：${r.error}`).join('；'));
      notify(`${action === 'copy' ? '已复制' : '已完成'} ${results.length - failures.length} 项${failures.length ? `，失败 ${failures.length} 项` : ''}`);
      changed();
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  }
  function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    const patch: BulkFeedSettingsInput = {};
    if (mode) patch.translationMode = mode;
    if (interval.trim()) patch.intervalMinutes = Number(interval);
    if (!Object.keys(patch).length) return;
    void operate('settings', selected, patch);
  }
  const all = visible.length > 0 && visible.every(f => selected.includes(f.id));
  return <section aria-label="订阅集合">
    <div className="collection-toolbar"><div className="inline"><label>来源 <select aria-label="筛选订阅来源" value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}><option value="all">全部来源</option><option value="website">网页抓取</option><option value="rss">RSS 来源</option></select></label><label>输出 <select aria-label="筛选订阅输出" value={outputFilter} onChange={e => setOutputFilter(e.target.value)}><option value="all">全部输出</option><option value="translated">翻译订阅</option><option value="original">原文订阅</option></select></label><label>状态 <select aria-label="筛选订阅状态" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="all">全部状态</option><option value="attention">需要检查</option></select></label></div></div>
    <div className="collection-toolbar"><label className="inline"><input type="checkbox" checked={all} disabled={busy || !visible.length} onChange={e => setSelected(e.target.checked ? visible.map(f => f.id) : [])} />全选当前结果</label>
      <div className="inline"><button className="button small" aria-pressed={view === 'list'} onClick={() => void changeView('list')}>列表</button><button className="button small" aria-pressed={view === 'cards'} onClick={() => void changeView('cards')}>卡片</button></div>
    </div>
    {selected.length > 0 && <div className="collection-toolbar"><span>已选择 {selected.length} 项</span><div className="detail-actions"><button className="button small" disabled={busy} onClick={() => { setMode(''); setInterval(''); setEditing(true); setError(''); }}>批量修改设置</button>{[['copy', '复制 RSS 地址'], ['pause', '暂停'], ['resume', '恢复'], ['refresh', '立即刷新'], ['delete', '删除']].map(([action, label]) => <button className="button small" key={action} disabled={busy} onClick={() => void operate(action)}>{label}</button>)}</div></div>}
    {editing && selected.length > 0 && <form className="panel settings-form" aria-label="批量修改订阅设置" onSubmit={saveSettings}>
      <h3>修改选中的 {selected.length} 个订阅</h3>
      <p className="hint">只应用填写的设置，其他设置保持原值。</p>
      <fieldset disabled={busy}>
        <label className="field"><span>翻译输出模式</span><select value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="">保持原值</option><option value="bilingual">双语</option><option value="chinese">仅中文</option><option value="original">原文（不翻译）</option></select></label>
        <label className="field"><span>刷新间隔（分钟）</span><input type="number" min={5} max={1440} step={1} placeholder="留空保持原值" value={interval} onChange={e => setInterval(e.target.value)} /></label>
        <div className="detail-actions"><button className="button" type="submit" disabled={!mode && !interval.trim()}>应用到所选订阅</button><button className="button secondary" type="button" onClick={() => setEditing(false)}>取消</button></div>
      </fieldset>
    </form>}
    {error && <div className="error-note" role="alert">{error}</div>}
    {visible.length === 0 && <p className="muted">当前筛选条件下没有订阅。</p>}
    <div className={view === 'cards' ? 'feed-grid' : 'feed-list'}>{visible.map(feed => <article className={view === 'cards' ? 'feed-card' : 'feed-row'} key={feed.id}>
      <label className="feed-select"><input type="checkbox" aria-label={`选择订阅 ${feed.name}`} disabled={busy} checked={selected.includes(feed.id)} onChange={e => setSelected(previous => e.target.checked ? [...previous, feed.id] : previous.filter(id => id !== feed.id))} /></label>
      <div className="feed-identity"><button className="card-title" aria-label={`查看订阅 ${feed.name}`} onClick={() => detail(feed.id)}>{feed.name}</button><div className="inline feed-kind"><span className="badge">{feed.sourceType === 'rss' ? 'RSS 来源' : '网页抓取'}</span><span className={`badge ${translationEnabled(feed) ? 'good' : ''}`}>{translationEnabled(feed) ? feed.translationMode === 'chinese' ? '中文翻译' : '双语翻译' : '原文'}</span></div><p className="feed-host" title={feed.url}>{feed.url}</p>{feed.lastError && <p className="card-error" title={feed.lastError}>{feed.lastError}</p>}</div>
      <span className={`badge ${feed.lastError ? 'bad' : feed.enabled ? 'good' : ''}`}>{feed.lastError ? '需要检查' : feed.enabled ? '更新中' : '已暂停'}</span>
      <div className="feed-metrics"><span>{feed.itemCount} 条内容 · 每 {feed.intervalMinutes} 分钟</span><small>最近成功：{feed.lastSuccessAt ? new Date(feed.lastSuccessAt).toLocaleString('zh-CN') : '尚未更新'}</small></div>
      <div className="detail-actions"><button className="button small" disabled={busy} aria-label={`复制 RSS 地址 ${feed.name}`} onClick={() => void operate('copy', [feed.id])}>复制 RSS</button><button className="button small" aria-label={`订阅设置 ${feed.name}`} onClick={() => settings(feed.id)}>订阅设置</button></div>
    </article>)}</div>
  </section>;
}
