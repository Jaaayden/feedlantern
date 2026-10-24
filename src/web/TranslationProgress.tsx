import { useEffect, useState } from 'react';
import { api } from './api';
import type { TranslationProviderId } from '../shared/types';
import { fmt, t } from './i18n';
import { absoluteTime, relativeTime } from './format';

export interface TranslationProgressData {
  worker: { provider?: TranslationProviderId | null; activeArticles: number; activeRequests: number; queuedSegments: number; cooldownUntil: number | null; stopped: boolean };
  tasks: { id: string; title: string; status: string; attempts: number; nextAt: number; error: string | null }[];
  logs: { id: number; at: number; message: string; itemId: string }[];
}
const states: Record<string, [() => string, string]> = { running: [() => t('item.translating'), 'pending'], pending: [() => t('progress.queued'), 'muted'], failed: [() => t('progress.failed'), 'failed'] };
const iso = (value: number) => new Date(value).toISOString();
/** Log lines worth highlighting, in either language. */
const problem = /失败|上限|中断|受限|错误|无效|fail|limit|interrupt|error|invalid|denied|couldn't/i;

function workerLine(data: TranslationProgressData, enabled: boolean): string {
  const service = data.worker.provider ? t(`provider.${data.worker.provider}`) : t('translation.service');
  const state = !enabled ? t('progress.feedPaused')
    : data.worker.stopped ? t('progress.servicePaused')
    : data.worker.cooldownUntil ? t('progress.cooldown', { service, time: fmt.date(data.worker.cooldownUntil, { timeStyle: 'medium' }) })
    : data.tasks.some(task => task.status === 'running') ? t('progress.translating')
    : data.tasks.some(task => task.status === 'pending') ? t('progress.waiting')
    : data.tasks.length ? t('progress.roundDone') : t('progress.waitingFetch');
  return `${state} · ${t('progress.load', { scope: data.worker.provider ? service : t('progress.allFeeds'), requests: data.worker.activeRequests, segments: data.worker.queuedSegments })}`;
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
      catch { if (!disposed) setError(t('progress.loadFailed')); }
      finally { loading = false; }
    };
    void load(); const timer = window.setInterval(() => void load(), 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [id]);
  const now = Date.now();
  const unfinished = data?.tasks.filter(task => task.status !== 'success') ?? [];
  const titles = new Map(data?.tasks.map(task => [task.id, task.title]));
  return <section className="activity-section translation-log" aria-label={t('progress.log')}>
    {error && <p className="error-note" role="alert">{error}</p>}
    {!data ? <p className="muted" role="status">{t('progress.loading')}</p> : <>
      <p className="activity-status" role="status"><span className={`activity-dot${data.tasks.some(t => t.status === 'running') ? ' live' : ''}`} aria-hidden="true" />{workerLine(data, enabled)}</p>
      <div className="activity-group">
        <h4>{t('progress.unfinished')} <span>{unfinished.length}</span></h4>
        {unfinished.length ? <ul className="activity-list">{unfinished.map(task => {
          const [label, tone] = states[task.status] ?? [() => task.status, 'muted'];
          return <li key={task.id} className={task.status === 'failed' ? 'is-failed' : undefined}>
            <span className={`item-tag ${tone}`}>{label()}</span>
            <span className="activity-text"><strong>{task.title}</strong>{task.error && <small>{task.error}</small>}</span>
            <span className="activity-time">{task.status === 'pending' && task.nextAt > now ? <time dateTime={iso(task.nextAt)} title={absoluteTime(iso(task.nextAt))}>{t('progress.retryAt', { time: relativeTime(iso(task.nextAt), now) })}</time> : t('progress.attempt', { n: Math.max(task.attempts, 1) })}</span>
          </li>;
        })}</ul> : <p className="activity-empty">{data.tasks.length ? t('progress.allDone') : t('progress.nothing')}</p>}
      </div>
      <div className="activity-group">
        <h4>{t('progress.log')}</h4>
        {data.logs.length ? <ol className="activity-list activity-log">{data.logs.map(log => <li key={log.id} className={problem.test(log.message) ? 'is-failed' : undefined}>
          <time dateTime={iso(log.at)} title={absoluteTime(iso(log.at))}>{new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
          <span className="activity-text"><strong>{titles.get(log.itemId) ?? t('progress.article')}</strong><small>{log.message}</small></span>
        </li>)}</ol> : <p className="activity-empty">{t('progress.noLog')}</p>}
      </div>
      <p className="hint">{t('progress.hint')}</p>
    </>}
  </section>;
}
