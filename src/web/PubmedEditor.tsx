import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ExternalLink, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import type { Feed, PubmedPreview, PubmedRssCheck, TargetLanguage, TranslationMode, TranslationProviderId } from '../shared/types';
import {
  buildPubmedQuery, isPubmedDate, parsePubmedQuery, pubmedTermHasOperator, pubmedConversion, pubmedDefaultTerms, pubmedQueryProblem, pubmedRssSource, pubmedSearchUrl,
  PUBMED_ARTICLE_TYPES, PUBMED_DAYS_MAX, PUBMED_DEFAULT_LIMIT, PUBMED_FIELD_IDS, PUBMED_LIMITS, PUBMED_OPERATORS,
  type PubmedArticleType, type PubmedBuilder, type PubmedField, type PubmedFilters, type PubmedOperator, type PubmedRow,
} from '../shared/pubmed';
import { LanguageOptions, ProviderOptions, useTranslationProviders } from './TranslationFields';
import { NetworkProfileSelect, useNetworkProfiles } from './NetworkProfiles';
import { api } from './api';
import { fmt, t } from './i18n';
import { coverageText, reasonText } from './PubmedConvert';

/** Builder lines carry a key so React keeps each input while lines are added or removed. */
type Line = PubmedRow & { key: number };
let nextKey = 1;
const line = (row: Partial<PubmedRow> = {}): Line => ({ op: 'AND', field: 'all', term: '', ...row, key: nextKey++ });
const linesOf = (builder: PubmedBuilder): Line[] => builder.rows.length ? builder.rows.map(row => line(row)) : [line()];
type DateMode = 'any' | 'recent' | 'range';
const dateModeOf = (filters: PubmedFilters): DateMode => filters.days ? 'recent' : filters.from || filters.to ? 'range' : 'any';
const typeKey = (type: PubmedArticleType) => ({ Review: 'review', 'Systematic Review': 'systematicReview', 'Meta-Analysis': 'metaAnalysis', 'Clinical Trial': 'clinicalTrial', 'Randomized Controlled Trial': 'randomizedControlledTrial', 'Case Reports': 'caseReports' } as const)[type];
const authorLine = (authors: string[]) => authors.length > 3 ? t('pubmedEditor.etAl', { names: authors.slice(0, 3).join(', ') }) : authors.join(', ');
const PREVIEW_DELAY_MS = 800;

/** What the editor starts from: a saved PubMed search, a PubMed RSS feed being converted, or a fresh search (optionally prefilled). */
function initialState(initial: Feed | undefined, convert: boolean, prefill?: { builder: PubmedBuilder; limit: number }, check?: PubmedRssCheck) {
  const saved = initial?.sourceType === 'pubmed' && initial.pubmed ? initial.pubmed : convert && check?.query ? { query: check.query, limit: check.limit } : undefined;
  if (saved) {
    const parsed = parsePubmedQuery(saved.query);
    return { builder: parsed ?? { rows: [], filters: {} }, query: saved.query, manual: !parsed, limit: saved.limit };
  }
  const rss = convert && initial ? pubmedRssSource(initial.url) : null;
  const start = rss ? pubmedConversion(rss) : prefill;
  if (start) return { builder: start.builder, query: buildPubmedQuery(start.builder), manual: false, limit: start.limit };
  return { builder: { rows: [], filters: {} }, query: '', manual: false, limit: PUBMED_DEFAULT_LIMIT };
}

export function PubmedEditor({ initial, convert = false, check, prefill, existing = [], saved, cancel }: {
  initial?: Feed; convert?: boolean; check?: PubmedRssCheck; prefill?: { builder: PubmedBuilder; limit: number };
  existing?: Feed[]; saved: (id: string) => void; cancel: () => void;
}) {
  const start = useMemo(() => initialState(initial, convert, prefill, check), []); // eslint-disable-line react-hooks/exhaustive-deps
  const rss = convert && initial ? pubmedRssSource(initial.url) : null;
  const [lines, setLines] = useState<Line[]>(() => linesOf(start.builder));
  const [filters, setFilters] = useState<PubmedFilters>(start.builder.filters);
  const [dateMode, setDateMode] = useState<DateMode>(dateModeOf(start.builder.filters));
  const [dateDraft, setDateDraft] = useState({ days: String(start.builder.filters.days ?? 30), from: start.builder.filters.from ?? '', to: start.builder.filters.to ?? '' });
  const [query, setQuery] = useState(start.query);
  const [manual, setManual] = useState(start.manual);
  const [limit, setLimit] = useState(start.limit);
  // A saved or converted feed keeps its name; a new one follows the conditions until the name is edited.
  const [name, setName] = useState(initial?.name ?? '');
  const [nameTouched, setNameTouched] = useState(!!initial);
  const [mode, setMode] = useState<TranslationMode>(initial?.translationMode ?? 'original');
  const [language, setLanguage] = useState<TargetLanguage>(initial?.targetLanguage ?? 'zh-CN');
  const [provider, setProvider] = useState<TranslationProviderId | ''>(initial?.translationProvider ?? '');
  const [interval, setIntervalValue] = useState(initial?.intervalMinutes ?? 60);
  const [networkProfileId, setNetworkProfileId] = useState(initial?.networkProfileId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const profiles = useNetworkProfiles(setError);
  const providers = useTranslationProviders();
  const [preview, setPreview] = useState<{ query: string; loading: boolean; data?: PubmedPreview; error?: string }>({ query: '', loading: false });

  const builder: PubmedBuilder = { rows: lines.map(({ key: _key, ...row }) => row), filters };
  const text = query.trim();
  const problem = pubmedQueryProblem(query);
  const autoName = t('pubmedEditor.defaultName', { terms: pubmedDefaultTerms(manual ? null : builder, query) });
  const shownName = nameTouched ? name : text ? autoName.slice(0, 200) : '';
  const duplicate = existing.find(feed => feed.sourceType === 'pubmed' && feed.id !== initial?.id && feed.pubmed?.query.trim() === text);

  /** A change made in the builder rewrites the query. */
  function apply(nextLines: Line[], nextFilters: PubmedFilters) {
    setLines(nextLines); setFilters(nextFilters);
    setQuery(buildPubmedQuery({ rows: nextLines, filters: nextFilters })); setManual(false);
  }
  const updateLine = (key: number, change: Partial<PubmedRow>) => apply(lines.map(entry => entry.key === key ? { ...entry, ...change } : entry), filters);
  const setFilter = (change: Partial<PubmedFilters>) => apply(lines, { ...filters, ...change });

  /** A query typed by hand updates the builder when the builder can show it. */
  function editQuery(value: string) {
    setQuery(value);
    if (!value.trim()) { setLines([line()]); setFilters({}); setDateMode('any'); setManual(false); return; }
    const parsed = parsePubmedQuery(value);
    if (!parsed) { setManual(true); return; }
    setLines(linesOf(parsed)); setFilters(parsed.filters); setDateMode(dateModeOf(parsed.filters));
    setDateDraft({ days: String(parsed.filters.days ?? 30), from: parsed.filters.from ?? '', to: parsed.filters.to ?? '' });
    setManual(false);
  }

  function changeDate(next: DateMode, draft = dateDraft) {
    setDateMode(next); setDateDraft(draft);
    const days = Number(draft.days);
    const valid = (value: string) => value.trim() && isPubmedDate(value.trim()) ? value.trim() : undefined;
    setFilter(next === 'recent' ? { days: Number.isInteger(days) && days >= 1 && days <= PUBMED_DAYS_MAX ? days : undefined, from: undefined, to: undefined }
      : next === 'range' ? { days: undefined, from: valid(draft.from), to: valid(draft.to) } : { days: undefined, from: undefined, to: undefined });
  }

  // The preview follows the query after a pause in typing; every request goes through the server's shared NCBI queue.
  const latest = useRef(0);
  useEffect(() => {
    if (!text || problem) { setPreview({ query: '', loading: false }); return; }
    const controller = new AbortController();
    const ticket = ++latest.current;
    setPreview(previous => ({ ...previous, loading: true }));
    const timer = window.setTimeout(() => {
      api.pubmed.preview(text, networkProfileId || null, controller.signal)
        .then(data => { if (ticket === latest.current) setPreview({ query: text, loading: false, data }); })
        .catch(reason => { if (ticket === latest.current && !controller.signal.aborted) setPreview({ query: text, loading: false, error: reason instanceof Error ? reason.message : t('error.pubmedPreviewFailed') }); });
    }, PREVIEW_DELAY_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [text, problem, networkProfileId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!text) { setError(t('error.pubmedQueryRequired')); return; }
    if (problem) { setError(t('error.pubmedQueryInvalid', { reason: t(`pubmed.problem.${problem}`, { max: 4000 }) })); return; }
    if (!shownName.trim()) { setError(t('feedSettings.nameRequired')); return; }
    if (convert && initial && !confirm(t('pubmedEditor.confirmConvert', { name: initial.name }))) return;
    setBusy(true); setError('');
    try {
      const body = {
        sourceType: 'pubmed' as const, pubmed: { query: text, limit }, url: pubmedSearchUrl({ query: text, limit }),
        name: shownName.trim(), translationMode: mode, targetLanguage: language, translationProvider: provider || null,
        intervalMinutes: interval, networkProfileId: networkProfileId || null, rules: { item: '', title: '', link: '' }, credentialId: null, waitMs: 0,
      };
      const result = initial ? await api.feeds.update(initial.id, body) : await api.feeds.create(body);
      saved(result.feed.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('common.saveFailed')); } finally { setBusy(false); }
  }

  const title = convert ? t('pubmedEditor.convertTitle') : initial ? t('pubmedEditor.editTitle') : t('pubmedEditor.title');
  const shown = preview.data && preview.query === text ? preview.data : undefined;
  return <>
    <button className="back-link" onClick={cancel}><ArrowLeft size={16} />{t('common.backToFeeds')}</button>
    <div className="page-heading"><div><span className="section-kicker">SEARCH PUBMED</span><h1>{title}</h1><p>{t('pubmedEditor.lead')}</p></div></div>
    {rss && check && <div className={`notice pubmed-convert-note ${check.status === 'review' ? 'is-warning' : ''}`} data-testid="pubmed-convert-note"><span>
      {rss.kind === 'journal' && <>{t('pubmedEditor.checkJournal', { journal: rss.name ? `${rss.name} (NLM ID ${rss.nlmId})` : `NLM ID ${rss.nlmId}` })}{' '}</>}
      {check.status === 'review' ? t('pubmedEditor.checkReview', { reason: reasonText(check) }) : t('pubmedEditor.checkVerified')}{' '}
      {check.coverage?.total ? t('pubmedEditor.checkCoverage', { coverage: coverageText(check) }) : ''}{check.repaired ? ` ${t('pubmedConvert.repaired')}` : ''}{check.error ? ` ${check.error}` : ''}{' '}
      {check.sourceTitle && <>{t('pubmedEditor.checkTitle')} <code>{check.sourceTitle}</code>{' '}</>}
      {t('pubmedEditor.checkKeeps')} <a className="text-link" href={initial!.url} target="_blank" rel="noreferrer">{t('pubmedEditor.openOriginal')}<ExternalLink size={13} /></a></span></div>}
    {rss && !check && <div className="notice pubmed-convert-note" data-testid="pubmed-convert-note"><span>{rss.kind === 'journal' ? t('pubmedEditor.convertJournal', { journal: rss.name ? `${rss.name} (NLM ID ${rss.nlmId})` : `NLM ID ${rss.nlmId}` }) : t('pubmedEditor.convertSearch')} <a className="text-link" href={initial!.url} target="_blank" rel="noreferrer">{t('pubmedEditor.openOriginal')}<ExternalLink size={13} /></a></span></div>}
    <form className="pubmed-editor" onSubmit={submit} aria-label={title}>
      <section className="panel pubmed-builder" aria-label={t('pubmedEditor.builder')}>
        <div className="panel-heading"><h2>{t('pubmedEditor.conditions')}</h2></div>
        {manual && <div className="notice pubmed-manual" role="status"><span>{t('pubmedEditor.manual')}</span><button type="button" className="button small" onClick={() => apply(lines, filters)}>{t('pubmedEditor.backToBuilder')}</button></div>}
        <fieldset className="pubmed-rows" disabled={busy || manual}>
          {lines.map((entry, index) => <div className="pubmed-row" role="group" aria-label={t('pubmedEditor.rowLabel', { n: index + 1 })} key={entry.key}>
            {index === 0 ? <span className="pubmed-row-first">{t('pubmedEditor.firstRow')}</span>
              : <select className="pubmed-op" aria-label={t('pubmedEditor.operatorOf', { n: index + 1 })} value={entry.op} onChange={e => updateLine(entry.key, { op: e.target.value as PubmedOperator })}>{PUBMED_OPERATORS.map(op => <option key={op} value={op}>{op}</option>)}</select>}
            <select className="pubmed-field" aria-label={t('pubmedEditor.fieldOf', { n: index + 1 })} value={entry.field} onChange={e => updateLine(entry.key, { field: e.target.value as PubmedField })}>{PUBMED_FIELD_IDS.map(field => <option key={field} value={field}>{t(`pubmedField.${field}`)}</option>)}</select>
            <input className="pubmed-term" aria-label={t('pubmedEditor.termOf', { n: index + 1 })} value={entry.term} maxLength={500} spellCheck={false} placeholder={t(`pubmedField.placeholder.${entry.field}`)} onChange={e => updateLine(entry.key, { term: e.target.value })} />
            <label className="pubmed-phrase" title={t('pubmedEditor.phraseHint')}><input type="checkbox" aria-label={t('pubmedEditor.phraseOf', { n: index + 1 })} checked={!!entry.phrase} onChange={e => updateLine(entry.key, { phrase: e.target.checked || undefined })} /><span>{t('pubmedEditor.phrase')}</span></label>
            <button type="button" className="icon-button danger pubmed-remove" aria-label={t('pubmedEditor.removeRow', { n: index + 1 })} title={t('pubmedEditor.removeRow', { n: index + 1 })} disabled={lines.length === 1} onClick={() => apply(lines.filter(other => other.key !== entry.key), filters)}><Trash2 size={15} /></button>
            {pubmedTermHasOperator(entry.term, entry.phrase) && <p className="hint pubmed-row-warning">{t('pubmedEditor.operatorInTerm')}</p>}
          </div>)}
          <div className="pubmed-row-actions"><button type="button" className="button small" disabled={lines.length >= 20} onClick={() => apply([...lines, line({ field: 'tiab' })], filters)}><Plus size={14} />{t('pubmedEditor.addRow')}</button><span className="hint">{t('pubmedEditor.termHint')}</span></div>
        </fieldset>
        <fieldset className="pubmed-filters" disabled={busy || manual}>
          <legend>{t('pubmedEditor.filters')}</legend>
          <div className="pubmed-date">
            <label className="field"><span>{t('pubmedEditor.date')}</span><select value={dateMode} onChange={e => changeDate(e.target.value as DateMode)}><option value="any">{t('pubmedEditor.date.any')}</option><option value="recent">{t('pubmedEditor.date.recent')}</option><option value="range">{t('pubmedEditor.date.range')}</option></select></label>
            {dateMode === 'recent' && <label className="field"><span>{t('pubmedEditor.days')}</span><input type="number" min={1} max={PUBMED_DAYS_MAX} step={1} value={dateDraft.days} onChange={e => changeDate('recent', { ...dateDraft, days: e.target.value })} /></label>}
            {dateMode === 'range' && <>
              <label className="field"><span>{t('pubmedEditor.from')}</span><input inputMode="numeric" placeholder="2024/01/01" value={dateDraft.from} aria-invalid={!!dateDraft.from.trim() && !isPubmedDate(dateDraft.from.trim())} onChange={e => changeDate('range', { ...dateDraft, from: e.target.value })} /></label>
              <label className="field"><span>{t('pubmedEditor.to')}</span><input inputMode="numeric" placeholder="2026/12/31" value={dateDraft.to} aria-invalid={!!dateDraft.to.trim() && !isPubmedDate(dateDraft.to.trim())} onChange={e => changeDate('range', { ...dateDraft, to: e.target.value })} /></label>
            </>}
          </div>
          {dateMode === 'range' && [dateDraft.from, dateDraft.to].some(value => value.trim() && !isPubmedDate(value.trim())) && <p className="hint is-error">{t('pubmedEditor.dateFormat')}</p>}
          <label className="checkbox-field"><input type="checkbox" checked={!!filters.hasAbstract} onChange={e => setFilter({ hasAbstract: e.target.checked || undefined })} /><span>{t('pubmedEditor.hasAbstract')}</span></label>
          <div className="pubmed-types" role="group" aria-label={t('pubmedEditor.types')}><span className="pubmed-types-label">{t('pubmedEditor.types')}</span>
            {PUBMED_ARTICLE_TYPES.map(type => { const checked = !!filters.types?.includes(type); return <label key={type} className="pubmed-type" data-checked={checked || undefined}><input type="checkbox" checked={checked} onChange={e => { const next = e.target.checked ? [...(filters.types ?? []), type] : (filters.types ?? []).filter(other => other !== type); setFilter({ types: next.length ? PUBMED_ARTICLE_TYPES.filter(known => next.includes(known)) : undefined }); }} /><span>{t(`pubmedType.${typeKey(type)}`)}</span></label>; })}
          </div>
        </fieldset>
        <div className="pubmed-query">
          <label className="field"><span>{t('pubmedEditor.query')}</span><textarea rows={3} spellCheck={false} disabled={busy} value={query} onChange={e => editQuery(e.target.value)} placeholder={'("cryo-EM"[Title/Abstract]) AND ("ShanghaiTech"[Affiliation])'} aria-invalid={!!problem && !!text} /></label>
          {problem && text ? <p className="hint is-error" role="alert">{t('error.pubmedQueryInvalid', { reason: t(`pubmed.problem.${problem}`, { max: 4000 }) })}</p> : <p className="hint">{t('pubmedEditor.queryHint')}</p>}
          {text && !problem && <a className="text-link" href={pubmedSearchUrl({ query: text, limit })} target="_blank" rel="noreferrer">{t('pubmedEditor.openInPubmed')}<ExternalLink size={13} /></a>}
        </div>
      </section>

      <section className="panel pubmed-preview" aria-label={t('pubmedEditor.preview')} aria-busy={preview.loading}>
        <div className="panel-heading"><h2>{t('pubmedEditor.preview')}</h2>{preview.loading && <span className="inline hint"><LoaderCircle size={14} className="spin" />{t('pubmedEditor.previewing')}</span>}</div>
        {!text || problem ? <p className="hint">{t('pubmedEditor.previewIdle')}</p> : preview.error && preview.query === text ? <div className="error-note" role="alert">{preview.error}</div> : shown ? <>
          <p className="pubmed-count" data-testid="pubmed-count"><strong>{fmt.number(shown.count)}</strong> {t('pubmedEditor.count', { count: shown.count })}</p>
          {shown.warnings.map((warning, index) => <p key={index} className="hint pubmed-warning">{t(`pubmedEditor.warning.${warning.kind}`, { text: warning.text })}</p>)}
          {!shown.items.length ? <p className="hint">{t('pubmedEditor.noMatches')}</p> : <><h3 className="pubmed-newest">{t('pubmedEditor.newest', { count: shown.items.length })}</h3><ol className="pubmed-results">{shown.items.map(item => <li key={item.pmid}>
            <a href={item.link} target="_blank" rel="noreferrer">{item.title}</a>
            <span className="pubmed-meta">{[item.journal, item.pubDate].filter(Boolean).join(' · ')}</span>
            {item.authors.length > 0 && <span className="pubmed-authors">{authorLine(item.authors)}</span>}
          </li>)}</ol></>}
          {shown.queryTranslation && <div className="pubmed-translation" data-testid="pubmed-translation"><span>{t('pubmedEditor.translation')}</span><code>{shown.queryTranslation}</code><small>{t('pubmedEditor.translationHint')}</small></div>}
        </> : <p className="hint">{t('pubmedEditor.previewing')}</p>}
        <p className="hint pubmed-rate">{t('pubmedEditor.rateNote')}</p>
      </section>

      <section className="panel settings-form pubmed-settings" aria-label={t('pubmedEditor.settings')}>
        <label className="field"><span>{t('label.feedName')}</span><input required maxLength={200} disabled={busy} value={shownName} onChange={e => { setName(e.target.value); setNameTouched(true); }} />{!initial && <small>{t('pubmedEditor.nameHint')}</small>}</label>
        <div className="form-row">
          <label className="field"><span>{t('pubmedEditor.limit')}</span><select value={limit} disabled={busy} onChange={e => setLimit(Number(e.target.value))}>{PUBMED_LIMITS.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <label className="field"><span>{t('label.intervalMinutes')}</span><input type="number" min={5} max={1440} required value={interval} disabled={busy} onChange={e => setIntervalValue(Number(e.target.value))} /></label>
        </div>
        <p className="hint">{t('pubmedEditor.limitHint')}</p>
        <label className="field"><span>{t('translation.outputMode')}</span><select value={mode} disabled={busy} onChange={e => setMode(e.target.value as TranslationMode)}><option value="original">{t('translation.mode.original')}</option><option value="bilingual">{t('translation.mode.bilingual')}</option><option value="translated">{t('translation.mode.translated')}</option></select></label>
        {mode !== 'original' && <div className="form-row">
          <label className="field"><span>{t('translation.targetLanguage')}</span><select value={language} disabled={busy} onChange={e => setLanguage(e.target.value as TargetLanguage)}><LanguageOptions /></select></label>
          <label className="field"><span>{t('translation.service')}</span><select value={provider} disabled={busy} onChange={e => setProvider(e.target.value as TranslationProviderId | '')}><ProviderOptions info={providers} current={initial?.translationProvider} /></select></label>
        </div>}
        <NetworkProfileSelect value={networkProfileId} disabled={busy} onChange={setNetworkProfileId} profiles={profiles} />
        {initial?.sourceType === 'pubmed' && <p className="hint">{t('pubmedEditor.editHint')}</p>}
        {duplicate && <p className="notice">{t('pubmedEditor.duplicate', { name: duplicate.name })}</p>}
        {error && <div className="error-note" role="alert">{error}</div>}
        <button className="button primary" disabled={busy || !text || !!problem}>{busy ? t('common.working') : convert ? t('pubmedEditor.saveConvert') : t('pubmedEditor.save')}</button>
      </section>
    </form>
  </>;
}
