import { useEffect, useState } from 'react';
import type { Feed } from '../shared/types';
import { api } from './api';

export function FeedCollection({ feeds, query, detail, edit, changed, notify }: {
  feeds: Feed[]; query: string; detail: (id: string) => void; edit: (feed: Feed) => void;
  changed: () => void; notify: (text: string) => void;
}) {
  const [view, setView] = useState<'list' | 'cards'>('list');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void api.settings.get().then(s => setView(s.feedView)).catch(e => setError(e.message)); }, []);
  useEffect(() => setSelected([]), [query]);
  useEffect(() => setSelected(previous => previous.filter(id => feeds.some(f => f.id === id))), [feeds]);
  async function changeView(next: 'list' | 'cards') {
    try { await api.settings.update(next); setView(next); } catch (e) { setError(String(e)); }
  }
  async function operate(action: string, ids = selected) {
    if (action === 'delete' && !confirm(`删除选中的 ${ids.length} 个订阅及其历史条目？`)) return;
    setBusy(true); setError('');
    try {
      const { results } = await api.feeds.bulk(ids, action);
      if (action === 'copy') await navigator.clipboard.writeText(results.filter(r => r.ok).map(r => r.feedUrl).join('\n'));
      const failures = results.filter(r => !r.ok);
      setSelected(failures.map(r => r.id));
      setError(failures.map(r => `${feeds.find(f => f.id === r.id)?.name ?? r.id}：${r.error}`).join('；'));
      notify(`${action === 'copy' ? '已复制' : '已完成'} ${results.length - failures.length} 项${failures.length ? `，失败 ${failures.length} 项` : ''}`);
      changed();
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  }
  const all = feeds.length > 0 && feeds.every(f => selected.includes(f.id));
  return <section aria-label="订阅集合">
    <div className="collection-toolbar"><label className="inline"><input type="checkbox" checked={all} disabled={busy || !feeds.length} onChange={e => setSelected(e.target.checked ? feeds.map(f => f.id) : [])} />全选当前结果</label>
      <div className="inline"><button className="button small" aria-pressed={view === 'list'} onClick={() => void changeView('list')}>列表</button><button className="button small" aria-pressed={view === 'cards'} onClick={() => void changeView('cards')}>卡片</button></div>
    </div>
    {selected.length > 0 && <div className="collection-toolbar"><span>已选择 {selected.length} 项</span><div className="detail-actions">{[['copy', '复制 RSS 地址'], ['pause', '暂停'], ['resume', '恢复'], ['refresh', '立即刷新'], ['delete', '删除']].map(([action, label]) => <button className="button small" key={action} disabled={busy} onClick={() => void operate(action)}>{label}</button>)}</div></div>}
    {error && <div className="error-note" role="alert">{error}</div>}
    <div className={view === 'cards' ? 'feed-grid' : 'feed-list'}>{feeds.map(feed => <article className={view === 'cards' ? 'feed-card' : 'feed-row'} key={feed.id}>
      <label className="feed-select"><input type="checkbox" aria-label={`选择订阅 ${feed.name}`} disabled={busy} checked={selected.includes(feed.id)} onChange={e => setSelected(previous => e.target.checked ? [...previous, feed.id] : previous.filter(id => id !== feed.id))} /></label>
      <div className="feed-identity"><button className="card-title" aria-label={`查看订阅 ${feed.name}`} onClick={() => detail(feed.id)}>{feed.name}</button><p className="feed-host" title={feed.url}>{feed.url}</p>{feed.lastError && <p className="card-error" title={feed.lastError}>{feed.lastError}</p>}</div>
      <span className={`badge ${feed.lastError ? 'bad' : feed.enabled ? 'good' : ''}`}>{feed.lastError ? '需要检查' : feed.enabled ? '更新中' : '已暂停'}</span>
      <div className="feed-metrics"><span>{feed.itemCount} 条内容 · 每 {feed.intervalMinutes} 分钟</span><small>最近成功：{feed.lastSuccessAt ? new Date(feed.lastSuccessAt).toLocaleString('zh-CN') : '尚未更新'}</small></div>
      <div className="detail-actions"><button className="button small" disabled={busy} aria-label={`复制 RSS 地址 ${feed.name}`} onClick={() => void operate('copy', [feed.id])}>复制 RSS</button><button className="button small" aria-label={`编辑订阅 ${feed.name}`} onClick={() => edit(feed)}>编辑</button></div>
    </article>)}</div>
  </section>;
}
