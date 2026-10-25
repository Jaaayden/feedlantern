import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Globe2, LoaderCircle, Network, Pencil, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import type { NetworkProfileInput, NetworkProfileSummary } from '../shared/types';
import { forbiddenHeaderReason, NETWORK_LIMITS } from '../shared/network-rules';
import { api } from './api';
import { Modal } from './Modal';
import { fmt, t, tx } from './i18n';

const messageOf = (error: unknown) => error instanceof Error ? error.message : t('common.notDone');
const proxyTypes = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' } as const;

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Busy({ label }: { label?: string }) { return <span className="inline"><LoaderCircle size={16} className="spin" />{label ?? t('common.busy')}</span>; }
function ErrorNote({ error }: { error?: string }) { return error ? <div className="error-note" role="alert">{error}</div> : null; }

/** One-line description of a profile, for cards and selects. */
export function profileLabel(profile: NetworkProfileSummary): string {
  const parts = [profile.proxy ? t('network.proxyLabel', { type: proxyTypes[profile.proxy.type], address: `${profile.proxy.host}:${profile.proxy.port}` }) : t('network.direct')];
  if (profile.userAgent) parts.push(t('network.customUa'));
  if (profile.referer) parts.push('Referer');
  if (profile.headerNames.length) parts.push(t('network.headerCount', { count: profile.headerNames.length }));
  return parts.join(' · ');
}

/** Select used by the website editor, the RSS editor, batch import and feed settings. */
export function NetworkProfileSelect({ value, onChange, profiles, disabled, label }: { value: string; onChange: (id: string) => void; profiles: NetworkProfileSummary[]; disabled?: boolean; label?: string }) {
  const missing = value && !profiles.some(profile => profile.id === value);
  return <Field label={label ?? t('network.profile')} hint={profiles.length ? undefined : t('network.selectHint')}>
    <select aria-label={label} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="">{t('network.defaultOption')}</option>
      {missing && <option value={value}>{t('network.missingOption')}</option>}
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
      if (reason) { setError(tx(reason)); return; }
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
    <p className="muted">{t('network.formLead')}</p>
    <Field label={t('network.name')}><input required maxLength={NETWORK_LIMITS.name} value={name} onChange={e => setName(e.target.value)} placeholder={t('network.namePlaceholder')} /></Field>
    <Field label={t('network.proxy')} hint={t('network.proxyHint')}><input value={proxyUrl} onChange={e => setProxyUrl(e.target.value)} autoComplete="off" spellCheck={false} placeholder="http://proxy.example.com:8080" /></Field>
    {proxyUrl.trim() && <div className="form-row">
      <Field label={t('label.proxyUsername')} hint={savedAuth && !clearAuth ? (proxyChanged ? t('network.proxyChanged') : t('network.authSaved')) : t('network.authOptional')}><input value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" maxLength={NETWORK_LIMITS.proxyUser} /></Field>
      <Field label={t('label.proxyPassword')}><input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" maxLength={NETWORK_LIMITS.proxyUser} /></Field>
    </div>}
    {proxyUrl.trim() && savedAuth && <label className="checkbox-field"><input type="checkbox" checked={clearAuth} onChange={e => setClearAuth(e.target.checked)} />{t('network.clearAuth')}</label>}
    <Field label={t('network.userAgent')} hint={t('network.userAgentHint')}><input value={userAgent} onChange={e => setUserAgent(e.target.value)} maxLength={NETWORK_LIMITS.userAgent} spellCheck={false} placeholder={t('network.userAgentPlaceholder')} /></Field>
    <Field label={t('network.referer')} hint={t('network.refererHint')}><input type="url" value={referer} onChange={e => setReferer(e.target.value)} maxLength={NETWORK_LIMITS.referer} placeholder="https://example.com/" /></Field>
    <fieldset className="header-rows">
      <legend>{t('network.headers', { max: NETWORK_LIMITS.headers })}</legend>
      <p className="hint">{t('network.headersHint')}</p>
      {headers.map((header, index) => <div className="header-row" key={index}>
        <input aria-label={t('network.headerName', { n: index + 1 })} value={header.name} disabled={header.saved} maxLength={NETWORK_LIMITS.headerName} spellCheck={false} placeholder="X-Api-Key" onChange={e => setHeaders(headers.map((item, i) => i === index ? { ...item, name: e.target.value } : item))} />
        <input aria-label={t('network.headerValue', { n: index + 1 })} value={header.value} maxLength={NETWORK_LIMITS.headerValue} spellCheck={false} autoComplete="off" placeholder={header.saved ? t('network.valueSaved') : t('network.value')} onChange={e => setHeaders(headers.map((item, i) => i === index ? { ...item, value: e.target.value } : item))} />
        <button type="button" className="icon-button" aria-label={t('network.removeHeader', { name: header.name || String(index + 1) })} onClick={() => setHeaders(headers.filter((_, i) => i !== index))}><X size={16} /></button>
      </div>)}
      {headers.length < NETWORK_LIMITS.headers && <button type="button" className="button small" onClick={() => setHeaders([...headers, { name: '', value: '', saved: false }])}><Plus size={14} />{t('network.addHeader')}</button>}
    </fieldset>
    <ErrorNote error={error} />
    <div className="modal-actions"><button type="button" className="button" onClick={cancel}>{t('common.cancel')}</button><button className="button primary" disabled={busy}>{busy ? <Busy /> : t('network.save')}</button></div>
  </form>;
}

/**
 * Used when no feed uses the profile and it was never tested here. A
 * connectivity check endpoint: Cloudflare's global anycast network (usually
 * reachable from mainland China too, unlike gstatic), an empty 204 with no
 * redirect, and the default test URL of Clash, Surge and sing-box for years.
 */
export const NEUTRAL_TEST_URL = 'https://cp.cloudflare.com/generate_204';
const lastTestKey = (id: string) => `feedlantern:network-test:${id}`;

/** The first (oldest) feed using the profile, then the last URL tested in this browser, then the neutral address. */
async function defaultTestUrl(profile: NetworkProfileSummary): Promise<{ url: string; source: string }> {
  if (profile.feedCount > 0) {
    try {
      const feed = (await api.feeds.list()).filter(item => item.networkProfileId === profile.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (feed) return { url: feed.url, source: t('network.sourceFeed', { name: feed.name }) };
    } catch { /* fall through */ }
  }
  try {
    const saved = localStorage.getItem(lastTestKey(profile.id));
    if (saved) return { url: saved, source: t('network.sourceLast') };
  } catch { /* per-browser convenience only */ }
  return { url: NEUTRAL_TEST_URL, source: t('network.sourceNeutral') };
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
    try {
      const { status } = await api.networkProfiles.test(profile.id, url);
      // Any 2xx (a connectivity check answers 204) is a success; other codes mean the path works but the site said no.
      if (status >= 200 && status < 300) setResult(t('network.testOk', { status: String(status) }));
      else setError(t('network.testNot2xx', { status: String(status), hint: t(status >= 300 && status < 400 ? 'network.testRedirect' : 'network.testRejected') }));
    }
    catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="modal-body">
    <p className="muted">{t('network.testLead')}</p>
    <Field label={t('label.testUrl')} hint={source ? t('network.testPrefilled', { source }) : undefined}><input required type="url" value={url} onChange={e => { setUrl(e.target.value); setSource(''); }} placeholder={NEUTRAL_TEST_URL} /></Field>
    <ErrorNote error={error} />{result && <div className="notice" role="status">{result}</div>}
    <div className="modal-actions"><button type="button" className="button" onClick={close}>{t('common.close')}</button><button className="button primary" disabled={busy}>{busy ? <Busy label={t('common.testing')} /> : t('network.test')}</button></div>
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
    if (!confirm(t('network.confirmDelete', { name: profile.name }))) return;
    try { await api.networkProfiles.remove(profile.id); notify(t('network.deleted')); await load(); } catch (error) { setError(messageOf(error)); }
  }
  return <section className="panel settings-form credentials-panel" aria-label={t('network.title')}>
    <div className="panel-heading"><h2>{t('network.title')}</h2><button className="button small" onClick={() => setEditing(null)}><Plus size={15} />{t('network.add')}</button></div>
    <p className="muted">{t('network.lead')}</p>
    <ErrorNote error={error} />
    <div className="info-strip"><ShieldCheck size={18} /><span>{t('network.info')}</span></div>
    {loading ? <Busy label={t('network.loading')} /> : profiles.length ? <div className="credential-grid">{profiles.map(profile => <article className="credential-card" key={profile.id} data-testid="network-profile">
      <div className="card-top"><span className="soft-icon"><Network size={21} /></span><div className="inline">
        <button className="icon-button" title={t('network.test')} aria-label={t('network.testOf', { name: profile.name })} onClick={() => setTesting(profile)}><Globe2 size={16} /></button>
        <button className="icon-button" title={t('network.edit')} aria-label={t('network.editOf', { name: profile.name })} onClick={() => setEditing(profile)}><Pencil size={16} /></button>
        <button className="icon-button danger" aria-label={t('network.deleteOf', { name: profile.name })} onClick={() => void remove(profile)}><Trash2 size={16} /></button>
      </div></div>
      <h3>{profile.name}</h3>
      <p className="muted">{profile.proxy ? profile.proxy.url : t('network.directNoProxy')}</p>
      <div className="credential-meta">
        <span>{profileLabel(profile)}</span>
        {profile.proxy && <span>{profile.proxy.authenticated ? t('network.authYes') : t('network.authNo')}</span>}
        {profile.headerNames.length > 0 && <span>{t('network.headerList', { names: fmt.list(profile.headerNames, 'unit') })}</span>}
        <span>{t('network.usedBy', { count: profile.feedCount })}</span>
      </div>
    </article>)}</div> : <div className="empty-state"><span className="large-icon"><Network size={30} /></span><h2>{t('network.emptyTitle')}</h2><p>{t('network.emptyBody')}</p><button className="button" onClick={() => setEditing(null)}><Plus size={16} />{t('network.add')}</button></div>}
    {editing !== undefined && <Modal title={editing ? t('network.edit') : t('network.add')} close={close}><ProfileForm editing={editing ?? undefined} cancel={close} done={() => { close(); notify(t('network.saved')); void load(); }} /></Modal>}
    {testing && <Modal title={t('network.testTitle', { name: testing.name })} close={() => setTesting(null)}><TestForm profile={testing} close={() => setTesting(null)} /></Modal>}
  </section>;
}
