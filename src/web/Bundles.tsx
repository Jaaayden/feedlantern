import { useState } from 'react';
import type { FormEvent } from 'react';
import { Copy, ExternalLink, KeyRound, Layers, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { BUNDLE_ITEM_LIMIT, translationEnabled, type BundlePayload, type Feed } from '../shared/types';
import { api } from './api';
import { copyText } from './format';
import { ActionMenu } from './Menu';
import { Modal } from './Modal';

const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试';
const feedKind = (feed: Feed) => `${feed.sourceType === 'rss' ? 'RSS 来源' : '网页抓取'}${translationEnabled(feed) ? ' · 翻译' : ''}`;

function memberNames(feedIds: string[], feeds: Feed[]): string {
  const names = feedIds.flatMap(id => feeds.find(feed => feed.id === id)?.name ?? []);
  return names.length > 4 ? `${names.slice(0, 4).join('、')} 等 ${names.length} 个` : names.join('、');
}

/** Bundles on the feeds page: copy the address, edit members, rotate the key or delete. */
export function BundleSection({ bundles, feeds, create, edit, changed, notify }: {
  bundles: BundlePayload[]; feeds: Feed[]; create: () => void; edit: (bundle: BundlePayload) => void; changed: () => void; notify: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(operation: () => Promise<unknown>, success: string) {
    setBusy(true); setError('');
    try { await operation(); changed(); notify(success); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <section className="bundle-section" aria-label="聚合订阅">
    <div className="list-toolbar"><h2>聚合订阅 <span>{bundles.length}</span></h2><button className="button small" disabled={busy} onClick={create}><Plus size={14} />新建聚合</button></div>
    {error && <div className="error-note" role="alert">{error}</div>}
    <div className="bundle-grid">{bundles.map(({ bundle, bundleUrl }) => <article className="bundle-card" key={bundle.id} aria-label={`聚合订阅 ${bundle.name}`}>
      <div className="bundle-head">
        <span className="soft-icon"><Layers size={18} /></span>
        <div className="bundle-title"><h3 title={bundle.name}>{bundle.name}</h3><small>{bundle.feedIds.length} 个订阅 · 最多 {bundle.itemLimit} 条</small></div>
        <ActionMenu label={`更多操作 ${bundle.name}`} trigger={<MoreHorizontal size={17} />} actions={[
          { label: '编辑聚合', icon: <Pencil size={15} />, disabled: busy, onSelect: () => edit({ bundle, bundleUrl }) },
          { label: '轮换密钥', icon: <KeyRound size={15} />, disabled: busy, onSelect: () => { if (confirm('轮换后，旧的聚合地址将立即失效。继续？')) void run(() => api.bundles.rotate(bundle.id), '聚合地址已更新'); } },
          { label: '删除聚合', icon: <Trash2 size={15} />, danger: true, disabled: busy, onSelect: () => { if (confirm(`删除聚合订阅“${bundle.name}”？成员订阅不受影响。`)) void run(() => api.bundles.remove(bundle.id), '聚合订阅已删除'); } },
        ]} />
      </div>
      <p className="bundle-members" title={memberNames(bundle.feedIds, feeds)}>{bundle.feedIds.length ? memberNames(bundle.feedIds, feeds) : '还没有成员，编辑聚合添加订阅。'}</p>
      <div className="detail-actions">
        <button className="button small" disabled={busy} aria-label={`复制聚合地址 ${bundle.name}`} onClick={() => void copyText(bundleUrl).then(() => notify('聚合地址已复制')).catch(() => setError('无法访问剪贴板，请在聚合订阅页中手动复制地址。'))}><Copy size={14} />复制地址</button>
        <a className="button small" href={bundleUrl} target="_blank" rel="noreferrer" aria-label={`打开聚合订阅页 ${bundle.name}`}><ExternalLink size={14} />打开</a>
        <button className="button small" disabled={busy} aria-label={`编辑聚合 ${bundle.name}`} onClick={() => edit({ bundle, bundleUrl })}><Pencil size={14} />编辑</button>
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
  const shown = feeds.filter(feed => `${feed.name} ${feed.url}`.toLowerCase().includes(query.trim().toLowerCase()));
  async function submit(event: FormEvent) {
    event.preventDefault();
    const itemLimit = Number(limit);
    if (!Number.isInteger(itemLimit) || itemLimit < BUNDLE_ITEM_LIMIT.min || itemLimit > BUNDLE_ITEM_LIMIT.max) { setError(`条目上限必须是 ${BUNDLE_ITEM_LIMIT.min} 到 ${BUNDLE_ITEM_LIMIT.max} 之间的整数`); return; }
    setBusy(true); setError('');
    // Members that were deleted meanwhile are dropped instead of failing the save.
    const body = { name: name.trim(), itemLimit, feedIds: members.filter(id => feeds.some(feed => feed.id === id)) };
    try { saved(initial ? await api.bundles.update(initial.bundle.id, body) : await api.bundles.create(body), !initial); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  const toggle = (id: string, checked: boolean) => setMembers(previous => checked ? [...previous.filter(item => item !== id), id] : previous.filter(item => item !== id));
  return <Modal title={initial ? '编辑聚合订阅' : '新建聚合订阅'} close={close}><form className="modal-body bundle-editor" onSubmit={submit}>
    <p className="muted">把多个订阅合并成一个 RSS 地址：按时间合并各订阅已收集的内容，注明来源，相同链接只出现一次。聚合只读取已有内容，不会额外抓取。</p>
    <div className="form-row">
      <label className="field"><span>聚合名称</span><input required maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder="例如：每日科技" /></label>
      <label className="field"><span>最多条数</span><input type="number" required min={BUNDLE_ITEM_LIMIT.min} max={BUNDLE_ITEM_LIMIT.max} step={1} value={limit} onChange={e => setLimit(e.target.value)} /></label>
    </div>
    <fieldset className="bundle-picker" disabled={busy}>
      <legend>成员订阅 <span className="muted">已选择 {members.filter(id => feeds.some(feed => feed.id === id)).length} 个</span></legend>
      {feeds.length > 6 && <div className="input-icon"><Search size={16} /><input aria-label="搜索成员订阅" placeholder="搜索名称或网址" value={query} onChange={e => setQuery(e.target.value)} /></div>}
      {feeds.length ? <div className="bundle-options">{shown.map(feed => <label key={feed.id} className="bundle-option"><input type="checkbox" aria-label={`加入成员 ${feed.name}`} checked={members.includes(feed.id)} onChange={e => toggle(feed.id, e.target.checked)} /><span><strong>{feed.name}</strong><small>{feedKind(feed)}{feed.enabled ? '' : ' · 已暂停'}</small></span></label>)}{!shown.length && <p className="muted">没有匹配的订阅。</p>}</div> : <p className="muted">还没有订阅。先创建网页订阅或 RSS 翻译，再把它们加入聚合。</p>}
    </fieldset>
    {error && <div className="error-note" role="alert">{error}</div>}
    <div className="modal-actions"><button type="button" className="button" onClick={close}>取消</button><button className="button primary" disabled={busy}>{busy ? '正在保存…' : initial ? '保存聚合' : '创建聚合'}</button></div>
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
      if (target === 'new') { const created = await api.bundles.create({ name: name.trim(), feedIds }); done(`已创建聚合订阅“${created.bundle.name}”`); }
      else { const updated = await api.bundles.addFeeds(target, feedIds); done(`已加入聚合订阅“${updated.bundle.name}”`); }
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <Modal title="加入聚合订阅" close={close}><form className="modal-body bundle-editor" onSubmit={submit}>
    <p className="muted">把选中的 {feedIds.length} 个订阅加入聚合订阅。已在其中的订阅不会重复添加。</p>
    <fieldset className="bundle-picker" disabled={busy}><legend>加入到</legend><div className="bundle-options">
      {bundles.map(({ bundle }) => <label key={bundle.id} className="bundle-option"><input type="radio" name="bundle-target" checked={target === bundle.id} onChange={() => setTarget(bundle.id)} /><span><strong>{bundle.name}</strong><small>{bundle.feedIds.length} 个订阅</small></span></label>)}
      <label className="bundle-option"><input type="radio" name="bundle-target" checked={target === 'new'} onChange={() => setTarget('new')} /><span><strong>新建聚合订阅</strong><small>用选中的订阅创建</small></span></label>
    </div></fieldset>
    {target === 'new' && <label className="field"><span>聚合名称</span><input required maxLength={200} autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="例如：每日科技" /></label>}
    {error && <div className="error-note" role="alert">{error}</div>}
    <div className="modal-actions"><button type="button" className="button" onClick={close}>取消</button><button className="button primary" disabled={busy}>{busy ? '正在保存…' : '加入聚合'}</button></div>
  </form></Modal>;
}
