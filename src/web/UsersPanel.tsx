import { useEffect, useState, type FormEvent } from 'react';
import type { UserSummary } from '../shared/types';
import { api } from './api';

export function UsersPanel() {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [reset, setReset] = useState<UserSummary | null>(null);
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
  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await run(() => reset ? api.users.password(reset.id, password) : api.users.create(username, password), reset ? '密码已重置，该用户需要重新登录。' : '用户已创建，请将账号和密码告知对方。');
    if (ok) { setPassword(''); setUsername(''); setReset(null); }
  }
  return <>
    <div className="page-heading"><div><span className="section-kicker">ACCOUNTS</span><h1>用户管理</h1><p>创建独立账号，管理登录权限。每个用户拥有自己的订阅和 Cookie 凭据。</p></div></div>
    {error && <p className="error-note" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <form className="panel settings-form" onSubmit={submit}>
      <h2>{reset ? `重置 ${reset.username} 的密码` : '创建用户'}</h2>
      {!reset && <label className="field"><span>用户名</span><input required maxLength={100} pattern="[^\s]+" value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" /></label>}
      <label className="field"><span>{reset ? '新密码' : '初始密码'}</span><input required type="password" minLength={8} maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></label>
      <div className="inline"><button className="button primary" disabled={busy}>{busy ? '正在保存…' : reset ? '确认重置密码' : '创建用户'}</button>{reset && <button type="button" className="button" disabled={busy} onClick={() => { setReset(null); setPassword(''); }}>取消重置</button>}</div>
    </form>
    <section className="panel settings-form users-list" aria-label="用户列表"><h2>全部账号</h2>
      {users.map(user => <div className="user-row" key={user.id}>
        <div><strong>{user.username}</strong><p className="muted">{user.role === 'admin' ? '管理员' : '普通用户'} · {user.enabled ? '已启用' : '已停用'}</p></div>
        {user.role === 'user' && <div className="inline"><button className="button small" disabled={busy} onClick={() => {
          if (user.enabled && !confirm(`停用 ${user.username}？该用户将退出登录，自动任务和 RSS 访问也会暂停。`)) return;
          void run(() => api.users.enabled(user.id, !user.enabled), user.enabled ? '账号已停用。' : '账号已启用，原有订阅可继续使用。');
        }}>{user.enabled ? '停用' : '启用'}</button><button className="button small" disabled={busy} onClick={() => { setReset(user); setPassword(''); setNotice(''); }}>重置密码</button></div>}
      </div>)}
    </section>
  </>;
}
