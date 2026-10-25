import { useEffect, useState } from 'react';
import { LoaderCircle, Microscope } from 'lucide-react';
import type { Feed, PubmedCheckEntry, PubmedCheckJob, PubmedRssCheck } from '../shared/types';
import { pubmedRssSource } from '../shared/pubmed';
import { api } from './api';
import { Modal } from './Modal';
import { fmt, t } from './i18n';

const messageOf = (error: unknown) => error instanceof Error ? error.message : t('common.notDone');
export const isPubmedRss = (feed: Feed) => feed.sourceType === 'rss' && !!pubmedRssSource(feed.url);

/** "15 / 15 · 100%", with a note when the comparison used stored items. */
export function coverageText(check: Pick<PubmedRssCheck, 'coverage'>): string {
  if (!check.coverage || !check.coverage.total) return '—';
  const { matched, total, ratio, source } = check.coverage;
  const text = t('pubmedConvert.coverageValue', { matched, total, percent: fmt.number(ratio, { style: 'percent', maximumFractionDigits: 0 }) });
  return source === 'stored' ? `${text} ${t('pubmedConvert.coverageStored')}` : text;
}
export const reasonText = (check: Pick<PubmedRssCheck, 'reason'>) => check.reason ? t(`pubmedConvert.reason.${check.reason}`) : '';

/**
 * PubMed RSS addresses in a feed's panel: what converting brings, then a check
 * (the RSS is read once and compared with the recovered query). A verified
 * feed is converted after the user confirms; anything else opens the search
 * builder with the recovered query to review. Nothing happens automatically.
 */
export function PubmedRssNotice({ feed, review, converted }: { feed: Feed; review: (check?: PubmedRssCheck) => void; converted: () => void }) {
  const rss = pubmedRssSource(feed.url);
  const [check, setCheck] = useState<PubmedRssCheck>();
  const [busy, setBusy] = useState<'' | 'check' | 'convert'>('');
  const [error, setError] = useState('');
  if (!rss) return null;
  async function verify() {
    setBusy('check'); setError('');
    try { const result = await api.feeds.pubmedCheck(feed.id); if (result.status === 'verified') setCheck(result); else review(result); }
    catch (reason) { setError(messageOf(reason)); } finally { setBusy(''); }
  }
  async function convert(result: PubmedRssCheck) {
    setBusy('convert'); setError('');
    try { await api.feeds.pubmedConvert(feed.id, result.query, result.limit); converted(); }
    catch (reason) { setError(messageOf(reason)); } finally { setBusy(''); }
  }
  return <div className={`notice pubmed-rss-notice ${rss.kind === 'journal' ? 'is-warning' : ''}`} data-testid="pubmed-rss-notice">
    <div className="pubmed-rss-notice-body">
      <span>{rss.kind === 'journal' ? t('pubmed.journalRssNotice') : t('pubmed.searchRssNotice')}</span>
      {check ? <div className="pubmed-check-result" data-testid="pubmed-check-result">
        <p><strong>{t('pubmedConvert.verified')}</strong> {t('pubmedConvert.verifiedDetail', { coverage: coverageText(check), count: fmt.number(check.count ?? 0) })}</p>
        <code>{check.query}</code>
        {check.repaired && <p className="hint">{t('pubmedConvert.repaired')}</p>}
        <div className="detail-actions">
          <button type="button" className="button small primary" disabled={!!busy} onClick={() => void convert(check)}>{busy === 'convert' ? t('common.working') : t('pubmedConvert.confirm')}</button>
          <button type="button" className="button small" disabled={!!busy} onClick={() => review(check)}>{t('pubmedConvert.editFirst')}</button>
          <button type="button" className="button small" disabled={!!busy} onClick={() => setCheck(undefined)}>{t('common.cancel')}</button>
        </div>
      </div> : error && <p className="hint is-error" role="alert">{error}</p>}
    </div>
    {!check && <button type="button" className="button small" disabled={!!busy} onClick={() => void verify()}>{busy === 'check' ? <><LoaderCircle size={14} className="spin" />{t('pubmedConvert.checking')}</> : <><Microscope size={14} />{t('pubmed.convert')}</>}</button>}
  </div>;
}

/** "about 2 min" / "about 40 s". */
const etaText = (seconds: number) => seconds >= 90 ? t('pubmedBatch.etaMinutes', { count: Math.round(seconds / 60) }) : t('pubmedBatch.etaSeconds', { count: Math.max(1, seconds) });
const POLL_MS = 1500;

/**
 * Converts many PubMed RSS feeds. The check runs on the server as a job (it
 * continues when this window or the page is closed; reopening shows it), up
 * to five feeds at a time within the shared NCBI rate limit. Feeds that are
 * verified can be converted as soon as they are, without waiting for the
 * rest; the others are reviewed one by one in the search builder.
 */
export function PubmedBatchConvert({ feeds, close, review, changed, notify }: { feeds: Feed[]; close: () => void; review: (feed: Feed, check?: PubmedRssCheck) => void; changed: () => void; notify: (text: string) => void }) {
  const [job, setJob] = useState<PubmedCheckJob>();
  const [busy, setBusy] = useState<'' | 'convert' | 'cancel' | 'retry' | 'recheck'>('');
  const [error, setError] = useState('');
  const ids = feeds.map(feed => feed.id).sort().join(',');
  // Reopening shows the job already running (or finished) for these feeds; otherwise a new one starts, reusing saved results.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { job: latest } = await api.pubmedChecks.latest();
        const covers = latest && feeds.every(feed => latest.entries.some(entry => entry.feedId === feed.id));
        const next = covers && latest ? latest : await api.pubmedChecks.start(feeds.map(feed => feed.id));
        if (live) setJob(next);
      } catch (reason) { if (live) setError(messageOf(reason)); }
    })();
    return () => { live = false; };
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!job || job.state !== 'running') return;
    const timer = window.setTimeout(() => { void api.pubmedChecks.get(job.id).then(setJob).catch(reason => setError(messageOf(reason))); }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [job]);
  const byId = new Map(feeds.map(feed => [feed.id, feed]));
  const entries = job?.entries.filter(entry => byId.has(entry.feedId)) ?? [];
  const ready = entries.filter(entry => entry.state === 'done' && entry.check?.status === 'verified');
  const progress = job?.progress;
  async function act(kind: 'cancel' | 'retry' | 'recheck') {
    if (!job) return;
    setBusy(kind); setError('');
    try { setJob(kind === 'cancel' ? await api.pubmedChecks.cancel(job.id) : kind === 'retry' ? await api.pubmedChecks.retry(job.id) : await api.pubmedChecks.start(feeds.map(feed => feed.id), true)); }
    catch (reason) { setError(messageOf(reason)); } finally { setBusy(''); }
  }
  async function convertReady() {
    if (!job || !ready.length || !confirm(t('pubmedBatch.confirm', { count: ready.length }))) return;
    setBusy('convert'); setError('');
    try {
      const { results, job: next } = await api.pubmedChecks.convert(job.id, ready.map(entry => entry.feedId));
      setJob(next); changed();
      const done = results.filter(result => result.ok).length;
      notify(t('pubmedBatch.converted', { count: done }));
      if (done < results.length) setError(results.filter(result => !result.ok).map(result => `${byId.get(result.feedId)?.name ?? result.feedId}: ${result.error ?? ''}`).join('\n'));
    } catch (reason) { setError(messageOf(reason)); } finally { setBusy(''); }
  }
  const status = (entry: PubmedCheckEntry) => entry.state === 'queued' ? t('pubmedBatch.waiting') : entry.state === 'checking' ? t('pubmedConvert.checking')
    : entry.state === 'converted' ? t('pubmedBatch.done') : entry.state === 'canceled' ? t('pubmedBatch.canceled') : entry.state === 'failed' ? t('pubmedBatch.failed', { error: entry.error ?? '' })
    : entry.check?.status === 'verified' ? t('pubmedConvert.verified') : entry.check?.reason ? t('pubmedConvert.needsReviewBecause', { reason: reasonText(entry.check as PubmedRssCheck) }) : t('pubmedConvert.needsReview');
  const rowState = (entry: PubmedCheckEntry) => entry.state === 'done' ? entry.check?.status : entry.state;
  return <Modal title={t('pubmedBatch.title')} close={close} wide><div className="modal-body pubmed-batch">
    <p className="muted">{t('pubmedBatch.lead')}</p>
    {job && !job.ncbiKeyConfigured && <div className="notice"><span>{t('pubmedBatch.noKey')} <a className="text-link" href="#/settings/pubmed" onClick={close}>{t('pubmedBatch.keySettings')}</a></span></div>}
    {progress && <div className="pubmed-batch-progress" role="status">
      <div className="pubmed-progress-bar" aria-hidden="true"><span style={{ width: `${progress.total ? Math.round(progress.done / progress.total * 100) : 0}%` }} /></div>
      <span>{job?.state === 'running' && <LoaderCircle size={14} className="spin" />}{t('pubmedBatch.progressLine', { done: progress.done, total: progress.total })}{job?.state === 'running' && progress.etaSeconds !== undefined ? ` · ${etaText(progress.etaSeconds)}` : ''}</span>
      <span className="muted">{t('pubmedBatch.summary', { verified: progress.verified, review: progress.review, total: progress.total })}{progress.failed ? ` ${t('pubmedBatch.failedCount', { count: progress.failed })}` : ''}{progress.converted ? ` ${t('pubmedBatch.convertedCount', { count: progress.converted })}` : ''}</span>
    </div>}
    {!job && !error && <p className="pubmed-batch-progress"><LoaderCircle size={14} className="spin" />{t('pubmedConvert.checking')}</p>}
    {error && <div className="error-note" role="alert">{error}</div>}
    {entries.length > 0 && <div className="pubmed-batch-table" role="table" aria-label={t('pubmedBatch.title')}>
      <div role="row" className="pubmed-batch-head"><span role="columnheader">{t('label.feedName')}</span><span role="columnheader">{t('pubmedBatch.query')}</span><span role="columnheader">{t('pubmedBatch.coverage')}</span><span role="columnheader">{t('pubmedBatch.status')}</span></div>
      {entries.map(entry => <div role="row" key={entry.feedId} data-state={rowState(entry)}>
        <span role="cell" className="pubmed-batch-name">{entry.name}</span>
        <span role="cell">{entry.check?.query ? <code>{entry.check.query}</code> : '—'}</span>
        <span role="cell">{entry.check ? coverageText(entry.check) : '—'}{entry.cached && <small className="pubmed-cached"> {t('pubmedBatch.cached')}</small>}</span>
        <span role="cell" className="pubmed-batch-status">{status(entry)}{entry.state === 'done' && entry.check?.status === 'review' && byId.get(entry.feedId) && <button type="button" className="button small" onClick={() => review(byId.get(entry.feedId)!, { ...entry.check!, ncbiKeyConfigured: !!job?.ncbiKeyConfigured } as PubmedRssCheck)}>{t('pubmedBatch.review')}</button>}</span>
      </div>)}
    </div>}
    <div className="modal-actions">
      {job?.state === 'running' && <button type="button" className="button" disabled={!!busy} onClick={() => void act('cancel')}>{t('pubmedBatch.cancelChecks')}</button>}
      {job && !!progress?.failed && job.state !== 'running' && <button type="button" className="button" disabled={!!busy} onClick={() => void act('retry')}>{t('pubmedBatch.retryFailed')}</button>}
      {job && job.state !== 'running' && <button type="button" className="button" disabled={!!busy} onClick={() => void act('recheck')}>{t('pubmedBatch.recheck')}</button>}
      <button type="button" className="button" onClick={close}>{t('common.close')}</button>
      <button type="button" className="button primary" disabled={!!busy || !ready.length} onClick={() => void convertReady()}>{busy === 'convert' ? t('pubmedBatch.converting') : t('pubmedBatch.convert', { count: ready.length })}</button>
    </div>
  </div></Modal>;
}
