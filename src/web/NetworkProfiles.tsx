import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Globe2, LoaderCircle, Network, Pencil, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import type { NetworkProfileInput, NetworkProfileSummary } from '../shared/types';
import { forbiddenHeaderReason, NETWORK_LIMITS } from '../shared/network-rules';
import { api } from './api';
import { Modal } from './Modal';

const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试';
const proxyTypes = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' } as const;

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Busy({ label = '处理中' }: { label?: string }) { return <span className="inline"><LoaderCircle size={16} className="spin" />{label}</span>; }
function ErrorNote({ error }: { error?: string }) { return error ? <div className="error-note" role="alert">{error}</div> : null; }

/** One-line description of a profile, for cards and selects. */
export function profileLabel(profile: NetworkProfileSummary): string {
  const parts = [profile.proxy ? `${proxyTypes[profile.proxy.type]} 代理 ${profile.proxy.host}:${profile.proxy.port}` : '直连'];
  if (profile.userAgent) parts.push('自定义 UA');
  if (profile.referer) parts.push('Referer');
  if (profile.headerNames.length) parts.push(`${profile.headerNames.length} 个请求头`);
  return parts.join(' · ');
}

/** Select used by the website editor, the RSS editor, batch import and feed settings. */
export function NetworkProfileSelect({ value, onChange, profiles, disabled, label = '网络配置' }: { value: string; onChange: (id: string) => void; profiles: NetworkProfileSummary[]; disabled?: boolean; label?: string }) {
  const missing = value && !profiles.some(profile => profile.id === value);
  return <Field label={label} hint={profiles.length ? undefined : '需要代理、User-Agent 或请求头时，可先在「设置 → 网络配置」中添加。'}>
    <select aria-label={label} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="">默认网络（直连，无额外请求头）</option>
      {missing && <option value={value}>（已不可用的网络配置）</option>}
      {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} — {profileLabel(profile)}</option>)}
    </select>
  </Field>;
}

export function useNetworkProfiles(onError?: (message: string) => void): NetworkProfileSummary[] {
  const [profiles, setProfiles] = useState<NetworkProfileSummary[]>([]);
  useEffect(() => {
    let live = true;
    void api.networkProfiles.list().then(list => { if (live) setProfiles(list); }).catch(error => { if (live) onError?.(messageOf(error)); });
    return () => { live = false; };
    // Load once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return profiles;
}

type HeaderRow = { name: string; value: string; saved: boolean };

function ProfileForm({ editing, done, cancel }: { editing?: NetworkProfileSummary; done: () => void; cancel: () => void }) {
  const [name, setName] = useState(editing?.name ?? '');
  const [proxyUrl, setProxyUrl] = useState(editing?.proxy?.url ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clearAuth, setClearAuth] = useState(false);
  const [userAgent, setUserAgent] = useState(editing?.userAgent ?? '');
  const [referer, setReferer] = useState(editing?.referer ?? '');
  const [headers, setHeaders] = useState<HeaderRow[]>(editing?.headerNames.map(header => ({ name: header, value: '', saved: true })) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const savedAuth = !!editing?.proxy?.authenticated;
  const proxyChanged = !!editing?.proxy && proxyUrl.trim() !== editing.proxy.url;

  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    for (const header of headers) {
      const reason = header.name.trim() && forbiddenHeaderReason(header.name.trim());
      if (reason) { setError(reason); return; }
    }
    const body: NetworkProfileInput = {
      name,
      proxyUrl: proxyUrl.trim() || null,
      userAgent: userAgent.trim() || null,
      referer: referer.trim() || null,
      headers: headers.filter(header => header.name.trim()).map(header => header.saved && !header.value ? { name: header.name.trim() } : { name: header.name.trim(), value: header.value }),
    };
    if (proxyUrl.trim()) {
      if (username) { body.proxyUsername = username; body.proxyPassword = password; }
      else if (clearAuth || !savedAuth) body.proxyUsername = null;
      // Otherwise omit both: the server keeps the saved login.
    }
    setBusy(true);
    try {
      if (editing) await api.networkProfiles.update(editing.id, body); else await api.networkProfiles.create(body);
      setPassword(''); done();
    } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }

  return <form onSubmit={submit} className="modal-body network-profile-form">
    <p className="muted">保存后可在多个订阅中选用。代理密码和请求头的值加密保存，之后不会再显示。</p>
    <Field label="配置名称"><input required maxLength={NETWORK_LIMITS.name} value={name} onChange={e => setName(e.target.value)} placeholder="例如：日本出口代理" /></Field>
    <Field label="代理地址（可选）" hint="支持 http://、https:// 和 socks5://，例如 socks5://proxy.example.com:1080。代理不能指向内网或本机地址，除非管理员已允许。"><input value={proxyUrl} onChange={e => setProxyUrl(e.target.value)} autoComplete="off" spellCheck={false} placeholder="http://proxy.example.com:8080" /></Field>
    {proxyUrl.trim() && <div className="form-row">
      <Field label="代理用户名" hint={savedAuth && !clearAuth ? (proxyChanged ? '代理地址已更改，请重新填写用户名和密码。' : '已保存认证信息（不显示）。留空保持不变。') : '不需要认证时留空。'}><input value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" maxLength={NETWORK_LIMITS.proxyUser} /></Field>
      <Field label="代理密码"><input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" maxLength={NETWORK_LIMITS.proxyUser} /></Field>
    </div>}
    {proxyUrl.trim() && savedAuth && <label className="checkbox-field"><input type="checkbox" checked={clearAuth} onChange={e => setClearAuth(e.target.checked)} />移除已保存的代理认证</label>}
    <Field label="User-Agent（可选）" hint="网页订阅同时改变浏览器的 navigator.userAgent。"><input value={userAgent} onChange={e => setUserAgent(e.target.value)} maxLength={NETWORK_LIMITS.userAgent} spellCheck={false} placeholder="留空使用默认值" /></Field>
    <Field label="Referer（可选）" hint="打开订阅页面时发送的来源地址。"><input type="url" value={referer} onChange={e => setReferer(e.target.value)} maxLength={NETWORK_LIMITS.referer} placeholder="https://example.com/" /></Field>
    <fieldset className="header-rows">
      <legend>额外请求头（最多 {NETWORK_LIMITS.headers} 个）</legend>
      <p className="hint">只发送给订阅网址所在的网站及其子域名，不会发给第三方资源。不能设置 Host、Cookie、Proxy-*、Connection 等请求头；Cookie 请使用 Cookie 凭据。</p>
      {headers.map((header, index) => <div className="header-row" key={index}>
        <input aria-label={`请求头 ${index + 1} 名称`} value={header.name} disabled={header.saved} maxLength={NETWORK_LIMITS.headerName} spellCheck={false} placeholder="X-Api-Key" onChange={e => setHeaders(headers.map((item, i) => i === index ? { ...item, name: e.target.value } : item))} />
        <input aria-label={`请求头 ${index + 1} 值`} value={header.value} maxLength={NETWORK_LIMITS.headerValue} spellCheck={false} autoComplete="off" placeholder={header.saved ? '已保存（不显示），留空保持不变' : '值'} onChange={e => setHeaders(headers.map((item, i) => i === index ? { ...item, value: e.target.value } : item))} />
        <button type="button" className="icon-button" aria-label={`删除请求头 ${header.name || index + 1}`} onClick={() => setHeaders(headers.filter((_, i) => i !== index))}><X size={16} /></button>
      </div>)}
      {headers.length < NETWORK_LIMITS.headers && <button type="button" className="button small" onClick={() => setHeaders([...headers, { name: '', value: '', saved: false }])}><Plus size={14} />添加请求头</button>}
    </fieldset>
    <ErrorNote error={error} />
    <div className="modal-actions"><button type="button" className="button" onClick={cancel}>取消</button><button className="button primary" disabled={busy}>{busy ? <Busy /> : '保存网络配置'}</button></div>
  </form>;
}

/**
 * Used when no feed uses the profile and it was never tested here. It is the
 * IANA-reserved example domain: neutral (no third-party service or tracking),
 * HTTPS, answers 200 without a redirect, and is stable over years.
 */
export const NEUTRAL_TEST_URL = 'https://example.com/';
const lastTestKey = (id: string) => `feedlantern:network-test:${id}`;

/** The first (oldest) feed using the profile, then the last URL tested in this browser, then the neutral address. */
async function defaultTestUrl(profile: NetworkProfileSummary): Promise<{ url: string; source: string }> {
  if (profile.feedCount > 0) {
    try {
      const feed = (await api.feeds.list()).filter(item => item.networkProfileId === profile.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (feed) return { url: feed.url, source: `订阅“${feed.name}”的来源地址` };
    } catch { /* fall through */ }
  }
  try {
    const saved = localStorage.getItem(lastTestKey(profile.id));
    if (saved) return { url: saved, source: '上次测试的网址' };
  } catch { /* per-browser convenience only */ }
  return { url: NEUTRAL_TEST_URL, source: '通用的连通性检查地址' };
}

function TestForm({ profile, close }: { profile: NetworkProfileSummary; close: () => void }) {
  const [url, setUrl] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  useEffect(() => {
    let current = true;
    // Never replace what the user has started typing.
    void defaultTestUrl(profile).then(found => { if (current) { setUrl(previous => previous || found.url); setSource(found.source); } });
    return () => { current = false; };
  }, [profile]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setResult('');
    try { localStorage.setItem(lastTestKey(profile.id), url); } catch { /* per-browser convenience only */ }
    try { const response = await api.networkProfiles.test(profile.id, url); setResult(`连接成功：目标网站返回 HTTP ${response.status}`); }
    catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="modal-body">
    <p className="muted">用这组网络配置请求一次网址，检查代理是否可达、认证是否正确。不会跟随重定向。</p>
    <Field label="测试网址" hint={source ? `默认填入${source}，可以修改。` : undefined}><input required type="url" value={url} onChange={e => { setUrl(e.target.value); setSource(''); }} placeholder={NEUTRAL_TEST_URL} /></Field>
    <ErrorNote error={error} />{result && <div className="notice" role="status">{result}</div>}
    <div className="modal-actions"><button type="button" className="button" onClick={close}>关闭</button><button className="button primary" disabled={busy}>{busy ? <Busy label="正在测试" /> : '测试连接'}</button></div>
  </form>;
}

export function NetworkProfilesView({ notify }: { notify: (message: string) => void }) {
  const [profiles, setProfiles] = useState<NetworkProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<NetworkProfileSummary | null | undefined>(undefined);
  const [testing, setTesting] = useState<NetworkProfileSummary | null>(null);
  const load = useCallback(async () => { try { setProfiles(await api.networkProfiles.list()); } catch (error) { setError(messageOf(error)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const close = useCallback(() => setEditing(undefined), []);
  async function remove(profile: NetworkProfileSummary) {
    if (!confirm(`删除网络配置“${profile.name}”？`)) return;
    try { await api.networkProfiles.remove(profile.id); notify('网络配置已删除'); await load(); } catch (error) { setError(messageOf(error)); }
  }
  return <section className="panel settings-form credentials-panel" aria-label="网络配置">
    <div className="panel-heading"><h2>网络配置</h2><button className="button small" onClick={() => setEditing(null)}><Plus size={15} />添加网络配置</button></div>
    <p className="muted">为需要指定出口 IP、User-Agent 或 Referer 的网站设置代理和请求头，可在多个订阅间复用。</p>
    <ErrorNote error={error} />
    <div className="info-strip"><ShieldCheck size={18} /><span>代理密码和请求头的值加密保存，不会再显示；代理同样受内网地址拦截限制。</span></div>
    {loading ? <Busy label="正在加载网络配置" /> : profiles.length ? <div className="credential-grid">{profiles.map(profile => <article className="credential-card" key={profile.id} data-testid="network-profile">
      <div className="card-top"><span className="soft-icon"><Network size={21} /></span><div className="inline">
        <button className="icon-button" title="测试连接" aria-label={`测试网络配置 ${profile.name}`} onClick={() => setTesting(profile)}><Globe2 size={16} /></button>
        <button className="icon-button" title="编辑网络配置" aria-label={`编辑网络配置 ${profile.name}`} onClick={() => setEditing(profile)}><Pencil size={16} /></button>
        <button className="icon-button danger" aria-label={`删除网络配置 ${profile.name}`} onClick={() => void remove(profile)}><Trash2 size={16} /></button>
      </div></div>
      <h3>{profile.name}</h3>
      <p className="muted">{profile.proxy ? profile.proxy.url : '直连（不使用代理）'}</p>
      <div className="credential-meta">
        <span>{profileLabel(profile)}</span>
        {profile.proxy && <span>{profile.proxy.authenticated ? '代理认证：已保存' : '代理认证：无'}</span>}
        {profile.headerNames.length > 0 && <span>请求头：{profile.headerNames.join('、')}</span>}
        <span>{profile.feedCount} 个订阅使用</span>
      </div>
    </article>)}</div> : <div className="empty-state"><span className="large-icon"><Network size={30} /></span><h2>还没有网络配置</h2><p>大部分网站不需要。只有网站要求特定出口 IP、User-Agent 或 Referer 时再添加。</p><button className="button" onClick={() => setEditing(null)}><Plus size={16} />添加网络配置</button></div>}
    {editing !== undefined && <Modal title={editing ? '编辑网络配置' : '添加网络配置'} close={close}><ProfileForm editing={editing ?? undefined} cancel={close} done={() => { close(); notify('网络配置已保存'); void load(); }} /></Modal>}
    {testing && <Modal title={`测试：${testing.name}`} close={() => setTesting(null)}><TestForm profile={testing} close={() => setTesting(null)} /></Modal>}
  </section>;
}
