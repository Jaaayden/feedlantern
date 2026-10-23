import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, Copy, KeySquare, RefreshCw, Trash2 } from 'lucide-react';
import type { ApiTokenCall, ApiTokenCallFilter, ApiTokenScope, ApiTokenSummary, UserSummary } from '../shared/types';
import { api } from './api';
import { absoluteTime, copyText, relativeTime } from './format';

const expiryOptions: Array<[string, string]> = [['30', '30 天'], ['90', '90 天'], ['365', '1 年'], ['', '永不过期']];
const callFilters: Array<[ApiTokenCallFilter | '', string]> = [['', '全部'], ['success', '成功'], ['denied', '被拒绝'], ['error', '出错']];
const statusHints: Record<number, string> = { 401: '令牌无效或已过期', 403: '无权调用：只读令牌写入，或接口仅限网页登录', 404: '资源或接口不存在', 409: '状态冲突', 429: '验证失败次数过多，已限流' };

function statusTitle(status: number): string {
  return statusHints[status] ?? (status >= 500 ? '服务器内部错误' : status >= 400 ? '请求被拒绝或参数无效' : '成功');
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
      if (current === generation.current) setError(e instanceof Error ? e.message : '调用记录加载失败');
    } finally { if (current === generation.current) setLoading(false); }
  }, [token.id, filter, userId]);
  useEffect(() => { generation.current++; setCalls([]); setCursor(null); void load(); }, [load, reload]);
  const now = Date.now();
  return <div className="token-calls" role="region" aria-label={`调用记录 ${token.name}`}>
    <div className="token-calls-toolbar">
      <div className="detail-actions" role="group" aria-label="按状态筛选">{callFilters.map(([value, label]) => <button key={value} type="button" className="button small" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
      <button type="button" className="icon-button" aria-label="刷新调用记录" title="刷新" disabled={loading} onClick={() => setReload(v => v + 1)}><RefreshCw size={15} className={loading ? 'spin' : undefined} /></button>
    </div>
    {error && <p className="error-note" role="alert">{error}</p>}
    {!error && !loading && !calls.length && <p className="token-calls-empty">{filter ? '没有符合条件的调用。' : '还没有调用记录。用这个令牌调用 API 后，会在这里出现。'}</p>}
    {calls.length > 0 && <ol className="token-call-list">{calls.map(call => {
      const failed = call.status >= 400;
      return <li key={call.id} className={`token-call${failed ? ' is-failed' : ''}`} aria-label={`${call.method} ${call.route ?? '未匹配的接口'} ${call.status}`}>
        <time dateTime={call.at} title={absoluteTime(call.at)}>{relativeTime(call.at, now)}</time>
        <span className="token-call-request"><span className="token-call-method">{call.method}</span><code className="token-call-route" title={call.route ?? '请求路径未匹配任何接口'}>{call.route ?? '未匹配的接口'}</code></span>
        <span className={`token-call-status ${failed ? 'bad' : 'good'}`} title={statusTitle(call.status)}>{call.status}</span>
        <span className="token-call-duration">{call.durationMs < 1000 ? `${call.durationMs} ms` : `${(call.durationMs / 1000).toFixed(1)} s`}</span>
        <code className="token-call-ip" title="来源 IP">{call.ip ?? '—'}</code>
      </li>;
    })}</ol>}
    {cursor && <button type="button" className="button small token-calls-more" disabled={loading} onClick={() => void load(cursor)}>加载更多</button>}
    {meta && <p className="hint">只记录用此令牌发起的请求，网页登录后的操作不会出现在这里。保留最近 {meta.retentionDays} 天，每个令牌最多 {meta.perTokenLimit} 条；不记录令牌本身和查询参数。</p>}
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
    try { setTokens(await api.tokens.list(target?.id)); } catch (e) { setError(e instanceof Error ? e.message : '加载失败'); }
  }, [target?.id]);
  useEffect(() => { void load(); }, [load]);
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api.tokens.create({ name: name.trim(), scope, expiresInDays: expiry ? Number(expiry) : null });
      setCreated({ name: result.token.name, secret: result.secret }); setName(''); await load();
    } catch (e) { setError(e instanceof Error ? e.message : '创建失败'); } finally { setBusy(false); }
  }
  async function revoke(token: ApiTokenSummary) {
    if (!confirm(`吊销令牌“${token.name}”？使用它的脚本会立即失去访问权限，调用记录也会一并删除。`)) return;
    setError('');
    try { await api.tokens.revoke(token.id); notify('令牌已吊销'); await load(); } catch (e) { setError(e instanceof Error ? e.message : '吊销失败'); }
  }
  const now = Date.now();
  return <section className="panel settings-form api-tokens" aria-label="访问令牌">
    <div className="panel-heading"><h2>访问令牌</h2><KeySquare size={19} /></div>
    {readOnly
      ? <p className="muted">{target.username} 的访问令牌和调用记录，只能查看。令牌只能由账号本人创建或吊销。</p>
      : <p className="muted">让脚本或 AI Agent 以你的身份调用 API，请求头写 <code>Authorization: Bearer 令牌</code>。令牌只能访问你自己的工作台，不能管理备份、账号或其他令牌。修改密码、停用或删除账号会吊销全部令牌。</p>}
    {!readOnly && <form className="api-token-form" onSubmit={create} aria-label="创建访问令牌">
      <label className="field"><span>令牌名称</span><input required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="例如：每日备份脚本" /></label>
      <label className="field"><span>权限</span><select value={scope} onChange={e => setScope(e.target.value as ApiTokenScope)}><option value="read">只读（read）</option><option value="write">读写（write）</option></select></label>
      <label className="field"><span>有效期</span><select value={expiry} onChange={e => setExpiry(e.target.value)}>{expiryOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button className="button primary" disabled={busy || !name.trim()}>创建令牌</button>
    </form>}
    {created && <div className="api-token-created" role="status">
      <strong>已创建“{created.name}”。请立即复制保存，关闭后无法再次查看。</strong>
      <div className="copy-row"><input readOnly aria-label="新令牌" value={created.secret} onFocus={e => e.target.select()} spellCheck={false} /><button type="button" className="button primary" onClick={() => void copyText(created.secret).then(() => notify('令牌已复制')).catch(() => setError('无法访问剪贴板，请选中令牌后手动复制。'))}><Copy size={15} />复制</button></div>
      <button type="button" className="button small" onClick={() => setCreated(null)}>我已保存</button>
    </div>}
    {error && <p className="error-note" role="alert">{error}</p>}
    {tokens === null ? <p className="muted">正在加载令牌…</p> : tokens.length ? <ul className="api-token-list">{tokens.map(token => {
      const expired = !!token.expiresAt && Date.parse(token.expiresAt) <= now;
      const usage = token.usage24h;
      const expanded = open === token.id;
      return <li key={token.id} className={`api-token-row${expanded ? ' is-open' : ''}`} aria-label={`令牌 ${token.name}`}>
        <div className="api-token-summary">
          <div className="api-token-main">
            <strong>{token.name}</strong>
            <span className="inline"><code>{token.prefix}…</code><span className={`badge ${token.scope === 'write' ? '' : 'good'}`}>{token.scope === 'write' ? '读写' : '只读'}</span>{expired && <span className="badge bad">已过期</span>}</span>
            <small>创建于 <span title={absoluteTime(token.createdAt)}>{relativeTime(token.createdAt, now)}</span> · {token.expiresAt ? <>{expired ? '过期于' : '有效至'} <span title={absoluteTime(token.expiresAt)}>{absoluteTime(token.expiresAt).slice(0, 10)}</span></> : '永不过期'} · {token.lastUsedAt ? <>最近使用 <span title={absoluteTime(token.lastUsedAt)}>{relativeTime(token.lastUsedAt, now)}</span></> : '尚未使用'}</small>
          </div>
          <div className="api-token-actions">
            {usage && <span className="api-token-usage" title="最近 24 小时">24 小时 {usage.calls} 次{usage.failures > 0 && <em>{usage.failures} 次失败</em>}</span>}
            <button type="button" className="button small" aria-expanded={expanded} aria-label={`调用记录 ${token.name}`} onClick={() => setOpen(expanded ? null : token.id)}>调用记录<ChevronDown size={14} className="chevron" /></button>
            {!readOnly && <button type="button" className="button small danger" aria-label={`吊销令牌 ${token.name}`} onClick={() => void revoke(token)}><Trash2 size={14} />吊销</button>}
          </div>
        </div>
        {expanded && <TokenCalls token={token} userId={target?.id} />}
      </li>;
    })}</ul> : <p className="muted">{readOnly ? '此账号还没有令牌。' : '还没有令牌。'}</p>}
    <p className="hint">接口文档（OpenAPI 3.1）：<a className="text-link" href="/api/openapi.json" target="_blank" rel="noreferrer">/api/openapi.json</a></p>
  </section>;
}
