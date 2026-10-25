import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, Copy, KeySquare, RefreshCw, Trash2 } from 'lucide-react';
import type { ApiTokenCall, ApiTokenCallFilter, ApiTokenScope, ApiTokenSummary, UserSummary } from '../shared/types';
import { api } from './api';
import { absoluteTime, copyText, relativeTime } from './format';
import { fmt, t } from './i18n';

const expiryOptions = (): Array<[string, string]> => [['30', t('tokens.days', { count: 30 })], ['90', t('tokens.days', { count: 90 })], ['365', t('tokens.oneYear')], ['', t('tokens.never')]];
const callFilters = (): Array<[ApiTokenCallFilter | '', string]> => [['', t('tokens.filter.all')], ['success', t('tokens.filter.success')], ['denied', t('tokens.filter.denied')], ['error', t('tokens.filter.error')]];
const statusHint = (status: number) => [401, 403, 404, 409, 429].includes(status) ? t(`tokens.status.${status as 401}`) : undefined;

function statusTitle(status: number): string {
  return statusHint(status) ?? (status >= 500 ? t('error.internal') : status >= 400 ? t('tokens.status.rejected') : t('tokens.filter.success'));
}

/** One token's calls, newest first, with a status filter and cursor paging. */
function TokenCalls({ token, userId }: { token: ApiTokenSummary; userId?: string }) {
  const [filter, setFilter] = useState<ApiTokenCallFilter | ''>('');
  const [calls, setCalls] = useState<ApiTokenCall[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ retentionDays: number; perTokenLimit: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const load = useCallback(async (next?: string) => {
    const current = generation.current;
    setLoading(true);
    try {
      const page = await api.tokens.calls(token.id, { status: filter || undefined, cursor: next, userId });
      if (current !== generation.current) return;
      setCalls(previous => next ? [...previous, ...page.calls] : page.calls);
      setCursor(page.nextCursor); setMeta({ retentionDays: page.retentionDays, perTokenLimit: page.perTokenLimit }); setError('');
    } catch (e) {
      if (current === generation.current) setError(e instanceof Error ? e.message : t('tokens.callsLoadFailed'));
    } finally { if (current === generation.current) setLoading(false); }
  }, [token.id, filter, userId]);
  useEffect(() => { generation.current++; setCalls([]); setCursor(null); void load(); }, [load, reload]);
  const now = Date.now();
  return <div className="token-calls" role="region" aria-label={t('tokens.callsOf', { name: token.name })}>
    <div className="token-calls-toolbar">
      <div className="detail-actions" role="group" aria-label={t('tokens.filterByStatus')}>{callFilters().map(([value, label]) => <button key={value} type="button" className="button small" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
      <button type="button" className="icon-button" aria-label={t('tokens.refreshCalls')} title={t('common.refresh')} disabled={loading} onClick={() => setReload(v => v + 1)}><RefreshCw size={15} className={loading ? 'spin' : undefined} /></button>
    </div>
    {error && <p className="error-note" role="alert">{error}</p>}
    {!error && !loading && !calls.length && <p className="token-calls-empty">{filter ? t('tokens.noMatchingCalls') : t('tokens.noCalls')}</p>}
    {calls.length > 0 && <ol className="token-call-list">{calls.map(call => {
      const failed = call.status >= 400;
      return <li key={call.id} className={`token-call${failed ? ' is-failed' : ''}`} aria-label={`${call.method} ${call.route ?? t('tokens.unmatched')} ${call.status}`}>
        <time dateTime={call.at} title={absoluteTime(call.at)}>{relativeTime(call.at, now)}</time>
        <span className="token-call-request"><span className="token-call-method">{call.method}</span><code className="token-call-route" title={call.route ?? t('tokens.unmatchedTitle')}>{call.route ?? t('tokens.unmatched')}</code></span>
        <span className={`token-call-status ${failed ? 'bad' : 'good'}`} title={statusTitle(call.status)}>{call.status}</span>
        <span className="token-call-duration">{call.durationMs < 1000 ? `${call.durationMs} ms` : `${(call.durationMs / 1000).toFixed(1)} s`}</span>
        <code className="token-call-ip" title={t('tokens.ip')}>{call.ip ?? '—'}</code>
      </li>;
    })}</ol>}
    {cursor && <button type="button" className="button small token-calls-more" disabled={loading} onClick={() => void load(cursor)}>{t('common.loadMore')}</button>}
    {meta && <p className="hint">{t('tokens.callsHint', { days: meta.retentionDays, max: meta.perTokenLimit })}</p>}
  </div>;
}

/**
 * Personal access tokens of the signed-in account. In another account's
 * workspace an administrator sees that account's tokens and calls, read-only.
 */
export function ApiTokensPanel({ notify, target }: { notify: (message: string) => void; target?: UserSummary | null }) {
  const [tokens, setTokens] = useState<ApiTokenSummary[] | null>(null);
  const [name, setName] = useState(''), [scope, setScope] = useState<ApiTokenScope>('read'), [expiry, setExpiry] = useState('90');
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const readOnly = !!target;
  const load = useCallback(async () => {
    try { setTokens(await api.tokens.list(target?.id)); } catch (e) { setError(e instanceof Error ? e.message : t('common.loadFailed')); }
  }, [target?.id]);
  useEffect(() => { void load(); }, [load]);
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api.tokens.create({ name: name.trim(), scope, expiresInDays: expiry ? Number(expiry) : null });
      setCreated({ name: result.token.name, secret: result.secret }); setName(''); await load();
    } catch (e) { setError(e instanceof Error ? e.message : t('common.createFailed')); } finally { setBusy(false); }
  }
  async function revoke(token: ApiTokenSummary) {
    if (!confirm(t('tokens.confirmRevoke', { name: token.name }))) return;
    setError('');
    try { await api.tokens.revoke(token.id); notify(t('tokens.revoked')); await load(); } catch (e) { setError(e instanceof Error ? e.message : t('tokens.revokeFailed')); }
  }
  const now = Date.now();
  return <section className="panel settings-form api-tokens" aria-label={t('tokens.title')}>
    <div className="panel-heading"><h2>{t('tokens.title')}</h2><KeySquare size={19} /></div>
    {readOnly
      ? <p className="muted">{t('tokens.readOnly', { name: target.username })}</p>
      : <p className="muted">{t('tokens.leadBefore')}<code>{t('tokens.leadHeader')}</code>{t('tokens.leadAfter')}</p>}
    {!readOnly && <form className="api-token-form" onSubmit={create} aria-label={t('tokens.create')}>
      <label className="field"><span>{t('label.tokenName')}</span><input required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder={t('tokens.namePlaceholder')} /></label>
      <label className="field"><span>{t('tokens.scope')}</span><select value={scope} onChange={e => setScope(e.target.value as ApiTokenScope)}><option value="read">{t('tokens.scopeRead')}</option><option value="write">{t('tokens.scopeWrite')}</option></select></label>
      <label className="field"><span>{t('tokens.expiry')}</span><select value={expiry} onChange={e => setExpiry(e.target.value)}>{expiryOptions().map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button className="button primary" disabled={busy || !name.trim()}>{t('tokens.createButton')}</button>
    </form>}
    {created && <div className="api-token-created" role="status">
      <strong>{t('tokens.createdNamed', { name: created.name })}</strong>
      <div className="copy-row"><input readOnly aria-label={t('tokens.newToken')} value={created.secret} onFocus={e => e.target.select()} spellCheck={false} /><button type="button" className="button primary" onClick={() => void copyText(created.secret).then(() => notify(t('tokens.copied'))).catch(() => setError(t('tokens.copyFailed')))}><Copy size={15} />{t('common.copy')}</button></div>
      <button type="button" className="button small" onClick={() => setCreated(null)}>{t('tokens.saved')}</button>
    </div>}
    {error && <p className="error-note" role="alert">{error}</p>}
    {tokens === null ? <p className="muted">{t('tokens.loading')}</p> : tokens.length ? <ul className="api-token-list">{tokens.map(token => {
      const expired = !!token.expiresAt && Date.parse(token.expiresAt) <= now;
      const usage = token.usage24h;
      const expanded = open === token.id;
      return <li key={token.id} className={`api-token-row${expanded ? ' is-open' : ''}`} aria-label={t('tokens.named', { name: token.name })}>
        <div className="api-token-summary">
          <div className="api-token-main">
            <strong>{token.name}</strong>
            <span className="inline"><code>{token.prefix}…</code><span className={`badge ${token.scope === 'write' ? '' : 'good'}`}>{token.scope === 'write' ? t('tokens.write') : t('tokens.read')}</span>{expired && <span className="badge bad">{t('tokens.expired')}</span>}</span>
            <small>{t('tokens.createdLabel')} <span title={absoluteTime(token.createdAt)}>{relativeTime(token.createdAt, now)}</span> · {token.expiresAt ? <>{expired ? t('tokens.expiredOn') : t('tokens.validUntil')} <span title={absoluteTime(token.expiresAt)}>{fmt.date(token.expiresAt, { dateStyle: 'medium' })}</span></> : t('tokens.never')} · {token.lastUsedAt ? <>{t('tokens.lastUsed')} <span title={absoluteTime(token.lastUsedAt)}>{relativeTime(token.lastUsedAt, now)}</span></> : t('tokens.unused')}</small>
          </div>
          <div className="api-token-actions">
            {usage && <span className="api-token-usage" title={t('tokens.last24hTitle')}>{t('tokens.last24h', { count: usage.calls })}{usage.failures > 0 && <em>{t('tokens.failures', { count: usage.failures })}</em>}</span>}
            <button type="button" className="button small" aria-expanded={expanded} aria-label={t('tokens.callsOf', { name: token.name })} onClick={() => setOpen(expanded ? null : token.id)}>{t('tokens.calls')}<ChevronDown size={14} className="chevron" /></button>
            {!readOnly && <button type="button" className="button small danger" aria-label={t('tokens.revokeOf', { name: token.name })} onClick={() => void revoke(token)}><Trash2 size={14} />{t('tokens.revoke')}</button>}
          </div>
        </div>
        {expanded && <TokenCalls token={token} userId={target?.id} />}
      </li>;
    })}</ul> : <p className="muted">{readOnly ? t('tokens.noneForAccount') : t('tokens.none')}</p>}
    <p className="hint">{t('tokens.docs')}<a className="text-link" href="/api/openapi.json" target="_blank" rel="noreferrer">/api/openapi.json</a></p>
  </section>;
}
