import { useEffect, useState, type FormEvent } from 'react';
import type { UserSummary } from '../shared/types';
import { api } from './api';

type Preview = Awaited<ReturnType<typeof api.users.deletionPreview>>;
export function UsersPanel({ currentUserId, manage, identityChanged }: { currentUserId: string; manage: (user: UserSummary) => void; identityChanged: () => void }) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [editing, setEditing] = useState<UserSummary | null>(null);
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [deletion, setDeletion] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { void api.users.list().then(setUsers).catch(e => setError(e.message)); }, []);
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setUsers(await api.users.list()); setNotice(message); return true; }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); return false; }
    finally { setBusy(false); }
  }
  function reset() { setEditing(null); setUsername(''); setPassword(''); setRole('user'); }
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
  return <>
    <div className="page-heading"><div><span className="section-kicker">ACCOUNTS</span><h1>用户管理</h1><p>管理账号权限，或进入用户的独立工作台。管理员拥有相同管理权限。</p></div></div>
    {error && <p className="error-note" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <form className="panel settings-form" onSubmit={submit}>
      <h2>{editing ? `编辑 ${editing.username}` : '创建用户'}</h2>
      <label className="field"><span>用户名</span><input required maxLength={100} pattern="[^\s]+" value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" /></label>
      {editing && <label className="field"><span>角色</span><select aria-label="角色" value={role} onChange={e => setRole(e.target.value as 'admin' | 'user')}><option value="user">普通用户</option><option value="admin">管理员</option></select><small>始终需要至少一名启用的管理员。修改自己的身份后需要重新登录。</small></label>}
      {editing?.id !== currentUserId && <label className="field"><span>{editing ? '新密码（留空保留）' : '初始密码'}</span><input required={!editing} type="password" minLength={8} maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></label>}
      <div className="inline"><button className="button primary" disabled={busy}>{busy ? '正在保存…' : editing ? '保存账号' : '创建用户'}</button>{editing && <button type="button" className="button" disabled={busy} onClick={reset}>取消编辑</button>}</div>
    </form>
    <section className="panel settings-form users-list" aria-label="用户列表"><h2>全部账号</h2>
      {users.map(user => <div className="user-row" key={user.id}>
        <div><strong>{user.username}{user.id === currentUserId ? '（自己）' : ''}</strong><p className="muted">{user.role === 'admin' ? '管理员' : '普通用户'} · {user.enabled ? '已启用' : '已停用'}</p></div>
        <div className="inline user-actions">
          <button className="button small" disabled={busy} onClick={() => manage(user)}>管理工作台</button>
          <button className="button small" disabled={busy} onClick={() => { setEditing(user); setUsername(user.username); setRole(user.role); setPassword(''); }}>编辑账号</button>
          {user.id !== currentUserId && <><button className="button small" disabled={busy} onClick={() => {
            if (user.enabled && !confirm(`停用 ${user.username}？登录、自动任务和 RSS 访问将暂停。`)) return;
            void run(() => api.users.enabled(user.id, !user.enabled), user.enabled ? '账号已停用。' : '账号已启用。');
          }}>{user.enabled ? '停用' : '启用'}</button><button className="button small danger" disabled={busy} onClick={() => { void run(async () => { setDeletion(await api.users.deletionPreview(user.id)); setConfirmation(''); }, '请核对删除范围。'); }}>删除用户</button></>}
        </div>
      </div>)}
    </section>
    {deletion && <div className="modal-backdrop"><section className="panel settings-form delete-user-dialog" role="dialog" aria-modal="true" aria-label="永久删除用户">
      <h2>永久删除 {deletion.user.username}</h2><p>将删除 {deletion.feeds} 个订阅、{deletion.credentials} 个凭据、{deletion.jobs} 个批量任务，以及全部历史、个人设置和通知记录。原 RSS 地址将失效，此操作不可撤销。</p>
      <label className="field"><span>输入目标用户名确认</span><input autoFocus value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>
      {error && <p role="alert" className="error-note">{error}</p>}
      <div className="inline"><button className="button danger" disabled={busy || confirmation !== deletion.user.username} onClick={() => { void run(() => api.users.delete(deletion.user.id, confirmation), '用户及其数据已永久删除。').then(ok => { if (ok) { setDeletion(null); reset(); } }); }}>永久删除</button><button className="button" disabled={busy} onClick={() => setDeletion(null)}>取消</button></div>
    </section></div>}
  </>;
}
