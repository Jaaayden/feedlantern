import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSourceLabels, type AlertStatus, type FetchLog, type FetchStatus } from '../shared/types';
import { api } from './api';

const statusLabels: Record<FetchStatus, string> = { running: '执行中', success: '成功', failure: '失败', interrupted: '中断' };
const alertLabels: Record<AlertStatus, string> = { pending: '待发送', sent: '已发送', failed: '发送失败', canceled: '已取消', disabled: '未启用' };

export function FetchLogs({ id, revision }: { id: string; revision: number }) {
  const [retention, setRetention] = useState(30);
  const [status, setStatus] = useState<FetchStatus | ''>('');
  const [logs, setLogs] = useState<FetchLog[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const pending = useRef(false);

  const load = useCallback(async (next?: string, current = generation.current) => {
    if (pending.current) return;
    pending.current = true;
    try {
      const page = await api.feeds.logs(id, status || undefined, next);
      if (generation.current !== current) return;
      setLogs(previous => next ? [...previous, ...page.logs] : page.logs);
      setRetention(page.retentionDays ?? 30);
      setCursor(page.nextCursor); setError('');
    } catch (e) {
      if (generation.current === current) setError(e instanceof Error ? e.message : '日志加载失败');
    } finally {
      if (generation.current === current) { pending.current = false; setLoading(false); }
    }
  }, [id, status]);

  useEffect(() => {
    const current = ++generation.current;
    pending.current = false;
    setLogs([]); setCursor(null); setExpanded(false); setLoading(true); setError('');
    void load(undefined, current);
    return () => { generation.current++; };
  }, [load, revision, retry]);

  useEffect(() => {
    if (expanded) return;
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 5_000);
    return () => clearInterval(timer);
  }, [expanded, load]);

  return <section aria-label="抓取日志" className="fetch-logs">
    <div className="collection-toolbar">
      <label className="inline">执行状态<select aria-label="日志状态" value={status} onChange={e => setStatus(e.target.value as FetchStatus | '')}>
        <option value="">全部状态</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <button className="button small" onClick={() => setRetry(v => v + 1)}>刷新日志</button>
    </div>
    <p className="hint">仅保留最近 {retention} 天。{expanded ? '查看历史时暂停自动更新。' : '最新日志每 5 秒自动更新。'}</p>
    {error && <div className="error-note" role="alert">{error}<button className="button small" onClick={() => setRetry(v => v + 1)}>重试</button></div>}
    {loading && <p role="status">正在加载日志…</p>}
    {!loading && !error && logs.length === 0 && <p className="muted">暂无抓取日志</p>}
    <div className="fetch-log-list">{logs.map(log => <article className="fetch-log" key={log.id}>
      <div className="fetch-log-heading"><time dateTime={log.startedAt}>{new Date(log.startedAt).toLocaleString('zh-CN', { hour12: false })}</time>
        <span>{fetchSourceLabels[log.source]}</span><span className={`badge ${log.status === 'success' ? 'good' : log.status === 'failure' || log.status === 'interrupted' ? 'bad' : ''}`}>{statusLabels[log.status]}</span>
      </div>
      <p className="muted">耗时：{log.durationMs === null ? log.status === 'running' ? '执行中' : '未知' : `${(log.durationMs / 1000).toFixed(2)} 秒`}
        {log.itemCount !== null && ` · 有效 ${log.itemCount} 条 · 新增 ${log.newItemCount} 条`}</p>
      {log.error && <p className="card-error">{log.error}</p>}
      {log.notification && <p className="fetch-log-notification">Bark：{alertLabels[log.notification.status]}{log.notification.error && ` · ${log.notification.error}`}</p>}
    </article>)}</div>
    {cursor && <button className="button small" disabled={loading} onClick={() => {
      if (pending.current) return;
      setExpanded(true); setLoading(true); void load(cursor);
    }}>加载更多</button>}
  </section>;
}
