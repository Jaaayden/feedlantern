import { Layers, MousePointer2, Play } from 'lucide-react';
import { paginationLimits, type PaginationReport, type PaginationRules } from '../shared/types';
import { t } from './i18n';

type Mode = PaginationRules['mode'] | 'none';
const modes: Mode[] = ['none', 'next', 'template', 'loadMore'];
const modeLabel = (mode: Mode) => t(`paginationPanel.mode.${mode}`);

/** What is missing before the settings can be tested or saved; '' when complete. */
export function paginationProblem(value: PaginationRules | null): string {
  if (!value) return '';
  if (!Number.isInteger(value.maxPages) || value.maxPages < 1 || value.maxPages > paginationLimits.maxPages) return t('paginationPanel.maxPagesRange', { max: paginationLimits.maxPages });
  if (!Number.isInteger(value.delayMs) || value.delayMs < paginationLimits.minDelayMs || value.delayMs > paginationLimits.maxDelayMs) return t('paginationPanel.delayRange', { min: paginationLimits.minDelayMs / 1000, max: paginationLimits.maxDelayMs / 1000 });
  if (value.mode === 'template') {
    if (!value.urlTemplate?.includes('{n}')) return t('error.urlTemplatePlaceholder', { placeholder: '{n}' });
    try { const url = new URL(value.urlTemplate.replaceAll('{n}', String(value.start ?? 2))); if (!['http:', 'https:'].includes(url.protocol)) throw Error(); } catch { return t('paginationPanel.templateInvalid'); }
    if (!Number.isInteger(value.start) || value.start! < 0) return t('paginationPanel.startInvalid');
    if (!Number.isInteger(value.step) || value.step! < 1) return t('paginationPanel.stepInvalid');
    return '';
  }
  return value.nextSelector?.trim() ? '' : value.mode === 'next' ? t('paginationPanel.nextRequired') : t('paginationPanel.moreRequired');
}

export function PaginationPanel({ value, onChange, disabled, onPick, onTest, report }: {
  value: PaginationRules | null;
  onChange: (value: PaginationRules | null) => void;
  disabled: boolean;
  /** Start picking the next link / load-more button on the page screenshot. */
  onPick: () => void;
  onTest: () => void;
  report: PaginationReport | null;
}) {
  const mode: Mode = value?.mode ?? 'none';
  const problem = paginationProblem(value);
  function setMode(next: Mode) {
    if (next === 'none') { onChange(null); return; }
    const base = { mode: next, maxPages: value?.maxPages ?? 3, delayMs: value?.delayMs ?? paginationLimits.defaultDelayMs };
    onChange(next === 'template'
      ? { ...base, urlTemplate: value?.urlTemplate ?? '', start: value?.start ?? 2, step: value?.step ?? 1 }
      : { ...base, nextSelector: value?.nextSelector ?? '' });
  }
  const set = (patch: Partial<PaginationRules>) => value && onChange({ ...value, ...patch });
  const integer = (text: string) => text === '' ? Number.NaN : Number(text);
  return <section className="panel pagination-panel" aria-label={t('paginationPanel.title')}>
    <div className="panel-heading"><h2>{t('paginationPanel.title')}</h2><Layers size={18} /></div>
    <p className="hint">{t('paginationPanel.lead')}</p>
    <div className="form-row">
      <label className="field"><span>{t('paginationPanel.method')}</span><select aria-label={t('paginationPanel.method')} disabled={disabled} value={mode} onChange={e => setMode(e.target.value as Mode)}>{modes.map(key => <option key={key} value={key}>{modeLabel(key)}</option>)}</select></label>
      {value && <>
        <label className="field"><span>{t('paginationPanel.maxPages')}</span><input aria-label={t('paginationPanel.maxPagesShort')} type="number" min={1} max={paginationLimits.maxPages} step={1} disabled={disabled} value={Number.isNaN(value.maxPages) ? '' : value.maxPages} onChange={e => set({ maxPages: integer(e.target.value) })} /></label>
        <label className="field"><span>{t('paginationPanel.delay')}</span><input aria-label={t('paginationPanel.delayShort')} type="number" min={paginationLimits.minDelayMs / 1000} max={paginationLimits.maxDelayMs / 1000} step={0.5} disabled={disabled} value={Number.isNaN(value.delayMs) ? '' : value.delayMs / 1000} onChange={e => set({ delayMs: e.target.value === '' ? Number.NaN : Math.round(Number(e.target.value) * 1000) })} /><small>{t('paginationPanel.jitter')}</small></label>
      </>}
    </div>
    {value && value.mode !== 'template' && <div className="pagination-selector">
      <label className="field"><span>{value.mode === 'next' ? t('paginationPanel.nextSelector') : t('paginationPanel.moreSelector')}</span><input aria-label={t('paginationPanel.selector')} spellCheck={false} disabled={disabled} value={value.nextSelector ?? ''} placeholder={value.mode === 'next' ? 'a[rel~="next"]' : 'button.load-more'} onChange={e => set({ nextSelector: e.target.value })} /></label>
      <button type="button" className="button small" disabled={disabled} onClick={onPick}><MousePointer2 size={14} />{t('paginationPanel.pick')}</button>
    </div>}
    {value?.mode === 'template' && <div className="form-row">
      <label className="field pagination-template"><span>{t('label.urlTemplate')}</span><input aria-label={t('label.urlTemplate')} type="url" spellCheck={false} disabled={disabled} value={value.urlTemplate ?? ''} placeholder="https://example.com/list?page={n}" onChange={e => set({ urlTemplate: e.target.value })} /><small>{t('paginationPanel.templateHint', { placeholder: '{n}' })}</small></label>
      <label className="field"><span>{t('paginationPanel.start')}</span><input aria-label={t('label.startPage')} type="number" min={0} step={1} disabled={disabled} value={Number.isNaN(value.start) ? '' : value.start} onChange={e => set({ start: integer(e.target.value) })} /></label>
      <label className="field"><span>{t('paginationPanel.step')}</span><input aria-label={t('label.pageStep')} type="number" min={1} step={1} disabled={disabled} value={Number.isNaN(value.step) ? '' : value.step} onChange={e => set({ step: integer(e.target.value) })} /></label>
    </div>}
    {value && <div className="pagination-actions">
      <button type="button" className="button small" disabled={disabled || !!problem || value.maxPages < 2} onClick={onTest}><Play size={14} />{t('paginationPanel.test')}</button>
      <span className="muted">{problem || (value.maxPages < 2 ? t('paginationPanel.singlePage') : t('paginationPanel.sameLogic'))}</span>
    </div>}
    {value?.mode === 'loadMore' && <p className="hint">{t('paginationPanel.loadMoreHint')}</p>}
    {report && <div className="page-report" role="status" aria-label={t('paginationPanel.result')}>
      <ol>{report.pages.map(page => <li key={page.page} className={page.error ? 'failed' : undefined}><strong>{t('paginationPanel.page', { n: page.page })}</strong>{page.error ? <span>{t('paginationPanel.pageFailed', { error: page.error })}</span> : <span>{page.added !== page.count ? t('paginationPanel.pageCountNew', { count: page.count, added: page.added }) : t('paginationPanel.pageCount', { count: page.count })}</span>}</li>)}</ol>
      <p><strong>{t('paginationPanel.stopReason')}</strong>{report.message}</p>
    </div>}
  </section>;
}
