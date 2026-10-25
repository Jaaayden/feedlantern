import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSourceName, notificationChannelLabels, type AlertStatus, type FetchLog, type FetchStatus } from '../shared/types';
import { api } from './api';
import { fmt, t } from './i18n';

const fetchStatuses: FetchStatus[] = ['running', 'success', 'failure', 'interrupted'];
const statusLabel = (status: FetchStatus) => t(`fetchLog.status.${status}`);
const alertLabel = (status: AlertStatus) => t(`fetchLog.alert.${status}`);
/** One entry per channel the alert went to, e.g. "Bark sent · Webhook retrying (…)". */
function notificationText(notification: NonNullable<FetchLog['notification']>): string {
  if (!notification.channels?.length) return `${alertLabel(notification.status)}${notification.error ? ` · ${notification.error}` : ''}`;
  return notification.channels.map(c => t(c.error ? 'fetchLog.channelError' : 'fetchLog.channel', { channel: notificationChannelLabels[c.channel] ?? c.channel, status: c.status === 'pending' && c.error ? t('fetchLog.alert.retrying') : alertLabel(c.status), error: c.error ?? '' })).join(' · ');
}

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
      if (generation.current === current) setError(e instanceof Error ? e.message : t('fetchLog.loadFailed'));
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

  return <section aria-label={t('fetchLog.title')} className="fetch-logs">
    <div className="collection-toolbar">
      <label className="inline">{t('fetchLog.statusFilter')}<select aria-label={t('fetchLog.statusFilterLabel')} value={status} onChange={e => setStatus(e.target.value as FetchStatus | '')}>
        <option value="">{t('fetchLog.allStatuses')}</option>{fetchStatuses.map(key => <option key={key} value={key}>{statusLabel(key)}</option>)}
      </select></label>
      <button className="button small" onClick={() => setRetry(v => v + 1)}>{t('fetchLog.refresh')}</button>
    </div>
    <p className="hint">{t('fetchLog.retention', { count: retention })} {expanded ? t('fetchLog.paused') : t('fetchLog.auto')}</p>
    {error && <div className="error-note" role="alert">{error}<button className="button small" onClick={() => setRetry(v => v + 1)}>{t('common.retry')}</button></div>}
    {loading && <p role="status">{t('fetchLog.loading')}</p>}
    {!loading && !error && logs.length === 0 && <p className="muted">{t('fetchLog.empty')}</p>}
    <div className="fetch-log-list">{logs.map(log => <article className="fetch-log" key={log.id}>
      <div className="fetch-log-heading"><div className="fetch-log-meta"><time dateTime={log.startedAt}>{new Date(log.startedAt).toLocaleString('zh-CN', { hour12: false })}</time><span>{fetchSourceName(t, log.source)}</span></div>
        <div className="fetch-log-statuses"><span className={`badge ${log.status === 'success' ? 'good' : log.status === 'failure' || log.status === 'interrupted' ? 'bad' : ''}`}>{statusLabel(log.status)}</span>{log.warning && <span className={`badge ${log.warningSeverity === 'warning' ? 'warn' : ''}`}>{t(log.warningSeverity === 'notice' ? 'health.noticeBadge' : log.warningSeverity === 'warning' ? 'health.badge' : 'health.checkRecord')}</span>}</div>
      </div>
      <p className="muted">{t('fetchLog.duration', { value: log.durationMs === null ? log.status === 'running' ? statusLabel('running') : t('fetchLog.unknown') : t('fetchLog.seconds', { value: fmt.number(log.durationMs / 1000, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }) })}
        {log.itemCount !== null && ` · ${t('fetchLog.counts', { valid: log.itemCount, added: log.newItemCount ?? 0 })}`}</p>
      {log.note && <p className="fetch-log-note muted">{t('fetchLog.pages', { note: log.note })}</p>}
      {log.error && <p className="card-error">{log.error}</p>}
      {log.warning && <p className={log.warningSeverity === 'warning' ? 'card-warning' : 'card-notice'}>{log.warning}</p>}
      {log.notification && <p className="fetch-log-notification">{t('fetchLog.notification', { text: notificationText(log.notification) })}</p>}
    </article>)}</div>
    {cursor && <button className="button small" disabled={loading} onClick={() => {
      if (pending.current) return;
      setExpanded(true); setLoading(true); void load(cursor);
    }}>{t('common.loadMore')}</button>}
  </section>;
}
