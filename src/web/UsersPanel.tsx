import { useEffect, useState, type FormEvent } from 'react';
import type { UserSummary } from '../shared/types';
import { api } from './api';
import { Modal } from './Modal';
import { Ban, ChevronRight, CircleCheck, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { ActionMenu } from './Menu';
import { absoluteTime, relativeTime } from './format';
import { fmt, t } from './i18n';

type Preview = Awaited<ReturnType<typeof api.users.deletionPreview>>;
export function UsersPanel({ currentUserId, manage, changed, identityChanged }: { currentUserId: string; manage: (user: UserSummary | null, attention?: boolean) => void; changed?: () => void; identityChanged: () => void }) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [editing, setEditing] = useState<UserSummary | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [deletion, setDeletion] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [onlyAttention, setOnlyAttention] = useState(false);
  useEffect(() => { void api.users.list().then(setUsers).catch(e => setError(e.message)); }, []);
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setUsers(await api.users.list()); changed?.(); setNotice(message); return true; }
    catch (e) { setError(e instanceof Error ? e.message : t('error.actionFailed')); return false; }
    finally { setBusy(false); }
  }
  function reset() { setEditing(null); setUsername(''); setPassword(''); setRole('user'); setFormOpen(false); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await run(async () => {
      if (!editing) return api.users.create(username, password);
      // Reset another account's password before changing identity; self changes revoke this session.
      if (password) await api.users.password(editing.id, password);
      await api.users.update(editing.id, { username, role });
      if (editing.id === currentUserId && (username !== editing.username || role !== editing.role)) identityChanged();
    }, editing ? t('users.updated') : t('users.created'));
    if (ok) reset();
  }
  const shown = users.filter(user => user.username.toLowerCase().includes(query.trim().toLowerCase()) && (!onlyAttention || !!user.stats?.attentionFeeds));
  const totals = users.reduce((sum, user) => ({ feeds: sum.feeds + (user.stats?.feeds ?? 0), attention: sum.attention + (user.stats?.attentionFeeds ?? 0) }), { feeds: 0, attention: 0 });
  return <>
    <div className="page-heading"><div><span className="section-kicker">ACCOUNTS</span><h1>{t('users.title')}</h1><p>{t('users.lead')}</p></div><button className="button primary" disabled={busy} onClick={() => { reset(); setError(''); setFormOpen(true); }}><Plus size={17} />{t('users.create')}</button></div>
    {error && !formOpen && !deletion && <p className="error-note" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {formOpen && <Modal title={editing ? t('users.editTitle', { name: editing.username }) : t('users.create')} close={() => { if (!busy) reset(); }}><form className="modal-body" onSubmit={submit}>
      <label className="field"><span>{t('auth.username')}</span><input required maxLength={100} pattern="[^\s]+" value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" /></label>
      {editing && <label className="field"><span>{t('users.role')}</span><select aria-label={t('users.role')} value={role} onChange={e => setRole(e.target.value as 'admin' | 'user')}><option value="user">{t('role.user')}</option><option value="admin">{t('role.admin')}</option></select><small>{t('users.roleHint')}</small></label>}
      {editing?.id !== currentUserId && <label className="field"><span>{editing ? t('users.newPassword') : t('users.initialPassword')}</span><input required={!editing} type="password" minLength={8} maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></label>}
      {error && <p className="error-note" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={reset}>{editing ? t('users.cancelEdit') : t('common.cancel')}</button><button className="button primary" disabled={busy}>{busy ? t('common.saving') : editing ? t('users.save') : t('users.create')}</button></div>
    </form></Modal>}
    {users.length > 0 && <div className="stats-row users-summary">
      <div><span>{t('users.accounts')}</span><strong>{users.length}<small>{t('users.adminCount', { count: users.filter(user => user.role === 'admin').length })}</small></strong></div>
      <div><span>{t('users.disabled')}</span><strong>{users.filter(user => !user.enabled).length}<small>{t('users.accountsUnit', { count: users.filter(user => !user.enabled).length })}</small></strong></div>
      <div><span>{t('users.totalFeeds')}</span><strong>{totals.feeds}<small>{t('users.sourcesUnit', { count: totals.feeds })}</small></strong></div>
      {totals.attention ? <button className={`attention ${onlyAttention ? 'active' : ''}`} aria-pressed={onlyAttention} title={onlyAttention ? t('users.showAll') : t('users.onlyAttention')} onClick={() => setOnlyAttention(!onlyAttention)}><span>{t('collection.attention')}</span><strong>{totals.attention}<small>{onlyAttention ? t('users.filtered') : t('users.clickToFilter')}</small><ChevronRight size={15} className="stat-arrow" /></strong></button> : <div><span>{t('collection.attention')}</span><strong>0<small>{t('users.allGood')}</small></strong></div>}
    </div>}
    <section className="panel settings-form users-list" aria-label={t('users.list')}><div className="panel-heading"><h2>{t('users.allAccounts')} <span>{users.length}</span></h2>{users.length > 5 && <div className="input-icon users-search"><Search size={15} /><input aria-label={t('workspace.searchUsers')} placeholder={t('users.searchPlaceholder')} value={query} onChange={e => setQuery(e.target.value)} /></div>}</div>
      <div className="user-row user-head" aria-hidden="true"><span>{t('users.accounts')}</span><span>{t('users.feeds')}</span><span>{t('users.credentials')}</span><span>{t('users.lastActive')}</span><span /></div>
      {shown.map(user => <div className={`user-row ${user.enabled ? '' : 'is-disabled'}`} key={user.id}>
        <div className="user-identity"><span className={`avatar ${user.enabled ? '' : 'off'}`}>{user.username.slice(0, 1).toUpperCase()}</span><div><strong>{user.username}{user.id === currentUserId ? t('users.you') : ''}</strong><p className="inline user-badges"><span className={`badge ${user.role === 'admin' ? 'good' : ''}`}>{user.role === 'admin' ? t('role.admin') : t('role.user')}</span><span className={`badge ${user.enabled ? '' : 'bad'}`}>{user.enabled ? t('users.enabled') : t('users.disabled')}</span></p></div></div>
        <div className="user-cell user-feeds" data-label={t('users.feeds')}><strong>{user.stats?.feeds ?? '—'}</strong>{!!user.stats?.attentionFeeds && <button type="button" className="user-failing" title={user.id === currentUserId ? t('users.myAttention') : t('users.theirAttention', { name: user.username })} onClick={() => manage(user.id === currentUserId ? null : user, true)}>{t('users.attentionCount', { count: user.stats.attentionFeeds })}</button>}{user.stats?.attentionFeeds === 0 && <span className="user-attention-zero">{t('users.attentionCount', { count: 0 })}</span>}{!!user.stats?.pausedFeeds && <span className="user-paused">{t('users.pausedCount', { count: user.stats.pausedFeeds })}</span>}</div>
        <div className="user-cell" data-label={t('users.credentials')}>{user.stats ? t('users.credentialCount', { count: user.stats.credentials }) : '—'}</div>
        <div className="user-cell user-seen" data-label={t('users.lastActive')}><span title={absoluteTime(user.stats?.lastSeenAt)}>{user.stats?.lastSeenAt ? relativeTime(user.stats.lastSeenAt) : t('users.noSession')}</span><small title={absoluteTime(user.createdAt)}>{t('users.createdOn', { date: fmt.date(user.createdAt, { dateStyle: 'medium' }) })}</small></div>
        <div className="inline user-actions">
          {user.id !== currentUserId && <button className="button small" disabled={busy} onClick={() => manage(user)}>{t('users.manageWorkspace')}</button>}
          <ActionMenu label={t('users.more', { name: user.username })} trigger={<MoreHorizontal size={18} />} actions={[
            { label: t('users.edit'), icon: <Pencil size={15} />, disabled: busy, onSelect: () => { setEditing(user); setUsername(user.username); setRole(user.role); setPassword(''); setError(''); setFormOpen(true); } },
            ...(user.id !== currentUserId ? [
              { label: user.enabled ? t('users.disable') : t('users.enable'), icon: user.enabled ? <Ban size={15} /> : <CircleCheck size={15} />, disabled: busy, onSelect: () => {
                if (user.enabled && !confirm(t('users.confirmDisable', { name: user.username }))) return;
                void run(() => api.users.enabled(user.id, !user.enabled), user.enabled ? t('users.disabledDone') : t('users.enabledDone'));
              } },
              { label: t('users.delete'), icon: <Trash2 size={15} />, danger: true, disabled: busy, onSelect: () => { void run(async () => { setDeletion(await api.users.deletionPreview(user.id)); setConfirmation(''); }, t('users.checkScope')); } },
            ] : []),
          ]} />
        </div>
      </div>)}
      {users.length > 0 && !shown.length && <p className="muted users-empty">{t('workspace.noMatch')}{onlyAttention && <> · <button type="button" className="link-button" onClick={() => setOnlyAttention(false)}>{t('users.showAll')}</button></>}</p>}
    </section>
    {deletion && <div className="modal-backdrop"><section className="panel settings-form delete-user-dialog" role="dialog" aria-modal="true" aria-label={t('users.deleteTitleLabel')}>
      <h2>{t('users.deleteTitle', { name: deletion.user.username })}</h2><p>{t('users.deleteScope', { list: fmt.list([t('users.feedCount', { count: deletion.feeds }), ...(deletion.bundles ? [t('backup.bundleCount', { count: deletion.bundles })] : []), t('users.credentialItems', { count: deletion.credentials }), t('users.jobCount', { count: deletion.jobs })], 'unit') })}</p>
      <label className="field"><span>{t('users.typeToConfirm')}</span><input autoFocus value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>
      {error && <p role="alert" className="error-note">{error}</p>}
      <div className="inline"><button className="button danger" disabled={busy || confirmation !== deletion.user.username} onClick={() => { void run(() => api.users.delete(deletion.user.id, confirmation), t('users.deleted')).then(ok => { if (ok) { setDeletion(null); reset(); } }); }}>{t('users.deleteForever')}</button><button className="button" disabled={busy} onClick={() => setDeletion(null)}>{t('common.cancel')}</button></div>
    </section></div>}
  </>;
}
