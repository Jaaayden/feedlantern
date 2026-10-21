import type { UserSummary } from '../shared/types';
import { BarkPanel } from './BarkPanel';
import { UsersPanel } from './UsersPanel';
import { translationEnabled } from '../shared/types';
import { TranslationProgress } from './TranslationProgress';
import { RssEditor, RssContent } from './RssEditor';
import { ApplicationSettingsPanel } from './ApplicationSettingsPanel';
import { BackupPanel } from './BackupPanel';
import { BatchView } from './BatchView';
import { FeedCollection } from './FeedCollection';
import { FetchLogs } from './FetchLogs';
import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Archive, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Check, ChevronDown, CircleHelp, Cookie, Copy, ExternalLink, Globe2, Info, KeyRound, Languages, ListPlus, LoaderCircle, LogOut, Monitor, Moon, MousePointer2, Pencil, Plus, Radio, RefreshCw, Rss, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Sun, Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { absoluteTime, copyText, relativeTime } from './format';
import type { StatusFilter } from './FeedCollection';
import { readTheme, saveTheme, themeLabels } from './theme';
import type { Theme } from './theme';
import { api, onUnauthorized, setCsrfToken, setWorkspaceUser } from './api';
import type { CredentialPayload } from './api';
import type { AuthState, CredentialSummary, DetectionCandidate, DetectionResult, ExtractedItem, Feed, FeedInput, FeedItem, FieldName, Rect, RuleOrigins, ScreenFrame, SelectionRules } from '../shared/types';

type Notify = (message: string) => void;
const fieldLabels: Record<'item' | FieldName, string> = { item: '条目容器', title: '标题', link: '链接', description: '摘要', image: '图片', date: '日期' };
const keys = Object.keys(fieldLabels) as Array<'item' | FieldName>;
const emptyRules: SelectionRules = { item: '', title: '', link: '' };
const rulesSignature = (rules: SelectionRules) => JSON.stringify(keys.map(key => [key, rules[key] ?? '']));
const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试';
const dateLabel = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未更新';
const hostLabel = (url: string) => { try { return new URL(url).host; } catch { return url; } };
function Busy({ label = '处理中' }: { label?: string }) { return <span className="inline"><LoaderCircle size={16} className="spin" />{label}</span>; }
function ErrorNote({ error }: { error?: string }) { return error ? <div className="error-note" role="alert">{error}</div> : null; }
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function Brand({ compact = false }: { compact?: boolean }) { return <div className="brand"><img className="brand-logo" src="/favicon.svg" alt="" width={40} height={40} /><span>FeedLantern{!compact && <small>订阅灯</small>}</span></div>; }

function AuthScreen({ state, authenticated }: { state: AuthState; authenticated: (state: AuthState) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = state.setupRequired ? await api.auth.setup({ username, password, setupToken }) : await api.auth.login({ username, password });
      setPassword(''); setSetupToken(''); authenticated(result);
    } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  return <div className="auth-page"><section className="auth-story"><Brand /><div className="auth-copy"><span className="eyebrow">YOUR WEB, ON YOUR TERMS</span><h1>把值得关注的网页，<br />留在自己的订阅里。</h1><p>输入网址，自动发现内容。<br />不再反复打开网页，看看有没有更新。</p><div className="auth-illustration" aria-hidden="true"><div className="paper paper-back" /><div className="paper"><span className="paper-dot" /><div className="paper-line" /><div className="paper-line short" /><div className="paper-picture" /><div className="paper-line" /><div className="paper-line short" /></div><span className="floating-rss"><Rss size={34} /></span></div></div><div className="auth-footer"><ShieldCheck size={16} /> 本地优先 · 开源 · 自己掌控</div></section><section className="auth-form-panel"><div className="auth-form"><span className="section-kicker">FEEDLANTERN / {state.setupRequired ? 'WELCOME' : 'SIGN IN'}</span><h2>{state.setupRequired ? '点亮你的第一盏订阅灯' : '欢迎回来'}</h2><p className="muted">{state.setupRequired ? '先设置管理员账号，保护你的订阅与网站登录态。' : '登录后，继续管理你的订阅。'}</p><form onSubmit={submit}>
    {state.setupRequired && <Field label="一次性设置码" hint="设置码位于服务数据目录的 setup-token 文件中，默认是 data/setup-token。"><input required type="password" value={setupToken} onChange={e => setSetupToken(e.target.value)} autoComplete="off" placeholder="粘贴本机生成的设置码" /></Field>}
    <Field label="用户名"><input required value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" maxLength={100} /></Field>
    <Field label="密码" hint={state.setupRequired ? '至少 8 个字符。请使用独立的长密码。' : undefined}><input required type="password" minLength={8} maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} autoComplete={state.setupRequired ? 'new-password' : 'current-password'} /></Field>
    <ErrorNote error={error} /><button className="button primary full" disabled={busy}>{busy ? <Busy /> : <>{state.setupRequired ? '创建管理员' : '登录'}<ArrowRight size={17} /></>}</button>
  </form><p className="auth-note"><KeyRound size={14} />{state.setupRequired ? '只有持有本机设置码的人可以创建管理员。' : '普通用户忘记密码请联系管理员；管理员可在服务主机运行 pnpm admin:reset。'}</p>{state.setupRequired && <BackupPanel setup onRestored={() => location.reload()} />}<span className="version">{state.version} · <a href="https://github.com/Jaaayden/feedlantern" target="_blank" rel="noreferrer">GitHub · Jaaayden/feedlantern</a></span></div></section></div>;
}

function ItemPreview({ items, empty = '还没有可预览的条目' }: { items: ExtractedItem[]; empty?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return <div className="empty-preview"><Search size={24} /><p>{empty}</p></div>;
  const shown = expanded ? items : items.slice(0, 20);
  return <><div className="item-list">{shown.map((item, index) => <article className="preview-item" key={`${item.link}-${index}`}><div className="preview-number">{String(index + 1).padStart(2, '0')}</div><div className="preview-text"><a href={item.link} target="_blank" rel="noreferrer">{item.title || '（未匹配到标题）'}<ExternalLink size={13} /></a>{item.description && <p>{item.description}</p>}{item.contentHtml !== undefined && <RssContent title={`订阅正文 ${index + 1}`} html={item.contentHtml} />}{item.translationError && <p className="card-error">{item.translationError}</p>}<div className="item-meta"><span>{hostLabel(item.link)}</span>{item.publishedAt && <time>{dateLabel(item.publishedAt)}{item.publishedAtSource === 'relative' ? '（估算）' : ''}</time>}</div></div>{item.image && <img src={item.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = 'none'; }} />}</article>)}</div>{items.length > 20 && !expanded && <button className="button small show-all" onClick={() => setExpanded(true)}>显示全部 {items.length} 条</button>}</>;
}

function CredentialForm({ editing, done, cancel }: { editing?: CredentialSummary; done: () => void; cancel: () => void }) {
  const [name, setName] = useState(editing?.name ?? '');
  const [url, setUrl] = useState(editing?.url ?? '');
  const [format, setFormat] = useState<'header' | 'json'>(editing?.format ?? 'header');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    const body: CredentialPayload = { name, url, format, value };
    try { if (editing) await api.credentials.update(editing.id, body); else await api.credentials.create(body); setValue(''); done(); } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="modal-body"><p className="muted">从你已登录的浏览器导入 Cookie，供后台访问需要登录的网页。</p><Field label="凭据名称"><input required value={name} onChange={e => setName(e.target.value)} placeholder="例如：我的论坛账号" /></Field><Field label="目标网址" hint="只保留适用于此网站的 Cookie。"><input required type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/articles" /></Field><Field label="导入格式"><select value={format} onChange={e => { setFormat(e.target.value as 'header' | 'json'); setValue(''); }}><option value="header">Cookie 字符串</option><option value="json">OpenCookie / JSON</option></select></Field><Field label="Cookie 内容" hint={editing ? '重新导入会替换这组凭据。现有值不会回显。' : '加密保存，仅用于你选择的订阅。'}><textarea required value={value} onChange={e => setValue(e.target.value)} rows={6} autoComplete="off" spellCheck={false} placeholder={format === 'json' ? '[{"name":"session", "value":"…", "domain":"example.com"}]' : 'session=…; preference=…'} /></Field>{format === 'json' && <Field label="或选择 JSON 文件"><input type="file" accept=".json,application/json" onChange={async e => { const file = e.target.files?.[0]; if (file) { if (file.size > 1024 * 1024) setError('文件不能超过 1 MB'); else setValue(await file.text()); } e.target.value = ''; }} /></Field>}<ErrorNote error={error} /><div className="modal-actions"><button type="button" className="button" onClick={cancel}>取消</button><button className="button primary" disabled={busy}>{busy ? <Busy /> : '保存凭据'}</button></div></form>;
}

function CredentialsView({ notify }: { notify: Notify }) {
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<CredentialSummary | null | undefined>(undefined);
  const load = useCallback(async () => { try { setCredentials(await api.credentials.list()); } catch (error) { setError(messageOf(error)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const close = useCallback(() => setEditing(undefined), []);
  async function remove(item: CredentialSummary) { if (!confirm(`删除凭据“${item.name}”？正在使用的凭据需要先从订阅中解除关联。`)) return; try { await api.credentials.remove(item.id); notify('凭据已删除'); await load(); } catch (error) { setError(messageOf(error)); } }
  return <section className="panel settings-form credentials-panel" aria-label="Cookie 凭据"><div className="panel-heading"><h2>Cookie 凭据</h2><button className="button small" onClick={() => setEditing(null)}><Plus size={15} />添加凭据</button></div><p className="muted">让需要登录的网页，也能成为订阅。</p><ErrorNote error={error} /><div className="info-strip"><ShieldCheck size={18} /><span>凭据加密保存在服务主机中，只有你选择使用它的订阅才会携带对应 Cookie。</span></div>{loading ? <Busy label="正在加载凭据" /> : credentials.length ? <div className="credential-grid">{credentials.map(item => <article className="credential-card" key={item.id}><div className="card-top"><span className="soft-icon"><Cookie size={21} /></span><div className="inline"><button className="icon-button" title="更新凭据" aria-label={`更新凭据 ${item.name}`} onClick={() => setEditing(item)}><Pencil size={16} /></button><button className="icon-button danger" aria-label={`删除凭据 ${item.name}`} onClick={() => void remove(item)}><Trash2 size={16} /></button></div></div><h3>{item.name}</h3><p className="muted">{item.domains.join(' · ')}</p><div className="credential-meta"><span>{item.count} 个 Cookie</span><span>更新于 {dateLabel(item.updatedAt)}</span><span>{item.expiresAt ? `最早到期：${dateLabel(item.expiresAt)}` : '会话 Cookie / 未提供到期时间'}</span></div></article>)}</div> : <div className="empty-state"><span className="large-icon"><Cookie size={30} /></span><h2>连接需要登录的网站</h2><p>从浏览器复制 Cookie，或导入 OpenCookie 导出的 JSON。</p><button className="button" onClick={() => setEditing(null)}><Plus size={16} />添加第一组凭据</button></div>}{editing !== undefined && <Modal title={editing ? '更新 Cookie 凭据' : '添加 Cookie 凭据'} close={close}><CredentialForm editing={editing ?? undefined} cancel={close} done={() => { close(); notify('凭据已保存'); void load(); }} /></Modal>}</section>;
}

function FeedEditor({ source: initialSource, ...props }: { initial?: Feed; source?: 'website' | 'rss'; saved: (id: string) => void; cancel: () => void }) {
  const [source, setSource] = useState<'website' | 'rss'>(props.initial?.sourceType ?? initialSource ?? 'website');
  return <>{!props.initial && <div className="detail-actions" aria-label="订阅来源类型"><button className="button" aria-pressed={source === 'website'} onClick={() => setSource('website')}>网页生成 RSS</button><button className="button" aria-pressed={source === 'rss'} onClick={() => setSource('rss')}>RSS 翻译</button></div>}{source === 'rss' ? <RssEditor {...props} /> : <Editor {...props} />}</>;
}

export function Editor({ initial, draft, submitFeed, saved, cancel }: { initial?: Feed; draft?: FeedInput; submitFeed?: (input: FeedInput) => Promise<{ feed: Feed }>; saved: (id: string) => void; cancel: () => void }) {
  const [url, setUrl] = useState(initial?.url ?? draft?.url ?? '');
  const [credentialId, setCredentialId] = useState(initial?.credentialId ?? draft?.credentialId ?? '');
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [name, setName] = useState(initial?.name ?? draft?.name ?? '');
  const [intervalMinutes, setIntervalMinutes] = useState(initial?.intervalMinutes ?? draft?.intervalMinutes ?? 60);
  const [waitMs, setWaitMs] = useState(initial?.waitMs ?? 1000);
  const [waitForSelector, setWaitForSelector] = useState(initial?.waitForSelector ?? '');
  const [frame, setFrame] = useState<ScreenFrame | null>(null);
  const [sourceKey, setSourceKey] = useState('');
  const [rules, setRules] = useState<SelectionRules>(initial?.rules ?? emptyRules);
  const [origins, setOrigins] = useState<RuleOrigins>(initial?.ruleOrigins ?? (initial ? Object.fromEntries(keys.map(key => [key, 'manual'])) : {}));
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [candidateId, setCandidateId] = useState('');
  const [items, setItems] = useState<ExtractedItem[]>([]);
  const [previewSignature, setPreviewSignature] = useState('');
  const [rects, setRects] = useState<Rect[]>([]);
  const [adjusting, setAdjusting] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [target, setTarget] = useState<'item' | FieldName>('item');
  const [ancestorLevel, setAncestorLevel] = useState(-1);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const sessionRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const previewSeq = useRef(0);
  const imageRef = useRef<HTMLImageElement>(null);
  const currentKey = JSON.stringify([url, credentialId, waitMs, waitForSelector]);
  const sourceUnchanged = sourceKey === currentKey;
  useEffect(() => {
    mountedRef.current = true;
    void api.credentials.list().then(setCredentials).catch(error => setError(messageOf(error)));
    const close = () => {
      const id = sessionRef.current;
      sessionRef.current = null;
      previewSeq.current++;
      if (id) void api.browser.close(id).catch(() => {});
    };
    window.addEventListener('pagehide', close);
    return () => { mountedRef.current = false; window.removeEventListener('pagehide', close); close(); };
  }, []);

  async function preview(nextRules: SelectionRules, id = sessionRef.current) {
    const seq = ++previewSeq.current;
    const signature = rulesSignature(nextRules);
    // Invalidate the previous preview before the asynchronous request starts.
    // This prevents a fast click on “save” from persisting new rules together
    // with items extracted using the previous rules.
    setItems([]);
    setPreviewSignature('');
    if (!id || !nextRules.item || !nextRules.title || !nextRules.link) return;
    try {
      const result = await api.browser.preview(id, nextRules);
      if (seq === previewSeq.current) {
        setItems(result.items);
        setPreviewSignature(signature);
        setError('');
      }
    } catch (error) {
      if (seq === previewSeq.current) {
        setItems([]);
        setPreviewSignature('');
        setError(messageOf(error));
      }
    }
  }
  async function applyCandidate(candidate: DetectionCandidate, replaceManual = false, id = sessionRef.current) {
    let next = { ...candidate.rules };
    const nextOrigins: RuleOrigins = Object.fromEntries(keys.map(key => [key, 'auto']));
    if (!replaceManual) for (const key of keys) if (origins[key] === 'manual') { next[key] = rules[key] ?? ''; nextOrigins[key] = 'manual'; }
    if (origins.item === 'manual' && !replaceManual) {
      // Field selectors belong to their container. A new automatic container
      // must not be mixed with a previously hand-picked container.
      next = { ...rules };
      for (const key of keys) nextOrigins[key] = origins[key] ?? 'manual';
      setNote('已保留手动选择的条目容器和字段。若要使用新候选，请选择“替换全部匹配”。');
    } else setNote(candidate.warnings.join('；'));
    setRules(next); setOrigins(nextOrigins); setCandidateId(candidate.id); setRects(candidate.rects); await preview(next, id);
  }
  async function detect(id: string) {
    const result = await api.browser.detect(id); setDetection(result);
    const recommended = result.candidates.find(item => item.id === result.recommendedId);
    if (recommended) await applyCandidate(recommended, false, id);
    else if (result.candidates.length === 1) { await applyCandidate(result.candidates[0], false, id); setNote('已找到一个候选列表，请检查预览后保存。'); }
    else { setNote(result.warnings.join('；') || '发现多个可能的内容列表，请选择你想关注的一组。'); if (!initial) { setItems([]); setCandidateId(''); } }
    if (!result.candidates.length) setAdjusting(true);
  }
  async function open(event?: FormEvent) {
    event?.preventDefault(); setError(''); setNote(''); setBusy('正在打开网页并分析内容');
    try {
      if (sessionRef.current) { await api.browser.close(sessionRef.current).catch(() => {}); sessionRef.current = null; }
      const result = await api.browser.open({ url, credentialId: credentialId || null, waitMs, waitForSelector: waitForSelector || undefined });
      if (!mountedRef.current) { await api.browser.close(result.sessionId).catch(() => {}); return; }
      sessionRef.current = result.sessionId; setFrame(result); setSourceKey(currentKey); setRects([]);
      if (!name) setName(result.title || hostLabel(url));
      if (initial) { await preview(rules, result.sessionId); setNote('已载入保存的匹配规则。需要时可以重新识别。'); }
      else await detect(result.sessionId);
    } catch (error) { setFrame(null); setError(messageOf(error)); } finally { setBusy(''); }
  }
  async function rescan() { if (!frame) return; setBusy('正在重新识别'); setError(''); try { await detect(frame.sessionId); } catch (error) { setError(messageOf(error)); } finally { setBusy(''); } }
  useEffect(() => {
    if (!frame || busy || !sourceUnchanged) return;
    const timer = setTimeout(() => void preview(rules, frame.sessionId), 450);
    return () => clearTimeout(timer);
    // Preview only tracks edits; action handlers explicitly refresh on new frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules, frame?.sessionId]);
  function changeRule(key: 'item' | FieldName, value: string) {
    // A manual edit invalidates both the visible items and any in-flight
    // preview. The save action also checks the signature below, so it cannot
    // combine a new selector with items from the previous selector set.
    previewSeq.current += 1;
    setItems([]);
    setPreviewSignature('');
    setRules(previous => ({ ...previous, [key]: value }));
    setOrigins(previous => ({ ...previous, [key]: 'manual' }));
    if (key === 'item') setNote('条目容器已更改，请检查其余字段是否仍匹配。');
  }
  async function frameAction(operation: () => Promise<ScreenFrame>) {
    setBusy('正在更新网页'); setError('');
    try { const result = await operation(); setFrame(result); setRects([]); } catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  async function clickImage(event: React.MouseEvent<HTMLImageElement>) {
    if (!frame || busy) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * frame.width / bounds.width;
    const y = (event.clientY - bounds.top) * frame.height / bounds.height;
    if (browsing) {
      setBusy('正在浏览'); setError('');
      try { const result = await api.browser.click(frame.sessionId, x, y); setFrame(result); setRects([]); setItems([]); setPreviewSignature(''); setSourceKey(''); setNote('浏览操作未被记录。请将目标列表的直接网址填入上方，再打开并识别后保存。'); }
      catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
      return;
    }
    setBusy('正在定位内容'); setError('');
    try { const picked = await api.browser.pick(frame.sessionId, { x, y, target, itemSelector: rules.item || undefined, ancestorLevel: ancestorLevel < 0 ? undefined : ancestorLevel }); changeRule(target, picked.selector); setRects(picked.rects); setNote(`${fieldLabels[target]}匹配 ${picked.count} 项。${picked.warning ?? ''}${picked.datePreview ? ` ${picked.datePreview.dateText} → ${dateLabel(picked.datePreview.publishedAt)}${picked.datePreview.publishedAtSource === 'relative' ? '（估算）' : ''}` : ''}`); await preview({ ...rules, [target]: picked.selector }, frame.sessionId); }
    catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!sourceUnchanged || !items.length || previewSignature !== rulesSignature(rules)) {
      if (sourceUnchanged && rulesSignature(rules) !== previewSignature) setNote('匹配规则正在重新预览，请稍候再保存。');
      return;
    }
    setBusy('正在保存订阅'); setError('');
    try { const body: FeedInput = { name, url, credentialId: credentialId || null, rules, ruleOrigins: origins, intervalMinutes, waitMs, waitForSelector: waitForSelector || undefined }; const result = submitFeed ? await submitFeed(body) : initial ? await api.feeds.update(initial.id, body) : await api.feeds.create(body); saved(result.feed.id); }
    catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  const chosen = detection?.candidates.find(item => item.id === candidateId);
  return <><button className="back-link" onClick={cancel}><ArrowLeft size={16} />返回订阅</button><div className="page-heading"><div><span className="section-kicker">A NEW WAY TO FOLLOW</span><h1>{initial ? '编辑匹配规则' : '让网页成为订阅'}</h1><p>我们先找到内容，你只需确认值得关注。</p></div><span className="step-label">{frame ? '02 / 预览与保存' : '01 / 连接网页'}</span></div>
    <form className="source-panel" onSubmit={open}><div className="source-row"><Field label="源网址"><div className="input-icon"><Globe2 size={18} /><input required type="url" placeholder="https://example.com/articles" value={url} onChange={e => setUrl(e.target.value)} /></div></Field><Field label="Cookie 凭据" hint={credentials.length ? undefined : '需要登录的网页，可先在「设置 → Cookie 凭据」中添加。'}><select value={credentialId} onChange={e => setCredentialId(e.target.value)}><option value="">公开网页，无需 Cookie</option>{credentials.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><button className="button primary source-submit" disabled={!!busy}>{busy ? <Busy label="处理中" /> : <><Sparkles size={17} />打开并自动识别</>}</button></div><details className="advanced"><summary>加载设置<ChevronDown size={14} /></summary><div className="form-row"><Field label="额外等待时间（毫秒）"><input type="number" min={0} max={10000} step={100} value={waitMs} onChange={e => setWaitMs(Number(e.target.value))} /></Field><Field label="等待元素（可选）"><input value={waitForSelector} onChange={e => setWaitForSelector(e.target.value)} placeholder="CSS 选择器，例如 .article-list" /></Field></div></details></form>
    <ErrorNote error={error} />{busy && <div className="progress-strip" role="status"><Busy label={busy} /></div>}
    {!frame && !busy && <div className="editor-welcome"><div className="welcome-step"><span>01</span><Globe2 size={23} /><h3>打开网页</h3><p>支持动态内容与 Cookie 登录态</p></div><div className="welcome-step"><span>02</span><Sparkles size={23} /><h3>自动识别</h3><p>找到列表，匹配标题、图片与摘要</p></div><div className="welcome-step"><span>03</span><Rss size={23} /><h3>持续关注</h3><p>复制 RSS 地址到你喜欢的阅读器</p></div></div>}
    {frame && <><div className="result-toolbar"><div><span className={`badge ${chosen?.confidence === 'high' ? 'good' : ''}`}><Sparkles size={13} />{chosen?.confidence === 'high' ? '已自动匹配' : '匹配结果'}</span><span className="muted">{items.length} 条内容</span></div><div className="inline"><button type="button" className="button small" onClick={() => void rescan()} disabled={!!busy}><RefreshCw size={14} />重新识别</button><button type="button" className="button small" disabled={!!busy} onClick={() => setAdjusting(!adjusting)}><MousePointer2 size={14} />{adjusting ? '收起调整' : '调整匹配'}</button></div></div>{note && <div className="notice"><CircleHelp size={16} /><span>{note}</span></div>}{!sourceUnchanged && <div className="notice">网址或加载设置已变化，请重新打开网页后保存。</div>}
    {!!detection?.candidates.length && (detection.candidates.length > 1 || !candidateId) && <div className="candidate-grid">{detection.candidates.map(candidate => <button key={candidate.id} className={`candidate ${candidate.id === candidateId ? 'selected' : ''}`} disabled={!!busy} onClick={() => void applyCandidate(candidate)}><span className="inline"><Radio size={15} />{candidate.label}<span className="muted">{candidate.count} 条</span></span><strong>{candidate.items[0]?.title ?? '查看候选内容'}</strong><small>{candidate.confidence === 'high' ? '匹配明确' : '请检查样例'}</small></button>)}</div>}
    {adjusting && <section className="adjust-panel"><div className="adjust-heading"><h2>在网页上调整匹配</h2><div className="inline"><button className={`button small ${browsing ? 'active' : ''}`} onClick={() => setBrowsing(!browsing)}>{browsing ? '浏览模式' : '选择模式'}</button><button className="icon-button" aria-label="向上滚动网页" disabled={!!busy} onClick={() => void frameAction(() => api.browser.scroll(frame.sessionId, -500))}><ArrowUp size={17} /></button><button className="icon-button" aria-label="向下滚动网页" disabled={!!busy} onClick={() => void frameAction(() => api.browser.scroll(frame.sessionId, 500))}><ArrowDown size={17} /></button><button className="icon-button" aria-label="更新网页画面" disabled={!!busy} onClick={() => void frameAction(() => api.browser.frame(frame.sessionId))}><RefreshCw size={16} /></button></div></div><div className="field-tabs">{keys.map(key => <button className={target === key ? 'selected' : ''} key={key} onClick={() => { setTarget(key); setBrowsing(false); }}>{fieldLabels[key]}{rules[key] && <Check size={12} />}</button>)}<label className="ancestor">父级层数<select value={ancestorLevel} onChange={e => setAncestorLevel(Number(e.target.value))}>{[-1, 0, 1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n < 0 ? "自动" : n}</option>)}</select></label></div><p className="hint">{browsing ? '点击会与目标网页交互。浏览操作不保存为抓取步骤。' : `点击网页中的${fieldLabels[target]}，选择模式不会触发网页链接。`}</p><div className="browser-bar"><span /><span /><span /><code>{frame.url}</code></div><div className={`browser-screen ${browsing ? 'browse' : ''}`}><img ref={imageRef} src={frame.image} alt="目标网页预览" onClick={event => void clickImage(event)} draggable={false} />{rects.map((rect, index) => <span className="selection-rect" key={index} style={{ left: `${rect.x / frame.width * 100}%`, top: `${rect.y / frame.height * 100}%`, width: `${rect.width / frame.width * 100}%`, height: `${rect.height / frame.height * 100}%` }} />)}</div><details className="advanced"><summary>高级：编辑匹配规则<ChevronDown size={14} /></summary><div className="selector-grid">{keys.map(key => <Field key={key} label={`${fieldLabels[key]}选择器`} hint={origins[key] === 'manual' ? '手动配置 · 重新识别时保留' : '自动配置'}><input value={rules[key] ?? ''} onChange={e => changeRule(key, e.target.value)} placeholder={key === 'item' ? 'article' : key === 'title' || key === 'link' ? 'h2 a' : '可留空'} spellCheck={false} /></Field>)}</div>{chosen && <button type="button" className="button small" onClick={() => { if (confirm('使用此候选替换全部匹配规则，包括你手动修改的字段？')) void applyCandidate(chosen, true); }}>替换全部匹配</button>}</details></section>}
    <div className="editor-results"><section className="panel"><div className="panel-heading"><h2>订阅预览</h2><span className="muted">与后台抓取使用相同规则</span></div><ItemPreview items={items} empty={detection?.candidates.length ? '选择候选列表，或调整匹配以查看内容' : '没有找到可靠列表，可以手动点选条目与字段'} /></section><form className="save-panel panel" onSubmit={save}><div className="panel-heading"><h2>保存订阅</h2><Rss size={18} /></div><Field label="订阅名称"><input required value={name} onChange={e => setName(e.target.value)} /></Field><Field label="刷新间隔（分钟）"><input type="number" required min={5} max={1440} value={intervalMinutes} onChange={e => setIntervalMinutes(Number(e.target.value))} /></Field><p className="hint">保存后会在后台定时更新。页面关闭不影响运行中的服务。</p><button className="button primary full" disabled={!!busy || !items.length || !sourceUnchanged || previewSignature !== rulesSignature(rules)}>{busy === '正在保存订阅' ? <Busy /> : <><Check size={16} />保存订阅</>}</button></form></div></>}
  </>;
}

function FeedAddress({ feedUrl, notify, onError }: { feedUrl: string; notify: Notify; onError: (error: string) => void }) {
  return <Field label="RSS 订阅地址" hint="持有此地址即可读取订阅内容。需要撤销时可在订阅设置中轮换密钥。">
    <div className="copy-row"><input readOnly value={feedUrl} onFocus={e => e.target.select()} /><a className="icon-button" href={feedUrl} target="_blank" rel="noreferrer" title="在新标签页打开订阅页" aria-label="在新标签页打开订阅页"><ExternalLink size={16} /></a><button className="button primary" onClick={() => void copyText(feedUrl).then(() => notify('RSS 地址已复制')).catch(() => onError('无法访问剪贴板，请选中地址后手动复制。'))}><Copy size={15} />复制 RSS 地址</button></div>
  </Field>;
}

function FeedStatus({ feed }: { feed: Feed }) {
  return <><div className="detail-status"><span>每 {feed.intervalMinutes} 分钟刷新</span><span title={absoluteTime(feed.lastSuccessAt)}>最近成功：{feed.lastSuccessAt ? relativeTime(feed.lastSuccessAt) : '尚未更新'}</span><span title={feed.enabled ? absoluteTime(feed.nextFetchAt) : undefined}>{feed.enabled ? `下次检查：${feed.nextFetchAt ? relativeTime(feed.nextFetchAt) : '尚未安排'}` : '已暂停自动刷新'}</span></div><ErrorNote error={feed.lastError ?? undefined} />{feed.translation && <p role="status" className="translation-summary">翻译：{feed.translation.success} 条完成 · {feed.translation.pending} 条等待 · {feed.translation.failed} 条失败</p>}</>;
}

type PanelTab = 'items' | 'logs' | 'settings';
const panelTabs: Array<[PanelTab, string]> = [['items', '订阅内容'], ['logs', '抓取日志'], ['settings', '订阅设置']];
type FeedDetailData = { feed: Feed; items: FeedItem[]; feedUrl: string };

// One panel for everything about a feed: the address and status stay on top,
// content, fetch logs and settings are tabs underneath.
function FeedPanel({ id, tab, onTab, close, edit, changed, notify }: { id: string; tab: PanelTab; onTab: (tab: PanelTab) => void; close: () => void; edit: (feed: Feed) => void; changed: () => void; notify: Notify }) {
  const [revision, setRevision] = useState(0);
  const [detail, setDetail] = useState<FeedDetailData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const dirty = useRef(false);
  const load = useCallback(async () => { setDetail(await api.feeds.detail(id)); }, [id]);
  useEffect(() => { void load().catch(error => setError(messageOf(error))); }, [load]);
  useEffect(() => {
    if ((!detail || !translationEnabled(detail.feed)) || !detail.feed.enabled || (detail.feed.lastSuccessAt || detail.feed.lastError) && !detail.feed.translation?.pending) return;
    const timer = window.setInterval(() => { void load().catch(e => setError(messageOf(e))); }, 3000);
    return () => window.clearInterval(timer);
  }, [detail?.feed.sourceType, detail?.feed.enabled, detail?.feed.lastFetchedAt, detail?.feed.lastSuccessAt, detail?.feed.lastError, detail?.feed.translation?.pending, load]);
  function guard(next: () => void) {
    if (busy) return;
    if (!dirty.current || confirm('有未保存的设置，确定放弃修改？')) { dirty.current = false; next(); }
  }
  async function refresh() {
    setBusy('刷新'); setError('');
    try { await api.feeds.refresh(id); await load(); setRevision(v => v + 1); changed(); }
    catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  const feed = detail?.feed;
  return <Modal title={feed?.name ?? '订阅详情'} close={() => guard(close)} wide><div className="modal-body feed-panel">
    <ErrorNote error={error} />{!detail || !feed ? !error && <Busy label="正在加载订阅" /> : <>
      <div className="feed-panel-head">
        <div className="feed-panel-source"><div className="detail-source"><Globe2 size={16} /><a href={feed.url} target="_blank" rel="noreferrer">{feed.url}</a></div><button className="button small" disabled={!!busy} onClick={() => void refresh()}><RefreshCw size={14} className={busy === '刷新' ? 'spin' : undefined} />{busy === '刷新' ? '正在刷新' : '立即刷新'}</button></div>
        <FeedAddress feedUrl={detail.feedUrl} notify={notify} onError={setError} />
        <FeedStatus feed={feed} />
      </div>
      <div className="detail-actions feed-tabs" aria-label="详情内容">{panelTabs.map(([key, label]) => <button key={key} className="button small" aria-pressed={tab === key} onClick={() => { if (tab !== key) guard(() => onTab(key)); }}>{label}</button>)}</div>
      {tab === 'items' && <>
        {translationEnabled(feed) && <TranslationProgress id={id} enabled={feed.enabled} />}
        {translationEnabled(feed) && <button className="button small retry-translation" disabled={!!busy || !feed.enabled} onClick={() => { setBusy('重试翻译'); void api.feeds.retryTranslation(id).then(load).catch(e => setError(messageOf(e))).finally(() => setBusy('')); }}>重试未完成翻译</button>}
        <ItemPreview items={detail.items} />
      </>}
      {tab === 'logs' && <FetchLogs id={id} revision={revision} />}
      {tab === 'settings' && <FeedSettingsTab feed={feed} busy={busy} setBusy={setBusy} setError={setError} dirty={dirty} reload={load} saved={result => setDetail(previous => previous && { ...previous, ...result })} changed={changed} notify={notify} edit={() => guard(() => edit(feed))} removed={close} />}
    </>}
  </div></Modal>;
}

function FeedSettingsTab({ feed, busy, setBusy, setError, dirty, reload, saved, changed, notify, edit, removed }: {
  feed: Feed; busy: string; setBusy: (value: string) => void; setError: (value: string) => void; dirty: React.MutableRefObject<boolean>;
  reload: () => Promise<void>; saved: (result: { feed: Feed; feedUrl: string }) => void; changed: () => void; notify: Notify; edit: () => void; removed: () => void;
}) {
  const [title, setTitle] = useState(feed.name);
  const [interval, setIntervalValue] = useState(String(feed.intervalMinutes));
  const [mode, setMode] = useState<'original' | 'chinese' | 'bilingual'>(feed.translationMode ?? 'bilingual');
  const isDirty = title !== feed.name || interval !== String(feed.intervalMinutes) || mode !== (feed.translationMode ?? 'bilingual');
  dirty.current = isDirty;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim()) { setError('请输入订阅名称'); return; }
    const minutes = Number(interval);
    if (!interval || !Number.isInteger(minutes) || minutes < 5 || minutes > 1440) { setError('刷新间隔必须是 5 到 1440 之间的整数'); return; }
    setBusy('保存设置'); setError('');
    try {
      const result = await api.feeds.settings(feed.id, {
        ...(mode !== feed.translationMode ? { translationMode: mode } : {}),
        ...(title !== feed.name ? { channelTitle: title } : {}),
        ...(interval !== String(feed.intervalMinutes) ? { intervalMinutes: minutes } : {}),
      });
      saved(result); setTitle(result.feed.name); setIntervalValue(String(result.feed.intervalMinutes)); setMode(result.feed.translationMode ?? 'bilingual');
      changed(); notify('订阅设置已保存');
    } catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  async function action(label: string, fn: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(label); setError('');
    try { await fn(); await reload(); changed(); notify(success); }
    catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  async function remove() {
    if (busy || !confirm('删除此订阅及其历史条目？')) return;
    setBusy('删除订阅'); setError('');
    try { await api.feeds.remove(feed.id); dirty.current = false; changed(); notify('订阅已删除'); removed(); }
    catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  return <div className="feed-settings">
    <form onSubmit={save} className="feed-settings-form">
      <Field label="订阅名称" hint="同步更新订阅列表和 RSS 频道标题，订阅地址保持不变。"><input required maxLength={200} disabled={!!busy} value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <div className="form-row">
        <Field label="刷新间隔（分钟）" hint="支持 5–1440 分钟。修改后从保存时重新计时，不会立即抓取；已暂停的订阅继续保持暂停。"><input type="number" required min={5} max={1440} step={1} disabled={!!busy} value={interval} onChange={e => setIntervalValue(e.target.value)} /></Field>
        <Field label="输出模式" hint="开启翻译后，仅发布翻译完成的标题和已抓取内容；不会额外抓取文章全文。"><select aria-label="输出模式" disabled={!!busy} value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="original">原文（不翻译）</option><option value="bilingual">双语（中文在前）</option><option value="chinese">仅中文</option></select></Field>
      </div>
      <button className="button primary" disabled={!!busy || !isDirty}>{busy === '保存设置' ? <Busy label="正在保存" /> : '保存设置'}</button>
    </form>
    <section className="feed-settings-section" aria-label="更新与匹配">
      <div><h3>更新与匹配</h3><p className="hint">暂停后不再自动刷新，随时可以恢复。</p></div>
      <div className="detail-actions"><button className="button small" disabled={!!busy} onClick={() => void action('切换状态', () => api.feeds.toggle(feed.id), feed.enabled ? '订阅已暂停' : '订阅已恢复')}>{feed.enabled ? '暂停订阅' : '恢复订阅'}</button><button className="button small" disabled={!!busy} onClick={edit}><Pencil size={14} />{feed.sourceType === 'rss' ? '编辑 RSS 来源' : '编辑匹配规则'}</button></div>
    </section>
    <section className="feed-settings-section danger-zone" aria-label="订阅地址与删除">
      <div><h3>订阅地址与删除</h3><p className="hint">轮换密钥会立即使旧 RSS 地址失效；删除订阅会同时删除历史条目。</p></div>
      <div className="detail-actions"><button className="button small" disabled={!!busy} onClick={() => { if (confirm('轮换后，旧 RSS 地址将立即失效。继续？')) void action('轮换密钥', () => api.feeds.rotate(feed.id), '订阅地址已更新'); }}><KeyRound size={14} />轮换订阅密钥</button><button className="button small danger" disabled={!!busy} onClick={() => void remove()}><Trash2 size={14} />删除订阅</button></div>
    </section>
    {busy && !['保存设置', '刷新', '重试翻译'].includes(busy) && <Busy label={`正在${busy}`} />}
  </div>;
}

type SettingsSection = { id: string; label: string; icon: typeof Bell };

function SettingsView({ auth, logout, notify, target }: { auth: AuthState; logout: () => void; notify: Notify; target?: UserSummary | null }) {
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const admin = auth.role === 'admin' && !target;
  const sections: SettingsSection[] = [
    ...(admin ? [{ id: 'general', label: '应用设置', icon: SlidersHorizontal }] : []),
    { id: 'notifications', label: '通知', icon: Bell },
    { id: 'credentials', label: 'Cookie 凭据', icon: Cookie },
    ...(!target ? [{ id: 'account', label: '账号与密码', icon: KeyRound }] : []),
    ...(admin ? [{ id: 'backup', label: '备份与迁移', icon: Archive }] : []),
    { id: 'about', label: '关于', icon: Info },
  ];
  const sectionKey = sections.map(section => section.id).join();
  const [active, setActive] = useState(sections[0].id);
  useEffect(() => {
    // Highlight the group currently near the top of the viewport.
    const nodes = sectionKey.split(',').map(id => document.getElementById(`settings-${id}`)).filter((node): node is HTMLElement => !!node);
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActive(visible.target.id.replace('settings-', ''));
    }, { rootMargin: '-90px 0px -55% 0px' });
    nodes.forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [sectionKey]);
  function jump(id: string) { setActive(id); document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  async function submit(event: FormEvent) { event.preventDefault(); if (newPassword !== confirmPassword) { setError('两次输入的新密码不一致'); return; } setBusy(true); setError(''); try { await api.auth.password({ currentPassword, newPassword }); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); notify('密码已修改，请重新登录'); logout(); } catch (error) { setError(messageOf(error)); } finally { setBusy(false); } }
  return <>
    <div className="page-heading"><div><span className="section-kicker">MAKE IT YOURS</span><h1>设置</h1><p>{auth.role === 'admin' ? '管理通知、抓取、网络与个人账号。' : '管理你的个人通知与登录密码。'}</p></div></div>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分组">{sections.map(section => <button key={section.id} className={active === section.id ? 'selected' : ''} aria-current={active === section.id ? 'true' : undefined} onClick={() => jump(section.id)}><section.icon size={16} />{section.label}</button>)}</nav>
      <div className="settings-sections">
        {admin && <div id="settings-general" className="settings-section"><ApplicationSettingsPanel revision={settingsRevision} /></div>}
        <div id="settings-notifications" className="settings-section"><BarkPanel key={settingsRevision} username={target?.username ?? auth.username!} enabled={target?.enabled !== false} /></div>
        <div id="settings-credentials" className="settings-section"><CredentialsView notify={notify} /></div>
        {!target && <div id="settings-account" className="settings-section"><form className="panel settings-form" onSubmit={submit}><div className="panel-heading"><h2>修改密码</h2><KeyRound size={19} /></div><p className="muted">当前用户：{auth.username}。修改后会退出此账号的所有现有会话。</p><Field label="当前密码"><input required type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} autoComplete="current-password" /></Field><div className="form-row"><Field label="新密码"><input required type="password" minLength={8} maxLength={1024} value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" /></Field><Field label="确认新密码"><input required type="password" minLength={8} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" /></Field></div><ErrorNote error={error} /><button className="button primary" disabled={busy}>{busy ? <Busy /> : '更新密码'}</button></form></div>}
        {admin && <div id="settings-backup" className="settings-section"><BackupPanel onRestored={logout} onImported={() => setSettingsRevision(v => v + 1)} /></div>}
        <div id="settings-about" className="settings-section"><section className="panel about-panel"><Brand /><p>自动找到网页上的新内容，汇入你的 RSS 阅读器。</p><div className="about-row"><span>版本</span><code>{auth.version}</code></div><div className="about-row"><span>许可证</span><span>MIT</span></div><a className="text-link" href="https://github.com/Jaaayden/feedlantern" target="_blank" rel="noreferrer">查看开源项目<ExternalLink size={14} /></a><div className="notice">服务主机需要保持运行，定时更新才会继续。支持网页列表订阅与 RSS 翻译；RSS 全文以源内提供的内容为准，不自动补抓全文或翻页。</div></section></div>
      </div>
    </div>
  </>;
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const next: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  return <button className="icon-button theme-toggle" title={`界面主题：${themeLabels[theme]}`} aria-label={`界面主题：${themeLabels[theme]}，点击切换为${themeLabels[next]}`} onClick={() => { saveTheme(next); setTheme(next); }}><Icon size={17} /></button>;
}

type NewSource = 'website' | 'rss';

function NewFeedMenu({ create, batch }: { create: (source: NewSource) => void; batch: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', pointer);
    document.addEventListener('keydown', key);
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => { document.removeEventListener('mousedown', pointer); document.removeEventListener('keydown', key); };
  }, [open]);
  const choose = (fn: () => void) => { setOpen(false); fn(); };
  return <div className="split-button" ref={ref}>
    <button className="button primary" onClick={() => create('website')}><Plus size={17} />新建订阅</button>
    <button className="button primary split-toggle" aria-label="更多新建方式" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDown size={16} /></button>
    {open && <div className="menu" role="menu" aria-label="新建方式">
      <button role="menuitem" onClick={() => choose(() => create('website'))}><span className="menu-icon"><Globe2 size={17} /></span><span><strong>网页生成 RSS</strong><small>打开网页，自动识别内容列表</small></span></button>
      <button role="menuitem" onClick={() => choose(() => create('rss'))}><span className="menu-icon"><Languages size={17} /></span><span><strong>RSS 翻译</strong><small>把英文订阅变成中文或双语</small></span></button>
      <button role="menuitem" onClick={() => choose(batch)}><span className="menu-icon"><ListPlus size={17} /></span><span><strong>批量添加</strong><small>一次粘贴多个网址</small></span></button>
    </div>}
  </div>;
}

type Page = 'feeds' | 'settings' | 'batch' | 'users';
type Route = { page: Page; panel: { id: string; tab: PanelTab } | null; create: NewSource | null };

// Hash routes keep the current screen across reloads and make back/forward work:
// #/ · #/settings · #/users · #/batch · #/new · #/new/rss · #/feed/<id>[/logs|/settings]
function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const empty: Route = { page: 'feeds', panel: null, create: null };
  if (parts[0] === 'settings' || parts[0] === 'users' || parts[0] === 'batch') return { ...empty, page: parts[0] };
  if (parts[0] === 'new') return { ...empty, create: parts[1] === 'rss' ? 'rss' : 'website' };
  if (parts[0] === 'feed' && parts[1]) return { ...empty, panel: { id: parts[1], tab: parts[2] === 'logs' || parts[2] === 'settings' ? parts[2] : 'items' } };
  return empty;
}

function routeHash(route: Route): string {
  if (route.panel) return `#/feed/${encodeURIComponent(route.panel.id)}${route.panel.tab === 'items' ? '' : `/${route.panel.tab}`}`;
  if (route.create) return route.create === 'rss' ? '#/new/rss' : '#/new';
  return route.page === 'feeds' ? '#/' : `#/${route.page}`;
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [bootError, setBootError] = useState('');
  const [page, setPage] = useState<Page>('feeds');
  const [target, setTarget] = useState<UserSummary | null>(null);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [editor, setEditor] = useState<Feed | null | undefined>(undefined);
  const [editorSource, setEditorSource] = useState<NewSource>('website');
  const [panel, setPanel] = useState<{ id: string; tab: PanelTab } | null>(null);
  const [editorReturnId, setEditorReturnId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const notify = useCallback((message: string) => setToast(message), []);
  const authGeneration = useRef(0);
  // Bumped whenever the session is (re)accepted so the feed list always reloads,
  // even when the user stays signed in (e.g. after changing their own identity).
  const [session, setSession] = useState(0);
  const applyRoute = useCallback((route: Route) => {
    setPage(route.page); setPanel(route.panel); setEditorReturnId(null);
    if (route.create) { setEditorSource(route.create); setEditor(null); } else setEditor(undefined);
  }, []);
  const acceptAuth = useCallback((state: AuthState) => { authGeneration.current++; setFeeds([]); setWorkspaceUser(undefined); setTarget(null); setCsrfToken(state.csrfToken); setAuth(state); setSession(value => value + 1); applyRoute(state.authenticated ? parseRoute(location.hash) : parseRoute('')); setQuery(''); setStatus('all'); setError(''); }, [applyRoute]);
  const forgetAuth = useCallback(() => { authGeneration.current++; setWorkspaceUser(undefined); setTarget(null); setCsrfToken(undefined); setAuth(previous => previous ? { ...previous, authenticated: false, csrfToken: undefined } : null); setFeeds([]); setEditor(undefined); setPanel(null); setEditorReturnId(null); }, []);
  useEffect(() => { void api.auth.status().then(acceptAuth).catch(error => setBootError(messageOf(error))); return onUnauthorized(forgetAuth); }, [acceptAuth, forgetAuth]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4000); return () => clearTimeout(timer); }, [toast]);
  const loadFeeds = useCallback(async () => {
    const generation = authGeneration.current; setLoading(true);
    try { const next = await api.feeds.list(); if (generation === authGeneration.current) { setFeeds(next); setError(''); } }
    catch (error) { if (generation === authGeneration.current) setError(messageOf(error)); }
    finally { if (generation === authGeneration.current) setLoading(false); }
  }, []);
  useEffect(() => {
    if (!auth?.authenticated) return;
    void loadFeeds();
    // Poll only while the tab is visible; refresh as soon as it comes back.
    const timer = setInterval(() => { if (!document.hidden) void loadFeeds(); }, 30000);
    const visible = () => { if (!document.hidden) void loadFeeds(); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [auth?.authenticated, session, target?.id, loadFeeds]);
  const changeWorkspace = useCallback((user: UserSummary | null) => {
    authGeneration.current++; setWorkspaceUser(user?.id); setTarget(user); setFeeds([]); setPage('feeds'); setQuery(''); setStatus('all'); setError(''); setEditor(undefined); setPanel(null); setEditorReturnId(null);
  }, []);
  // Keep the address bar in step with the screen; back/forward replays it.
  const authenticated = !!auth?.authenticated;
  const editingExisting = editor !== undefined && editor !== null;
  const currentHash = routeHash({ page, panel, create: editor === null ? editorSource : null });
  const lastHash = useRef(currentHash);
  useEffect(() => {
    if (!authenticated || editingExisting) return;
    if (location.hash !== currentHash && !(currentHash === '#/' && !location.hash)) {
      const panelOf = (hash: string) => hash.startsWith('#/feed/') ? hash.split('/').slice(0, 3).join('/') : '';
      // Closing the panel or switching its tabs replaces the entry so Back is not cluttered.
      const replace = !!panelOf(lastHash.current) && (!panelOf(currentHash) || panelOf(currentHash) === panelOf(lastHash.current));
      if (replace) history.replaceState(null, '', currentHash); else history.pushState(null, '', currentHash);
    }
    lastHash.current = currentHash;
  }, [authenticated, editingExisting, currentHash]);
  useEffect(() => {
    if (!authenticated) return;
    const pop = () => applyRoute(parseRoute(location.hash));
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [authenticated, applyRoute]);
  const crumb = page === 'feeds' ? editor !== undefined ? editor ? editor.sourceType === 'rss' ? '编辑 RSS 翻译' : '编辑匹配规则' : '新建订阅' : '订阅管理' : page === 'batch' ? '批量添加' : page === 'users' ? '用户管理' : '设置';
  useEffect(() => { document.title = authenticated ? `${crumb} · FeedLantern` : 'FeedLantern · 订阅灯'; }, [authenticated, crumb]);
  // "/" jumps to the feed search from anywhere on the dashboard.
  const onDashboard = authenticated && page === 'feeds' && editor === undefined && !panel;
  useEffect(() => {
    if (!onDashboard) return;
    const key = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || element?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault(); searchRef.current?.focus();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onDashboard]);
  const closePanel = useCallback(() => setPanel(null), []);
  async function logout() { try { await api.auth.logout(); forgetAuth(); } catch (error) { notify(messageOf(error)); } }
  if (!auth) return <div className="boot"><Brand />{bootError ? <><ErrorNote error={bootError} /><button className="button" onClick={() => location.reload()}>重新连接</button></> : <Busy label="正在连接服务" />}</div>;
  if (!auth.authenticated) return <><AuthScreen state={auth} authenticated={acceptAuth} />{toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}</>;
  const filtered = feeds.filter(feed => `${feed.name} ${feed.url}`.toLowerCase().includes(query.toLowerCase()));
  const attention = feeds.filter(feed => !!feed.lastError).length;
  function navigate(next: Page) { setPage(next); setEditor(undefined); setPanel(null); setEditorReturnId(null); }
  function create(source: NewSource) { setEditorSource(source); setEditor(null); }
  return <div className="app-layout"><aside className="sidebar"><Brand /><div className="workspace-label">个人工作台</div><nav aria-label="主导航"><button className={page === 'feeds' || page === 'batch' ? 'selected' : ''} onClick={() => navigate('feeds')}><Rss size={19} />订阅管理<span>{feeds.length}</span></button><button className={page === 'settings' ? 'selected' : ''} onClick={() => navigate('settings')}><Settings2 size={19} />设置</button>{auth.role === 'admin' && <button className={page === 'users' ? 'selected' : ''} onClick={() => navigate('users')}><ShieldCheck size={19} />用户管理</button>}</nav><div className="sidebar-bottom"><div className="local-label"><span /> 自托管 · 独立运行</div><div className="account"><span className="avatar">{auth.username?.slice(0, 1).toUpperCase()}</span><div><strong>{auth.username}</strong><small>{auth.role === 'admin' ? '管理员' : '普通用户'}</small></div><button className="icon-button" aria-label="退出登录" onClick={() => void logout()}><LogOut size={17} /></button></div><span className="version">{auth.version}</span></div></aside><div className="main-shell"><header className="topbar"><span><span className="muted">工作台</span><span className="slash">/</span>{crumb}</span><span className="topbar-actions"><ThemeToggle /><span className="topbar-status"><ShieldCheck size={14} /> 已安全登录 <button className="icon-button mobile-logout" aria-label="退出登录" onClick={() => void logout()}><LogOut size={15} /></button></span></span></header><main className="main-content" key={target?.id ?? auth.userId}>
    {target && <div className="workspace-banner" role="status"><div><strong>正在管理：{target.username}</strong><p>{target.enabled ? '修改将作用于此用户的订阅、凭据和个人设置。' : '此用户已停用，可以查看和修改静态配置；执行任务前请先启用。'}</p></div><button className="button small" onClick={() => changeWorkspace(null)}>返回我的工作台</button></div>}
    {page === 'users' && auth.role === 'admin' ? <UsersPanel currentUserId={auth.userId!} manage={changeWorkspace} identityChanged={() => void api.auth.status().then(acceptAuth)} /> : page === 'batch' ? <BatchView notify={notify} changed={() => void loadFeeds()} back={() => navigate('feeds')} /> : page === 'settings' ? <SettingsView target={target} auth={auth} logout={forgetAuth} notify={notify} /> : editor !== undefined ? <FeedEditor key={editor?.id ?? `new-${editorSource}`} initial={editor ?? undefined} source={editorSource} cancel={() => { setEditor(undefined); if (editorReturnId) setPanel({ id: editorReturnId, tab: 'settings' }); setEditorReturnId(null); }} saved={id => { setEditor(undefined); setPanel({ id, tab: editorReturnId ? 'settings' : 'items' }); setEditorReturnId(null); notify('订阅已保存'); void loadFeeds(); }} /> : <>
      <div className="page-heading"><div><span className="section-kicker">LESS CHECKING. MORE READING.</span><h1>你的订阅，持续点亮。</h1><p>把关注的网页汇集在这里，新内容会自动抵达。</p></div><NewFeedMenu create={create} batch={() => navigate('batch')} /></div>
      <div className="stats-row"><div><span>全部订阅</span><strong>{feeds.length}<small>个来源</small></strong></div><div><span>正在关注</span><strong>{feeds.filter(feed => feed.enabled).length}<small>自动更新</small></strong></div><div><span>已收集内容</span><strong>{feeds.reduce((sum, feed) => sum + feed.itemCount, 0)}<small>条记录</small></strong></div>{attention ? <button className={`attention ${status === 'attention' ? 'active' : ''}`} title="只看需要检查的订阅" onClick={() => setStatus(status === 'attention' ? 'all' : 'attention')}><span>需要检查</span><strong>{attention}<small>个来源出错</small></strong></button> : <div><span>需要检查</span><strong>0<small>一切正常</small></strong></div>}</div>
      <div className="list-toolbar"><h2>订阅列表 <span>{feeds.length}</span></h2><div className="input-icon search-input"><Search size={16} /><input ref={searchRef} aria-label="搜索订阅" placeholder="搜索名称或网址" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }} /><kbd className="search-key" aria-hidden="true">/</kbd></div></div>
      <ErrorNote error={error} />{loading && !feeds.length ? <Busy label="正在加载订阅" /> : filtered.length ? <FeedCollection auth={target ? { ...auth, userId: target.id, role: 'user' } : auth} feeds={filtered} query={query} status={status} onStatus={setStatus} detail={id => setPanel({ id, tab: 'items' })} settings={id => setPanel({ id, tab: 'settings' })} logs={id => setPanel({ id, tab: 'logs' })} changed={() => void loadFeeds()} notify={notify} /> : <div className="empty-state"><span className="large-icon"><Rss size={32} /></span><h2>{query ? '没有找到匹配的订阅' : '从一个值得关注的网址开始'}</h2><p>{query ? '尝试其他名称或网址。' : '输入网页地址，自动识别内容，预览后即可生成 RSS。'}</p>{query ? <button className="button" onClick={() => setQuery('')}>清除搜索</button> : <button className="button" onClick={() => create('website')}><Plus size={16} />创建第一条订阅</button>}</div>}<div className="dashboard-note"><Sparkles size={17} /><span>自动识别先行，手动调整随时可用。</span><span className="muted">按 / 搜索订阅。</span></div></>}
  </main><footer className="page-footer"><span>FeedLantern · 订阅灯</span><a href="https://github.com/Jaaayden/feedlantern" target="_blank" rel="noreferrer">GitHub · Jaaayden/feedlantern · {auth.version}</a></footer></div>{panel && <FeedPanel key={panel.id} id={panel.id} tab={panel.tab} onTab={tab => setPanel(previous => previous && { ...previous, tab })} close={closePanel} edit={feed => { setPanel(null); setEditorReturnId(feed.id); setEditor(feed); }} changed={() => void loadFeeds()} notify={notify} />}{toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}</div>;
}
