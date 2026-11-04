import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowDown, ArrowUp, Copy, ExternalLink, GitMerge, KeyRound, Layers, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { BUNDLE_DEDUPE_DEFAULT, BUNDLE_DEDUPE_MODES, BUNDLE_DEDUPE_WINDOW, BUNDLE_ITEM_LIMIT, ITEM_FILTER_LIMITS, translationEnabled, type BundleDedupe, type BundleFilter, type BundleItemRef, type BundlePayload, type BundlePreview, type Feed } from '../shared/types';
import { api } from './api';
import { copyText } from './format';
import { draftFilter } from './filter-draft';
import { ActionMenu } from './Menu';
import { Modal } from './Modal';
import { fmt, t } from './i18n';

const messageOf = (error: unknown) => error instanceof Error ? error.message : t('common.notDone');
const feedKind = (feed: Feed) => `${feed.sourceType === 'pubmed' ? t('feedKind.pubmed') : feed.sourceType === 'rss' ? t('feedKind.rss') : t('feedKind.website')}${translationEnabled(feed) ? ` · ${t('bundle.translated')}` : ''}`;

function memberNames(feedIds: string[], feeds: Feed[]): string {
  const names = feedIds.flatMap(id => feeds.find(feed => feed.id === id)?.name ?? []);
  return names.length > 4 ? t('bundle.andMore', { names: fmt.list(names.slice(0, 4), 'unit'), count: names.length }) : fmt.list(names, 'unit');
}

/** Reuse the existing bundle operations in their own compact page. */
export function BundleSection({ bundles, feeds, create, edit, changed, notify, standalone = false }: {
  bundles: BundlePayload[]; feeds: Feed[]; create: () => void; edit: (bundle: BundlePayload) => void; changed: () => void; notify: (text: string) => void; standalone?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState<BundlePayload['bundle'] | null>(null);
  async function run(operation: () => Promise<unknown>, success: string) {
    setBusy(true); setError('');
    try { await operation(); changed(); notify(success); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <section className={`bundle-section ${standalone ? 'standalone' : ''}`} aria-label={t('opml.bundles')}>
    <div className={standalone ? 'page-heading' : 'list-toolbar'}>{standalone ? <div><h1>{t('nav.bundles')}</h1><p>{t('bundle.pageLead')}</p></div> : <h2>{t('opml.bundles')} <span>{bundles.length}</span></h2>}<button className={`button ${standalone ? 'primary' : 'small'}`} disabled={busy} onClick={create}><Plus size={14} />{t('bundle.new')}</button></div>
    {error && <div className="error-note" role="alert">{error}</div>}
    {standalone && bundles.length === 0 && <div className="empty-state"><span className="large-icon"><Layers size={32} /></span><h2>{t('bundle.emptyTitle')}</h2><p>{t('bundle.emptyBody')}</p></div>}
    <div className={standalone ? 'bundle-list' : 'bundle-grid'}>{bundles.map(({ bundle, bundleUrl }) => <article className="bundle-card" key={bundle.id} aria-label={t('bundle.named', { name: bundle.name })}>
      <div className="bundle-head">
        <span className="soft-icon"><Layers size={18} /></span>
        <div className="bundle-title"><h3 title={bundle.name}>{bundle.name}</h3><small>{t('bundle.summary', { count: bundle.feedIds.length, limit: bundle.itemLimit })}</small><small className="bundle-tags">{t(`bundle.tag.dedupe.${bundle.dedupe.mode}`)}{bundle.itemFilter ? ` · ${t('bundle.tag.filter')}` : ''}</small></div>
        <ActionMenu label={t('users.more', { name: bundle.name })} trigger={<MoreHorizontal size={17} />} actions={[
          { label: t('bundle.edit'), icon: <Pencil size={15} />, disabled: busy, onSelect: () => edit({ bundle, bundleUrl }) },
          { label: t('bundle.rotate'), icon: <KeyRound size={15} />, disabled: busy, onSelect: () => { if (confirm(t('bundle.confirmRotate'))) void run(() => api.bundles.rotate(bundle.id), t('bundle.rotated')); } },
          { label: t('bundle.delete'), icon: <Trash2 size={15} />, danger: true, disabled: busy, onSelect: () => { if (confirm(t('bundle.confirmDelete', { name: bundle.name }))) void run(() => api.bundles.remove(bundle.id), t('bundle.deleted')); } },
        ]} />
      </div>
      <p className="bundle-members" title={memberNames(bundle.feedIds, feeds)}>{bundle.feedIds.length ? memberNames(bundle.feedIds, feeds) : t('bundle.noMembers')}</p>
      <div className="detail-actions">
        <button className="button small" disabled={busy} aria-label={t('bundle.copyOf', { name: bundle.name })} onClick={() => void copyText(bundleUrl).then(() => notify(t('bundle.copied'))).catch(() => setError(t('bundle.copyFailed')))}><Copy size={14} />{t('bundle.copy')}</button>
        <a className="button small" href={bundleUrl} target="_blank" rel="noreferrer" aria-label={t('bundle.openOf', { name: bundle.name })}><ExternalLink size={14} />{t('bundle.open')}</a>
        <button className="button small" disabled={busy} aria-label={t('bundle.detailsOf', { name: bundle.name })} onClick={() => setDetails(bundle)}><GitMerge size={14} />{t('bundle.details')}</button>
        <button className="button small" disabled={busy} aria-label={t('bundle.editOf', { name: bundle.name })} onClick={() => edit({ bundle, bundleUrl })}><Pencil size={14} />{t('common.edit')}</button>
      </div>
    </article>)}</div>
    {details && <Modal title={t('bundle.detailsTitle')} close={() => setDetails(null)} wide><div className="modal-body bundle-details">
      <p className="muted">{details.name}</p>
      <PreviewLoader load={() => api.bundles.previewSaved(details.id)} />
    </div></Modal>}
  </section>;
}

/** Fetches a preview once and shows it. */
function PreviewLoader({ load }: { load: () => Promise<BundlePreview> }) {
  const [state, setState] = useState<{ preview?: BundlePreview; error?: string }>({});
  useEffect(() => { let current = true; load().then(preview => { if (current) setState({ preview }); }).catch(e => { if (current) setState({ error: messageOf(e) }); }); return () => { current = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <BundlePreviewView preview={state.preview ?? null} error={state.error ?? ''} />;
}

function ItemLine({ item, tag, note }: { item: BundleItemRef; tag?: string; note?: string }) {
  const safe = /^https?:\/\//i.test(item.link);
  return <span className="bundle-item-line">
    {tag && <span className="bundle-item-tag">{tag}</span>}
    {safe ? <a href={item.link} target="_blank" rel="noreferrer noopener">{item.title || item.link}</a> : <span>{item.title || item.link}</span>}
    <small>{[item.feedName, note].filter(Boolean).join(' · ')}</small>
  </span>;
}

/** The numbers behind a bundle's settings, with the filtered items and the merged duplicates one click away. */
export function BundlePreviewView({ preview, error, loading = false }: { preview: BundlePreview | null; error: string; loading?: boolean }) {
  if (error) return <p className="output-summary is-error" role="alert">{t('bundle.preview.error', { message: error })}</p>;
  if (!preview) return <p className="output-summary" aria-live="polite">{t('bundle.preview.loading')}</p>;
  const shownMerged = preview.groups.reduce((sum, group) => sum + group.merged.length, 0);
  return <div className={`bundle-preview ${loading ? 'is-loading' : ''}`}>
    <p className="output-summary" aria-live="polite" data-testid="bundle-preview-summary">{t('bundle.preview.summary', { output: preview.output, candidates: preview.candidates, filtered: preview.filtered, merged: preview.merged })}{preview.overLimit ? `${t('punctuation.comma')}${t('bundle.preview.overLimit', { count: preview.overLimit })}` : ''}</p>
    {preview.filterTimedOut && <p className="output-summary is-error" role="alert">{t('bundle.preview.timeout')}</p>}
    {!preview.filtered && !preview.merged && <p className="hint">{t('bundle.preview.nothing')}</p>}
    {preview.filtered > 0 && <details className="bundle-detail"><summary>{t('bundle.preview.filteredTitle', { count: preview.filtered })}</summary>
      <ul>{preview.filteredItems.map(entry => <li key={entry.id}><ItemLine item={entry} note={entry.status === 'excluded' ? t('bundle.preview.excludedBy', { pattern: entry.pattern ?? '' }) : t('bundle.preview.notIncluded')} /></li>)}</ul>
      {preview.filtered > preview.filteredItems.length && <p className="hint">{t('bundle.preview.truncated', { count: preview.filteredItems.length })}</p>}
    </details>}
    {preview.merged > 0 && <details className="bundle-detail"><summary>{t('bundle.preview.mergedTitle', { count: preview.merged })}</summary>
      <ul>{preview.groups.map(group => <li key={group.kept.id} className="bundle-group">
        <ItemLine item={group.kept} tag={t('bundle.preview.kept')} />
        <ul>{group.merged.map(entry => <li key={entry.id}><ItemLine item={entry} tag={t('bundle.preview.dropped')} note={t(`bundle.preview.reason.${entry.reason}`)} /></li>)}</ul>
      </li>)}</ul>
      {preview.merged > shownMerged && <p className="hint">{t('bundle.preview.truncated', { count: shownMerged })}</p>}
    </details>}
    {preview.items.length > 0 && <details className="bundle-detail"><summary>{t('bundle.preview.itemsTitle')}</summary>
      <ul>{preview.items.map(entry => <li key={entry.id}><ItemLine item={entry} /></li>)}</ul>
      {preview.output > preview.items.length && <p className="hint">{t('bundle.preview.truncated', { count: preview.items.length })}</p>}
    </details>}
  </div>;
}

/** Create a bundle (optionally with members already chosen) or edit one. */
export function BundleEditor({ initial, preset = [], feeds, close, saved }: {
  initial?: BundlePayload; preset?: string[]; feeds: Feed[]; close: () => void; saved: (result: BundlePayload, created: boolean) => void;
}) {
  const [name, setName] = useState(initial?.bundle.name ?? '');
  const [limit, setLimit] = useState(String(initial?.bundle.itemLimit ?? BUNDLE_ITEM_LIMIT.default));
  const [members, setMembers] = useState<string[]>(initial?.bundle.feedIds ?? preset);
  const [mode, setMode] = useState<BundleDedupe['mode']>(initial?.bundle.dedupe.mode ?? BUNDLE_DEDUPE_DEFAULT.mode);
  const [windowDays, setWindowDays] = useState(initial?.bundle.dedupe.windowDays ? String(initial.bundle.dedupe.windowDays) : '');
  const [prefer, setPrefer] = useState<BundleDedupe['prefer']>(initial?.bundle.dedupe.prefer ?? BUNDLE_DEDUPE_DEFAULT.prefer);
  const [include, setInclude] = useState(initial?.bundle.itemFilter?.include.join('\n') ?? '');
  const [exclude, setExclude] = useState(initial?.bundle.itemFilter?.exclude.join('\n') ?? '');
  const [regex, setRegex] = useState(initial?.bundle.itemFilter?.regex ?? false);
  const [matchSource, setMatchSource] = useState(initial?.bundle.itemFilter?.matchSource ?? false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const feedIds = useMemo(() => new Set(feeds.map(feed => feed.id)), [feeds]);
  const selected = new Set(members);
  // Members that were deleted meanwhile are dropped instead of failing the save.
  const liveMembers = useMemo(() => members.filter(id => feedIds.has(id)), [members, feedIds]);
  const search = query.trim().toLowerCase();
  const shown = useMemo(() => feeds.filter(feed => `${feed.name} ${feed.url}`.toLowerCase().includes(search)), [feeds, search]);
  const allShown = shown.length > 0 && shown.every(feed => selected.has(feed.id));
  const itemLimit = Number(limit);
  const limitValid = Number.isInteger(itemLimit) && itemLimit >= BUNDLE_ITEM_LIMIT.min && itemLimit <= BUNDLE_ITEM_LIMIT.max;
  const windowNumber = Number(windowDays);
  const windowValid = mode !== 'title' || !windowDays.trim() || Number.isInteger(windowNumber) && windowNumber >= BUNDLE_DEDUPE_WINDOW.min && windowNumber <= BUNDLE_DEDUPE_WINDOW.max;
  const dedupe: BundleDedupe = { mode, windowDays: mode === 'title' && windowDays.trim() && windowValid ? windowNumber : null, prefer };
  const filter = draftFilter(include, exclude, regex);
  const itemFilter: BundleFilter | null = filter ? { ...filter, matchSource } : null;
  const settingsKey = JSON.stringify({ liveMembers, itemLimit, dedupe, itemFilter });
  const byId = useMemo(() => new Map(feeds.map(feed => [feed.id, feed])), [feeds]);

  // Ask the server what these settings would publish; it runs the same code as the bundle address.
  useEffect(() => {
    if (!limitValid || !windowValid) return;
    let current = true;
    const timer = window.setTimeout(() => {
      const draft = JSON.parse(settingsKey) as { liveMembers: string[]; itemLimit: number; dedupe: BundleDedupe; itemFilter: BundleFilter | null };
      api.bundles.preview({ feedIds: draft.liveMembers, itemLimit: draft.itemLimit, dedupe: draft.dedupe, itemFilter: draft.itemFilter })
        .then(result => { if (current) { setPreview(result); setPreviewError(''); } })
        .catch(e => { if (current) { setPreview(null); setPreviewError(messageOf(e)); } });
    }, 350);
    return () => { current = false; window.clearTimeout(timer); };
  }, [settingsKey, limitValid, windowValid]);

  function selectShown() {
    const ids = new Set(shown.map(feed => feed.id));
    setMembers(previous => allShown ? previous.filter(id => !ids.has(id)) : [...new Set([...previous, ...ids])]);
  }
  const move = (id: string, step: -1 | 1) => setMembers(previous => {
    const live = previous.filter(item => feedIds.has(item)), index = live.indexOf(id), target = index + step;
    if (index < 0 || target < 0 || target >= live.length) return previous;
    [live[index], live[target]] = [live[target], live[index]];
    return live;
  });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!limitValid) { setError(t('error.integerRange', { label: t('label.bundleItemLimit'), min: String(BUNDLE_ITEM_LIMIT.min), max: String(BUNDLE_ITEM_LIMIT.max) })); return; }
    if (!windowValid) { setError(t('error.bundleDedupeWindow', { min: BUNDLE_DEDUPE_WINDOW.min, max: BUNDLE_DEDUPE_WINDOW.max })); return; }
    setBusy(true); setError('');
    const body = { name: name.trim(), itemLimit, feedIds: liveMembers, dedupe, itemFilter };
    try { saved(initial ? await api.bundles.update(initial.bundle.id, body) : await api.bundles.create(body), !initial); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  const toggle = (id: string, checked: boolean) => setMembers(previous => checked ? [...previous.filter(item => item !== id), id] : previous.filter(item => item !== id));
  return <Modal title={initial ? t('bundle.editTitle') : t('bundle.newTitle')} close={close}><form className="modal-body bundle-editor" onSubmit={submit}>
    <p className="muted">{t('bundle.lead')}</p>
    <div className="form-row">
      <label className="field"><span>{t('label.bundleName')}</span><input required maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder={t('bundle.namePlaceholder')} /></label>
      <label className="field"><span>{t('bundle.maxItems')}</span><input type="number" required min={BUNDLE_ITEM_LIMIT.min} max={BUNDLE_ITEM_LIMIT.max} step={1} value={limit} onChange={e => setLimit(e.target.value)} /></label>
    </div>
    <fieldset className="bundle-picker" disabled={busy}>
      <legend>{t('bundle.members')} <span className="muted">{t('collection.selected', { count: liveMembers.length })}</span></legend>
      {feeds.length > 0 && <><div className="input-icon"><Search size={16} /><input aria-label={t('bundle.searchMembers')} placeholder={t('bundle.searchPlaceholder')} value={query} onChange={e => setQuery(e.target.value)} /></div><div className="bundle-selection"><span className="muted">{t('bundle.matches', { count: shown.length })}</span><button type="button" className="button small" disabled={!shown.length} onClick={selectShown}>{t(allShown ? 'bundle.clearMatches' : 'bundle.selectMatches')}</button></div></>}
      {feeds.length ? <div className="bundle-options">{shown.map(feed => <label key={feed.id} className="bundle-option"><input type="checkbox" aria-label={t('bundle.addMember', { name: feed.name })} checked={selected.has(feed.id)} onChange={e => toggle(feed.id, e.target.checked)} /><span><strong>{feed.name}</strong><small>{feedKind(feed)}{feed.enabled ? '' : ` · ${t('feed.paused')}`}</small></span></label>)}{!shown.length && <p className="muted">{t('bundle.noMatch')}</p>}</div> : <p className="muted">{t('bundle.noFeeds')}</p>}
    </fieldset>
    {liveMembers.length > 1 && <fieldset className="bundle-picker" disabled={busy}>
      <legend>{t('bundle.order')}</legend>
      <p className="hint">{t('bundle.orderHint')}</p>
      <ol className="bundle-order" aria-label={t('bundle.order')}>{liveMembers.map((id, index) => {
        const label = byId.get(id)?.name ?? id;
        return <li key={id}><span title={label}>{t('bundle.orderItem', { position: index + 1, name: label })}</span>
          <button type="button" className="icon-button" aria-label={t('bundle.moveUp', { name: label })} disabled={index === 0} onClick={() => move(id, -1)}><ArrowUp size={15} /></button>
          <button type="button" className="icon-button" aria-label={t('bundle.moveDown', { name: label })} disabled={index === liveMembers.length - 1} onClick={() => move(id, 1)}><ArrowDown size={15} /></button>
        </li>;
      })}</ol>
    </fieldset>}
    <fieldset className="bundle-picker" disabled={busy}>
      <legend>{t('bundle.dedupe')}</legend>
      <p className="hint">{t('bundle.dedupeHint')}</p>
      <div className="bundle-options" role="radiogroup" aria-label={t('bundle.dedupeMode')}>{BUNDLE_DEDUPE_MODES.map(option => <label key={option} className="bundle-option"><input type="radio" name="bundle-dedupe-mode" checked={mode === option} onChange={() => setMode(option)} /><span><strong>{t(`bundle.dedupeMode.${option}`)}</strong><small>{t(`bundle.dedupeMode.${option}.hint`)}</small></span></label>)}</div>
      {mode === 'title' && <label className="field"><span>{t('bundle.dedupeWindow')}</span><input type="number" min={BUNDLE_DEDUPE_WINDOW.min} max={BUNDLE_DEDUPE_WINDOW.max} step={1} value={windowDays} placeholder={t('bundle.dedupeWindowPlaceholder')} onChange={e => setWindowDays(e.target.value)} /><small>{t('bundle.dedupeWindowHint')}</small></label>}
      {mode !== 'off' && <label className="field"><span>{t('bundle.prefer')}</span><select value={prefer} onChange={e => setPrefer(e.target.value as BundleDedupe['prefer'])}><option value="earliest">{t('bundle.prefer.earliest')}</option><option value="order">{t('bundle.prefer.order')}</option></select></label>}
    </fieldset>
    <fieldset className="bundle-picker output-settings" disabled={busy}>
      <legend>{t('bundle.filter')}</legend>
      <p className="hint">{t('bundle.filterHint')}</p>
      <div className="form-row bundle-filter-row">
        <label className="field"><span>{t('filter.include')}</span><textarea rows={3} spellCheck={false} value={include} onChange={e => setInclude(e.target.value)} placeholder={t('feedSettings.includePlaceholder')} /><small>{t('feedSettings.includeHint')}</small></label>
        <label className="field"><span>{t('filter.exclude')}</span><textarea rows={3} spellCheck={false} value={exclude} onChange={e => setExclude(e.target.value)} placeholder={t('feedSettings.excludePlaceholder')} /><small>{t('feedSettings.excludeHint')}</small></label>
      </div>
      <label className="checkbox-field"><input type="checkbox" checked={regex} onChange={e => setRegex(e.target.checked)} /><span>{t('feedSettings.regex', { max: ITEM_FILTER_LIMITS.patternLength })}</span></label>
      <label className="checkbox-field"><input type="checkbox" checked={matchSource} onChange={e => setMatchSource(e.target.checked)} /><span>{t('bundle.filterSource')}<small>{t('bundle.filterSourceHint')}</small></span></label>
    </fieldset>
    {limitValid && windowValid && <div className="bundle-preview-box"><BundlePreviewView preview={preview} error={previewError} /></div>}
    {error && <div className="error-note" role="alert">{error}</div>}
    <div className="modal-actions"><button type="button" className="button" onClick={close}>{t('common.cancel')}</button><button className="button primary" disabled={busy}>{busy ? t('common.saving') : initial ? t('bundle.save') : t('bundle.create')}</button></div>
  </form></Modal>;
}

/** Bulk action: add the selected feeds to an existing bundle or a new one. */
export function AddToBundle({ bundles, feedIds, close, done }: {
  bundles: BundlePayload[]; feedIds: string[]; close: () => void; done: (message: string) => void;
}) {
  const [target, setTarget] = useState(bundles[0]?.bundle.id ?? 'new');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (target === 'new') { const created = await api.bundles.create({ name: name.trim(), feedIds }); done(t('bundle.createdNamed', { name: created.bundle.name })); }
      else { const updated = await api.bundles.addFeeds(target, feedIds); done(t('bundle.addedNamed', { name: updated.bundle.name })); }
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <Modal title={t('bundle.addTitle')} close={close}><form className="modal-body bundle-editor" onSubmit={submit}>
    <p className="muted">{t('bundle.addLead', { count: feedIds.length })}</p>
    <fieldset className="bundle-picker" disabled={busy}><legend>{t('bundle.addTo')}</legend><div className="bundle-options">
      {bundles.map(({ bundle }) => <label key={bundle.id} className="bundle-option"><input type="radio" name="bundle-target" checked={target === bundle.id} onChange={() => setTarget(bundle.id)} /><span><strong>{bundle.name}</strong><small>{t('users.feedCount', { count: bundle.feedIds.length })}</small></span></label>)}
      <label className="bundle-option"><input type="radio" name="bundle-target" checked={target === 'new'} onChange={() => setTarget('new')} /><span><strong>{t('bundle.newTitle')}</strong><small>{t('bundle.fromSelected')}</small></span></label>
    </div></fieldset>
    {target === 'new' && <label className="field"><span>{t('label.bundleName')}</span><input required maxLength={200} autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={t('bundle.namePlaceholder')} /></label>}
    {error && <div className="error-note" role="alert">{error}</div>}
    <div className="modal-actions"><button type="button" className="button" onClick={close}>{t('common.cancel')}</button><button className="button primary" disabled={busy}>{busy ? t('common.saving') : t('collection.addToBundle')}</button></div>
  </form></Modal>;
}
