import { useEffect, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Search, Users } from 'lucide-react';
import type { UserSummary } from '../shared/types';
import { useMenuBehaviour } from './Menu';
import { t } from './i18n';

function meta(user: UserSummary): string {
  const parts = [user.role === 'admin' ? t('role.admin') : t('role.user')];
  if (!user.enabled) parts.push(t('users.disabled'));
  if (user.stats) {
    parts.push(t('users.feedCount', { count: user.stats.feeds }));
    if (user.stats.failingFeeds) parts.push(t('users.failingCount', { count: user.stats.failingFeeds }));
  }
  return parts.join(' · ');
}

/**
 * Admin-only switcher at the top of the sidebar: "My workspace" plus every other
 * account. Picking one opens that user's workspace; the URL records it.
 */
export function WorkspaceSwitcher({ me, users, target, open: openWorkspace, manageUsers, refresh }: {
  me: { id: string; username: string }; users: UserSummary[]; target: UserSummary | null;
  open: (user: UserSummary | null) => void; manageUsers: () => void; refresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useMenuBehaviour(open, setOpen, root, button);
  useEffect(() => {
    if (!open) { setQuery(''); return; }
    refresh();
    root.current?.querySelector<HTMLElement>('.switcher-search input, [role="menuitem"]')?.focus();
  }, [open, refresh]);
  const others = users.filter(user => user.id !== me.id);
  const shown = others.filter(user => user.username.toLowerCase().includes(query.trim().toLowerCase()));
  const choose = (user: UserSummary | null) => { setOpen(false); openWorkspace(user); };
  const current = target ?? { username: me.username };
  return <div className={`workspace-switcher ${target ? 'managing' : ''}`} ref={root}>
    <button ref={button} type="button" className="switcher-trigger" aria-label={t('workspace.switch')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="switcher-avatar">{current.username.slice(0, 1).toUpperCase()}</span>
      <span className="switcher-text"><small>{target ? t('workspace.managing') : t('workspace.mine')}</small><strong>{current.username}</strong></span>
      <ChevronsUpDown size={15} />
    </button>
    {open && <div className="menu switcher-menu" role="menu" aria-label={t('workspace.menu')}>
      <button type="button" role="menuitem" className={!target ? 'current' : ''} onClick={() => choose(null)}><span className="switcher-avatar mine">{me.username.slice(0, 1).toUpperCase()}</span><span className="switcher-option"><strong>{t('workspace.mine')}</strong><small>{me.username}</small></span>{!target && <Check size={15} />}</button>
      {others.length > 6 && <label className="switcher-search"><Search size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('workspace.searchUsers')} aria-label={t('workspace.searchUsers')} /></label>}
      {others.length > 0 && <div className="switcher-group">{t('workspace.otherUsers')}</div>}
      <div className="switcher-list">{shown.map(user => <button key={user.id} type="button" role="menuitem" className={`${target?.id === user.id ? 'current' : ''} ${user.enabled ? '' : 'disabled-user'}`} onClick={() => choose(user)}>
        <span className="switcher-avatar">{user.username.slice(0, 1).toUpperCase()}</span>
        <span className="switcher-option"><strong>{user.username}</strong><small className={user.stats?.failingFeeds ? 'has-errors' : ''}>{meta(user)}</small></span>
        {target?.id === user.id && <Check size={15} />}
      </button>)}{others.length > 0 && !shown.length && <p className="switcher-empty">{t('workspace.noMatch')}</p>}</div>
      {!others.length && <p className="switcher-empty">{t('workspace.noOthers')}</p>}
      <button type="button" role="menuitem" className="switcher-manage" onClick={() => { setOpen(false); manageUsers(); }}><Users size={15} /><span>{t('workspace.manageUsers')}</span></button>
    </div>}
  </div>;
}
