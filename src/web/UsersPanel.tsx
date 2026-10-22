import { useEffect, useState, type FormEvent } from 'react';
import type { UserSummary } from '../shared/types';
import { api } from './api';
import { Modal } from './Modal';
import { Ban, CircleCheck, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { ActionMenu } from './Menu';
import { absoluteTime, relativeTime } from './format';

type Preview = Awaited<ReturnType<typeof api.users.deletionPreview>>;
export function UsersPanel({ currentUserId, manage, changed, identityChanged }: { currentUserId: string; manage: (user: UserSummary) => void; changed?: () => void; identityChanged: () => void }) {
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
  useEffect(() => { void api.users.list().then(setUsers).catch(e => setError(e.message)); }, []);
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setUsers(await api.users.list()); changed?.(); setNotice(message); return true; }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); return false; }
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
    }, editing ? '账号已更新；身份或密码变化后需要重新登录。' : '用户已创建。');
    if (ok) reset();
  }
  const shown = users.filter(user => user.username.toLowerCase().includes(query.trim().toLowerCase()));
  const totals = users.reduce((sum, user) => ({ feeds: sum.feeds + (user.stats?.feeds ?? 0), failing: sum.failing + (user.stats?.failingFeeds ?? 0) }), { feeds: 0, failing: 0 });
  return <>
    <div className="page-heading"><div><span className="section-kicker">ACCOUNTS</span><h1>用户管理</h1><p>管理账号权限，或进入用户的独立工作台。管理员拥有相同管理权限。</p></div><button className="button primary" disabled={busy} onClick={() => { reset(); setError(''); setFormOpen(true); }}><Plus size={17} />创建用户</button></div>
    {error && !formOpen && !deletion && <p className="error-note" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {formOpen && <Modal title={editing ? `编辑 ${editing.username}` : '创建用户'} close={() => { if (!busy) reset(); }}><form className="modal-body" onSubmit={submit}>
      <label className="field"><span>用户名</span><input required maxLength={100} pattern="[^\s]+" value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" /></label>
      {editing && <label className="field"><span>角色</span><select aria-label="角色" value={role} onChange={e => setRole(e.target.value as 'admin' | 'user')}><option value="user">普通用户</option><option value="admin">管理员</option></select><small>始终需要至少一名启用的管理员。修改自己的身份后需要重新登录。</small></label>}
      {editing?.id !== currentUserId && <label className="field"><span>{editing ? '新密码（留空保留）' : '初始密码'}</span><input required={!editing} type="password" minLength={8} maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></label>}
      {error && <p className="error-note" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={reset}>{editing ? '取消编辑' : '取消'}</button><button className="button primary" disabled={busy}>{busy ? '正在保存…' : editing ? '保存账号' : '创建用户'}</button></div>
    </form></Modal>}
    {users.length > 0 && <div className="stats-row users-summary">
      <div><span>账号</span><strong>{users.length}<small>{users.filter(user => user.role === 'admin').length} 位管理员</small></strong></div>
      <div><span>已停用</span><strong>{users.filter(user => !user.enabled).length}<small>个账号</small></strong></div>
      <div><span>订阅总数</span><strong>{totals.feeds}<small>个来源</small></strong></div>
      <div className={totals.failing ? 'attention' : ''}><span>出错订阅</span><strong>{totals.failing}<small>{totals.failing ? '需要检查' : '一切正常'}</small></strong></div>
    </div>}
    <section className="panel settings-form users-list" aria-label="用户列表"><div className="panel-heading"><h2>全部账号 <span>{users.length}</span></h2>{users.length > 5 && <div className="input-icon users-search"><Search size={15} /><input aria-label="搜索用户" placeholder="搜索用户名" value={query} onChange={e => setQuery(e.target.value)} /></div>}</div>
      <div className="user-row user-head" aria-hidden="true"><span>账号</span><span>订阅</span><span>凭据</span><span>最近活跃</span><span /></div>
      {shown.map(user => <div className={`user-row ${user.enabled ? '' : 'is-disabled'}`} key={user.id}>
        <div className="user-identity"><span className={`avatar ${user.enabled ? '' : 'off'}`}>{user.username.slice(0, 1).toUpperCase()}</span><div><strong>{user.username}{user.id === currentUserId ? '（自己）' : ''}</strong><p className="inline user-badges"><span className={`badge ${user.role === 'admin' ? 'good' : ''}`}>{user.role === 'admin' ? '管理员' : '普通用户'}</span><span className={`badge ${user.enabled ? '' : 'bad'}`}>{user.enabled ? '已启用' : '已停用'}</span></p></div></div>
        <div className="user-cell user-feeds" data-label="订阅"><strong>{user.stats?.feeds ?? '—'}</strong>{!!user.stats?.failingFeeds && <span className="user-failing">{user.stats.failingFeeds} 出错</span>}{!!user.stats?.pausedFeeds && <span className="user-paused">{user.stats.pausedFeeds} 暂停</span>}</div>
        <div className="user-cell" data-label="凭据">{user.stats ? `${user.stats.credentials} 组` : '—'}</div>
        <div className="user-cell user-seen" data-label="最近活跃"><span title={absoluteTime(user.stats?.lastSeenAt)}>{user.stats?.lastSeenAt ? relativeTime(user.stats.lastSeenAt) : '暂无会话'}</span><small title={absoluteTime(user.createdAt)}>创建于 {new Date(user.createdAt).toLocaleDateString('zh-CN')}</small></div>
        <div className="inline user-actions">
          {user.id !== currentUserId && <button className="button small" disabled={busy} onClick={() => manage(user)}>管理工作台</button>}
          <ActionMenu label={`更多操作 ${user.username}`} trigger={<MoreHorizontal size={18} />} actions={[
            { label: '编辑账号', icon: <Pencil size={15} />, disabled: busy, onSelect: () => { setEditing(user); setUsername(user.username); setRole(user.role); setPassword(''); setError(''); setFormOpen(true); } },
            ...(user.id !== currentUserId ? [
              { label: user.enabled ? '停用' : '启用', icon: user.enabled ? <Ban size={15} /> : <CircleCheck size={15} />, disabled: busy, onSelect: () => {
                if (user.enabled && !confirm(`停用 ${user.username}？登录、自动任务和 RSS 访问将暂停。`)) return;
                void run(() => api.users.enabled(user.id, !user.enabled), user.enabled ? '账号已停用。' : '账号已启用。');
              } },
              { label: '删除用户', icon: <Trash2 size={15} />, danger: true, disabled: busy, onSelect: () => { void run(async () => { setDeletion(await api.users.deletionPreview(user.id)); setConfirmation(''); }, '请核对删除范围。'); } },
            ] : []),
          ]} />
        </div>
      </div>)}
      {users.length > 0 && !shown.length && <p className="muted users-empty">没有匹配的用户</p>}
    </section>
    {deletion && <div className="modal-backdrop"><section className="panel settings-form delete-user-dialog" role="dialog" aria-modal="true" aria-label="永久删除用户">
      <h2>永久删除 {deletion.user.username}</h2><p>将删除 {deletion.feeds} 个订阅、{deletion.credentials} 个凭据、{deletion.jobs} 个批量任务，以及全部历史、个人设置和通知记录。原 RSS 地址将失效，此操作不可撤销。</p>
      <label className="field"><span>输入目标用户名确认</span><input autoFocus value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>
      {error && <p role="alert" className="error-note">{error}</p>}
      <div className="inline"><button className="button danger" disabled={busy || confirmation !== deletion.user.username} onClick={() => { void run(() => api.users.delete(deletion.user.id, confirmation), '用户及其数据已永久删除。').then(ok => { if (ok) { setDeletion(null); reset(); } }); }}>永久删除</button><button className="button" disabled={busy} onClick={() => setDeletion(null)}>取消</button></div>
    </section></div>}
  </>;
}
