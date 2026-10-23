import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Copy, KeySquare, Trash2 } from 'lucide-react';
import type { ApiTokenScope, ApiTokenSummary } from '../shared/types';
import { api } from './api';
import { absoluteTime, copyText, relativeTime } from './format';

const expiryOptions: Array<[string, string]> = [['30', '30 天'], ['90', '90 天'], ['365', '1 年'], ['', '永不过期']];

/** Personal access tokens of the signed-in account (never another workspace's). */
export function ApiTokensPanel({ notify }: { notify: (message: string) => void }) {
  const [tokens, setTokens] = useState<ApiTokenSummary[] | null>(null);
  const [name, setName] = useState(''), [scope, setScope] = useState<ApiTokenScope>('read'), [expiry, setExpiry] = useState('90');
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setTokens(await api.tokens.list()); } catch (e) { setError(e instanceof Error ? e.message : '加载失败'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api.tokens.create({ name: name.trim(), scope, expiresInDays: expiry ? Number(expiry) : null });
      setCreated({ name: result.token.name, secret: result.secret }); setName(''); await load();
    } catch (e) { setError(e instanceof Error ? e.message : '创建失败'); } finally { setBusy(false); }
  }
  async function revoke(token: ApiTokenSummary) {
    if (!confirm(`吊销令牌“${token.name}”？使用它的脚本会立即失去访问权限。`)) return;
    setError('');
    try { await api.tokens.revoke(token.id); notify('令牌已吊销'); await load(); } catch (e) { setError(e instanceof Error ? e.message : '吊销失败'); }
  }
  const now = Date.now();
  return <section className="panel settings-form api-tokens" aria-label="访问令牌">
    <div className="panel-heading"><h2>访问令牌</h2><KeySquare size={19} /></div>
    <p className="muted">让脚本或 AI Agent 以你的身份调用 API，请求头写 <code>Authorization: Bearer 令牌</code>。令牌只能访问你自己的工作台，不能管理备份、账号或其他令牌。修改密码、停用或删除账号会吊销全部令牌。</p>
    <form className="api-token-form" onSubmit={create} aria-label="创建访问令牌">
      <label className="field"><span>令牌名称</span><input required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="例如：每日备份脚本" /></label>
      <label className="field"><span>权限</span><select value={scope} onChange={e => setScope(e.target.value as ApiTokenScope)}><option value="read">只读（read）</option><option value="write">读写（write）</option></select></label>
      <label className="field"><span>有效期</span><select value={expiry} onChange={e => setExpiry(e.target.value)}>{expiryOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button className="button primary" disabled={busy || !name.trim()}>创建令牌</button>
    </form>
    {created && <div className="api-token-created" role="status">
      <strong>已创建“{created.name}”。请立即复制保存，关闭后无法再次查看。</strong>
      <div className="copy-row"><input readOnly aria-label="新令牌" value={created.secret} onFocus={e => e.target.select()} spellCheck={false} /><button type="button" className="button primary" onClick={() => void copyText(created.secret).then(() => notify('令牌已复制')).catch(() => setError('无法访问剪贴板，请选中令牌后手动复制。'))}><Copy size={15} />复制</button></div>
      <button type="button" className="button small" onClick={() => setCreated(null)}>我已保存</button>
    </div>}
    {error && <p className="error-note" role="alert">{error}</p>}
    {tokens === null ? <p className="muted">正在加载令牌…</p> : tokens.length ? <ul className="api-token-list">{tokens.map(token => {
      const expired = !!token.expiresAt && Date.parse(token.expiresAt) <= now;
      return <li key={token.id} className="api-token-row" aria-label={`令牌 ${token.name}`}>
        <div className="api-token-main">
          <strong>{token.name}</strong>
          <span className="inline"><code>{token.prefix}…</code><span className={`badge ${token.scope === 'write' ? '' : 'good'}`}>{token.scope === 'write' ? '读写' : '只读'}</span>{expired && <span className="badge bad">已过期</span>}</span>
          <small>创建于 <span title={absoluteTime(token.createdAt)}>{relativeTime(token.createdAt, now)}</span> · {token.expiresAt ? <>{expired ? '过期于' : '有效至'} <span title={absoluteTime(token.expiresAt)}>{absoluteTime(token.expiresAt).slice(0, 10)}</span></> : '永不过期'} · {token.lastUsedAt ? <>最近使用 <span title={absoluteTime(token.lastUsedAt)}>{relativeTime(token.lastUsedAt, now)}</span></> : '尚未使用'}</small>
        </div>
        <button type="button" className="button small danger" aria-label={`吊销令牌 ${token.name}`} onClick={() => void revoke(token)}><Trash2 size={14} />吊销</button>
      </li>;
    })}</ul> : <p className="muted">还没有令牌。</p>}
    <p className="hint">接口文档（OpenAPI 3.1）：<a className="text-link" href="/api/openapi.json" target="_blank" rel="noreferrer">/api/openapi.json</a></p>
  </section>;
}
