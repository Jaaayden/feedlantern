import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Copy, ExternalLink, KeyRound, Layers, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { BUNDLE_ITEM_LIMIT, translationEnabled, type BundlePayload, type Feed } from '../shared/types';
import { api } from './api';
import { copyText } from './format';
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
        <div className="bundle-title"><h3 title={bundle.name}>{bundle.name}</h3><small>{t('bundle.summary', { count: bundle.feedIds.length, limit: bundle.itemLimit })}</small></div>
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
        <button className="button small" disabled={busy} aria-label={t('bundle.editOf', { name: bundle.name })} onClick={() => edit({ bundle, bundleUrl })}><Pencil size={14} />{t('common.edit')}</button>
      </div>
    </article>)}</div>
  </section>;
}

/** Create a bundle (optionally with members already chosen) or edit one. */
export function BundleEditor({ initial, preset = [], feeds, close, saved }: {
  initial?: BundlePayload; preset?: string[]; feeds: Feed[]; close: () => void; saved: (result: BundlePayload, created: boolean) => void;
}) {
  const [name, setName] = useState(initial?.bundle.name ?? '');
  const [limit, setLimit] = useState(String(initial?.bundle.itemLimit ?? BUNDLE_ITEM_LIMIT.default));
  const [members, setMembers] = useState<string[]>(initial?.bundle.feedIds ?? preset);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const feedIds = useMemo(() => new Set(feeds.map(feed => feed.id)), [feeds]);
  const selected = new Set(members);
  const search = query.trim().toLowerCase();
  const shown = useMemo(() => feeds.filter(feed => `${feed.name} ${feed.url}`.toLowerCase().includes(search)), [feeds, search]);
  const allShown = shown.length > 0 && shown.every(feed => selected.has(feed.id));
  function selectShown() {
    const ids = new Set(shown.map(feed => feed.id));
    setMembers(previous => allShown ? previous.filter(id => !ids.has(id)) : [...new Set([...previous, ...ids])]);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const itemLimit = Number(limit);
    if (!Number.isInteger(itemLimit) || itemLimit < BUNDLE_ITEM_LIMIT.min || itemLimit > BUNDLE_ITEM_LIMIT.max) { setError(t('error.integerRange', { label: t('label.bundleItemLimit'), min: String(BUNDLE_ITEM_LIMIT.min), max: String(BUNDLE_ITEM_LIMIT.max) })); return; }
    setBusy(true); setError('');
    // Members that were deleted meanwhile are dropped instead of failing the save.
    const body = { name: name.trim(), itemLimit, feedIds: members.filter(id => feedIds.has(id)) };
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
      <legend>{t('bundle.members')} <span className="muted">{t('collection.selected', { count: members.filter(id => feedIds.has(id)).length })}</span></legend>
      {feeds.length > 0 && <><div className="input-icon"><Search size={16} /><input aria-label={t('bundle.searchMembers')} placeholder={t('bundle.searchPlaceholder')} value={query} onChange={e => setQuery(e.target.value)} /></div><div className="bundle-selection"><span className="muted">{t('bundle.matches', { count: shown.length })}</span><button type="button" className="button small" disabled={!shown.length} onClick={selectShown}>{t(allShown ? 'bundle.clearMatches' : 'bundle.selectMatches')}</button></div></>}
      {feeds.length ? <div className="bundle-options">{shown.map(feed => <label key={feed.id} className="bundle-option"><input type="checkbox" aria-label={t('bundle.addMember', { name: feed.name })} checked={selected.has(feed.id)} onChange={e => toggle(feed.id, e.target.checked)} /><span><strong>{feed.name}</strong><small>{feedKind(feed)}{feed.enabled ? '' : ` · ${t('feed.paused')}`}</small></span></label>)}{!shown.length && <p className="muted">{t('bundle.noMatch')}</p>}</div> : <p className="muted">{t('bundle.noFeeds')}</p>}
    </fieldset>
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
