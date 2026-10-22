import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

/** Close on outside click / Escape and move focus with the arrow keys. */
export function useMenuBehaviour(open: boolean, setOpen: (open: boolean) => void, root: RefObject<HTMLElement | null>, trigger: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const pointer = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      items[index < 0 ? 0 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    };
    document.addEventListener('mousedown', pointer);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', pointer); document.removeEventListener('keydown', key, true); };
  }, [open, setOpen, root, trigger]);
}

export interface MenuAction { label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; onSelect: () => void }

/** A compact "⋯" style menu: one trigger button, a list of actions. */
export function ActionMenu({ label, trigger, actions, className = '' }: { label: string; trigger: ReactNode; actions: MenuAction[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useMenuBehaviour(open, setOpen, root, button);
  useEffect(() => { if (open) root.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus(); }, [open]);
  return <div className={`action-menu ${className}`} ref={root}>
    <button ref={button} type="button" className="icon-button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{trigger}</button>
    {open && <div className="menu compact" role="menu" aria-label={label}>{actions.map(action => <button key={action.label} type="button" role="menuitem" className={action.danger ? 'danger' : ''} disabled={action.disabled} onClick={() => { setOpen(false); action.onSelect(); }}>{action.icon}<span>{action.label}</span></button>)}</div>}
  </div>;
}
