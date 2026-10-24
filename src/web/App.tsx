import type { UserSummary } from '../shared/types';
import { NotificationsPanel } from './NotificationsPanel';
import { UsersPanel } from './UsersPanel';
import { feedFormatUrl, isFeedSource, ITEM_FILTER_LIMITS, OUTPUT_LIMIT, RETENTION_LIMIT, translationEnabled } from '../shared/types';
import type { FeedFormat, ItemFilter, ItemOutputStatus } from '../shared/types';
import { TranslationLog } from './TranslationProgress';
import { ItemPreview } from './ItemList';
import { LanguageOptions, ProviderOptions, useTranslationProviders } from './TranslationFields';
import { RssEditor } from './RssEditor';
import { PubmedEditor } from './PubmedEditor';
import { PubmedBatchConvert, PubmedRssNotice, isPubmedRss } from './PubmedConvert';
import { pubmedConversion, pubmedRssSource, type PubmedBuilder } from '../shared/pubmed';
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
import { Archive, BookOpen, Microscope, ChevronRight, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Check, ChevronDown, CircleHelp, Cookie, Copy, ExternalLink, Globe2, Info, KeyRound, KeySquare, Languages, Layers, ListPlus, LoaderCircle, LogOut, Monitor, Moon, Network, MousePointer2, Pencil, Plus, Radio, RefreshCw, Rss, Search, Server, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Sun, Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { NetworkProfileSelect, NetworkProfilesView, useNetworkProfiles } from './NetworkProfiles';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { absoluteTime, copyText, relativeTime, sameAddress } from './format';
import type { StatusFilter } from './FeedCollection';
import { readTheme, saveTheme, themeLabel } from './theme';
import { adoptAccountLocale, adoptGuestLocale, fmt, t, useLocale } from './i18n';
import { LanguageSelect } from './LanguageSelect';
import type { Theme } from './theme';
import { api, onUnauthorized, setCsrfToken, setWorkspaceUser } from './api';
import type { TargetLanguage, TranslationMode, TranslationProviderId } from '../shared/types';
import type { CredentialPayload, OutputPreview } from './api';
import type { BundlePayload } from '../shared/types';
import type { PubmedRssCheck } from '../shared/types';
import type { AuthState, CredentialSummary, DetectionCandidate, DetectionResult, ExtractedItem, Feed, FeedInput, FeedItem, FieldName, PaginationReport, PaginationRules, PickResult, Rect, RuleOrigins, ScreenFrame, SelectionRules } from '../shared/types';

type Notify = (message: string) => void;
const keys: Array<'item' | FieldName> = ['item', 'title', 'link', 'description', 'image', 'date'];
const fieldLabel = (key: 'item' | FieldName) => t(`field.${key}`);
const emptyRules: SelectionRules = { item: '', title: '', link: '' };
const rulesSignature = (rules: SelectionRules) => JSON.stringify(keys.map(key => [key, rules[key] ?? '']));
const messageOf = (error: unknown) => error instanceof Error ? error.message : t('common.notDone');
const dateLabel = (value?: string | null) => value ? fmt.date(value, { dateStyle: 'short', timeStyle: 'medium' }) : t('feed.neverUpdated');
const hostLabel = (url: string) => { try { return new URL(url).host; } catch { return url; } };
function Busy({ label }: { label?: string }) { return <span className="inline"><LoaderCircle size={16} className="spin" />{label ?? t('common.busy')}</span>; }
function ErrorNote({ error }: { error?: string }) { return error ? <div className="error-note" role="alert">{error}</div> : null; }
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function Brand({ compact = false }: { compact?: boolean }) { return <div className="brand"><img className="brand-logo" src="/favicon.svg" alt="" width={40} height={40} /><span>FeedLantern{!compact && t('app.tagline') && <small>{t('app.tagline')}</small>}</span></div>; }

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
  return <div className="auth-page"><section className="auth-story"><Brand /><div className="auth-copy"><span className="eyebrow">YOUR WEB, ON YOUR TERMS</span><h1>{t('auth.heroLine1')}<br />{t('auth.heroLine2')}</h1><p>{t('auth.leadLine1')}<br />{t('auth.leadLine2')}</p><div className="auth-illustration" aria-hidden="true"><div className="paper paper-back" /><div className="paper"><span className="paper-dot" /><div className="paper-line" /><div className="paper-line short" /><div className="paper-picture" /><div className="paper-line" /><div className="paper-line short" /></div><span className="floating-rss"><Rss size={34} /></span></div></div><div className="auth-footer"><ShieldCheck size={16} /> {t('auth.footer')}</div></section><section className="auth-form-panel"><div className="auth-form"><div className="auth-form-top"><span className="section-kicker">FEEDLANTERN / {state.setupRequired ? 'WELCOME' : 'SIGN IN'}</span><LanguageSelect compact /></div><h2>{state.setupRequired ? t('auth.setupTitle') : t('auth.welcomeBack')}</h2><p className="muted">{state.setupRequired ? t('auth.setupLead') : t('auth.signInLead')}</p><form onSubmit={submit}>
    {state.setupRequired && <Field label={t('auth.setupCode')} hint={t('auth.setupCodeHint')}><input required type="password" value={setupToken} onChange={e => setSetupToken(e.target.value)} autoComplete="off" placeholder={t('auth.setupCodePlaceholder')} /></Field>}
    <Field label={t('auth.username')}><input required value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" maxLength={100} /></Field>
    <Field label={t('auth.password')} hint={state.setupRequired ? t('auth.passwordHint') : undefined}><input required type="password" autoFocus={!state.setupRequired && !!username} minLength={8} maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} autoComplete={state.setupRequired ? 'new-password' : 'current-password'} /></Field>
    <ErrorNote error={error} /><button className="button primary full" disabled={busy}>{busy ? <Busy /> : <>{state.setupRequired ? t('auth.createAdmin') : t('auth.signIn')}<ArrowRight size={17} /></>}</button>
  </form><p className="auth-note"><KeyRound size={14} />{state.setupRequired ? t('auth.setupNote') : t('auth.forgotNote')}</p>{state.setupRequired && <BackupPanel setup onRestored={() => location.reload()} />}<span className="version">{state.version} · <a href="https://github.com/Jaaayden/feedlantern" target="_blank" rel="noreferrer">GitHub · Jaaayden/feedlantern</a></span></div></section></div>;
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
  return <form onSubmit={submit} className="modal-body"><p className="muted">{t('cookies.formLead')}</p><details className="advanced cookie-help"><summary>{t('cookies.howTo')}<ChevronDown size={14} /></summary><ol><li>{t('cookies.step1')}</li><li>{t('cookies.step2')}</li><li>{t('cookies.step3Before')}<code>Cookie</code>{t('cookies.step3After')}</li><li>{t('cookies.step4')}</li></ol><p className="hint">{t('cookies.howToHint')}</p></details><Field label={t('label.credentialName')}><input required value={name} onChange={e => setName(e.target.value)} placeholder={t('cookies.namePlaceholder')} /></Field><Field label={t('cookies.url')} hint={t('cookies.urlHint')}><input required type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/articles" /></Field><Field label={t('cookies.format')}><select value={format} onChange={e => { setFormat(e.target.value as 'header' | 'json'); setValue(''); }}><option value="header">{t('cookies.formatHeader')}</option><option value="json">OpenCookie / JSON</option></select></Field><Field label={t('label.cookieValue')} hint={editing ? t('cookies.valueHintEdit') : t('cookies.valueHint')}><textarea required value={value} onChange={e => setValue(e.target.value)} rows={6} autoComplete="off" spellCheck={false} placeholder={format === 'json' ? '[{"name":"session", "value":"…", "domain":"example.com"}]' : 'session=…; preference=…'} /></Field>{format === 'json' && <Field label={t('cookies.file')}><input type="file" accept=".json,application/json" onChange={async e => { const file = e.target.files?.[0]; if (file) { if (file.size > 1024 * 1024) setError(t('cookies.fileTooLarge')); else setValue(await file.text()); } e.target.value = ''; }} /></Field>}<ErrorNote error={error} /><div className="modal-actions"><button type="button" className="button" onClick={cancel}>{t('common.cancel')}</button><button className="button primary" disabled={busy}>{busy ? <Busy /> : t('cookies.save')}</button></div></form>;
}

function CredentialsView({ notify }: { notify: Notify }) {
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<CredentialSummary | null | undefined>(undefined);
  const load = useCallback(async () => { try { setCredentials(await api.credentials.list()); } catch (error) { setError(messageOf(error)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const close = useCallback(() => setEditing(undefined), []);
  async function remove(item: CredentialSummary) { if (!confirm(t('cookies.confirmDelete', { name: item.name }))) return; try { await api.credentials.remove(item.id); notify(t('cookies.deleted')); await load(); } catch (error) { setError(messageOf(error)); } }
  return <section className="panel settings-form credentials-panel" aria-label={t('cookies.title')}><div className="panel-heading"><h2>{t('cookies.title')}</h2><button className="button small" onClick={() => setEditing(null)}><Plus size={15} />{t('cookies.add')}</button></div><p className="muted">{t('cookies.lead')}</p><ErrorNote error={error} /><div className="info-strip"><ShieldCheck size={18} /><span>{t('cookies.info')}</span></div>{loading ? <Busy label={t('cookies.loading')} /> : credentials.length ? <div className="credential-grid">{credentials.map(item => <article className="credential-card" key={item.id}><div className="card-top"><span className="soft-icon"><Cookie size={21} /></span><div className="inline"><button className="icon-button" title={t('cookies.update')} aria-label={t('cookies.updateOf', { name: item.name })} onClick={() => setEditing(item)}><Pencil size={16} /></button><button className="icon-button danger" aria-label={t('cookies.deleteOf', { name: item.name })} onClick={() => void remove(item)}><Trash2 size={16} /></button></div></div><h3>{item.name}</h3><p className="muted">{item.domains.join(' · ')}</p><div className="credential-meta"><span>{t('cookies.count', { count: item.count })}</span><span>{t('cookies.updatedAt', { time: dateLabel(item.updatedAt) })}</span><span>{item.expiresAt ? t('cookies.expires', { time: dateLabel(item.expiresAt) }) : t('cookies.session')}</span></div></article>)}</div> : <div className="empty-state"><span className="large-icon"><Cookie size={30} /></span><h2>{t('cookies.emptyTitle')}</h2><p>{t('cookies.emptyBody')}</p><button className="button" onClick={() => setEditing(null)}><Plus size={16} />{t('cookies.addFirst')}</button></div>}{editing !== undefined && <Modal title={editing ? t('cookies.updateTitle') : t('cookies.addTitle')} close={close}><CredentialForm editing={editing ?? undefined} cancel={close} done={() => { close(); notify(t('cookies.saved')); void load(); }} /></Modal>}</section>;
}

function FeedEditor({ source: initialSource, convert: initialConvert = false, check, ...props }: { initial?: Feed; source?: NewSource; convert?: boolean; check?: PubmedRssCheck; existing?: Feed[]; saved: (id: string) => void; cancel: () => void }) {
  const [source, setSource] = useState<NewSource>(props.initial?.sourceType ?? initialSource ?? 'website');
  // Converting a PubMed RSS feed opens the PubMed editor on the same feed; a new PubMed RSS address can start a prefilled search.
  const [convert, setConvert] = useState(initialConvert);
  const [prefill, setPrefill] = useState<{ builder: PubmedBuilder; limit: number }>();
  const pubmed = source === 'pubmed' || convert;
  const usePubmed = (url: string) => {
    const rss = pubmedRssSource(url);
    if (props.initial) { setConvert(true); return; }
    setPrefill(rss ? pubmedConversion(rss) : undefined); setSource('pubmed');
  };
  return <>{!props.initial && <div className="detail-actions source-switch" aria-label={t('editor.sourceType')}><button className="button" aria-pressed={source === 'website'} onClick={() => setSource('website')}>{t('newFeed.website')}</button><button className="button" aria-pressed={source === 'rss'} onClick={() => setSource('rss')}>{t('newFeed.rss')}</button><button className="button" aria-pressed={source === 'pubmed'} onClick={() => setSource('pubmed')}>{t('newFeed.pubmed')}</button></div>}{pubmed ? <PubmedEditor key={prefill ? 'prefilled' : 'blank'} {...props} convert={convert} check={check} prefill={prefill} /> : source === 'rss' ? <RssEditor {...props} usePubmed={usePubmed} /> : <Editor {...props} />}</>;
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
  // Last picked element (and the element under the pointer at the time), for Widen/Narrow.
  const [lastPick, setLastPick] = useState<{ base: number; node: number } | null>(null);
  // Loading of the next screenshot segment below what is shown.
  const [segmentState, setSegmentState] = useState<SegmentState>('idle');
  const segmentLoading = useRef(false);
  const [target, setTarget] = useState<'item' | FieldName | 'next'>('item');
  const [pagination, setPagination] = useState<PaginationRules | null>(initial?.pagination ?? draft?.pagination ?? null);
  const [pageReport, setPageReport] = useState<PaginationReport | null>(null);
  const pickNext = pagination?.mode === 'next' || pagination?.mode === 'loadMore';
  const nextLabel = pagination?.mode === 'loadMore' ? t('pagination.moreControl') : t('pagination.nextControl');
  const targetLabel = target === 'next' ? nextLabel : fieldLabel(target);
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
    setBusy(t('editor.testingPages', { count: pagination.maxPages, seconds: Math.round(pagination.delayMs / 1000) })); setError('');
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
      setNote(t('editor.keptManual'));
    } else setNote(candidate.warnings.join(t('punctuation.semicolon')));
    setRules(next); setOrigins(nextOrigins); setCandidateId(candidate.id); setRects(candidate.rects); await preview(next, id);
  }
  async function detect(id: string) {
    const result = await api.browser.detect(id); setDetection(result);
    const recommended = result.candidates.find(item => item.id === result.recommendedId);
    if (recommended) await applyCandidate(recommended, false, id);
    else if (result.candidates.length === 1) { await applyCandidate(result.candidates[0], false, id); setNote(t('editor.oneCandidate')); }
    else { setNote(result.warnings.join(t('punctuation.semicolon')) || t('editor.severalCandidates')); if (!initial) { setItems([]); setCandidateId(''); } }
    if (!result.candidates.length) setAdjusting(true);
  }
  async function open(event?: FormEvent, target = url) {
    event?.preventDefault(); setError(''); setNote(''); setBusy(t('editor.opening'));
    try {
      if (sessionRef.current) { await api.browser.close(sessionRef.current).catch(() => {}); sessionRef.current = null; }
      const result = await api.browser.open({ url: target, credentialId: credentialId || null, networkProfileId: networkProfileId || null, waitMs, waitForSelector: waitForSelector || undefined });
      if (!mountedRef.current) { await api.browser.close(result.sessionId).catch(() => {}); return; }
      sessionRef.current = result.sessionId; setFrame(result); setSourceKey(JSON.stringify([target, credentialId, networkProfileId, waitMs, waitForSelector])); setRects([]); setNavigated(false); setLastPick(null);
      if (!name) setName(result.title || hostLabel(target));
      if (initial) { await preview(rules, result.sessionId); setNote(t('editor.loadedRules')); }
      else await detect(result.sessionId);
    } catch (error) { setFrame(null); setError(messageOf(error)); } finally { setBusy(''); }
  }
  async function rescan() { if (!frame) return; setBusy(t('editor.redetecting')); setError(''); try { await detect(frame.sessionId); } catch (error) { setError(messageOf(error)); } finally { setBusy(''); } }
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
    if (key === 'item') setNote(t('editor.itemChanged'));
  }
  async function frameAction(operation: () => Promise<ScreenFrame>) {
    setBusy(t('editor.updatingPage')); setError('');
    try { const result = await operation(); setFrame(result); setRects([]); setLastPick(null); } catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  async function pickAt(choice: ScreenChoice) {
    if (!frame || busy) return;
    if (navigated) { setNote(t('editor.notSource')); return; }
    setBusy(t('editor.locating')); setError('');
    try {
      const at = choice.node !== undefined ? { node: choice.node, ...(choice.exact ? { exact: true } : {}) } : { x: choice.x, y: choice.y };
      if (target === 'next') {
        const picked = await api.browser.pick(frame.sessionId, { ...at, target });
        setPagination(previous => previous && { ...previous, nextSelector: picked.selector });
        setRects(picked.rects);
        setLastPick(picked.node !== undefined ? { base: choice.base ?? picked.node, node: picked.node } : null);
        setNote([t('editor.matched', { target: nextLabel, count: picked.count }), picked.count > 1 ? t('editor.firstOnly') : '', picked.warning ?? ''].filter(Boolean).join(' '));
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
    setNote([t('editor.matched', { target: targetLabel, count: picked.count }), picked.warning ?? '', picked.datePreview ? `${picked.datePreview.dateText} → ${dateLabel(picked.datePreview.publishedAt)}${picked.datePreview.publishedAtSource === 'relative' ? t('item.estimated') : ''}` : ''].filter(Boolean).join(' '));
  }
  // Widen or narrow the last pick along the chain from the pointed element outwards.
  async function resize(delta: 1 | -1) {
    const map = frame?.map;
    if (!map || !lastPick) return;
    let base = lastPick.base;
    let level = levelsBetween(map, base, lastPick.node);
    if (level < 0) { base = lastPick.node; level = 0; }
    const node = liftNode(map, base, Math.max(0, level + delta));
    if (node === lastPick.node) { setNote(delta > 0 ? t('editor.outermost') : t('editor.innermost')); return; }
    await pickAt({ x: 0, y: 0, base, node, exact: true });
  }
  async function followLink(node: number, href: string | undefined) {
    if (!frame || busy) return;
    if (!href) { setNote(t('editor.notLink', { key: linkModifier })); return; }
    setBusy(t('editor.openingLink')); setError('');
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
    if (paginationProblem(pagination)) { setNote(t('editor.paginationIncomplete', { problem: paginationProblem(pagination) })); return; }
    if (navigated || !sourceUnchanged || !items.length || previewSignature !== rulesSignature(rules)) {
      if (sourceUnchanged && rulesSignature(rules) !== previewSignature) setNote(t('editor.previewPending'));
      return;
    }
    setBusy(t('editor.saving')); setError('');
    try { const body: FeedInput = { name, url, credentialId: credentialId || null, networkProfileId: networkProfileId || null, rules, ruleOrigins: origins, intervalMinutes, waitMs, waitForSelector: waitForSelector || undefined, pagination }; const result = submitFeed ? await submitFeed(body) : initial ? await api.feeds.update(initial.id, body) : await api.feeds.create(body); saved(result.feed.id); }
    catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  const chosen = detection?.candidates.find(item => item.id === candidateId);
  const duplicate = !initial ? existing.find(feed => (feed.sourceType ?? 'website') === 'website' && sameAddress(feed.url, url)) : undefined;
  return <><button className="back-link" onClick={cancel}><ArrowLeft size={16} />{t('common.backToFeeds')}</button><div className="page-heading"><div><span className="section-kicker">A NEW WAY TO FOLLOW</span><h1>{initial ? t('editor.editRules') : t('editor.title')}</h1><p>{t('editor.lead')}</p></div><span className="step-label">{frame ? t('editor.step2') : t('editor.step1')}</span></div>
    <form className="source-panel" onSubmit={open}><div className="source-row"><Field label={t('editor.sourceUrl')}><div className="input-icon"><Globe2 size={18} /><input required type="url" placeholder="https://example.com/articles" value={url} onChange={e => setUrl(e.target.value)} /></div></Field><Field label={t('cookies.title')} hint={credentials.length ? undefined : t('editor.cookieHint')}><select value={credentialId} onChange={e => setCredentialId(e.target.value)}><option value="">{t('editor.noCookie')}</option>{credentials.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><button className="button primary source-submit" disabled={!!busy}>{busy ? <Busy /> : <><Sparkles size={17} />{t('editor.openDetect')}</>}</button></div><details className="advanced" open={!!networkProfileId || undefined}><summary>{t('editor.loadSettings')}<ChevronDown size={14} /></summary><div className="form-row"><NetworkProfileSelect value={networkProfileId} onChange={setNetworkProfileId} profiles={profiles} /></div><div className="form-row"><Field label={t('editor.waitMs')}><input type="number" min={0} max={10000} step={100} value={waitMs} onChange={e => setWaitMs(Number(e.target.value))} /></Field><Field label={t('editor.waitFor')}><input value={waitForSelector} onChange={e => setWaitForSelector(e.target.value)} placeholder={t('editor.waitForPlaceholder')} /></Field></div></details></form>
    {duplicate && <div className="notice duplicate-note"><CircleHelp size={16} /><span>{t('editor.duplicate', { name: duplicate.name })}</span></div>}
    <ErrorNote error={error} />{busy && <div className="progress-strip" role="status"><Busy label={busy} /></div>}
    {!frame && !busy && <div className="editor-welcome"><div className="welcome-step"><span>01</span><Globe2 size={23} /><h3>{t('editor.welcome1Title')}</h3><p>{t('editor.welcome1Body')}</p></div><div className="welcome-step"><span>02</span><Sparkles size={23} /><h3>{t('editor.welcome2Title')}</h3><p>{t('editor.welcome2Body')}</p></div><div className="welcome-step"><span>03</span><Rss size={23} /><h3>{t('editor.welcome3Title')}</h3><p>{t('editor.welcome3Body')}</p></div></div>}
    {frame && <><div className="result-toolbar"><div><span className={`badge ${chosen?.confidence === 'high' ? 'good' : ''}`}><Sparkles size={13} />{chosen?.confidence === 'high' ? t('editor.autoMatched') : t('editor.matchResult')}</span><span className="muted">{t('editor.itemCount', { count: items.length })}</span></div><div className="inline"><button type="button" className="button small" onClick={() => void rescan()} disabled={!!busy}><RefreshCw size={14} />{t('health.redetect')}</button><button type="button" className="button small" disabled={!!busy} onClick={() => setAdjusting(!adjusting)}><MousePointer2 size={14} />{adjusting ? t('editor.closeAdjust') : t('editor.adjust')}</button></div></div>{note && <div className="notice"><CircleHelp size={16} /><span>{note}</span></div>}{!sourceUnchanged && <div className="notice">{t('editor.sourceChanged')}</div>}
    {!!detection?.candidates.length && (detection.candidates.length > 1 || !candidateId) && <div className="candidate-grid">{detection.candidates.map(candidate => <button key={candidate.id} className={`candidate ${candidate.id === candidateId ? 'selected' : ''}`} disabled={!!busy} onClick={() => void applyCandidate(candidate)}><span className="inline"><Radio size={15} />{candidate.label}<span className="muted">{t('health.count', { count: candidate.count })}</span></span><strong>{candidate.items[0]?.title ?? t('editor.viewCandidate')}</strong><small>{candidate.confidence === 'high' ? t('editor.confident') : t('editor.checkSamples')}</small></button>)}</div>}
    {adjusting && <section className="adjust-panel"><div className="adjust-heading"><h2>{t('editor.adjustTitle')}</h2><div className="inline">{(frame.map ? frame.map.innerScroll : frame.height <= frame.viewportHeight) && <><button className="icon-button" aria-label={t('editor.scrollUp')} title={t('editor.scrollTitle')} disabled={!!busy} onClick={() => void frameAction(() => api.browser.scroll(frame.sessionId, -500))}><ArrowUp size={17} /></button><button className="icon-button" aria-label={t('editor.scrollDown')} title={t('editor.scrollTitle')} disabled={!!busy} onClick={() => void frameAction(() => api.browser.scroll(frame.sessionId, 500))}><ArrowDown size={17} /></button></>}<button className="icon-button" aria-label={t('editor.refreshView')} title={t('editor.refreshViewTitle')} disabled={!!busy} onClick={() => void frameAction(() => api.browser.frame(frame.sessionId))}><RefreshCw size={16} /></button></div></div>
      <div className="field-tabs">{keys.map(key => <button className={target === key ? 'selected' : ''} key={key} onClick={() => { setTarget(key); setLastPick(null); }}>{fieldLabel(key)}{rules[key] && <Check size={12} />}</button>)}{pickNext && <button className={target === 'next' ? 'selected' : ''} onClick={() => { setTarget('next'); setLastPick(null); }}>{pagination?.mode === 'loadMore' ? t('common.loadMore') : t('editor.nextPage')}{pagination?.nextSelector && <Check size={12} />}</button>}<span className="scope-controls"><button className="button small" disabled={!!busy || !lastPick} title={t('editor.widenTitle')} onClick={() => void resize(1)}><ArrowUp size={14} />{t('editor.widen')}</button><button className="button small" disabled={!!busy || !lastPick} title={t('editor.narrowTitle')} onClick={() => void resize(-1)}><ArrowDown size={14} />{t('editor.narrow')}</button></span></div>
      <p className="hint">{t('editor.pickHintBefore')}<strong>{targetLabel}</strong>{t('editor.pickHintAfter', { key: linkModifier })}</p>
      {navigated && <div className="notice navigated-notice" role="status"><Globe2 size={16} /><span>{t('editor.navigatedBefore')}<code>{frame.url}</code>{t('editor.navigatedAfter')}</span><span className="inline"><button className="button small primary" disabled={!!busy} onClick={adoptCurrentPage}>{t('editor.adopt')}</button><button className="button small" disabled={!!busy} onClick={() => void open()}>{t('editor.backToSource')}</button></span></div>}
      <div className="browser-bar"><span /><span /><span /><code>{frame.url}</code>{busy && <small className="browser-busy"><LoaderCircle size={13} className="spin" />{busy}</small>}</div>
      <PageScreen frame={frame} rects={rects} disabled={!!busy || segmentState === 'loading'} navigated={navigated} revealKey={[frame.image.length, frame.url, candidateId].join('|')} segmentState={segmentState} loadMore={() => void loadMore()} pick={choice => void pickAt(choice)} follow={(node, href) => void followLink(node, href)} />
      <details className="advanced"><summary>{t('editor.advanced')}<ChevronDown size={14} /></summary><div className="selector-grid">{keys.map(key => <Field key={key} label={t('editor.selectorOf', { field: fieldLabel(key) })} hint={origins[key] === 'manual' ? t('editor.manualKept') : t('editor.auto')}><input value={rules[key] ?? ''} onChange={e => changeRule(key, e.target.value)} placeholder={key === 'item' ? 'article' : key === 'title' || key === 'link' ? 'h2 a' : t('editor.optional')} spellCheck={false} /></Field>)}</div>{chosen && <button type="button" className="button small" onClick={() => { if (confirm(t('editor.confirmReplaceAll'))) void applyCandidate(chosen, true); }}>{t('editor.replaceAll')}</button>}</details></section>}
    <PaginationPanel value={pagination} onChange={setPagination} disabled={!!busy} report={pageReport} onTest={() => void testPages()} onPick={() => { setAdjusting(true); setTarget('next'); setLastPick(null); setNote(t('editor.clickBelow', { target: nextLabel })); }} />
    <div className="editor-results"><section className="panel"><div className="panel-heading"><h2>{t('editor.preview')}</h2><span className="muted">{t('editor.previewNote')}</span></div><ItemPreview items={items} empty={detection?.candidates.length ? t('editor.emptyWithCandidates') : t('editor.emptyNoCandidates')} /></section><form className="save-panel panel" onSubmit={save}><div className="panel-heading"><h2>{t('editor.saveTitle')}</h2><Rss size={18} /></div><Field label={t('label.feedName')}><input required value={name} onChange={e => setName(e.target.value)} /></Field><Field label={t('label.intervalMinutes')}><input type="number" required min={5} max={1440} value={intervalMinutes} onChange={e => setIntervalMinutes(Number(e.target.value))} /></Field><p className="hint">{t('editor.saveHint')}</p><button className="button primary full" disabled={!!busy || navigated || !items.length || !sourceUnchanged || previewSignature !== rulesSignature(rules) || !!paginationProblem(pagination)}>{busy === t('editor.saving') ? <Busy /> : <><Check size={16} />{t('editor.saveTitle')}</>}</button></form></div></>}
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
    <div className="feed-address-head"><span>{t('feedAddress.title')}</span><div className="format-switch" role="group" aria-label={t('feedAddress.format')}>{formatOptions.map(([key, text]) => <button key={key} type="button" className="button small" aria-pressed={format === key} onClick={() => choose(key)}>{text}</button>)}</div></div>
    <div className="copy-row"><input readOnly aria-label={t('feedAddress.addressOf', { format: label })} value={url} onFocus={e => e.target.select()} /><a className="icon-button" href={url} target="_blank" rel="noreferrer" title={t('feedAddress.open')} aria-label={t('feedAddress.open')}><ExternalLink size={16} /></a><button className="button primary" onClick={() => void copyText(url).then(() => notify(t('feedAddress.copied', { format: label }))).catch(() => onError(t('feedAddress.copyFailed')))}><Copy size={15} />{t('feedAddress.copy', { format: label })}</button></div>
    <small>{t('feedAddress.hint')}</small>
  </div>;
}

/** Counts behind the "output / filtered" summaries. */
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
  return <p className="output-summary" aria-live="polite">{[t('output.summary', { stored, published: counts.published }), counts.filtered ? t('output.filtered', { count: counts.filtered }) : '', counts.overLimit ? t('output.overLimit', { count: counts.overLimit }) : '', counts.untranslated ? t('output.untranslated', { count: counts.untranslated }) : ''].filter(Boolean).join(t('punctuation.comma'))}{preview.filterTimedOut ? t('output.regexTimeout') : ''}</p>;
}

function FeedStatus({ feed, retry, busy }: { feed: Feed; retry: () => void; busy: boolean }) {
  const unfinished = (feed.translation?.pending ?? 0) + (feed.translation?.failed ?? 0);
  return <><div className="detail-status"><span>{t('feed.every', { count: feed.intervalMinutes })}</span><span title={absoluteTime(feed.lastSuccessAt)}>{t('collection.lastSuccess', { time: feed.lastSuccessAt ? relativeTime(feed.lastSuccessAt) : t('feed.neverUpdated') })}</span><span title={feed.enabled ? absoluteTime(feed.nextFetchAt) : undefined}>{feed.enabled ? t('feed.nextCheck', { time: feed.nextFetchAt ? relativeTime(feed.nextFetchAt) : t('feed.notScheduled') }) : t('feed.autoPaused')}</span></div><ErrorNote error={feed.lastError ?? undefined} />{translationEnabled(feed) && feed.translation && <div className="translation-summary"><p role="status">{t('feed.translationStatus', { done: feed.translation.success, waiting: feed.translation.pending })} · <span className={feed.translation.failed ? 'has-failed' : undefined}>{t('feed.translationFailed', { count: feed.translation.failed })}</span></p>{unfinished > 0 && <button type="button" className="button small" disabled={busy || !feed.enabled} title={feed.enabled ? t('feed.retryTitle') : t('feed.pausedTitle')} onClick={retry}><RefreshCw size={13} className={busy ? 'spin' : undefined} />{t('feed.retryTranslation')}</button>}</div>}</>;
}

type PanelTab = 'items' | 'logs' | 'settings';
const panelTabs = (): Array<[PanelTab, string]> => [['items', t('panel.items')], ['logs', t('panel.logs')], ['settings', t('feed.settings')]];

/**
 * The activity tab: fetch runs and, for translated feeds, translation activity. They
 * are two segments rather than one merged timeline: fetch runs page through a
 * long history by status, translation events are a short rolling window with
 * a live article queue, and each keeps its own refresh pace.
 */
function ActivityTab({ feed, revision }: { feed: Feed; revision: number }) {
  const translated = translationEnabled(feed);
  const [view, setView] = useState<'fetch' | 'translation'>('fetch');
  const failed = feed.translation?.failed ?? 0;
  return <div className="activity">
    {translated && <div className="detail-actions activity-switch" role="group" aria-label={t('panel.logType')}>
      <button type="button" className="button small" aria-pressed={view === 'fetch'} onClick={() => setView('fetch')}>{t('panel.fetchLog')}</button>
      <button type="button" className="button small" aria-pressed={view === 'translation'} onClick={() => setView('translation')}>{t('panel.translationLog')}{failed > 0 && <span className="count bad" aria-label={t('feed.translationFailed', { count: failed })}>{failed}</span>}</button>
    </div>}
    {translated && view === 'translation' ? <TranslationLog id={feed.id} enabled={feed.enabled} /> : <FetchLogs id={feed.id} revision={revision} />}
  </div>;
}
type FeedDetailData = { feed: Feed; items: FeedItem[]; feedUrl: string } & OutputPreview;

// One panel for everything about a feed: the address and status stay on top,
// content, fetch logs and settings are tabs underneath.
function FeedPanel({ id, tab, onTab, close, edit, changed, notify }: { id: string; tab: PanelTab; onTab: (tab: PanelTab) => void; close: () => void; edit: (feed: Feed, convert?: boolean, check?: PubmedRssCheck) => void; changed: () => void; notify: Notify }) {
  const [revision, setRevision] = useState(0);
  const [detail, setDetail] = useState<FeedDetailData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const dirty = useRef(false);
  const load = useCallback(async () => { setDetail(await api.feeds.detail(id)); }, [id]);
  useEffect(() => { void load().catch(error => setError(messageOf(error))); }, [load]);
  useEffect(() => {
    if (!detail || !detail.feed.enabled) return;
    // RSS and PubMed feeds fetch in the background after saving: follow the first fetch, then any pending translations.
    const firstFetch = !detail.feed.lastSuccessAt && !detail.feed.lastError;
    if (!(isFeedSource(detail.feed) && firstFetch) && (!translationEnabled(detail.feed) || !firstFetch && !detail.feed.translation?.pending)) return;
    const timer = window.setInterval(() => { void load().catch(e => setError(messageOf(e))); }, 3000);
    return () => window.clearInterval(timer);
  }, [detail?.feed.sourceType, detail?.feed.enabled, detail?.feed.lastFetchedAt, detail?.feed.lastSuccessAt, detail?.feed.lastError, detail?.feed.translation?.pending, load]);
  function guard(next: () => void) {
    if (busy) return;
    if (!dirty.current || confirm(t('panel.discardChanges'))) { dirty.current = false; next(); }
  }
  function retryTranslation() {
    setBusy('retryTranslation'); setError('');
    void api.feeds.retryTranslation(id).then(load).then(() => notify(t('panel.retryScheduled'))).catch(e => setError(messageOf(e))).finally(() => setBusy(''));
  }
  async function refresh() {
    setBusy('refresh'); setError('');
    try { await api.feeds.refresh(id); await load(); setRevision(v => v + 1); changed(); notify(t('panel.refreshed')); }
    catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  const feed = detail?.feed;
  return <Modal title={feed?.name ?? t('panel.title')} close={() => guard(close)} wide><div className="modal-body feed-panel">
    <ErrorNote error={error} />{!detail || !feed ? !error && <Busy label={t('panel.loading')} /> : <>
      <div className="feed-panel-head">
        <div className="feed-panel-source">{feed.sourceType === 'pubmed' ? <div className="detail-source pubmed-source"><Microscope size={16} /><code title={feed.pubmed?.query}>{feed.pubmed?.query}</code><a className="text-link" href={feed.url} target="_blank" rel="noreferrer">{t('pubmedEditor.openInPubmed')}<ExternalLink size={13} /></a></div> : <div className="detail-source"><Globe2 size={16} /><a href={feed.url} target="_blank" rel="noreferrer">{feed.url}</a></div>}<button className="button small" disabled={!!busy} onClick={() => void refresh()}><RefreshCw size={14} className={busy === 'refresh' ? 'spin' : undefined} />{busy === 'refresh' ? t('panel.refreshing') : t('collection.refresh')}</button></div>
        <FeedAddress feedUrl={detail.feedUrl} notify={notify} onError={setError} />
        {feed.sourceType === 'rss' && <PubmedRssNotice key={feed.id} feed={feed} review={check => guard(() => edit(feed, true, check))} converted={() => { void load().catch(e => setError(messageOf(e))); setRevision(v => v + 1); changed(); notify(t('pubmedConvert.done')); }} />}
        <FeedStatus feed={feed} retry={retryTranslation} busy={busy === 'retryTranslation'} />
        <RuleHealthNotice key={feed.id} feed={feed} notify={notify} updated={() => { void load().catch(e => setError(messageOf(e))); setRevision(v => v + 1); changed(); }} />
      </div>
      <div className="detail-actions feed-tabs" aria-label={t('panel.sections')}>{panelTabs().map(([key, label]) => <button key={key} className="button small" aria-pressed={tab === key} onClick={() => { if (tab !== key) guard(() => onTab(key)); }}>{label}</button>)}</div>
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
  const retentionAuto = isFeedSource(feed) ? RETENTION_LIMIT.rssAuto : RETENTION_LIMIT.websiteAuto;
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
    if (!title.trim()) { setError(t('feedSettings.nameRequired')); return; }
    const minutes = Number(interval);
    if (!interval || !Number.isInteger(minutes) || minutes < 5 || minutes > 1440) { setError(t('error.intervalRange')); return; }
    if (!limitValid) { setError(t('error.outputLimitRange', { min: OUTPUT_LIMIT.min, max: OUTPUT_LIMIT.max })); return; }
    if (!retentionValid) { setError(t('feedSettings.retentionRange', { min: retentionMin, max: RETENTION_LIMIT.max })); return; }
    setBusy('saveSettings'); setError('');
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
      changed(); notify(t('feedSettings.saved'));
    } catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  async function action(label: string, fn: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(label); setError('');
    try { await fn(); await reload(); changed(); notify(success); }
    catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  async function remove() {
    if (busy || !confirm(t('feedSettings.confirmDelete'))) return;
    setBusy('delete'); setError('');
    try { await api.feeds.remove(feed.id); dirty.current = false; changed(); notify(t('feedSettings.deleted')); removed(); }
    catch (error) { setError(messageOf(error)); } finally { setBusy(''); }
  }
  return <div className="feed-settings">
    <form onSubmit={save} className="feed-settings-form">
      <Field label={t('label.feedName')} hint={t('feedSettings.nameHint')}><input required maxLength={200} disabled={!!busy} value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <div className="form-row">
        <Field label={t('label.intervalMinutes')} hint={t('feedSettings.intervalHint')}><input type="number" required min={5} max={1440} step={1} disabled={!!busy} value={interval} onChange={e => setIntervalValue(e.target.value)} /></Field>
        <Field label={t('translation.outputMode')} hint={t('feedSettings.modeHint')}><select aria-label={t('translation.outputMode')} disabled={!!busy} value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="original">{t('translation.mode.original')}</option><option value="bilingual">{t('translation.mode.bilingual')}</option><option value="translated">{t('translation.mode.translated')}</option></select></Field>
      </div>
      <NetworkProfileSelect value={networkProfileId} onChange={setNetworkProfileId} profiles={profiles} disabled={!!busy} />
      {mode !== 'original' && <div className="form-row">
        <Field label={t('translation.targetLanguage')}><select aria-label={t('translation.targetLanguage')} disabled={!!busy} value={language} onChange={e => setLanguage(e.target.value as TargetLanguage)}><LanguageOptions /></select></Field>
        <Field label={t('translation.service')} hint={t('feedSettings.serviceHint')}><select aria-label={t('translation.service')} disabled={!!busy} value={provider} onChange={e => setProvider(e.target.value as TranslationProviderId | '')}><ProviderOptions info={providers} current={feed.translationProvider} /></select></Field>
      </div>}
      {retranslates && <p className="notice">{t('feedSettings.retranslate')}</p>}
      <fieldset className="output-settings" disabled={!!busy}>
        <legend>{t('feedSettings.output')}</legend>
        <p className="hint">{t('feedSettings.outputHint')}</p>
        <div className="form-row">
          <Field label={t('output.limit')} hint={t('feedSettings.limitHint', { min: OUTPUT_LIMIT.min, max: OUTPUT_LIMIT.max })}><input type="number" required min={OUTPUT_LIMIT.min} max={OUTPUT_LIMIT.max} step={1} value={limit} onChange={e => setLimit(e.target.value)} /></Field>
          <Field label={t('output.retention')} hint={t('feedSettings.retentionHint', { kind: feed.sourceType === 'pubmed' ? t('feedSettings.kindPubmed') : feed.sourceType === 'rss' ? t('feedSettings.kindRss') : t('feedSettings.kindWebsite'), auto: retentionAuto, min: retentionMin, max: RETENTION_LIMIT.max })}><input type="number" min={retentionMin} max={RETENTION_LIMIT.max} step={1} placeholder={t('feedSettings.retentionAuto', { count: Math.max(retentionAuto, limitValid ? limitNumber : 0) })} value={retention} onChange={e => setRetention(e.target.value)} /></Field>
        </div>
        <div className="form-row">
          <Field label={t('filter.include')} hint={t('feedSettings.includeHint')}><textarea rows={3} spellCheck={false} value={include} onChange={e => setInclude(e.target.value)} placeholder={t('feedSettings.includePlaceholder')} /></Field>
          <Field label={t('filter.exclude')} hint={t('feedSettings.excludeHint')}><textarea rows={3} spellCheck={false} value={exclude} onChange={e => setExclude(e.target.value)} placeholder={t('feedSettings.excludePlaceholder')} /></Field>
        </div>
        <label className="checkbox-field"><input type="checkbox" checked={regex} onChange={e => setRegex(e.target.checked)} /><span>{t('feedSettings.regex', { max: ITEM_FILTER_LIMITS.patternLength })}</span></label>
        {previewError ? <p className="output-summary is-error" role="alert">{previewError}</p> : preview && <OutputSummary preview={preview} stored={items.length} />}
      </fieldset>
      <button className="button primary" disabled={!!busy || !isDirty}>{busy === 'saveSettings' ? <Busy label={t('common.saving')} /> : t('feedSettings.save')}</button>
    </form>
    <section className="feed-settings-section" aria-label={t('feedSettings.updates')}>
      <div><h3>{t('feedSettings.updates')}</h3><p className="hint">{t('feedSettings.updatesHint')}</p></div>
      <div className="detail-actions"><button className="button small" disabled={!!busy} onClick={() => void action('toggle', () => api.feeds.toggle(feed.id), feed.enabled ? t('feedSettings.paused') : t('feedSettings.resumed'))}>{feed.enabled ? t('feedSettings.pause') : t('feedSettings.resume')}</button><button className="button small" disabled={!!busy} onClick={edit}><Pencil size={14} />{feed.sourceType === 'pubmed' ? t('feedSettings.editPubmed') : feed.sourceType === 'rss' ? t('feedSettings.editRss') : t('editor.editRules')}</button></div>
    </section>
    <section className="feed-settings-section danger-zone" aria-label={t('feedSettings.addressDelete')}>
      <div><h3>{t('feedSettings.addressDelete')}</h3><p className="hint">{t('feedSettings.addressDeleteHint')}</p></div>
      <div className="detail-actions"><button className="button small" disabled={!!busy} onClick={() => { if (confirm(t('feedSettings.confirmRotate'))) void action('rotate', () => api.feeds.rotate(feed.id), t('feedSettings.rotated')); }}><KeyRound size={14} />{t('feedSettings.rotate')}</button><button className="button small danger" disabled={!!busy} onClick={() => void remove()}><Trash2 size={14} />{t('feedSettings.delete')}</button></div>
    </section>
    {busy && !['saveSettings', 'refresh', 'retryTranslation'].includes(busy) && <Busy label={t(`feedBusy.${busy as 'toggle'}`)} />}
  </div>;
}

type SettingsSection = { id: string; label: string; icon: typeof Bell };

/** Settings sections available to this viewer, in navigation order. Admin-only groups stay admin-only. */
function settingsSections(admin: boolean, target?: UserSummary | null): SettingsSection[] {
  const instance = admin && !target;
  return [
    ...(instance ? [{ id: 'display', label: t('appSettings.display.title'), icon: SlidersHorizontal }, { id: 'translation', label: t('appSettings.translation.title'), icon: Languages }, { id: 'server', label: t('appSettings.server.title'), icon: Server }, { id: 'pubmed', label: t('appSettings.pubmed.title'), icon: BookOpen }] : []),
    { id: 'notifications', label: t('notifications.title'), icon: Bell },
    { id: 'credentials', label: t('cookies.title'), icon: Cookie },
    { id: 'network', label: t('network.title'), icon: Network },
    ...(!target ? [{ id: 'account', label: t('account.title'), icon: KeyRound }] : []),
    { id: 'tokens', label: t('tokens.title'), icon: KeySquare },
    ...(instance ? [{ id: 'backup', label: t('backup.title'), icon: Archive }] : []),
    { id: 'about', label: t('about.title'), icon: Info },
  ];
}

// One settings group per page; the group is part of the address (#/settings/translation).
function SettingsView({ auth, logout, notify, target, section, onSection, dirty, authChanged }: { auth: AuthState; logout: () => void; notify: Notify; authChanged: (state: AuthState) => void; target?: UserSummary | null; section: string | null; onSection: (id: string) => void; dirty: React.MutableRefObject<boolean> }) {
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
    if (dirty.current && !confirm(t('settings.discardGroup'))) return;
    dirty.current = false;
    onSection(id);
    window.scrollTo({ top: 0 });
  }
  const markDirty = useCallback((value: boolean) => { dirty.current = value; }, [dirty]);
  async function submit(event: FormEvent) { event.preventDefault(); if (newPassword !== confirmPassword) { setError(t('account.mismatch')); return; } setBusy(true); setError(''); try { await api.auth.password({ currentPassword, newPassword }); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); notify(t('account.changed')); logout(); } catch (error) { setError(messageOf(error)); } finally { setBusy(false); } }
  return <>
    <div className="page-heading"><div><span className="section-kicker">MAKE IT YOURS</span><h1>{t('settings.title')}</h1><p>{auth.role === 'admin' && !target ? t('settings.leadAdmin') : t('settings.lead')}</p></div></div>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label={t('settings.groups')} ref={navRef}>{sections.map(item => <button key={item.id} className={active.id === item.id ? 'selected' : ''} aria-current={active.id === item.id ? 'page' : undefined} onClick={() => jump(item.id)}><item.icon size={16} />{item.label}</button>)}</nav>
      <div className="settings-sections">
        <div id={`settings-${active.id}`} className="settings-section" key={active.id}>
          {(active.id === 'display' || active.id === 'translation' || active.id === 'server' || active.id === 'pubmed') && <ApplicationSettingsPanel group={active.id} revision={settingsRevision} onDirty={markDirty} />}
          {active.id === 'notifications' && <NotificationsPanel key={settingsRevision} username={target?.username ?? auth.username!} enabled={target?.enabled !== false} />}
          {active.id === 'credentials' && <CredentialsView notify={notify} />}
          {active.id === 'network' && <NetworkProfilesView notify={notify} />}
          {active.id === 'account' && <form className="panel settings-form" onSubmit={submit} aria-label={t('account.title')}><div className="panel-heading"><h2>{t('account.title')}</h2><KeyRound size={19} /></div><p className="muted">{t('account.lead', { name: auth.username ?? '', role: auth.role === 'admin' ? t('role.admin') : t('role.user') })}</p><h3 className="settings-subheading">{t('language.label')}</h3><LanguageSelect account={auth} follow onSaved={state => { authChanged(state); notify(t('account.languageSaved')); }} onError={setError} /><h3 className="settings-subheading">{t('account.changePassword')}</h3><Field label={t('account.current')}><input required type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} autoComplete="current-password" /></Field><div className="form-row"><Field label={t('account.new')}><input required type="password" minLength={8} maxLength={1024} value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" /></Field><Field label={t('account.confirm')}><input required type="password" minLength={8} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" /></Field></div><ErrorNote error={error} /><button className="button primary" disabled={busy}>{busy ? <Busy /> : t('account.update')}</button></form>}
          {active.id === 'tokens' && <ApiTokensPanel notify={notify} target={target} />}
          {active.id === 'backup' && <BackupPanel onRestored={logout} onImported={() => setSettingsRevision(v => v + 1)} />}
          {active.id === 'about' && <section className="panel about-panel" aria-label={t('about.title')}><div className="panel-heading"><h2>{t('about.title')}</h2><Info size={19} /></div><Brand /><p>{t('about.lead')}</p><div className="about-row"><span>{t('about.version')}</span><code>{auth.version}</code></div><div className="about-row"><span>{t('about.license')}</span><span>MIT</span></div><a className="text-link" href="https://github.com/Jaaayden/feedlantern" target="_blank" rel="noreferrer">{t('about.source')}<ExternalLink size={14} /></a><div className="notice">{t('about.notice')}</div></section>}
        </div>
      </div>
    </div>
  </>;
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const next: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  return <button className="icon-button theme-toggle" title={t('themeToggle.title', { theme: themeLabel(theme) })} aria-label={t('themeToggle.label', { theme: themeLabel(theme), next: themeLabel(next) })} onClick={() => { saveTheme(next); setTheme(next); }}><Icon size={17} /></button>;
}

type NewSource = 'website' | 'rss' | 'pubmed';

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
    <button className="button primary" onClick={() => create('website')}><Plus size={17} />{t('newFeed.button')}</button>
    <button className="button primary split-toggle" aria-label={t('newFeed.more')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDown size={16} /></button>
    {open && <div className="menu" role="menu" aria-label={t('newFeed.menu')}>
      <button role="menuitem" onClick={() => choose(() => create('website'))}><span className="menu-icon"><Globe2 size={17} /></span><span><strong>{t('newFeed.website')}</strong><small>{t('newFeed.websiteHint')}</small></span></button>
      <button role="menuitem" onClick={() => choose(() => create('rss'))}><span className="menu-icon"><Languages size={17} /></span><span><strong>{t('newFeed.rss')}</strong><small>{t('newFeed.rssHint')}</small></span></button>
      <button role="menuitem" onClick={() => choose(() => create('pubmed'))}><span className="menu-icon"><Microscope size={17} /></span><span><strong>{t('newFeed.pubmed')}</strong><small>{t('newFeed.pubmedHint')}</small></span></button>
      <button role="menuitem" onClick={() => choose(batch)}><span className="menu-icon"><ListPlus size={17} /></span><span><strong>{t('newFeed.batch')}</strong><small>{t('newFeed.batchHint')}</small></span></button>
      <button role="menuitem" onClick={() => choose(bundle)}><span className="menu-icon"><Layers size={17} /></span><span><strong>{t('opml.bundles')}</strong><small>{t('newFeed.bundleHint')}</small></span></button>
    </div>}
  </div>;
}

type Page = 'feeds' | 'settings' | 'batch' | 'users';
type Route = { page: Page; panel: { id: string; tab: PanelTab } | null; create: NewSource | null; workspace: string | null; section?: string | null };

// Hash routes keep the current screen across reloads and make back/forward work:
// #/ · #/settings[/<group>] · #/users · #/batch · #/new · #/new/rss · #/new/pubmed · #/feed/<id>[/logs|/settings]
// An admin working in another account's workspace gets a #/u/<userId> prefix.
function parseRoute(hash: string): Route {
  let parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  let workspace: string | null = null;
  if (parts[0] === 'u' && parts[1]) { workspace = parts[1]; parts = parts.slice(2); }
  const empty: Route = { page: 'feeds', panel: null, create: null, workspace };
  if (parts[0] === 'settings') return { ...empty, page: 'settings', section: parts[1] ?? null };
  if (parts[0] === 'users' || parts[0] === 'batch') return { ...empty, page: parts[0] };
  if (parts[0] === 'new') return { ...empty, create: parts[1] === 'rss' || parts[1] === 'pubmed' ? parts[1] : 'website' };
  if (parts[0] === 'feed' && parts[1]) return { ...empty, panel: { id: parts[1], tab: parts[2] === 'logs' || parts[2] === 'settings' ? parts[2] : 'items' } };
  return empty;
}

function routeHash(route: Route): string {
  const prefix = route.workspace ? `#/u/${encodeURIComponent(route.workspace)}` : '#';
  if (route.panel) return `${prefix}/feed/${encodeURIComponent(route.panel.id)}${route.panel.tab === 'items' ? '' : `/${route.panel.tab}`}`;
  if (route.create) return `${prefix}${route.create === 'website' ? '/new' : `/new/${route.create}`}`;
  if (route.page === 'settings' && route.section) return `${prefix}/settings/${encodeURIComponent(route.section)}`;
  return route.page === 'feeds' ? `${prefix}/` : `${prefix}/${route.page}`;
}

export default function App() {
  // The whole tree re-renders in the new language when it changes.
  const locale = useLocale();
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
  // The feed editor opened to convert a PubMed RSS feed into a PubMed search.
  const [editorConvert, setEditorConvert] = useState(false);
  // The conversion check that opened the editor, to prefill the recovered query and say why it needs review.
  const [editorCheck, setEditorCheck] = useState<PubmedRssCheck>();
  // PubMed RSS feeds being checked and converted together.
  const [pubmedBatch, setPubmedBatch] = useState<Feed[] | null>(null);
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
  const acceptAuth = useCallback((state: AuthState) => { if (state.authenticated) adoptAccountLocale(state.locale, state.defaultLocale); else adoptGuestLocale(state.defaultLocale); authGeneration.current++; targetRef.current = null; setFeeds([]); setBundles([]); setWorkspaceUser(undefined); setTarget(null); setCsrfToken(state.csrfToken); setAuth(state); setSession(value => value + 1); void applyRoute(state.authenticated ? parseRoute(location.hash) : parseRoute(''), state.role === 'admin'); setQuery(''); setStatus('all'); setError(''); }, [applyRoute]);
  const forgetAuth = useCallback(() => { authGeneration.current++; targetRef.current = null; setUsers([]); setWorkspaceUser(undefined); setTarget(null); setCsrfToken(undefined); setAuth(previous => previous ? { ...previous, authenticated: false, csrfToken: undefined } : null); setFeeds([]); setBundles([]); setBundleEditor(undefined); setBundleTarget(null); setEditor(undefined); setPanel(null); setEditorReturnId(null); }, []);
  useEffect(() => { void api.auth.status().then(acceptAuth).catch(error => setBootError(messageOf(error))); return onUnauthorized(() => { forgetAuth(); setToast(t('app.signedOut')); }); }, [acceptAuth, forgetAuth]);
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
  const crumb = page === 'feeds' ? editor !== undefined ? editor ? editorConvert ? t('pubmedEditor.convertTitle') : editor.sourceType === 'pubmed' ? t('pubmedEditor.editTitle') : editor.sourceType === 'rss' ? t('rssEditor.editTitle') : t('editor.editRules') : t('newFeed.button') : t('nav.feeds') : page === 'batch' ? t('newFeed.batch') : page === 'users' ? t('users.title') : t('settings.title');
  useEffect(() => { document.title = authenticated ? `${crumb} · FeedLantern` : t('app.documentTitle'); }, [authenticated, crumb, locale]);
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
  if (!auth) return <div className="boot"><Brand />{bootError ? <><ErrorNote error={bootError} /><button className="button" onClick={() => location.reload()}>{t('app.reconnect')}</button></> : <Busy label={t('app.connecting')} />}</div>;
  if (!auth.authenticated) return <><AuthScreen state={auth} authenticated={acceptAuth} />{toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}</>;
  const filtered = feeds.filter(feed => `${feed.name} ${feed.url}`.toLowerCase().includes(query.toLowerCase()));
  const attention = feeds.filter(needsAttention).length;
  function navigate(next: Page) {
    if (page === 'settings' && next !== 'settings' && settingsDirty.current && !confirm(t('settings.discardLeave'))) return;
    if (next !== 'settings') settingsDirty.current = false;
    setPage(next); setEditor(undefined); setPanel(null); setEditorReturnId(null);
  }
  function create(source: NewSource) { setEditorSource(source); setEditorConvert(false); setEditor(null); }
  return <div className={`app-layout ${target ? 'managing' : ''}`}><aside className="sidebar"><Brand />{auth.role === 'admin' ? <WorkspaceSwitcher me={{ id: auth.userId!, username: auth.username! }} users={users} target={target} open={user => changeWorkspace(user)} manageUsers={() => navigate('users')} refresh={refreshUsers} /> : <div className="workspace-label">{t('nav.personal')}</div>}<nav aria-label={t('nav.main')}><button className={page === 'feeds' || page === 'batch' ? 'selected' : ''} onClick={() => navigate('feeds')}><Rss size={19} />{t('nav.feeds')}<span>{feeds.length}</span></button><button className={page === 'settings' ? 'selected' : ''} onClick={() => navigate('settings')}><Settings2 size={19} />{t('settings.title')}</button>{auth.role === 'admin' && <button className={page === 'users' ? 'selected' : ''} onClick={() => navigate('users')}><ShieldCheck size={19} />{t('users.title')}</button>}</nav><div className="sidebar-bottom"><div className="local-label"><span /> {t('nav.selfHosted')}</div><div className="account"><span className="avatar">{auth.username?.slice(0, 1).toUpperCase()}</span><div><strong>{auth.username}</strong><small>{auth.role === 'admin' ? t('role.admin') : t('role.user')}</small></div><button className="icon-button" aria-label={t('nav.signOut')} onClick={() => void logout()}><LogOut size={17} /></button></div><span className="version">{auth.version}</span></div></aside><div className="main-shell"><header className="topbar"><span><span className="muted">{t('nav.workspace')}</span><span className="slash">/</span>{crumb}</span><span className="topbar-actions">{target && <span className="managing-chip" title={t('nav.managingTitle')}>{t('nav.managing', { name: target.username })}</span>}<LanguageSelect compact account={auth} onSaved={setAuth} onError={setToast} /><ThemeToggle /><span className="topbar-status"><ShieldCheck size={14} /> <span className="topbar-status-text">{t('nav.signedIn')}</span> <button className="icon-button mobile-logout" aria-label={t('nav.signOut')} onClick={() => void logout()}><LogOut size={15} /></button></span></span></header><main className="main-content" key={target?.id ?? auth.userId}>
    {target && <div className="workspace-banner" role="status"><div><strong>{t('nav.managingBanner', { name: target.username })}</strong><p>{target.enabled ? t('nav.managingHint') : t('nav.managingDisabled')}</p></div><button className="button small" onClick={() => changeWorkspace(null)}>{t('nav.backToMine')}</button></div>}
    {page === 'users' && auth.role === 'admin' ? <UsersPanel currentUserId={auth.userId!} manage={(user, attention) => { changeWorkspace(user); if (attention) setStatus('attention'); }} changed={refreshUsers} identityChanged={() => void api.auth.status().then(acceptAuth)} /> : page === 'batch' ? <BatchView notify={notify} changed={() => void loadFeeds()} back={() => navigate('feeds')} /> : page === 'settings' ? <SettingsView target={target} auth={auth} authChanged={setAuth} logout={forgetAuth} notify={notify} section={settingsSection} onSection={setSettingsSection} dirty={settingsDirty} /> : editor !== undefined ? <FeedEditor key={editor ? `${editor.id}${editorConvert ? '-convert' : ''}` : `new-${editorSource}`} initial={editor ?? undefined} source={editorSource} convert={!!editor && editorConvert} check={editor && editorConvert ? editorCheck : undefined} existing={feeds} cancel={() => { setEditor(undefined); if (editorReturnId) setPanel({ id: editorReturnId, tab: 'settings' }); setEditorReturnId(null); }} saved={id => { setEditor(undefined); setPanel({ id, tab: editorReturnId && !editorConvert ? 'settings' : 'items' }); setEditorReturnId(null); notify(t('feed.saved')); void loadFeeds(); }} /> : <>
      <div className="page-heading"><div><span className="section-kicker">LESS CHECKING. MORE READING.</span><h1>{t('home.title')}</h1><p>{t('home.lead')}</p></div><NewFeedMenu create={create} batch={() => navigate('batch')} bundle={() => setBundleEditor({})} /></div>
      {feeds.length > 0 && <div className="stats-row"><div><span>{t('home.allFeeds')}</span><strong>{feeds.length}<small>{t('users.sourcesUnit', { count: feeds.length })}</small></strong></div><div><span>{t('home.following')}</span><strong>{feeds.filter(feed => feed.enabled).length}<small>{t('home.autoUpdating')}</small></strong></div><div><span>{t('home.collected')}</span><strong>{fmt.number(feeds.reduce((sum, feed) => sum + feed.itemCount, 0))}<small>{t('home.records', { count: feeds.reduce((sum, feed) => sum + feed.itemCount, 0) })}</small></strong></div>{attention ? <button className={`attention ${status === 'attention' ? 'active' : ''}`} aria-pressed={status === 'attention'} title={status === 'attention' ? t('home.clearFilter') : t('collection.attentionOnly')} onClick={() => { const next = status === 'attention' ? 'all' : 'attention'; setStatus(next); if (next === 'attention') requestAnimationFrame(() => document.querySelector('.list-toolbar')?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }}><span>{t('collection.attention')}</span><strong>{attention}<small>{status === 'attention' ? t('users.filtered') : t('users.clickToFilter')}</small><ChevronRight size={15} className="stat-arrow" /></strong></button> : <div><span>{t('collection.attention')}</span><strong>0<small>{t('users.allGood')}</small></strong></div>}</div>}
      {bundles.length > 0 && <BundleSection bundles={bundles} feeds={feeds} create={() => setBundleEditor({})} edit={bundle => setBundleEditor({ initial: bundle })} changed={() => void loadFeeds()} notify={notify} />}
      <div className="list-toolbar"><h2>{t('home.list')} <span>{feeds.length}</span></h2><div className="input-icon search-input"><Search size={16} /><input ref={searchRef} aria-label={t('home.search')} placeholder={t('bundle.searchPlaceholder')} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }} /><kbd className="search-key" aria-hidden="true">/</kbd></div></div>
      <ErrorNote error={error} />{loading && !feeds.length ? <Busy label={t('home.loading')} /> : filtered.length ? <FeedCollection auth={target ? { ...auth, userId: target.id, role: 'user' } : auth} feeds={filtered} bundles={bundles} addToBundle={ids => setBundleTarget(ids)} convertPubmed={ids => setPubmedBatch(feeds.filter(feed => ids.includes(feed.id) && isPubmedRss(feed)))} query={query} status={status} onStatus={setStatus} detail={id => setPanel({ id, tab: 'items' })} settings={id => setPanel({ id, tab: 'settings' })} logs={id => setPanel({ id, tab: 'logs' })} changed={() => void loadFeeds()} notify={notify} /> : <div className="empty-state"><span className="large-icon"><Rss size={32} /></span><h2>{query ? t('home.noMatch') : t('home.emptyTitle')}</h2><p>{query ? t('home.noMatchHint') : t('home.emptyBody')}</p>{query ? <button className="button" onClick={() => setQuery('')}>{t('home.clearSearch')}</button> : <button className="button" onClick={() => create('website')}><Plus size={16} />{t('home.createFirst')}</button>}</div>}<div className="dashboard-note"><Sparkles size={17} /><span>{t('home.note')}</span><span className="muted">{t('home.searchHint')}</span></div></>}
  </main><footer className="page-footer"><span>{t('app.documentTitle')}</span><a href="https://github.com/Jaaayden/feedlantern" target="_blank" rel="noreferrer">GitHub · Jaaayden/feedlantern · {auth.version}</a></footer></div>{panel && <FeedPanel key={panel.id} id={panel.id} tab={panel.tab} onTab={tab => setPanel(previous => previous && { ...previous, tab })} close={closePanel} edit={(feed, convert, check) => { setPanel(null); setEditorReturnId(feed.id); setEditorConvert(!!convert); setEditorCheck(check); setEditor(feed); }} changed={() => void loadFeeds()} notify={notify} />}{bundleEditor && <BundleEditor initial={bundleEditor.initial} feeds={feeds} close={() => setBundleEditor(undefined)} saved={(_result, created) => { setBundleEditor(undefined); notify(created ? t('bundle.created') : t('bundle.saved')); void loadFeeds(); }} />}{pubmedBatch && <PubmedBatchConvert feeds={pubmedBatch} close={() => setPubmedBatch(null)} changed={() => void loadFeeds()} notify={notify} review={(feed, check) => { setPubmedBatch(null); setPanel(null); setEditorReturnId(null); setEditorConvert(true); setEditorCheck(check); setEditor(feed); }} />}{bundleTarget && <AddToBundle bundles={bundles} feedIds={bundleTarget} close={() => setBundleTarget(null)} done={message => { setBundleTarget(null); notify(message); void loadFeeds(); }} />}{toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}</div>;
}
