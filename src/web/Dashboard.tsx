import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowUpRight, CheckCircle2, ChevronRight, Info, Languages, RefreshCw } from 'lucide-react';
import type { DashboardDay, DashboardPeriod, DashboardStats, Feed } from '../shared/types';
import { isRuleHealthNotice } from '../shared/rule-health';
import { api } from './api';
import { fmt, t } from './i18n';
import { needsAttention, ruleHealthSummary } from './RuleHealth';

type Series = { key: 'collected' | 'translated' | 'subscriptions'; label: string; secondary?: boolean };
const dateLabel = (date: string) => fmt.date(`${date}T00:00:00Z`, { month: 'numeric', day: 'numeric', timeZone: 'UTC' });

function TrendChart({ data, series, label, unit }: { data: DashboardDay[]; series: Series[]; label: string; unit: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320), [active, setActive] = useState<number | null>(null);
  const id = useId();
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(150, entries[0].contentRect.width)));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => setActive(null), [data]);
  const height = 160, left = 46, right = width - 12, top = 24, bottom = 126;
  const values = data.flatMap(day => series.map(s => day[s.key]));
  const low = series[0].key === 'subscriptions' ? Math.max(0, Math.min(...values, Infinity) - 2) : 0;
  const minimum = Number.isFinite(low) ? low : 0;
  const maximum = Math.max(minimum + 2, ...values);
  const step = Math.max(1, Math.pow(10, Math.floor(Math.log10(Math.max(1, maximum - minimum)))));
  const high = Math.ceil((maximum + (maximum > 1 ? step * .2 : 0)) / step) * step;
  const y = (value: number) => bottom - (value - minimum) / (high - minimum) * (bottom - top);
  const x = (index: number) => data.length <= 1 ? (left + right) / 2 : left + index / (data.length - 1) * (right - left);
  const ticks = [...new Set([minimum, Math.round((minimum + high) / 2), high])];
  const xTicks = [...new Set(data.length ? (width < 300 ? [0, data.length - 1] : [0, Math.floor((data.length - 1) / 2), data.length - 1]) : [])];
  const index = active === null ? null : Math.min(data.length - 1, active);
  const selected = index === null ? null : data[index];
  const details = selected ? `${dateLabel(selected.date)} · ${series.map(s => `${s.label} ${fmt.number(selected[s.key])}`).join(' · ')}` : '';
  return <div className="dashboard-chart" ref={container}>
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={label} aria-describedby={selected ? id : undefined} tabIndex={0}
      onPointerMove={event => { const box = event.currentTarget.getBoundingClientRect(); setActive(Math.max(0, Math.min(data.length - 1, Math.round((event.clientX - box.left - left) / (right - left) * (data.length - 1))))); }}
      onPointerLeave={() => setActive(null)} onFocus={() => setActive(data.length - 1)} onBlur={() => setActive(null)}
      onKeyDown={event => {
        if (!['ArrowLeft','ArrowRight','Home','End','Escape'].includes(event.key)) return;
        event.preventDefault();
        setActive(event.key === 'Escape' ? null : event.key === 'Home' ? 0 : event.key === 'End' ? data.length - 1 : Math.max(0, Math.min(data.length - 1, (active ?? data.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1))));
      }}>
      <title>{label}</title>
      <text x={left} y={13}>{unit}</text>
      {ticks.map(value => <g key={value}><line className="dashboard-gridline" x1={left} x2={right} y1={y(value)} y2={y(value)} /><text x={left - 8} y={y(value) + 4} textAnchor="end">{fmt.number(value, { notation: 'compact', maximumFractionDigits: 1 })}</text></g>)}
      {xTicks.map(i => <text key={i} x={x(i)} y={height - 10} textAnchor={data.length === 1 ? 'middle' : i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}>{dateLabel(data[i].date)}</text>)}
      {series.map(s => <g key={s.key} className={s.secondary ? 'dashboard-series secondary' : 'dashboard-series'}><polyline data-series={s.key} points={data.map((day,i) => `${x(i)},${y(day[s.key])}`).join(' ')} />{data.length === 1 && <circle cx={x(0)} cy={y(data[0][s.key])} r={3} />}</g>)}
      {selected && index !== null && <g><line className="dashboard-guide" x1={x(index)} x2={x(index)} y1={top} y2={bottom} />{series.map(s => <circle key={s.key} className={`dashboard-marker ${s.secondary ? 'secondary' : ''}`} cx={x(index)} cy={y(selected[s.key])} r={3.5} />)}</g>}
    </svg>
    {selected && index !== null && <div className="dashboard-tooltip" style={{ left: Math.max(0, Math.min(width - 180, x(index) - 80)) }} aria-hidden="true"><strong>{dateLabel(selected.date)}</strong>{series.map(s => <span key={s.key}>{s.label}<b>{fmt.number(selected[s.key])}</b></span>)}</div>}
    <span id={id} className="visually-hidden" aria-live="polite">{details}</span>
  </div>;
}

export function Dashboard({ feeds, createMenu, openFeeds, openAttention, openNotices, openFeed, refresh }: {
  feeds: Feed[]; createMenu: ReactNode; openFeeds: () => void; openAttention: () => void; openNotices: () => void;
  openFeed: (feed: Feed) => void; refresh: () => void;
}) {
  const [days, setDays] = useState<DashboardPeriod>(30), [data, setData] = useState<DashboardStats | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void api.dashboard.get(days, controller.signal).then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : t('error.requestFailed')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [days, feeds, revision]);
  const current = data?.days === days ? data : null;
  const attention = feeds.filter(needsAttention), notices = feeds.filter(feed => feed.ruleHealth && isRuleHealthNotice(feed.ruleHealth) && !feed.lastError);
  const itemCount = feeds.reduce((sum, feed) => sum + feed.itemCount, 0);
  const totals = current?.daily.reduce((sum, day) => ({ collected: sum.collected + day.collected, translated: sum.translated + day.translated, added: sum.added + day.added, removed: sum.removed + day.removed }), { collected: 0, translated: 0, added: 0, removed: 0 });
  const messageSeries: Series[] = [{ key: 'collected', label: t('dashboard.collected') }, { key: 'translated', label: t('dashboard.translated'), secondary: true }];
  return <div className="dashboard-view">
    <div className="page-heading"><div><span className="section-kicker">LESS CHECKING. MORE READING.</span><h1>{t('nav.dashboard')}</h1><p>{t('dashboard.lead')}</p></div>{createMenu}</div>
    <div className="stats-row dashboard-stats">
      <button type="button" onClick={openFeeds}><span>{t('home.allFeeds')}</span><strong>{fmt.number(feeds.length)}<small>{t('users.sourcesUnit', { count: feeds.length })}</small></strong></button>
      <div><span>{t('home.following')}</span><strong>{fmt.number(feeds.filter(feed => feed.enabled).length)}<small>{t('home.autoUpdating')}</small></strong></div>
      <div><span>{t('dashboard.retained')}</span><strong>{fmt.number(itemCount)}<small>{t('home.records', { count: itemCount })}</small></strong></div>
      <button type="button" className={attention.length ? 'attention' : ''} onClick={openAttention}><span>{t('collection.attention')}</span><strong>{attention.length}<small>{t('dashboard.viewAll')}</small><ChevronRight size={15} /></strong></button>
    </div>
    {error && <p role="alert" className="error-note">{error}</p>}
    <section className="panel dashboard-trends" aria-label={t('dashboard.trends')} aria-busy={loading}>
      <div className="dashboard-panel-head"><div><h2>{t('dashboard.trends')}</h2>{current?.daily.length ? <span title={t('dashboard.timeZone')}>{dateLabel(current.daily[0].date)} – {dateLabel(current.daily.at(-1)!.date)}</span> : <span>{t('dashboard.loading')}</span>}</div><div className="inline" role="group" aria-label={t('dashboard.trends')}>{([7,30,90] as const).map(period => <button key={period} className="button small" aria-pressed={days === period} onClick={() => setDays(period)}>{t('dashboard.days', { count: period })}</button>)}</div></div>
      {current && totals ? <div className="dashboard-trend-grid">
        <div><div className="dashboard-chart-summary">{messageSeries.map(s => <span key={s.key}><i className={s.secondary ? 'secondary' : ''} />{s.label}<strong>{fmt.number(totals[s.key as 'collected' | 'translated'])}</strong></span>)}</div><TrendChart data={current.daily} series={messageSeries} label={t('dashboard.messageChart')} unit={t('dashboard.chartItems')} /></div>
        <div><div className="dashboard-chart-summary"><span>{t('dashboard.subscriptions')}<strong>{fmt.number(feeds.length)}</strong></span><span>{t('dashboard.net', { count: totals.added - totals.removed })}</span></div><TrendChart data={current.daily} series={[{ key: 'subscriptions', label: t('dashboard.subscriptions') }]} label={t('dashboard.subscriptionChart')} unit={t('dashboard.chartFeeds')} /><div className="dashboard-chart-foot"><span>{t('dashboard.added', { count: totals.added })}</span><span>{t('dashboard.removed', { count: totals.removed })}</span></div></div>
      </div> : <div className="dashboard-chart-loading" role="status">{loading ? t('dashboard.loading') : t('common.retry')}</div>}
    </section>
    <div className="dashboard-lower">
      <section className="panel dashboard-attention"><div className="dashboard-panel-head"><h2>{t('collection.attention')} <span className="muted">{attention.length}</span></h2><button className="link-button" onClick={openAttention}>{t('dashboard.viewAll')}<ArrowUpRight size={13} /></button></div>
        {attention.length ? <div className="dashboard-issues">{attention.slice(0,3).map(feed => <button key={feed.id} onClick={() => openFeed(feed)}><strong>{feed.name}</strong><span title={feed.lastError ?? ruleHealthSummary(feed)}>{feed.lastError ?? ruleHealthSummary(feed)}</span><ChevronRight size={14} /></button>)}</div> : <p className="dashboard-all-good"><CheckCircle2 size={18} />{t('dashboard.noIssues')}</p>}
        {notices.length > 0 && <button className="dashboard-notices" onClick={openNotices}><Info size={13} />{t('dashboard.notices', { count: notices.length })}</button>}
      </section>
      <section className="panel dashboard-lifetime"><div className="dashboard-panel-head"><h2>{t('dashboard.lifetime')}</h2><span title={t('dashboard.historyHint')}><Info size={13} />{data ? t('dashboard.since', { date: fmt.date(data.recordingSince, { dateStyle: 'medium', timeZone: 'UTC' }) }) : '—'}</span></div><div className="dashboard-lifetime-values"><div><span>{t('dashboard.totalCollected')}</span><strong>{data ? fmt.number(data.totals.collected) : '—'}</strong></div><div><span>{t('dashboard.totalTranslated')}</span><strong>{data ? fmt.number(data.totals.translated) : '—'}</strong></div></div><p>{t('dashboard.retentionHint')}</p></section>
    </div>
    <div className="dashboard-status" aria-live="polite">{data && <><span><Activity size={13} />{t('dashboard.fetching', { count: data.fetching })}</span><span><Languages size={13} />{t('dashboard.pending', { count: data.translation.pending })} · {t('dashboard.running', { count: data.translation.running })}</span>{data.translation.failed > 0 && <span>{t('dashboard.translationFailed', { count: data.translation.failed })}</span>}</>}
      <span className="dashboard-updated">{data && t('dashboard.updated', { time: fmt.date(data.updatedAt, { timeStyle: 'short' }) })}<button className="icon-button" disabled={loading} aria-label={t('common.refresh')} onClick={() => { setRevision(value => value + 1); refresh(); }}><RefreshCw size={14} /></button></span>
    </div>
  </div>;
}
