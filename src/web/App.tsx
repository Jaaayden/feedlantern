import type { UserSummary } from '../shared/types';
import { NotificationsPanel } from './NotificationsPanel';
import { UsersPanel } from './UsersPanel';
import { feedFormatUrl, ITEM_FILTER_LIMITS, OUTPUT_LIMIT, RETENTION_LIMIT, translationEnabled } from '../shared/types';
import type { FeedFormat, ItemFilter, ItemOutputStatus } from '../shared/types';
import { TranslationLog } from './TranslationProgress';
import { ItemPreview } from './ItemList';
import { LanguageOptions, ProviderOptions, useTranslationProviders } from './TranslationFields';
import { RssEditor } from './RssEditor';
import { ApplicationSettingsPanel } from './ApplicationSettingsPanel';
import { BackupPanel } from './BackupPanel';
import { ApiTokensPanel } from './ApiTokensPanel';
import { BatchView } from './BatchView';
import { FeedCollection } from './FeedCollection';
import { AddToBundle, BundleEditor, BundleSection } from './Bundles';
import { FetchLogs } from './FetchLogs';
import { PaginationPanel, paginationProblem } from './PaginationPanel';
import { RuleHealthNotice, needsAttention } from './RuleHealth';
import { PageScreen, linkModifier, loadedHeight, type ScreenChoice, type SegmentState } from './PageScreen';
import { levelsBetween, liftNode } from '../shared/element-map';
import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Archive, ChevronRight, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Check, ChevronDown, CircleHelp, Cookie, Copy, ExternalLink, Globe2, Info, KeyRound, KeySquare, Languages, Layers, ListPlus, LoaderCircle, LogOut, Monitor, Moon, Network, MousePointer2, Pencil, Plus, Radio, RefreshCw, Rss, Search, Server, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Sun, Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { NetworkProfileSelect, NetworkProfilesView, useNetworkProfiles } from './NetworkProfiles';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { absoluteTime, copyText, relativeTime, sameAddress } from './format';
import type { StatusFilter } from './FeedCollection';
import { readTheme, saveTheme, themeLabels } from './theme';
import type { Theme } from './theme';
import { api, onUnauthorized, setCsrfToken, setWorkspaceUser } from './api';
import type { TargetLanguage, TranslationMode, TranslationProviderId } from '../shared/types';
import type { CredentialPayload, OutputPreview } from './api';
import type { BundlePayload } from '../shared/types';
import type { AuthState, CredentialSummary, DetectionCandidate, DetectionResult, ExtractedItem, Feed, FeedInput, FeedItem, FieldName, PaginationReport, PaginationRules, PickResult, Rect, RuleOrigins, ScreenFrame, SelectionRules } from '../shared/types';

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
  const [username, setUsername] = useState(() => { if (state.setupRequired) return 'admin'; try { return localStorage.getItem('feedlantern:last-username') ?? ''; } catch { return ''; } });
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = state.setupRequired ? await api.auth.setup({ username, password, setupToken }) : await api.auth.login({ username, password });
      try { localStorage.setItem('feedlantern:last-username', username); } catch { /* convenience only */ }
      setPassword(''); setSetupToken(''); authenticated(result);
    } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  return <div className="auth-page"><section className="auth-story"><Brand /><div className="auth-copy"><span className="eyebrow">YOUR WEB, ON YOUR TERMS</span><h1>把值得关注的网页，<br />留在自己的订阅里。</h1><p>输入网址，自动发现内容。<br />不再反复打开网页，看看有没有更新。</p><div className="auth-illustration" aria-hidden="true"><div className="paper paper-back" /><div className="paper"><span className="paper-dot" /><div className="paper-line" /><div className="paper-line short" /><div className="paper-picture" /><div className="paper-line" /><div className="paper-line short" /></div><span className="floating-rss"><Rss size={34} /></span></div></div><div className="auth-footer"><ShieldCheck size={16} /> 本地优先 · 开源 · 自己掌控</div></section><section className="auth-form-panel"><div className="auth-form"><span className="section-kicker">FEEDLANTERN / {state.setupRequired ? 'WELCOME' : 'SIGN IN'}</span><h2>{state.setupRequired ? '点亮你的第一盏订阅灯' : '欢迎回来'}</h2><p className="muted">{state.setupRequired ? '先设置管理员账号，保护你的订阅与网站登录态。' : '登录后，继续管理你的订阅。'}</p><form onSubmit={submit}>
    {state.setupRequired && <Field label="一次性设置码" hint="设置码位于服务数据目录的 setup-token 文件中，默认是 data/setup-token。"><input required type="password" value={setupToken} onChange={e => setSetupToken(e.target.value)} autoComplete="off" placeholder="粘贴本机生成的设置码" /></Field>}
    <Field label="用户名"><input required value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" maxLength={100} /></Field>
    <Field label="密码" hint={state.setupRequired ? '至少 8 个字符。请使用独立的长密码。' : undefined}><input required type="password" autoFocus={!state.setupRequired && !!username} minLength={8} maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} autoComplete={state.setupRequired ? 'new-password' : 'current-password'} /></Field>
    <ErrorNote error={error} /><button className="button primary full" disabled={busy}>{busy ? <Busy /> : <>{state.setupRequired ? '创建管理员' : '登录'}<ArrowRight size={17} /></>}</button>
  </form><p className="auth-note"><KeyRound size={14} />{state.setupRequired ? '只有持有本机设置码的人可以创建管理员。' : '普通用户忘记密码请联系管理员；管理员可在服务主机运行 pnpm admin:reset。'}</p>{state.setupRequired && <BackupPanel setup onRestored={() => location.reload()} />}<span className="version">{state.version} · <a href="https://github.com/Jaaayden/feedlantern" target="_blank" rel="noreferrer">GitHub · Jaaayden/feedlantern</a></span></div></section></div>;
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
  return <form onSubmit={submit} className="modal-body"><p className="muted">从你已登录的浏览器导入 Cookie，供后台访问需要登录的网页。</p><details className="advanced cookie-help"><summary>如何获取 Cookie<ChevronDown size={14} /></summary><ol><li>在电脑浏览器中登录目标网站，打开需要订阅的页面。</li><li>按 F12（Mac 为 ⌥⌘I）打开开发者工具，切到“网络 / Network”，刷新页面。</li><li>点击第一条请求，在“请求标头”里找到 <code>Cookie</code>，复制冒号后的整段内容，粘贴到下方并选择“Cookie 字符串”。</li><li>也可以用 OpenCookie 等扩展导出该网站的 Cookie JSON，选择“OpenCookie / JSON”后粘贴或上传文件。</li></ol><p className="hint">Cookie 相当于登录凭证，只在你自己的服务器上加密保存。网站退出登录或过期后需要重新导入。</p></details><Field label="凭据名称"><input required value={name} onChange={e => setName(e.target.value)} placeholder="例如：我的论坛账号" /></Field><Field label="目标网址" hint="只保留适用于此网站的 Cookie。"><input required type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/articles" /></Field><Field label="导入格式"><select value={format} onChange={e => { setFormat(e.target.value as 'header' | 'json'); setValue(''); }}><option value="header">Cookie 字符串</option><option value="json">OpenCookie / JSON</option></select></Field><Field label="Cookie 内容" hint={editing ? '重新导入会替换这组凭据。现有值不会回显。' : '加密保存，仅用于你选择的订阅。'}><textarea required value={value} onChange={e => setValue(e.target.value)} rows={6} autoComplete="off" spellCheck={false} placeholder={format === 'json' ? '[{"name":"session", "value":"…", "domain":"example.com"}]' : 'session=…; preference=…'} /></Field>{format === 'json' && <Field label="或选择 JSON 文件"><input type="file" accept=".json,application/json" onChange={async e => { const file = e.target.files?.[0]; if (file) { if (file.size > 1024 * 1024) setError('文件不能超过 1 MB'); else setValue(await file.text()); } e.target.value = ''; }} /></Field>}<ErrorNote error={error} /><div className="modal-actions"><button type="button" className="button" onClick={cancel}>取消</button><button className="button primary" disabled={busy}>{busy ? <Busy /> : '保存凭据'}</button></div></form>;
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

function FeedEditor({ source: initialSource, ...props }: { initial?: Feed; source?: 'website' | 'rss'; existing?: Feed[]; saved: (id: string) => void; cancel: () => void }) {
  const [source, setSource] = useState<'website' | 'rss'>(props.initial?.sourceType ?? initialSource ?? 'website');
  return <>{!props.initial && <div className="detail-actions" aria-label="订阅来源类型"><button className="button" aria-pressed={source === 'website'} onClick={() => setSource('website')}>网页生成 RSS</button><button className="button" aria-pressed={source === 'rss'} onClick={() => setSource('rss')}>RSS 翻译</button></div>}{source === 'rss' ? <RssEditor {...props} /> : <Editor {...props} />}</>;
}

export function Editor({ initial, draft, existing = [], submitFeed, saved, cancel }: { initial?: Feed; draft?: FeedInput; existing?: Feed[]; submitFeed?: (input: FeedInput) => Promise<{ feed: Feed }>; saved: (id: string) => void; cancel: () => void }) {
  const [url, setUrl] = useState(initial?.url ?? draft?.url ?? '');
  const [credentialId, setCredentialId] = useState(initial?.credentialId ?? draft?.credentialId ?? '');
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [networkProfileId, setNetworkProfileId] = useState(initial?.networkProfileId ?? draft?.networkProfileId ?? '');
  const profiles = useNetworkProfiles(message => setError(message));
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
  // The frame shows a page reached by following a link, not the source URL.
  const [navigated, setNavigated] = useState(false);
  // Last picked element (and the element under the pointer at the time), for 扩大/缩小.
  const [lastPick, setLastPick] = useState<{ base: number; node: number } | null>(null);
  // Loading of the next screenshot segment below what is shown.
  const [segmentState, setSegmentState] = useState<SegmentState>('idle');
  const segmentLoading = useRef(false);
  const [target, setTarget] = useState<'item' | FieldName | 'next'>('item');
  const [pagination, setPagination] = useState<PaginationRules | null>(initial?.pagination ?? draft?.pagination ?? null);
  const [pageReport, setPageReport] = useState<PaginationReport | null>(null);
  const pickNext = pagination?.mode === 'next' || pagination?.mode === 'loadMore';
  const nextLabel = pagination?.mode === 'loadMore' ? '“加载更多”按钮' : '下一页链接或按钮';
  const targetLabel = target === 'next' ? nextLabel : fieldLabels[target];
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const sessionRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const previewSeq = useRef(0);
  const currentKey = JSON.stringify([url, credentialId, networkProfileId, waitMs, waitForSelector]);
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

  useEffect(() => {
    // Leaving with an opened page and unsaved rules would lose the work.
    if (!frame) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [frame]);

  // A multi-page result belongs to the rules and pagination it was made with.
  useEffect(() => { setPageReport(null); }, [rulesSignature(rules), JSON.stringify(pagination)]);
  useEffect(() => { if (target === 'next' && !pickNext) setTarget('item'); }, [target, pickNext]);
  async function testPages() {
    if (!frame || !pagination || busy) return;
    const seq = ++previewSeq.current;
    const signature = rulesSignature(rules);
    setBusy(`正在试抓最多 ${pagination.maxPages} 页，每页之间等待约 ${Math.round(pagination.delayMs / 1000)} 秒`); setError('');
    try {
      const result = await api.browser.paginate(frame.sessionId, rules, pagination);
      if (seq === previewSeq.current) { setItems(result.items); setPreviewSignature(signature); setPageReport(result.pagination ?? null); }
    } catch (error) { if (seq === previewSeq.current) setError(messageOf(error)); } finally { setBusy(''); }
  }
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
  async function open(event?: FormEvent, target = url) {
    event?.preventDefault(); setError(''); setNote(''); setBusy('正在打开网页并分析内容');
    try {
      if (sessionRef.current) { await api.browser.close(sessionRef.current).catch(() => {}); sessionRef.current = null; }
      const result = await api.browser.open({ url: target, credentialId: credentialId || null, networkProfileId: networkProfileId || null, waitMs, waitForSelector: waitForSelector || undefined });
      if (!mountedRef.current) { await api.browser.close(result.sessionId).catch(() => {}); return; }
      sessionRef.current = result.sessionId; setFrame(result); setSourceKey(JSON.stringify([target, credentialId, networkProfileId, waitMs, waitForSelector])); setRects([]); setNavigated(false); setLastPick(null);
      if (!name) setName(result.title || hostLabel(target));
      if (initial) { await preview(rules, result.sessionId); setNote('已载入保存的匹配规则。需要时可以重新识别。'); }
      else await detect(result.sessionId);
    } catch (error) { setFrame(null); setError(messageOf(error)); } finally { setBusy(''); }
  }
  async function rescan() { if (!frame) return; setBusy('正在重新识别'); setError(''); try { await detect(frame.sessionId); } catch (error) { setError(messageOf(error)); } finally { setBusy(''); } }
  useEffect(() => {
    if (!frame || busy || !sourceUnchanged || navigated) return;
    // A pick already returned the preview for exactly these rules.
    if (previewSignature && previewSignature === rulesSignature(rules)) return;
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
    try { const result = await operation(); setFrame(result); setRects([]); setLastPick(null); } catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  async function pickAt(choice: ScreenChoice) {
    if (!frame || busy) return;
    if (navigated) { setNote('当前画面不是源网址。请先选择“以此页为源网址”，或返回源网址后再点选。'); return; }
    setBusy('正在定位内容'); setError('');
    try {
      const at = choice.node !== undefined ? { node: choice.node, ...(choice.exact ? { exact: true } : {}) } : { x: choice.x, y: choice.y };
      if (target === 'next') {
        const picked = await api.browser.pick(frame.sessionId, { ...at, target });
        setPagination(previous => previous && { ...previous, nextSelector: picked.selector });
        setRects(picked.rects);
        setLastPick(picked.node !== undefined ? { base: choice.base ?? picked.node, node: picked.node } : null);
        setNote(`${nextLabel}匹配 ${picked.count} 项。${picked.count > 1 ? '翻页时只使用第一项。' : ''}${picked.warning ?? ''}`);
        return;
      }
      // Sending the current rules makes the server preview them in the same request.
      const picked = await api.browser.pick(frame.sessionId, { ...at, target, itemSelector: rules.item || undefined, rules });
      applyPick(picked, choice.base);
    } catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  function applyPick(picked: PickResult, base?: number) {
    const next = { ...rules, [target]: picked.selector };
    previewSeq.current += 1;
    setRules(next);
    setOrigins(previous => ({ ...previous, [target]: 'manual' }));
    setRects(picked.rects);
    setLastPick(picked.node !== undefined ? { base: base ?? picked.node, node: picked.node } : null);
    if (picked.items) { setItems(picked.items); setPreviewSignature(rulesSignature(next)); }
    else { setItems([]); setPreviewSignature(''); }
    if (picked.previewError) setError(picked.previewError);
    setNote(`${targetLabel}匹配 ${picked.count} 项。${picked.warning ?? ''}${picked.datePreview ? ` ${picked.datePreview.dateText} → ${dateLabel(picked.datePreview.publishedAt)}${picked.datePreview.publishedAtSource === 'relative' ? '（估算）' : ''}` : ''}`);
  }
  // Widen or narrow the last pick along the chain from the pointed element outwards.
  async function resize(delta: 1 | -1) {
    const map = frame?.map;
    if (!map || !lastPick) return;
    let base = lastPick.base;
    let level = levelsBetween(map, base, lastPick.node);
    if (level < 0) { base = lastPick.node; level = 0; }
    const node = liftNode(map, base, Math.max(0, level + delta));
    if (node === lastPick.node) { setNote(delta > 0 ? '已经是最外层的元素。' : '已经是最内层的元素。'); return; }
    await pickAt({ x: 0, y: 0, base, node, exact: true });
  }
  async function followLink(node: number, href: string | undefined) {
    if (!frame || busy) return;
    if (!href) { setNote(`这里不是链接。按住 ${linkModifier} 点击网页中的链接，可以跳转到对应页面。`); return; }
    setBusy('正在打开链接'); setError('');
    try {
      const result = await api.browser.follow(frame.sessionId, node);
      previewSeq.current += 1;
      setFrame(result); setRects([]); setItems([]); setPreviewSignature(''); setLastPick(null); setNavigated(true); setNote('');
    } catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  useEffect(() => { setSegmentState('idle'); }, [frame?.image]);
  async function loadMore() {
    if (!frame || busy || segmentLoading.current) return;
    const top = loadedHeight(frame);
    if (top >= frame.documentHeight) return;
    const first = frame.image;
    segmentLoading.current = true; setSegmentState('loading');
    try {
      const segment = await api.browser.segment(frame.sessionId, top);
      // Ignore a segment that arrives after the frame was replaced (refresh, link, reopen).
      setFrame(current => current && current.image === first ? {
        ...current, map: segment.map, documentHeight: segment.documentHeight, ...(segment.truncated ? { truncated: true } : {}),
        segments: [...(current.segments ?? []), { top: segment.top, height: segment.height, image: segment.image }],
      } : current);
      setSegmentState('idle');
    } catch { setSegmentState('error'); } finally { segmentLoading.current = false; }
  }
  function adoptCurrentPage() {
    if (!frame) return;
    const target = frame.url;
    setUrl(target);
    void open(undefined, target);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (paginationProblem(pagination)) { setNote(`多页采集设置未完成：${paginationProblem(pagination)}`); return; }
    if (navigated || !sourceUnchanged || !items.length || previewSignature !== rulesSignature(rules)) {
      if (sourceUnchanged && rulesSignature(rules) !== previewSignature) setNote('匹配规则正在重新预览，请稍候再保存。');
      return;
    }
    setBusy('正在保存订阅'); setError('');
    try { const body: FeedInput = { name, url, credentialId: credentialId || null, networkProfileId: networkProfileId || null, rules, ruleOrigins: origins, intervalMinutes, waitMs, waitForSelector: waitForSelector || undefined, pagination }; const result = submitFeed ? await submitFeed(body) : initial ? await api.feeds.update(initial.id, body) : await api.feeds.create(body); saved(result.feed.id); }
    catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  const chosen = detection?.candidates.find(item => item.id === candidateId);
  const duplicate = !initial ? existing.find(feed => (feed.sourceType ?? 'website') === 'website' && sameAddress(feed.url, url)) : undefined;
  return <><button className="back-link" onClick={cancel}><ArrowLeft size={16} />返回订阅</button><div className="page-heading"><div><span className="section-kicker">A NEW WAY TO FOLLOW</span><h1>{initial ? '编辑匹配规则' : '让网页成为订阅'}</h1><p>我们先找到内容，你只需确认值得关注。</p></div><span className="step-label">{frame ? '02 / 预览与保存' : '01 / 连接网页'}</span></div>
    <form className="source-panel" onSubmit={open}><div className="source-row"><Field label="源网址"><div className="input-icon"><Globe2 size={18} /><input required type="url" placeholder="https://example.com/articles" value={url} onChange={e => setUrl(e.target.value)} /></div></Field><Field label="Cookie 凭据" hint={credentials.length ? undefined : '需要登录的网页，可先在「设置 → Cookie 凭据」中添加。'}><select value={credentialId} onChange={e => setCredentialId(e.target.value)}><option value="">公开网页，无需 Cookie</option>{credentials.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><button className="button primary source-submit" disabled={!!busy}>{busy ? <Busy label="处理中" /> : <><Sparkles size={17} />打开并自动识别</>}</button></div><details className="advanced" open={!!networkProfileId || undefined}><summary>加载与网络设置<ChevronDown size={14} /></summary><div className="form-row"><NetworkProfileSelect value={networkProfileId} onChange={setNetworkProfileId} profiles={profiles} /></div><div className="form-row"><Field label="额外等待时间（毫秒）"><input type="number" min={0} max={10000} step={100} value={waitMs} onChange={e => setWaitMs(Number(e.target.value))} /></Field><Field label="等待元素（可选）"><input value={waitForSelector} onChange={e => setWaitForSelector(e.target.value)} placeholder="CSS 选择器，例如 .article-list" /></Field></div></details></form>
    {duplicate && <div className="notice duplicate-note"><CircleHelp size={16} /><span>已有订阅「{duplicate.name}」使用这个网址，仍可保存为新的订阅。</span></div>}
    <ErrorNote error={error} />{busy && <div className="progress-strip" role="status"><Busy label={busy} /></div>}
    {!frame && !busy && <div className="editor-welcome"><div className="welcome-step"><span>01</span><Globe2 size={23} /><h3>打开网页</h3><p>支持动态内容与 Cookie 登录态</p></div><div className="welcome-step"><span>02</span><Sparkles size={23} /><h3>自动识别</h3><p>找到列表，匹配标题、图片与摘要</p></div><div className="welcome-step"><span>03</span><Rss size={23} /><h3>持续关注</h3><p>复制 RSS 地址到你喜欢的阅读器</p></div></div>}
    {frame && <><div className="result-toolbar"><div><span className={`badge ${chosen?.confidence === 'high' ? 'good' : ''}`}><Sparkles size={13} />{chosen?.confidence === 'high' ? '已自动匹配' : '匹配结果'}</span><span className="muted">{items.length} 条内容</span></div><div className="inline"><button type="button" className="button small" onClick={() => void rescan()} disabled={!!busy}><RefreshCw size={14} />重新识别</button><button type="button" className="button small" disabled={!!busy} onClick={() => setAdjusting(!adjusting)}><MousePointer2 size={14} />{adjusting ? '收起调整' : '调整匹配'}</button></div></div>{note && <div className="notice"><CircleHelp size={16} /><span>{note}</span></div>}{!sourceUnchanged && <div className="notice">网址或加载设置已变化，请重新打开网页后保存。</div>}
    {!!detection?.candidates.length && (detection.candidates.length > 1 || !candidateId) && <div className="candidate-grid">{detection.candidates.map(candidate => <button key={candidate.id} className={`candidate ${candidate.id === candidateId ? 'selected' : ''}`} disabled={!!busy} onClick={() => void applyCandidate(candidate)}><span className="inline"><Radio size={15} />{candidate.label}<span className="muted">{candidate.count} 条</span></span><strong>{candidate.items[0]?.title ?? '查看候选内容'}</strong><small>{candidate.confidence === 'high' ? '匹配明确' : '请检查样例'}</small></button>)}</div>}
    {adjusting && <section className="adjust-panel"><div className="adjust-heading"><h2>在网页上调整匹配</h2><div className="inline">{(frame.map ? frame.map.innerScroll : frame.height <= frame.viewportHeight) && <><button className="icon-button" aria-label="在网页内向上滚动" title="滚动网页内部的滚动区域" disabled={!!busy} onClick={() => void frameAction(() => api.browser.scroll(frame.sessionId, -500))}><ArrowUp size={17} /></button><button className="icon-button" aria-label="在网页内向下滚动" title="滚动网页内部的滚动区域" disabled={!!busy} onClick={() => void frameAction(() => api.browser.scroll(frame.sessionId, 500))}><ArrowDown size={17} /></button></>}<button className="icon-button" aria-label="更新网页画面" title="重新截取网页画面" disabled={!!busy} onClick={() => void frameAction(() => api.browser.frame(frame.sessionId))}><RefreshCw size={16} /></button></div></div>
      <div className="field-tabs">{keys.map(key => <button className={target === key ? 'selected' : ''} key={key} onClick={() => { setTarget(key); setLastPick(null); }}>{fieldLabels[key]}{rules[key] && <Check size={12} />}</button>)}{pickNext && <button className={target === 'next' ? 'selected' : ''} onClick={() => { setTarget('next'); setLastPick(null); }}>{pagination?.mode === 'loadMore' ? '加载更多' : '下一页'}{pagination?.nextSelector && <Check size={12} />}</button>}<span className="scope-controls"><button className="button small" disabled={!!busy || !lastPick} title="把刚才的选择扩大到外层元素（悬停时也可按 ↑）" onClick={() => void resize(1)}><ArrowUp size={14} />扩大</button><button className="button small" disabled={!!busy || !lastPick} title="把刚才的选择缩小到内层元素（悬停时也可按 ↓）" onClick={() => void resize(-1)}><ArrowDown size={14} />缩小</button></span></div>
      <p className="hint">点击网页中的<strong>{targetLabel}</strong>。悬停时按 ↑ / ↓ 扩大或缩小范围；按住 {linkModifier} 点击链接可以跳转到该页。</p>
      {navigated && <div className="notice navigated-notice" role="status"><Globe2 size={16} /><span>画面已跳转到 <code>{frame.url}</code>。要订阅这一页，请把它设为源网址。</span><span className="inline"><button className="button small primary" disabled={!!busy} onClick={adoptCurrentPage}>以此页为源网址</button><button className="button small" disabled={!!busy} onClick={() => void open()}>返回源网址</button></span></div>}
      <div className="browser-bar"><span /><span /><span /><code>{frame.url}</code>{busy && <small className="browser-busy"><LoaderCircle size={13} className="spin" />{busy}</small>}</div>
      <PageScreen frame={frame} rects={rects} disabled={!!busy || segmentState === 'loading'} navigated={navigated} revealKey={[frame.image.length, frame.url, candidateId].join('|')} segmentState={segmentState} loadMore={() => void loadMore()} pick={choice => void pickAt(choice)} follow={(node, href) => void followLink(node, href)} />
      <details className="advanced"><summary>高级：编辑匹配规则<ChevronDown size={14} /></summary><div className="selector-grid">{keys.map(key => <Field key={key} label={`${fieldLabels[key]}选择器`} hint={origins[key] === 'manual' ? '手动配置 · 重新识别时保留' : '自动配置'}><input value={rules[key] ?? ''} onChange={e => changeRule(key, e.target.value)} placeholder={key === 'item' ? 'article' : key === 'title' || key === 'link' ? 'h2 a' : '可留空'} spellCheck={false} /></Field>)}</div>{chosen && <button type="button" className="button small" onClick={() => { if (confirm('使用此候选替换全部匹配规则，包括你手动修改的字段？')) void applyCandidate(chosen, true); }}>替换全部匹配</button>}</details></section>}
    <PaginationPanel value={pagination} onChange={setPagination} disabled={!!busy} report={pageReport} onTest={() => void testPages()} onPick={() => { setAdjusting(true); setTarget('next'); setLastPick(null); setNote(`在下方网页中点击${nextLabel}。`); }} />
    <div className="editor-results"><section className="panel"><div className="panel-heading"><h2>订阅预览</h2><span className="muted">与后台抓取使用相同规则</span></div><ItemPreview items={items} empty={detection?.candidates.length ? '选择候选列表，或调整匹配以查看内容' : '没有找到可靠列表，可以手动点选条目与字段'} /></section><form className="save-panel panel" onSubmit={save}><div className="panel-heading"><h2>保存订阅</h2><Rss size={18} /></div><Field label="订阅名称"><input required value={name} onChange={e => setName(e.target.value)} /></Field><Field label="刷新间隔（分钟）"><input type="number" required min={5} max={1440} value={intervalMinutes} onChange={e => setIntervalMinutes(Number(e.target.value))} /></Field><p className="hint">保存后会在后台定时更新。页面关闭不影响运行中的服务。</p><button className="button primary full" disabled={!!busy || navigated || !items.length || !sourceUnchanged || previewSignature !== rulesSignature(rules) || !!paginationProblem(pagination)}>{busy === '正在保存订阅' ? <Busy /> : <><Check size={16} />保存订阅</>}</button></form></div></>}
  </>;
}

const formatLabels: Record<FeedFormat, string> = { rss: 'RSS', atom: 'Atom', json: 'JSON Feed' };
const formatOptions: Array<[FeedFormat, string]> = [['rss', 'RSS 2.0'], ['atom', 'Atom 1.0'], ['json', 'JSON Feed 1.1']];
function readFormat(): FeedFormat {
  try { const saved = localStorage.getItem('feedlantern:feed-format'); return saved === 'atom' || saved === 'json' ? saved : 'rss'; } catch { return 'rss'; }
}

function FeedAddress({ feedUrl, notify, onError }: { feedUrl: string; notify: Notify; onError: (error: string) => void }) {
  const [format, setFormat] = useState<FeedFormat>(readFormat);
  const url = feedFormatUrl(feedUrl, format);
  const label = formatLabels[format];
  function choose(next: FeedFormat) {
    setFormat(next);
    try { localStorage.setItem('feedlantern:feed-format', next); } catch { /* per-browser preference only */ }
  }
  return <div className="field feed-address">
    <div className="feed-address-head"><span>订阅地址</span><div className="format-switch" role="group" aria-label="订阅格式">{formatOptions.map(([key, text]) => <button key={key} type="button" className="button small" aria-pressed={format === key} onClick={() => choose(key)}>{text}</button>)}</div></div>
    <div className="copy-row"><input readOnly aria-label={`${label} 订阅地址`} value={url} onFocus={e => e.target.select()} /><a className="icon-button" href={url} target="_blank" rel="noreferrer" title="在新标签页打开订阅页" aria-label="在新标签页打开订阅页"><ExternalLink size={16} /></a><button className="button primary" onClick={() => void copyText(url).then(() => notify(`${label} 地址已复制`)).catch(() => onError('无法访问剪贴板，请选中地址后手动复制。'))}><Copy size={15} />复制 {label} 地址</button></div>
    <small>三种格式内容相同，按阅读器支持的格式选择。持有地址即可读取订阅内容；需要撤销时可在订阅设置中轮换密钥，三种地址同时失效。</small>
  </div>;
}

/** Counts behind the "输出 / 过滤" summaries. */
function outputCounts(statuses: Record<string, ItemOutputStatus>) {
  const counts = { published: 0, filtered: 0, overLimit: 0, untranslated: 0 };
  for (const status of Object.values(statuses)) {
    if (status === 'published') counts.published++;
    else if (status === 'over-limit') counts.overLimit++;
    else if (status === 'untranslated') counts.untranslated++;
    else counts.filtered++;
  }
  return counts;
}

function OutputSummary({ preview, stored }: { preview: OutputPreview; stored: number }) {
  const counts = outputCounts(preview.outputStatus);
  return <p className="output-summary" aria-live="polite">已存储 {stored} 条，输出 {counts.published} 条{counts.filtered ? `，过滤 ${counts.filtered} 条` : ''}{counts.overLimit ? `，超出输出条数 ${counts.overLimit} 条` : ''}{counts.untranslated ? `，${counts.untranslated} 条翻译完成后输出` : ''}{preview.filterTimedOut ? '。正则过滤运行超时，暂未生效，请简化规则' : ''}</p>;
}

function FeedStatus({ feed, retry, busy }: { feed: Feed; retry: () => void; busy: boolean }) {
  const unfinished = (feed.translation?.pending ?? 0) + (feed.translation?.failed ?? 0);
  return <><div className="detail-status"><span>每 {feed.intervalMinutes} 分钟刷新</span><span title={absoluteTime(feed.lastSuccessAt)}>最近成功：{feed.lastSuccessAt ? relativeTime(feed.lastSuccessAt) : '尚未更新'}</span><span title={feed.enabled ? absoluteTime(feed.nextFetchAt) : undefined}>{feed.enabled ? `下次检查：${feed.nextFetchAt ? relativeTime(feed.nextFetchAt) : '尚未安排'}` : '已暂停自动刷新'}</span></div><ErrorNote error={feed.lastError ?? undefined} />{translationEnabled(feed) && feed.translation && <div className="translation-summary"><p role="status">翻译：{feed.translation.success} 条完成 · {feed.translation.pending} 条等待 · <span className={feed.translation.failed ? 'has-failed' : undefined}>{feed.translation.failed} 条失败</span></p>{unfinished > 0 && <button type="button" className="button small" disabled={busy || !feed.enabled} title={feed.enabled ? '立即重新翻译等待中和失败的文章' : '订阅已暂停'} onClick={retry}><RefreshCw size={13} className={busy ? 'spin' : undefined} />重试未完成翻译</button>}</div>}</>;
}

type PanelTab = 'items' | 'logs' | 'settings';
const panelTabs: Array<[PanelTab, string]> = [['items', '订阅内容'], ['logs', '运行日志'], ['settings', '订阅设置']];

/**
 * 运行日志: fetch runs and, for translated feeds, translation activity. They
 * are two segments rather than one merged timeline: fetch runs page through a
 * long history by status, translation events are a short rolling window with
 * a live article queue, and each keeps its own refresh pace.
 */
function ActivityTab({ feed, revision }: { feed: Feed; revision: number }) {
  const translated = translationEnabled(feed);
  const [view, setView] = useState<'fetch' | 'translation'>('fetch');
  const failed = feed.translation?.failed ?? 0;
  return <div className="activity">
    {translated && <div className="detail-actions activity-switch" role="group" aria-label="日志类型">
      <button type="button" className="button small" aria-pressed={view === 'fetch'} onClick={() => setView('fetch')}>抓取记录</button>
      <button type="button" className="button small" aria-pressed={view === 'translation'} onClick={() => setView('translation')}>翻译记录{failed > 0 && <span className="count bad" aria-label={`${failed} 条失败`}>{failed}</span>}</button>
    </div>}
    {translated && view === 'translation' ? <TranslationLog id={feed.id} enabled={feed.enabled} /> : <FetchLogs id={feed.id} revision={revision} />}
  </div>;
}
type FeedDetailData = { feed: Feed; items: FeedItem[]; feedUrl: string } & OutputPreview;

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
  function retryTranslation() {
    setBusy('重试翻译'); setError('');
    void api.feeds.retryTranslation(id).then(load).then(() => notify('已重新安排翻译')).catch(e => setError(messageOf(e))).finally(() => setBusy(''));
  }
  async function refresh() {
    setBusy('刷新'); setError('');
    try { await api.feeds.refresh(id); await load(); setRevision(v => v + 1); changed(); notify('刷新完成'); }
    catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  const feed = detail?.feed;
  return <Modal title={feed?.name ?? '订阅详情'} close={() => guard(close)} wide><div className="modal-body feed-panel">
    <ErrorNote error={error} />{!detail || !feed ? !error && <Busy label="正在加载订阅" /> : <>
      <div className="feed-panel-head">
        <div className="feed-panel-source"><div className="detail-source"><Globe2 size={16} /><a href={feed.url} target="_blank" rel="noreferrer">{feed.url}</a></div><button className="button small" disabled={!!busy} onClick={() => void refresh()}><RefreshCw size={14} className={busy === '刷新' ? 'spin' : undefined} />{busy === '刷新' ? '正在刷新' : '立即刷新'}</button></div>
        <FeedAddress feedUrl={detail.feedUrl} notify={notify} onError={setError} />
        <FeedStatus feed={feed} retry={retryTranslation} busy={busy === '重试翻译'} />
        <RuleHealthNotice key={feed.id} feed={feed} notify={notify} updated={() => { void load().catch(e => setError(messageOf(e))); setRevision(v => v + 1); changed(); }} />
      </div>
      <div className="detail-actions feed-tabs" aria-label="详情内容">{panelTabs.map(([key, label]) => <button key={key} className="button small" aria-pressed={tab === key} onClick={() => { if (tab !== key) guard(() => onTab(key)); }}>{label}</button>)}</div>
      {tab === 'items' && <>
        {(feed.itemFilter || Object.values(detail.outputStatus).includes('over-limit')) && <OutputSummary preview={detail} stored={detail.items.length} />}
        <ItemPreview items={detail.items} mode={translationEnabled(feed) ? feed.translationMode : undefined} status={item => detail.outputStatus[(item as FeedItem).id]} />
      </>}
      {tab === 'logs' && <ActivityTab feed={feed} revision={revision} />}
      {tab === 'settings' && <FeedSettingsTab feed={feed} busy={busy} setBusy={setBusy} setError={setError} dirty={dirty} reload={load} items={detail.items} saved={result => { setDetail(previous => previous && { ...previous, ...result }); void load().catch(e => setError(messageOf(e))); }} changed={changed} notify={notify} edit={() => guard(() => edit(feed))} removed={close} />}
    </>}
  </div></Modal>;
}

const filterLines = (value: string) => [...new Set(value.split('\n').map(line => line.trim()).filter(Boolean))];
function draftFilter(include: string, exclude: string, regex: boolean): ItemFilter | null {
  const draft = { include: filterLines(include), exclude: filterLines(exclude), regex };
  return draft.include.length || draft.exclude.length ? draft : null;
}

function FeedSettingsTab({ feed, items, busy, setBusy, setError, dirty, reload, saved, changed, notify, edit, removed }: {
  feed: Feed; items: FeedItem[]; busy: string; setBusy: (value: string) => void; setError: (value: string) => void; dirty: React.MutableRefObject<boolean>;
  reload: () => Promise<void>; saved: (result: { feed: Feed; feedUrl: string }) => void; changed: () => void; notify: Notify; edit: () => void; removed: () => void;
}) {
  const [title, setTitle] = useState(feed.name);
  const [interval, setIntervalValue] = useState(String(feed.intervalMinutes));
  const [mode, setMode] = useState<TranslationMode>(feed.translationMode ?? 'bilingual');
  const [language, setLanguage] = useState<TargetLanguage>(feed.targetLanguage ?? 'zh-CN');
  const [provider, setProvider] = useState<TranslationProviderId | ''>(feed.translationProvider ?? '');
  const providers = useTranslationProviders();
  const retranslates = language !== (feed.targetLanguage ?? 'zh-CN') || provider !== (feed.translationProvider ?? '');
  const savedLimit = feed.outputLimit ?? OUTPUT_LIMIT.default;
  const [limit, setLimit] = useState(String(savedLimit));
  const savedRetention = feed.retentionLimit ? String(feed.retentionLimit) : '';
  const [retention, setRetention] = useState(savedRetention);
  const [include, setInclude] = useState(feed.itemFilter?.include.join('\n') ?? '');
  const [exclude, setExclude] = useState(feed.itemFilter?.exclude.join('\n') ?? '');
  const [regex, setRegex] = useState(feed.itemFilter?.regex ?? false);
  const [preview, setPreview] = useState<OutputPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const filter = draftFilter(include, exclude, regex);
  const filterKey = JSON.stringify(filter);
  const filterDirty = filterKey !== JSON.stringify(feed.itemFilter ?? null);
  const limitNumber = Number(limit);
  const limitValid = !!limit && Number.isInteger(limitNumber) && limitNumber >= OUTPUT_LIMIT.min && limitNumber <= OUTPUT_LIMIT.max;
  const retentionNumber = Number(retention);
  const retentionMin = Math.max(RETENTION_LIMIT.min, limitValid ? limitNumber : OUTPUT_LIMIT.min);
  const retentionValid = !retention.trim() || Number.isInteger(retentionNumber) && retentionNumber >= retentionMin && retentionNumber <= RETENTION_LIMIT.max;
  const retentionAuto = feed.sourceType === 'rss' ? RETENTION_LIMIT.rssAuto : RETENTION_LIMIT.websiteAuto;
  const [networkProfileId, setNetworkProfileId] = useState(feed.networkProfileId ?? '');
  const profiles = useNetworkProfiles(setError);
  const networkDirty = networkProfileId !== (feed.networkProfileId ?? '');
  const isDirty = title !== feed.name || interval !== String(feed.intervalMinutes) || mode !== (feed.translationMode ?? 'bilingual') || limit !== String(savedLimit) || retention.trim() !== savedRetention || filterDirty || retranslates || networkDirty;
  dirty.current = isDirty;
  // Ask the server which stored items the draft would publish; it runs the same code as the feed output.
  useEffect(() => {
    if (!limitValid) return;
    let current = true;
    const timer = window.setTimeout(() => {
      api.feeds.outputPreview(feed.id, { itemFilter: JSON.parse(filterKey) as ItemFilter | null, outputLimit: limitNumber })
        .then(result => { if (current) { setPreview(result); setPreviewError(''); } })
        .catch(error => { if (current) { setPreview(null); setPreviewError(messageOf(error)); } });
    }, 350);
    return () => { current = false; window.clearTimeout(timer); };
  }, [feed.id, filterKey, limitNumber, limitValid, items]);
  function resetOutput(next: Feed) {
    setLimit(String(next.outputLimit ?? OUTPUT_LIMIT.default));
    setRetention(next.retentionLimit ? String(next.retentionLimit) : '');
    setInclude(next.itemFilter?.include.join('\n') ?? ''); setExclude(next.itemFilter?.exclude.join('\n') ?? ''); setRegex(next.itemFilter?.regex ?? false);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim()) { setError('请输入订阅名称'); return; }
    const minutes = Number(interval);
    if (!interval || !Number.isInteger(minutes) || minutes < 5 || minutes > 1440) { setError('刷新间隔必须是 5 到 1440 之间的整数'); return; }
    if (!limitValid) { setError(`输出条数必须是 ${OUTPUT_LIMIT.min} 到 ${OUTPUT_LIMIT.max} 之间的整数`); return; }
    if (!retentionValid) { setError(`保留条数必须是 ${retentionMin} 到 ${RETENTION_LIMIT.max} 之间的整数（不少于输出条数），留空为自动`); return; }
    setBusy('保存设置'); setError('');
    try {
      const result = await api.feeds.settings(feed.id, {
        ...(mode !== feed.translationMode ? { translationMode: mode } : {}),
        ...(language !== (feed.targetLanguage ?? 'zh-CN') ? { targetLanguage: language } : {}),
        ...(provider !== (feed.translationProvider ?? '') ? { translationProvider: provider || null } : {}),
        ...(title !== feed.name ? { channelTitle: title } : {}),
        ...(interval !== String(feed.intervalMinutes) ? { intervalMinutes: minutes } : {}),
        ...(limit !== String(savedLimit) ? { outputLimit: limitNumber } : {}),
        ...(retention.trim() !== savedRetention ? { retentionLimit: retention.trim() ? retentionNumber : null } : {}),
        ...(filterDirty ? { itemFilter: filter } : {}),
        ...(networkDirty ? { networkProfileId: networkProfileId || null } : {}),
      });
      saved(result); setTitle(result.feed.name); setIntervalValue(String(result.feed.intervalMinutes)); setMode(result.feed.translationMode ?? 'bilingual'); resetOutput(result.feed); setNetworkProfileId(result.feed.networkProfileId ?? '');
      setLanguage(result.feed.targetLanguage ?? 'zh-CN'); setProvider(result.feed.translationProvider ?? '');
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
        <Field label="输出模式" hint="开启翻译后，仅发布翻译完成的标题和已抓取内容；不会额外抓取文章全文。"><select aria-label="输出模式" disabled={!!busy} value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="original">原文（不翻译）</option><option value="bilingual">双语（译文在前）</option><option value="translated">仅译文</option></select></Field>
      </div>
      <NetworkProfileSelect value={networkProfileId} onChange={setNetworkProfileId} profiles={profiles} disabled={!!busy} />
      {mode !== 'original' && <div className="form-row">
        <Field label="目标语言"><select aria-label="目标语言" disabled={!!busy} value={language} onChange={e => setLanguage(e.target.value as TargetLanguage)}><LanguageOptions /></select></Field>
        <Field label="翻译服务" hint="服务由管理员在“设置”中配置。"><select aria-label="翻译服务" disabled={!!busy} value={provider} onChange={e => setProvider(e.target.value as TranslationProviderId | '')}><ProviderOptions info={providers} current={feed.translationProvider} /></select></Field>
      </div>}
      {retranslates && <p className="notice">更换目标语言或翻译服务后，已有文章会重新翻译；完成前它们暂不出现在订阅链接中。条目 ID 不变，阅读器不会重复推送。</p>}
      <fieldset className="output-settings" disabled={!!busy}>
        <legend>输出内容</legend>
        <p className="hint">RSS、Atom 和 JSON Feed 三种地址共用这些设置。过滤只影响输出，不删除已存储的条目，保存后立即生效。</p>
        <div className="form-row">
          <Field label="输出条数" hint={`每种地址最多输出的条目数，支持 ${OUTPUT_LIMIT.min}–${OUTPUT_LIMIT.max}。调小不会立即删除已存储的条目，下次抓取时按保留规则清理；调大后，新抓到的条目会逐步补足。`}><input type="number" required min={OUTPUT_LIMIT.min} max={OUTPUT_LIMIT.max} step={1} value={limit} onChange={e => setLimit(e.target.value)} /></Field>
          <Field label="保留条数" hint={`数据库最多保存的历史条目数。留空为自动：${feed.sourceType === 'rss' ? 'RSS 订阅' : '网页订阅'} ${retentionAuto} 条，输出数量更大时取输出数量。可设 ${retentionMin}–${RETENTION_LIMIT.max}，不能小于输出数量。调小同样在下次抓取时清理；网页上仍能看到的条目总会保留，避免被当作新条目重复推送。`}><input type="number" min={retentionMin} max={RETENTION_LIMIT.max} step={1} placeholder={`自动（${Math.max(retentionAuto, limitValid ? limitNumber : 0)}）`} value={retention} onChange={e => setRetention(e.target.value)} /></Field>
        </div>
        <div className="form-row">
          <Field label="包含关键词" hint="每行一个。填写后，只输出标题或摘要包含其中任意一个的条目。"><textarea rows={3} spellCheck={false} value={include} onChange={e => setInclude(e.target.value)} placeholder={'例如：\n发布\nrelease'} /></Field>
          <Field label="排除关键词" hint="每行一个。标题或摘要包含任意一个就不输出，优先于包含关键词。"><textarea rows={3} spellCheck={false} value={exclude} onChange={e => setExclude(e.target.value)} placeholder={'例如：\n广告\nsponsored'} /></Field>
        </div>
        <label className="checkbox-field"><input type="checkbox" checked={regex} onChange={e => setRegex(e.target.checked)} /><span>按正则表达式匹配（不区分大小写；每条不超过 {ITEM_FILTER_LIMITS.patternLength} 个字符，不支持嵌套重复和反向引用）</span></label>
        {previewError ? <p className="output-summary is-error" role="alert">{previewError}</p> : preview && <OutputSummary preview={preview} stored={items.length} />}
      </fieldset>
      <button className="button primary" disabled={!!busy || !isDirty}>{busy === '保存设置' ? <Busy label="正在保存" /> : '保存设置'}</button>
    </form>
    <section className="feed-settings-section" aria-label="更新与匹配">
      <div><h3>更新与匹配</h3><p className="hint">暂停后不再自动刷新，随时可以恢复。</p></div>
      <div className="detail-actions"><button className="button small" disabled={!!busy} onClick={() => void action('切换状态', () => api.feeds.toggle(feed.id), feed.enabled ? '订阅已暂停' : '订阅已恢复')}>{feed.enabled ? '暂停订阅' : '恢复订阅'}</button><button className="button small" disabled={!!busy} onClick={edit}><Pencil size={14} />{feed.sourceType === 'rss' ? '编辑 RSS 来源' : '编辑匹配规则'}</button></div>
    </section>
    <section className="feed-settings-section danger-zone" aria-label="订阅地址与删除">
      <div><h3>订阅地址与删除</h3><p className="hint">轮换密钥会立即使旧的 RSS、Atom 和 JSON Feed 地址全部失效；删除订阅会同时删除历史条目。</p></div>
      <div className="detail-actions"><button className="button small" disabled={!!busy} onClick={() => { if (confirm('轮换后，旧的 RSS、Atom 和 JSON Feed 地址将立即失效。继续？')) void action('轮换密钥', () => api.feeds.rotate(feed.id), '订阅地址已更新'); }}><KeyRound size={14} />轮换订阅密钥</button><button className="button small danger" disabled={!!busy} onClick={() => void remove()}><Trash2 size={14} />删除订阅</button></div>
    </section>
    {busy && !['保存设置', '刷新', '重试翻译'].includes(busy) && <Busy label={`正在${busy}`} />}
  </div>;
}

type SettingsSection = { id: string; label: string; icon: typeof Bell };

/** Settings sections available to this viewer, in navigation order. Admin-only groups stay admin-only. */
function settingsSections(admin: boolean, target?: UserSummary | null): SettingsSection[] {
  const instance = admin && !target;
  return [
    ...(instance ? [{ id: 'display', label: '日志与显示', icon: SlidersHorizontal }, { id: 'translation', label: '翻译服务', icon: Languages }, { id: 'server', label: '服务器与网络', icon: Server }] : []),
    { id: 'notifications', label: '通知', icon: Bell },
    { id: 'credentials', label: 'Cookie 凭据', icon: Cookie },
    { id: 'network', label: '网络配置', icon: Network },
    ...(!target ? [{ id: 'account', label: '账号与密码', icon: KeyRound }] : []),
    { id: 'tokens', label: '访问令牌', icon: KeySquare },
    ...(instance ? [{ id: 'backup', label: '备份与迁移', icon: Archive }] : []),
    { id: 'about', label: '关于', icon: Info },
  ];
}

// One settings group per page; the group is part of the address (#/settings/translation).
function SettingsView({ auth, logout, notify, target, section, onSection, dirty }: { auth: AuthState; logout: () => void; notify: Notify; target?: UserSummary | null; section: string | null; onSection: (id: string) => void; dirty: React.MutableRefObject<boolean> }) {
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sections = settingsSections(auth.role === 'admin', target);
  const active = sections.find(item => item.id === section) ?? sections[0];
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // On phones the navigation scrolls sideways: keep the current group in view.
    const nav = navRef.current, button = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && button && nav.scrollWidth > nav.clientWidth) nav.scrollTo({ left: button.offsetLeft - (nav.clientWidth - button.offsetWidth) / 2 });
  }, [active.id]);
  useEffect(() => {
    // Leaving the page with unsaved settings asks first.
    const warn = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function jump(id: string) {
    if (id === active.id) return;
    if (dirty.current && !confirm('当前分组有未保存的设置，确定放弃修改？')) return;
    dirty.current = false;
    onSection(id);
    window.scrollTo({ top: 0 });
  }
  const markDirty = useCallback((value: boolean) => { dirty.current = value; }, [dirty]);
  async function submit(event: FormEvent) { event.preventDefault(); if (newPassword !== confirmPassword) { setError('两次输入的新密码不一致'); return; } setBusy(true); setError(''); try { await api.auth.password({ currentPassword, newPassword }); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); notify('密码已修改，请重新登录'); logout(); } catch (error) { setError(messageOf(error)); } finally { setBusy(false); } }
  return <>
    <div className="page-heading"><div><span className="section-kicker">MAKE IT YOURS</span><h1>设置</h1><p>{auth.role === 'admin' && !target ? '管理整个实例的显示、翻译、网络，以及你的通知与账号。' : '管理通知、Cookie 凭据、网络配置、访问令牌与账号。'}</p></div></div>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分组" ref={navRef}>{sections.map(item => <button key={item.id} className={active.id === item.id ? 'selected' : ''} aria-current={active.id === item.id ? 'page' : undefined} onClick={() => jump(item.id)}><item.icon size={16} />{item.label}</button>)}</nav>
      <div className="settings-sections">
        <div id={`settings-${active.id}`} className="settings-section" key={active.id}>
          {(active.id === 'display' || active.id === 'translation' || active.id === 'server') && <ApplicationSettingsPanel group={active.id} revision={settingsRevision} onDirty={markDirty} />}
          {active.id === 'notifications' && <NotificationsPanel key={settingsRevision} username={target?.username ?? auth.username!} enabled={target?.enabled !== false} />}
          {active.id === 'credentials' && <CredentialsView notify={notify} />}
          {active.id === 'network' && <NetworkProfilesView notify={notify} />}
          {active.id === 'account' && <form className="panel settings-form" onSubmit={submit} aria-label="账号与密码"><div className="panel-heading"><h2>账号与密码</h2><KeyRound size={19} /></div><p className="muted">当前账号 {auth.username}（{auth.role === 'admin' ? '管理员' : '普通用户'}）。修改密码后会退出此账号的所有现有会话，并吊销全部访问令牌。</p><h3 className="settings-subheading">修改密码</h3><Field label="当前密码"><input required type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} autoComplete="current-password" /></Field><div className="form-row"><Field label="新密码"><input required type="password" minLength={8} maxLength={1024} value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" /></Field><Field label="确认新密码"><input required type="password" minLength={8} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" /></Field></div><ErrorNote error={error} /><button className="button primary" disabled={busy}>{busy ? <Busy /> : '更新密码'}</button></form>}
          {active.id === 'tokens' && <ApiTokensPanel notify={notify} target={target} />}
          {active.id === 'backup' && <BackupPanel onRestored={logout} onImported={() => setSettingsRevision(v => v + 1)} />}
          {active.id === 'about' && <section className="panel about-panel" aria-label="关于"><div className="panel-heading"><h2>关于</h2><Info size={19} /></div><Brand /><p>自动找到网页上的新内容，汇入你的 RSS 阅读器。</p><div className="about-row"><span>版本</span><code>{auth.version}</code></div><div className="about-row"><span>许可证</span><span>MIT</span></div><a className="text-link" href="https://github.com/Jaaayden/feedlantern" target="_blank" rel="noreferrer">查看开源项目<ExternalLink size={14} /></a><div className="notice">服务主机需要保持运行，定时更新才会继续。支持网页列表订阅与 RSS 翻译；RSS 全文以源内提供的内容为准，不自动补抓全文或翻页。</div></section>}
        </div>
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

function NewFeedMenu({ create, batch, bundle }: { create: (source: NewSource) => void; batch: () => void; bundle: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); ref.current?.querySelector<HTMLElement>('.split-toggle')?.focus(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
      const index = items.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    };
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
      <button role="menuitem" onClick={() => choose(bundle)}><span className="menu-icon"><Layers size={17} /></span><span><strong>聚合订阅</strong><small>把多个订阅合并成一个 RSS 地址</small></span></button>
    </div>}
  </div>;
}

type Page = 'feeds' | 'settings' | 'batch' | 'users';
type Route = { page: Page; panel: { id: string; tab: PanelTab } | null; create: NewSource | null; workspace: string | null; section?: string | null };

// Hash routes keep the current screen across reloads and make back/forward work:
// #/ · #/settings[/<group>] · #/users · #/batch · #/new · #/new/rss · #/feed/<id>[/logs|/settings]
// An admin working in another account's workspace gets a #/u/<userId> prefix.
function parseRoute(hash: string): Route {
  let parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  let workspace: string | null = null;
  if (parts[0] === 'u' && parts[1]) { workspace = parts[1]; parts = parts.slice(2); }
  const empty: Route = { page: 'feeds', panel: null, create: null, workspace };
  if (parts[0] === 'settings') return { ...empty, page: 'settings', section: parts[1] ?? null };
  if (parts[0] === 'users' || parts[0] === 'batch') return { ...empty, page: parts[0] };
  if (parts[0] === 'new') return { ...empty, create: parts[1] === 'rss' ? 'rss' : 'website' };
  if (parts[0] === 'feed' && parts[1]) return { ...empty, panel: { id: parts[1], tab: parts[2] === 'logs' || parts[2] === 'settings' ? parts[2] : 'items' } };
  return empty;
}

function routeHash(route: Route): string {
  const prefix = route.workspace ? `#/u/${encodeURIComponent(route.workspace)}` : '#';
  if (route.panel) return `${prefix}/feed/${encodeURIComponent(route.panel.id)}${route.panel.tab === 'items' ? '' : `/${route.panel.tab}`}`;
  if (route.create) return `${prefix}${route.create === 'rss' ? '/new/rss' : '/new'}`;
  if (route.page === 'settings' && route.section) return `${prefix}/settings/${encodeURIComponent(route.section)}`;
  return route.page === 'feeds' ? `${prefix}/` : `${prefix}/${route.page}`;
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [bootError, setBootError] = useState('');
  const [page, setPage] = useState<Page>('feeds');
  const [target, setTarget] = useState<UserSummary | null>(null);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [bundles, setBundles] = useState<BundlePayload[]>([]);
  // undefined: closed · {}: new bundle · {initial}: edit an existing one.
  const [bundleEditor, setBundleEditor] = useState<{ initial?: BundlePayload } | undefined>(undefined);
  const [bundleTarget, setBundleTarget] = useState<string[] | null>(null);
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
  const [users, setUsers] = useState<UserSummary[]>([]);
  const usersRef = useRef<UserSummary[]>([]);
  usersRef.current = users;
  const targetRef = useRef<string | null>(null);
  // True while a route's workspace is being resolved; the address bar must not be rewritten meanwhile.
  const resolvingRoute = useRef(false);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const settingsDirty = useRef(false);
  const showRoute = useCallback((route: Route) => {
    setPage(route.page); setPanel(route.panel); setEditorReturnId(null); setSettingsSection(route.section ?? null);
    if (route.create) { setEditorSource(route.create); setEditor(null); } else setEditor(undefined);
  }, []);
  // Switch the workspace (null = my own) and show the given screen inside it.
  const changeWorkspace = useCallback((user: UserSummary | null, route?: Route) => {
    authGeneration.current++; targetRef.current = user?.id ?? null;
    setWorkspaceUser(user?.id); setTarget(user); setFeeds([]); setBundles([]); setBundleEditor(undefined); setBundleTarget(null); setQuery(''); setStatus('all'); setError('');
    showRoute(route ?? { page: 'feeds', panel: null, create: null, workspace: user?.id ?? null });
  }, [showRoute]);
  const loadUsers = useCallback(async () => {
    try { const list = await api.users.list(); setUsers(list); return list; } catch { return usersRef.current; }
  }, []);
  const refreshUsers = useCallback(() => { void loadUsers(); }, [loadUsers]);
  const applyRoute = useCallback(async (route: Route, admin: boolean) => {
    const wanted = admin ? route.workspace : null;
    if ((wanted ?? null) === targetRef.current) { showRoute(route); return; }
    if (!wanted) { changeWorkspace(null, { ...route, workspace: null }); return; }
    resolvingRoute.current = true;
    let list = usersRef.current;
    try { if (!list.some(user => user.id === wanted)) list = await loadUsers(); } finally { resolvingRoute.current = false; }
    const user = list.find(item => item.id === wanted);
    // An unknown or deleted account falls back to my own workspace.
    changeWorkspace(user ?? null, user ? route : { page: route.page, panel: null, create: route.create, workspace: null });
  }, [changeWorkspace, loadUsers, showRoute]);
  const acceptAuth = useCallback((state: AuthState) => { authGeneration.current++; targetRef.current = null; setFeeds([]); setBundles([]); setWorkspaceUser(undefined); setTarget(null); setCsrfToken(state.csrfToken); setAuth(state); setSession(value => value + 1); void applyRoute(state.authenticated ? parseRoute(location.hash) : parseRoute(''), state.role === 'admin'); setQuery(''); setStatus('all'); setError(''); }, [applyRoute]);
  const forgetAuth = useCallback(() => { authGeneration.current++; targetRef.current = null; setUsers([]); setWorkspaceUser(undefined); setTarget(null); setCsrfToken(undefined); setAuth(previous => previous ? { ...previous, authenticated: false, csrfToken: undefined } : null); setFeeds([]); setBundles([]); setBundleEditor(undefined); setBundleTarget(null); setEditor(undefined); setPanel(null); setEditorReturnId(null); }, []);
  useEffect(() => { void api.auth.status().then(acceptAuth).catch(error => setBootError(messageOf(error))); return onUnauthorized(() => { forgetAuth(); setToast('登录已失效，请重新登录'); }); }, [acceptAuth, forgetAuth]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4000); return () => clearTimeout(timer); }, [toast]);
  const loadFeeds = useCallback(async () => {
    const generation = authGeneration.current; setLoading(true);
    try { const [next, nextBundles] = await Promise.all([api.feeds.list(), api.bundles.list()]); if (generation === authGeneration.current) { setFeeds(next); setBundles(nextBundles); setError(''); } }
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
  useEffect(() => { if (auth?.authenticated && auth.role === 'admin') void loadUsers(); }, [auth?.authenticated, auth?.role, session, loadUsers]);
  // Keep the address bar in step with the screen; back/forward replays it.
  const authenticated = !!auth?.authenticated;
  const editingExisting = editor !== undefined && editor !== null;
  const currentHash = routeHash({ page, panel, create: editor === null ? editorSource : null, workspace: target?.id ?? null, section: page === 'settings' ? settingsSection : null });
  const lastHash = useRef(currentHash);
  useEffect(() => {
    if (!authenticated || editingExisting || resolvingRoute.current) return;
    if (location.hash !== currentHash && !(currentHash === '#/' && !location.hash)) {
      const panelOf = (hash: string) => { const match = /^(#(?:\/u\/[^/]+)?\/feed\/[^/]+)/.exec(hash); return match ? match[1] : ''; };
      // Closing the panel or switching its tabs replaces the entry so Back is not cluttered.
      const replace = !!panelOf(lastHash.current) && (!panelOf(currentHash) || panelOf(currentHash) === panelOf(lastHash.current));
      if (replace) history.replaceState(null, '', currentHash); else history.pushState(null, '', currentHash);
    }
    lastHash.current = currentHash;
  }, [authenticated, editingExisting, currentHash]);
  useEffect(() => {
    if (!authenticated) return;
    const pop = () => void applyRoute(parseRoute(location.hash), auth?.role === 'admin');
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [authenticated, auth?.role, applyRoute]);
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
  const attention = feeds.filter(needsAttention).length;
  function navigate(next: Page) {
    if (page === 'settings' && next !== 'settings' && settingsDirty.current && !confirm('设置有未保存的修改，确定离开？')) return;
    if (next !== 'settings') settingsDirty.current = false;
    setPage(next); setEditor(undefined); setPanel(null); setEditorReturnId(null);
  }
  function create(source: NewSource) { setEditorSource(source); setEditor(null); }
  return <div className={`app-layout ${target ? 'managing' : ''}`}><aside className="sidebar"><Brand />{auth.role === 'admin' ? <WorkspaceSwitcher me={{ id: auth.userId!, username: auth.username! }} users={users} target={target} open={user => changeWorkspace(user)} manageUsers={() => navigate('users')} refresh={refreshUsers} /> : <div className="workspace-label">个人工作台</div>}<nav aria-label="主导航"><button className={page === 'feeds' || page === 'batch' ? 'selected' : ''} onClick={() => navigate('feeds')}><Rss size={19} />订阅管理<span>{feeds.length}</span></button><button className={page === 'settings' ? 'selected' : ''} onClick={() => navigate('settings')}><Settings2 size={19} />设置</button>{auth.role === 'admin' && <button className={page === 'users' ? 'selected' : ''} onClick={() => navigate('users')}><ShieldCheck size={19} />用户管理</button>}</nav><div className="sidebar-bottom"><div className="local-label"><span /> 自托管 · 独立运行</div><div className="account"><span className="avatar">{auth.username?.slice(0, 1).toUpperCase()}</span><div><strong>{auth.username}</strong><small>{auth.role === 'admin' ? '管理员' : '普通用户'}</small></div><button className="icon-button" aria-label="退出登录" onClick={() => void logout()}><LogOut size={17} /></button></div><span className="version">{auth.version}</span></div></aside><div className="main-shell"><header className="topbar"><span><span className="muted">工作台</span><span className="slash">/</span>{crumb}</span><span className="topbar-actions">{target && <span className="managing-chip" title="当前操作作用于此用户的订阅、凭据和个人设置">正在管理 {target.username}</span>}<ThemeToggle /><span className="topbar-status"><ShieldCheck size={14} /> 已安全登录 <button className="icon-button mobile-logout" aria-label="退出登录" onClick={() => void logout()}><LogOut size={15} /></button></span></span></header><main className="main-content" key={target?.id ?? auth.userId}>
    {target && <div className="workspace-banner" role="status"><div><strong>正在管理：{target.username}</strong><p>{target.enabled ? '修改将作用于此用户的订阅、凭据和个人设置。' : '此用户已停用，可以查看和修改静态配置；执行任务前请先启用。'}</p></div><button className="button small" onClick={() => changeWorkspace(null)}>返回我的工作台</button></div>}
    {page === 'users' && auth.role === 'admin' ? <UsersPanel currentUserId={auth.userId!} manage={(user, attention) => { changeWorkspace(user); if (attention) setStatus('attention'); }} changed={refreshUsers} identityChanged={() => void api.auth.status().then(acceptAuth)} /> : page === 'batch' ? <BatchView notify={notify} changed={() => void loadFeeds()} back={() => navigate('feeds')} /> : page === 'settings' ? <SettingsView target={target} auth={auth} logout={forgetAuth} notify={notify} section={settingsSection} onSection={setSettingsSection} dirty={settingsDirty} /> : editor !== undefined ? <FeedEditor key={editor?.id ?? `new-${editorSource}`} initial={editor ?? undefined} source={editorSource} existing={feeds} cancel={() => { setEditor(undefined); if (editorReturnId) setPanel({ id: editorReturnId, tab: 'settings' }); setEditorReturnId(null); }} saved={id => { setEditor(undefined); setPanel({ id, tab: editorReturnId ? 'settings' : 'items' }); setEditorReturnId(null); notify('订阅已保存'); void loadFeeds(); }} /> : <>
      <div className="page-heading"><div><span className="section-kicker">LESS CHECKING. MORE READING.</span><h1>你的订阅，持续点亮。</h1><p>把关注的网页汇集在这里，新内容会自动抵达。</p></div><NewFeedMenu create={create} batch={() => navigate('batch')} bundle={() => setBundleEditor({})} /></div>
      {feeds.length > 0 && <div className="stats-row"><div><span>全部订阅</span><strong>{feeds.length}<small>个来源</small></strong></div><div><span>正在关注</span><strong>{feeds.filter(feed => feed.enabled).length}<small>自动更新</small></strong></div><div><span>已收集内容</span><strong>{feeds.reduce((sum, feed) => sum + feed.itemCount, 0)}<small>条记录</small></strong></div>{attention ? <button className={`attention ${status === 'attention' ? 'active' : ''}`} aria-pressed={status === 'attention'} title={status === 'attention' ? '取消筛选，显示全部订阅' : '只看需要检查的订阅'} onClick={() => { const next = status === 'attention' ? 'all' : 'attention'; setStatus(next); if (next === 'attention') requestAnimationFrame(() => document.querySelector('.list-toolbar')?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }}><span>需要检查</span><strong>{attention}<small>{status === 'attention' ? '已筛选' : '点击筛选'}</small><ChevronRight size={15} className="stat-arrow" /></strong></button> : <div><span>需要检查</span><strong>0<small>一切正常</small></strong></div>}</div>}
      {bundles.length > 0 && <BundleSection bundles={bundles} feeds={feeds} create={() => setBundleEditor({})} edit={bundle => setBundleEditor({ initial: bundle })} changed={() => void loadFeeds()} notify={notify} />}
      <div className="list-toolbar"><h2>订阅列表 <span>{feeds.length}</span></h2><div className="input-icon search-input"><Search size={16} /><input ref={searchRef} aria-label="搜索订阅" placeholder="搜索名称或网址" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }} /><kbd className="search-key" aria-hidden="true">/</kbd></div></div>
      <ErrorNote error={error} />{loading && !feeds.length ? <Busy label="正在加载订阅" /> : filtered.length ? <FeedCollection auth={target ? { ...auth, userId: target.id, role: 'user' } : auth} feeds={filtered} bundles={bundles} addToBundle={ids => setBundleTarget(ids)} query={query} status={status} onStatus={setStatus} detail={id => setPanel({ id, tab: 'items' })} settings={id => setPanel({ id, tab: 'settings' })} logs={id => setPanel({ id, tab: 'logs' })} changed={() => void loadFeeds()} notify={notify} /> : <div className="empty-state"><span className="large-icon"><Rss size={32} /></span><h2>{query ? '没有找到匹配的订阅' : '从一个值得关注的网址开始'}</h2><p>{query ? '尝试其他名称或网址。' : '输入网页地址，自动识别内容，预览后即可生成 RSS。'}</p>{query ? <button className="button" onClick={() => setQuery('')}>清除搜索</button> : <button className="button" onClick={() => create('website')}><Plus size={16} />创建第一条订阅</button>}</div>}<div className="dashboard-note"><Sparkles size={17} /><span>自动识别先行，手动调整随时可用。</span><span className="muted">按 / 搜索订阅。</span></div></>}
  </main><footer className="page-footer"><span>FeedLantern · 订阅灯</span><a href="https://github.com/Jaaayden/feedlantern" target="_blank" rel="noreferrer">GitHub · Jaaayden/feedlantern · {auth.version}</a></footer></div>{panel && <FeedPanel key={panel.id} id={panel.id} tab={panel.tab} onTab={tab => setPanel(previous => previous && { ...previous, tab })} close={closePanel} edit={feed => { setPanel(null); setEditorReturnId(feed.id); setEditor(feed); }} changed={() => void loadFeeds()} notify={notify} />}{bundleEditor && <BundleEditor initial={bundleEditor.initial} feeds={feeds} close={() => setBundleEditor(undefined)} saved={(_result, created) => { setBundleEditor(undefined); notify(created ? '聚合订阅已创建' : '聚合订阅已保存'); void loadFeeds(); }} />}{bundleTarget && <AddToBundle bundles={bundles} feedIds={bundleTarget} close={() => setBundleTarget(null)} done={message => { setBundleTarget(null); notify(message); void loadFeeds(); }} />}{toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}</div>;
}
