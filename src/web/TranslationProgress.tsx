import { useEffect, useState } from 'react';
import { api } from './api';
import { translationProviderLabels, type TranslationProviderId } from '../shared/types';
import { absoluteTime, relativeTime } from './format';

export interface TranslationProgressData {
  worker: { provider?: TranslationProviderId | null; activeArticles: number; activeRequests: number; queuedSegments: number; cooldownUntil: number | null; stopped: boolean };
  tasks: { id: string; title: string; status: string; attempts: number; nextAt: number; error: string | null }[];
  logs: { id: number; at: number; message: string; itemId: string }[];
}
const states: Record<string, [string, string]> = { running: ['翻译中', 'pending'], pending: ['排队等待', 'muted'], failed: ['失败', 'failed'] };
const iso = (value: number) => new Date(value).toISOString();
const problem = /失败|上限|中断|受限|错误|无效/;

function workerLine(data: TranslationProgressData, enabled: boolean): string {
  const service = data.worker.provider ? translationProviderLabels[data.worker.provider] : '翻译服务';
  const state = !enabled ? '订阅已暂停'
    : data.worker.stopped ? '翻译服务已暂停'
    : data.worker.cooldownUntil ? `${service}请求受限，${new Date(data.worker.cooldownUntil).toLocaleTimeString('zh-CN', { hour12: false })} 后恢复调度`
    : data.tasks.some(t => t.status === 'running') ? '正在翻译'
    : data.tasks.some(t => t.status === 'pending') ? '等待调度或自动重试'
    : data.tasks.length ? '本轮翻译已结束' : '等待 RSS 抓取完成';
  return `${state} · ${data.worker.provider ? service : '全站'}当前 ${data.worker.activeRequests} 个请求，${data.worker.queuedSegments} 个片段排队`;
}

/** Translation activity of one feed: unfinished articles and the event log. Polls while shown. */
export function TranslationLog({ id, enabled }: { id: string; enabled: boolean }) {
  const [data, setData] = useState<TranslationProgressData>();
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false, loading = false;
    setData(undefined); setError('');
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try { const result = await api.feeds.translationProgress(id); if (!disposed) { setData(result); setError(''); } }
      catch { if (!disposed) setError('翻译进度读取失败，正在重试'); }
      finally { loading = false; }
    };
    void load(); const timer = window.setInterval(() => void load(), 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [id]);
  const now = Date.now();
  const unfinished = data?.tasks.filter(task => task.status !== 'success') ?? [];
  const titles = new Map(data?.tasks.map(task => [task.id, task.title]));
  return <section className="activity-section translation-log" aria-label="翻译日志">
    {error && <p className="error-note" role="alert">{error}</p>}
    {!data ? <p className="muted" role="status">正在读取翻译状态…</p> : <>
      <p className="activity-status" role="status"><span className={`activity-dot${data.tasks.some(t => t.status === 'running') ? ' live' : ''}`} aria-hidden="true" />{workerLine(data, enabled)}</p>
      <div className="activity-group">
        <h4>未完成的文章 <span>{unfinished.length}</span></h4>
        {unfinished.length ? <ul className="activity-list">{unfinished.map(task => {
          const [label, tone] = states[task.status] ?? [task.status, 'muted'];
          return <li key={task.id} className={task.status === 'failed' ? 'is-failed' : undefined}>
            <span className={`item-tag ${tone}`}>{label}</span>
            <span className="activity-text"><strong>{task.title}</strong>{task.error && <small>{task.error}</small>}</span>
            <span className="activity-time">{task.status === 'pending' && task.nextAt > now ? <time dateTime={iso(task.nextAt)} title={absoluteTime(iso(task.nextAt))}>{relativeTime(iso(task.nextAt), now)}重试</time> : `第 ${Math.max(task.attempts, 1)} 次`}</span>
          </li>;
        })}</ul> : <p className="activity-empty">{data.tasks.length ? '全部文章已翻译完成。' : '还没有需要翻译的文章。'}</p>}
      </div>
      <div className="activity-group">
        <h4>翻译日志</h4>
        {data.logs.length ? <ol className="activity-list activity-log">{data.logs.map(log => <li key={log.id} className={problem.test(log.message) ? 'is-failed' : undefined}>
          <time dateTime={iso(log.at)} title={absoluteTime(iso(log.at))}>{new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
          <span className="activity-text"><strong>{titles.get(log.itemId) ?? '文章'}</strong><small>{log.message}</small></span>
        </li>)}</ol> : <p className="activity-empty">暂无翻译日志；新任务开始后会在这里显示。</p>}
      </div>
      <p className="hint">最近 100 条，保留 7 天；每 2 秒自动更新。</p>
    </>}
  </section>;
}
