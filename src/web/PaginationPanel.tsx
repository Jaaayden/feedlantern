import { Layers, MousePointer2, Play } from 'lucide-react';
import { paginationLimits, type PaginationReport, type PaginationRules } from '../shared/types';

type Mode = PaginationRules['mode'] | 'none';
const modeLabels: Record<Mode, string> = {
  none: '不翻页，只抓源网址这一页',
  next: '点击“下一页”链接或按钮',
  template: 'URL 模板（按页码生成网址）',
  loadMore: '点击“加载更多”按钮（同一页追加内容）',
};

/** What is missing before the settings can be tested or saved; '' when complete. */
export function paginationProblem(value: PaginationRules | null): string {
  if (!value) return '';
  if (!Number.isInteger(value.maxPages) || value.maxPages < 1 || value.maxPages > paginationLimits.maxPages) return `最多页数需为 1–${paginationLimits.maxPages}`;
  if (!Number.isInteger(value.delayMs) || value.delayMs < paginationLimits.minDelayMs || value.delayMs > paginationLimits.maxDelayMs) return `每页间隔需为 ${paginationLimits.minDelayMs / 1000}–${paginationLimits.maxDelayMs / 1000} 秒`;
  if (value.mode === 'template') {
    if (!value.urlTemplate?.includes('{n}')) return 'URL 模板需要包含页码占位符 {n}';
    try { const url = new URL(value.urlTemplate.replaceAll('{n}', String(value.start ?? 2))); if (!['http:', 'https:'].includes(url.protocol)) throw Error(); } catch { return 'URL 模板不是有效的 HTTP(S) 网址'; }
    if (!Number.isInteger(value.start) || value.start! < 0) return '起始页码需为非负整数';
    if (!Number.isInteger(value.step) || value.step! < 1) return '步长需为正整数';
    return '';
  }
  return value.nextSelector?.trim() ? '' : value.mode === 'next' ? '请点选或填写“下一页”的选择器' : '请点选或填写“加载更多”按钮的选择器';
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
  return <section className="panel pagination-panel" aria-label="多页采集">
    <div className="panel-heading"><h2>多页采集</h2><Layers size={18} /></div>
    <p className="hint">默认只抓源网址这一页。开启后，第 1 页仍是源网址，再按下面的方式往后翻；每页之间会等待，一页的条目都已见过时提前停止。</p>
    <div className="form-row">
      <label className="field"><span>翻页方式</span><select aria-label="翻页方式" disabled={disabled} value={mode} onChange={e => setMode(e.target.value as Mode)}>{(Object.keys(modeLabels) as Mode[]).map(key => <option key={key} value={key}>{modeLabels[key]}</option>)}</select></label>
      {value && <>
        <label className="field"><span>最多页数（含第 1 页）</span><input aria-label="最多页数" type="number" min={1} max={paginationLimits.maxPages} step={1} disabled={disabled} value={Number.isNaN(value.maxPages) ? '' : value.maxPages} onChange={e => set({ maxPages: integer(e.target.value) })} /></label>
        <label className="field"><span>每页间隔（秒）</span><input aria-label="每页间隔" type="number" min={paginationLimits.minDelayMs / 1000} max={paginationLimits.maxDelayMs / 1000} step={0.5} disabled={disabled} value={Number.isNaN(value.delayMs) ? '' : value.delayMs / 1000} onChange={e => set({ delayMs: e.target.value === '' ? Number.NaN : Math.round(Number(e.target.value) * 1000) })} /><small>另加最多 20% 的随机抖动。</small></label>
      </>}
    </div>
    {value && value.mode !== 'template' && <div className="pagination-selector">
      <label className="field"><span>{value.mode === 'next' ? '“下一页”选择器' : '“加载更多”按钮选择器'}</span><input aria-label="翻页选择器" spellCheck={false} disabled={disabled} value={value.nextSelector ?? ''} placeholder={value.mode === 'next' ? 'a[rel~="next"]' : 'button.load-more'} onChange={e => set({ nextSelector: e.target.value })} /></label>
      <button type="button" className="button small" disabled={disabled} onClick={onPick}><MousePointer2 size={14} />在网页上点选</button>
    </div>}
    {value?.mode === 'template' && <div className="form-row">
      <label className="field pagination-template"><span>URL 模板</span><input aria-label="URL 模板" type="url" spellCheck={false} disabled={disabled} value={value.urlTemplate ?? ''} placeholder="https://example.com/list?page={n}" onChange={e => set({ urlTemplate: e.target.value })} /><small>第 2 页起依次把 {'{n}'} 换成起始页码、起始页码 + 步长……</small></label>
      <label className="field"><span>起始页码（第 2 页）</span><input aria-label="起始页码" type="number" min={0} step={1} disabled={disabled} value={Number.isNaN(value.start) ? '' : value.start} onChange={e => set({ start: integer(e.target.value) })} /></label>
      <label className="field"><span>步长</span><input aria-label="页码步长" type="number" min={1} step={1} disabled={disabled} value={Number.isNaN(value.step) ? '' : value.step} onChange={e => set({ step: integer(e.target.value) })} /></label>
    </div>}
    {value && <div className="pagination-actions">
      <button type="button" className="button small" disabled={disabled || !!problem || value.maxPages < 2} onClick={onTest}><Play size={14} />试抓多页</button>
      <span className="muted">{problem || (value.maxPages < 2 ? '最多页数为 1 时不会翻页。' : '与后台刷新使用同一套翻页逻辑，会按设置的间隔逐页打开。')}</span>
    </div>}
    {value?.mode === 'loadMore' && <p className="hint">“加载更多”只点击按钮，不会持续滚动；无限滚动的完整采集暂不支持。</p>}
    {report && <div className="page-report" role="status" aria-label="翻页结果">
      <ol>{report.pages.map(page => <li key={page.page} className={page.error ? 'failed' : undefined}><strong>第 {page.page} 页</strong>{page.error ? <span>失败：{page.error}</span> : <span>抓到 {page.count} 条{page.added !== page.count ? `，新增 ${page.added} 条` : ''}</span>}</li>)}</ol>
      <p><strong>停止原因：</strong>{report.message}</p>
    </div>}
  </section>;
}
