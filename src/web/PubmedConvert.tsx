import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Microscope } from 'lucide-react';
import type { Feed, PubmedRssCheck } from '../shared/types';
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
export const reasonText = (check: PubmedRssCheck) => check.reason ? t(`pubmedConvert.reason.${check.reason}`) : '';

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

type Row = { feed: Feed; check?: PubmedRssCheck; error?: string; state: 'waiting' | 'checking' | 'checked' | 'converting' | 'converted' | 'failed' };

/**
 * Converts many PubMed RSS feeds: each is checked in turn (requests follow the
 * shared NCBI rate limit), the results are shown as a table, and only the
 * verified ones are converted after the user confirms. The others are listed
 * to review one by one in the search builder.
 */
export function PubmedBatchConvert({ feeds, close, review, changed, notify }: { feeds: Feed[]; close: () => void; review: (feed: Feed, check?: PubmedRssCheck) => void; changed: () => void; notify: (text: string) => void }) {
  const [rows, setRows] = useState<Row[]>(() => feeds.map(feed => ({ feed, state: 'waiting' })));
  const [phase, setPhase] = useState<'checking' | 'ready' | 'converting' | 'done'>('checking');
  const stopped = useRef(false);
  const update = (id: string, change: Partial<Row>) => setRows(previous => previous.map(row => row.feed.id === id ? { ...row, ...change } : row));
  useEffect(() => {
    stopped.current = false;
    void (async () => {
      for (const feed of feeds) {
        if (stopped.current) break;
        update(feed.id, { state: 'checking' });
        try { update(feed.id, { state: 'checked', check: await api.feeds.pubmedCheck(feed.id) }); }
        catch (reason) { update(feed.id, { state: 'failed', error: messageOf(reason) }); }
      }
      if (!stopped.current) setPhase('ready');
    })();
    return () => { stopped.current = true; };
  }, [feeds]);
  const checked = rows.filter(row => row.check).length + rows.filter(row => row.state === 'failed').length;
  const verified = rows.filter(row => row.check?.status === 'verified' && row.state === 'checked');
  const keyMissing = rows.some(row => row.check && !row.check.ncbiKeyConfigured);
  async function convertVerified() {
    if (!verified.length || !confirm(t('pubmedBatch.confirm', { count: verified.length }))) return;
    setPhase('converting');
    let done = 0;
    for (const row of verified) {
      update(row.feed.id, { state: 'converting' });
      try { await api.feeds.pubmedConvert(row.feed.id, row.check!.query, row.check!.limit); update(row.feed.id, { state: 'converted' }); done++; }
      catch (reason) { update(row.feed.id, { state: 'failed', error: messageOf(reason) }); }
    }
    setPhase('done'); changed();
    notify(t('pubmedBatch.converted', { count: done }));
  }
  const status = (row: Row) => row.state === 'waiting' ? t('pubmedBatch.waiting') : row.state === 'checking' ? t('pubmedConvert.checking') : row.state === 'converting' ? t('pubmedBatch.converting')
    : row.state === 'converted' ? t('pubmedBatch.done') : row.state === 'failed' ? row.error ?? '' : row.check?.status === 'verified' ? t('pubmedConvert.verified') : row.check?.reason ? t('pubmedConvert.needsReviewBecause', { reason: reasonText(row.check) }) : t('pubmedConvert.needsReview');
  return <Modal title={t('pubmedBatch.title')} close={() => { stopped.current = true; close(); }} wide><div className="modal-body pubmed-batch">
    <p className="muted">{t('pubmedBatch.lead')}</p>
    {keyMissing && <div className="notice">{t('pubmedBatch.noKey')}</div>}
    <p className="pubmed-batch-progress" role="status">{phase === 'checking' ? <><LoaderCircle size={14} className="spin" />{t('pubmedBatch.progress', { done: checked, total: rows.length })}</> : t('pubmedBatch.summary', { verified: verified.length + rows.filter(row => row.state === 'converted').length, review: rows.filter(row => row.check?.status === 'review').length, total: rows.length })}</p>
    <div className="pubmed-batch-table" role="table" aria-label={t('pubmedBatch.title')}>
      <div role="row" className="pubmed-batch-head"><span role="columnheader">{t('label.feedName')}</span><span role="columnheader">{t('pubmedBatch.query')}</span><span role="columnheader">{t('pubmedBatch.coverage')}</span><span role="columnheader">{t('pubmedBatch.status')}</span></div>
      {rows.map(row => <div role="row" key={row.feed.id} data-state={row.check?.status ?? row.state}>
        <span role="cell" className="pubmed-batch-name">{row.feed.name}</span>
        <span role="cell">{row.check?.query ? <code>{row.check.query}</code> : '—'}</span>
        <span role="cell">{row.check ? coverageText(row.check) : '—'}</span>
        <span role="cell" className="pubmed-batch-status">{status(row)}{row.check?.status === 'review' && row.state === 'checked' && <button type="button" className="button small" onClick={() => { stopped.current = true; review(row.feed, row.check); }}>{t('pubmedBatch.review')}</button>}</span>
      </div>)}
    </div>
    <div className="modal-actions">
      <button type="button" className="button" onClick={() => { stopped.current = true; close(); }}>{phase === 'done' ? t('common.close') : t('common.cancel')}</button>
      {phase !== 'done' && <button type="button" className="button primary" disabled={phase !== 'ready' || !verified.length} onClick={() => void convertVerified()}>{phase === 'converting' ? t('pubmedBatch.converting') : t('pubmedBatch.convert', { count: verified.length })}</button>}
    </div>
  </div></Modal>;
}
