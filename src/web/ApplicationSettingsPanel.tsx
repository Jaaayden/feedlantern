import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronDown, Star } from 'lucide-react';
import type { ApplicationSettings, NcbiKeyTest, TranslationProviderId } from '../shared/types';
import { api } from './api';
import { fmt, t } from './i18n';

/** The instance-wide settings, split into pages that each save only their own fields. */
export type AppSettingsGroup = 'display' | 'translation' | 'server' | 'pubmed';
type Translation = ApplicationSettings['translation'];
type Service = 'deepl' | 'openai';
/** Everything with a write-only API key. */
type KeyOwner = Service | 'ncbi';

const titles = (group: AppSettingsGroup): [string, string] => [t(`appSettings.${group}.title`), t(`appSettings.${group}.intro`)];
const providerName = (provider: TranslationProviderId) => t(`provider.${provider}`);
const providers: TranslationProviderId[] = ['google', 'deepl', 'openai'];
const serviceKeys = { deepl: ['plan', 'concurrency', 'requestIntervalMs'], openai: ['baseUrl', 'model', 'systemPrompt', 'concurrency', 'requestIntervalMs'] } as const;

/** Mirrors the server's providerProblem: what a service still needs before it can translate. */
function missing(translation: Translation, provider: TranslationProviderId, keyKept: boolean): string {
  if (provider === 'deepl' && !(translation.deepl.apiKey || keyKept)) return t('appSettings.deeplNeedsKey');
  if (provider === 'openai' && (!translation.openai.baseUrl || !translation.openai.model)) return t('appSettings.openaiNeedsSettings');
  return '';
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Only what changed in this group goes to the server. API keys are write-only:
 * an empty field keeps the saved key, `null` removes it.
 */
function patchFor(group: AppSettingsGroup, saved: ApplicationSettings, draft: ApplicationSettings, clearKey: Record<KeyOwner, boolean>): Record<string, unknown> {
  if (group === 'pubmed') {
    const ncbi: Record<string, unknown> = {};
    if (draft.ncbi.email !== saved.ncbi.email) ncbi.email = draft.ncbi.email;
    if (clearKey.ncbi) ncbi.apiKey = null;
    else if (draft.ncbi.apiKey) ncbi.apiKey = draft.ncbi.apiKey;
    return Object.keys(ncbi).length ? { ncbi } : {};
  }
  if (group === 'display') return Object.fromEntries((['feedView', 'logRetentionDays'] as const).filter(key => draft[key] !== saved[key]).map(key => [key, draft[key]]));
  if (group === 'server') {
    const server = Object.fromEntries(Object.entries(draft.server).filter(([key, value]) => !same(value, saved.server[key as keyof ApplicationSettings['server']])));
    return Object.keys(server).length ? { server } : {};
  }
  const translation: Record<string, unknown> = {};
  for (const key of ['defaultProvider', 'concurrency', 'requestIntervalMs'] as const) if (draft.translation[key] !== saved.translation[key]) translation[key] = draft.translation[key];
  for (const service of ['deepl', 'openai'] as const) {
    const patch: Record<string, unknown> = {};
    for (const key of serviceKeys[service]) {
      const value = (draft.translation[service] as unknown as Record<string, unknown>)[key];
      if (value !== (saved.translation[service] as unknown as Record<string, unknown>)[key]) patch[key] = value;
    }
    if (clearKey[service]) patch.apiKey = null;
    else if (draft.translation[service].apiKey) patch.apiKey = draft.translation[service].apiKey;
    if (Object.keys(patch).length) translation[service] = patch;
  }
  return Object.keys(translation).length ? { translation } : {};
}

/** One line for a test result: what NCBI said, the rate limit it reported, and the email check. */
function ncbiTestText(test: NcbiKeyTest): string {
  const main = t(`appSettings.ncbiTest.${test.result}`, { rate: test.rateLimit ?? (test.result === 'valid' ? 10 : 3), detail: test.detail ?? '' });
  return test.email === 'invalid' ? `${main} ${t('error.ncbiEmailInvalid')}` : test.email === 'missing' ? `${main} ${t('appSettings.ncbiTest.noEmail')}` : main;
}

export function ApplicationSettingsPanel({ group, revision, onDirty }: { group: AppSettingsGroup; revision: number; onDirty: (dirty: boolean) => void }) {
  const [saved, setSaved] = useState<ApplicationSettings | null>(null);
  const [value, setValue] = useState<ApplicationSettings | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  /** Saved API keys are never sent back; these mark keys the administrator chose to remove. */
  const [clearKey, setClearKey] = useState<Record<KeyOwner, boolean>>({ deepl: false, openai: false, ncbi: false });
  const [open, setOpen] = useState<Set<TranslationProviderId>>(new Set());
  const [testing, setTesting] = useState<TranslationProviderId | ''>(''), [testResult, setTestResult] = useState<{ provider: TranslationProviderId; ok: boolean; text: string }>();
  // NCBI: the saved key's last test, and a test of the values as typed.
  const [ncbiStatus, setNcbiStatus] = useState<{ apiKeyConfigured: boolean; lastTest?: NcbiKeyTest }>();
  const [ncbiTest, setNcbiTest] = useState<{ key: string; test: NcbiKeyTest }>();
  const [ncbiTesting, setNcbiTesting] = useState(false);
  useEffect(() => { if (group === 'pubmed') void api.settings.ncbiStatus().then(setNcbiStatus).catch(() => {}); }, [group, revision, saved]);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  useEffect(() => {
    let live = true;
    void api.settings.get().then(v => {
      if (!live) return;
      setSaved(v); setValue(v); setClearKey({ deepl: false, openai: false, ncbi: false });
      // The default service starts expanded; the others are a click away.
      setOpen(new Set([v.translation.defaultProvider]));
    }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [revision]);
  const patch = saved && value ? patchFor(group, saved, value, clearKey) : {};
  const dirty = Object.keys(patch).length > 0;
  useEffect(() => { onDirtyRef.current(dirty); }, [dirty]);
  useEffect(() => () => onDirtyRef.current(false), []);

  async function save(e: FormEvent) {
    e.preventDefault(); if (!value || !dirty) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await api.settings.save(patch as Partial<ApplicationSettings>);
      setSaved(next); setValue(next); setClearKey({ deepl: false, openai: false, ncbi: false });
      setMessage(group === 'server' ? t('appSettings.savedRestart') : t('appSettings.saved'));
    } catch (e) { setError(e instanceof Error ? e.message : t('common.saveFailed')); } finally { setBusy(false); }
  }
  const [title, intro] = titles(group);
  if (!value || !saved) return <section className="panel settings-form" aria-label={title}>{error || t('appSettings.loading')}</section>;
  const translation = value.translation;
  const server = <K extends keyof ApplicationSettings['server']>(key: K, v: ApplicationSettings['server'][K]) => setValue({ ...value, server: { ...value.server, [key]: v } });
  const service = <S extends Service>(name: S, change: Partial<Translation[S]>) => setValue({ ...value, translation: { ...translation, [name]: { ...translation[name], ...change } } });
  const number = (label: string, v: number, min: number, max: number, change: (n: number) => void) => <label className="field"><span>{label}</span><input type="number" required min={min} max={max} step={1} value={v} onChange={e => change(Number(e.target.value))} /></label>;
  const keyKept = (name: Service) => !!translation[name].apiKeyConfigured && !clearKey[name];

  async function test(provider: TranslationProviderId) {
    setTesting(provider); setTestResult(undefined);
    try {
      const settings = provider === 'google' ? undefined : { ...translation[provider], apiKeyConfigured: undefined, apiKey: clearKey[provider] ? '' : translation[provider].apiKey };
      const result = await api.settings.testTranslation(provider, settings);
      setTestResult({ provider, ok: true, text: t('appSettings.testOk', { text: result.text }) });
    } catch (e) { setTestResult({ provider, ok: false, text: e instanceof Error ? e.message : t('appSettings.testFailed') }); }
    finally { setTesting(''); }
  }
  const testButton = (provider: TranslationProviderId) => <div className="inline service-test">
    <button type="button" className="button small" disabled={!!testing} onClick={() => void test(provider)}>{testing === provider ? t('common.testing') : t('appSettings.test', { name: providerName(provider) })}</button>
    {testResult?.provider === provider && <span role={testResult.ok ? 'status' : 'alert'} className={testResult.ok ? 'hint' : 'error-note'}>{testResult.text}</span>}
  </div>;
  const keyField = (name: Service, label: string) => <>
    <label className="field"><span>{label}</span><input type="password" autoComplete="off" spellCheck={false} value={translation[name].apiKey} placeholder={keyKept(name) ? t('appSettings.keySaved') : t('appSettings.notSet')} onChange={e => { service(name, { apiKey: e.target.value.trim() } as Partial<Translation[typeof name]>); setClearKey({ ...clearKey, [name]: false }); }} /></label>
    {translation[name].apiKeyConfigured && <label className="inline"><input type="checkbox" checked={clearKey[name]} onChange={e => setClearKey({ ...clearKey, [name]: e.target.checked })} />{t('appSettings.clearKey')}</label>}
  </>;
  const body: Record<TranslationProviderId, { subtitle: string; content: ReactNode }> = {
    google: { subtitle: t('appSettings.googleSubtitle'), content: <>
      <div className="form-row">{number(t('appSettings.concurrency', { name: 'Google' }), translation.concurrency, 1, 16, n => setValue({ ...value, translation: { ...translation, concurrency: n } }))}{number(t('appSettings.interval', { name: 'Google' }), translation.requestIntervalMs, 0, 5000, n => setValue({ ...value, translation: { ...translation, requestIntervalMs: n } }))}</div>
      <p className="hint">{t('appSettings.googleHint')}</p>
    </> },
    deepl: { subtitle: translation.deepl.apiKeyConfigured ? t('appSettings.keyStored') : t('appSettings.keyNeeded'), content: <>
      {keyField('deepl', 'DeepL API Key')}
      <div className="form-row">
        <label className="field"><span>{t('appSettings.deeplPlan')}</span><select value={translation.deepl.plan} onChange={e => service('deepl', { plan: e.target.value as 'auto' | 'free' | 'pro' })}><option value="auto">{t('appSettings.planAuto')}</option><option value="free">{t('appSettings.planFree')}</option><option value="pro">{t('appSettings.planPro')}</option></select></label>
        {number(t('appSettings.concurrency', { name: 'DeepL' }), translation.deepl.concurrency, 1, 16, n => service('deepl', { concurrency: n }))}{number(t('appSettings.interval', { name: 'DeepL' }), translation.deepl.requestIntervalMs, 0, 5000, n => service('deepl', { requestIntervalMs: n }))}
      </div>
      {testButton('deepl')}
    </> },
    openai: { subtitle: translation.openai.model ? t('appSettings.model', { model: translation.openai.model }) : t('appSettings.openaiNeeded'), content: <>
      <div className="form-row">
        <label className="field"><span>{t('appSettings.baseUrl')}</span><input type="url" value={translation.openai.baseUrl} placeholder="https://api.openai.com/v1" onChange={e => service('openai', { baseUrl: e.target.value.trim() })} /></label>
        <label className="field"><span>{t('appSettings.modelName')}</span><input value={translation.openai.model} maxLength={200} placeholder="gpt-4o-mini" onChange={e => service('openai', { model: e.target.value })} /></label>
      </div>
      {keyField('openai', t('appSettings.openaiKey'))}
      <label className="field"><span>{t('appSettings.systemPrompt')}</span><textarea rows={3} maxLength={4000} value={translation.openai.systemPrompt} placeholder={t('appSettings.systemPromptPlaceholder')} onChange={e => service('openai', { systemPrompt: e.target.value })} /></label>
      <div className="form-row">{number(t('appSettings.concurrency', { name: t('provider.openai') }), translation.openai.concurrency, 1, 16, n => service('openai', { concurrency: n }))}{number(t('appSettings.interval', { name: t('provider.openai') }), translation.openai.requestIntervalMs, 0, 5000, n => service('openai', { requestIntervalMs: n }))}</div>
      <p className="hint">{t('appSettings.openaiHint')}</p>
      {testButton('openai')}
    </> },
  };
  const toggle = (provider: TranslationProviderId) => setOpen(previous => { const next = new Set(previous); if (next.has(provider)) next.delete(provider); else next.add(provider); return next; });

  return <form className="panel settings-form application-settings" onSubmit={save} aria-label={title}>
    <div className="panel-heading"><h2>{title}</h2>{dirty && <span className="badge warn">{t('appSettings.unsaved')}</span>}</div>
    <p className="muted">{intro}</p>
    {group === 'display' && <fieldset disabled={busy}>
      <label className="field"><span>{t('appSettings.feedView')}</span><select value={value.feedView} onChange={e => setValue({ ...value, feedView: e.target.value as 'list' | 'cards' })}><option value="list">{t('collection.list')}</option><option value="cards">{t('collection.cards')}</option></select></label>
      {number(t('appSettings.logRetention'), value.logRetentionDays, 1, 365, n => setValue({ ...value, logRetentionDays: n }))}
      <p className="hint">{t('appSettings.logRetentionHint')}</p>
    </fieldset>}
    {group === 'translation' && <fieldset disabled={busy} className="service-cards">
      {providers.map(provider => {
        const isDefault = translation.defaultProvider === provider;
        const problem = missing(translation, provider, provider === 'deepl' ? keyKept('deepl') : false);
        const expanded = open.has(provider);
        return <article key={provider} className={`service-card${expanded ? ' is-open' : ''}${isDefault ? ' is-default' : ''}`} aria-label={providerName(provider)}>
          <div className="service-card-head">
            <button type="button" className="service-card-toggle" aria-expanded={expanded} aria-controls={`service-${provider}`} onClick={() => toggle(provider)}>
              <span className="service-card-title"><strong>{providerName(provider)}</strong><small>{body[provider].subtitle}</small></span>
              <span className="service-card-badges">
                {isDefault && <span className="badge default"><Star size={11} />{t('appSettings.default')}</span>}
                <span className={`badge ${problem ? '' : 'good'}`}>{problem ? t('appSettings.notConfigured') : t('appSettings.configured')}</span>
              </span>
              <ChevronDown size={16} className="chevron" aria-hidden="true" />
            </button>
            {!isDefault && <button type="button" className="button small" disabled={!!problem} title={problem || t('appSettings.defaultTitle', { name: providerName(provider) })} aria-label={t('appSettings.makeDefaultOf', { name: providerName(provider) })} onClick={() => setValue({ ...value, translation: { ...translation, defaultProvider: provider } })}>{t('appSettings.makeDefault')}</button>}
          </div>
          {!isDefault && problem && !expanded && <p className="service-card-note">{problem}。</p>}
          {expanded && <div className="service-card-body" id={`service-${provider}`}>{body[provider].content}</div>}
        </article>;
      })}
      <p className="hint">{t('appSettings.translationHint')}</p>
    </fieldset>}
    {group === 'pubmed' && <fieldset disabled={busy}>
      <label className="field"><span>{t('appSettings.ncbiKey')}</span><input type="password" autoComplete="off" spellCheck={false} value={value.ncbi.apiKey} placeholder={value.ncbi.apiKeyConfigured && !clearKey.ncbi ? t('appSettings.keySaved') : t('appSettings.notSet')} onChange={e => { setValue({ ...value, ncbi: { ...value.ncbi, apiKey: e.target.value.trim() } }); setClearKey({ ...clearKey, ncbi: false }); }} /></label>
      {value.ncbi.apiKeyConfigured && <label className="inline"><input type="checkbox" checked={clearKey.ncbi} onChange={e => setClearKey({ ...clearKey, ncbi: e.target.checked })} />{t('appSettings.clearKey')}</label>}
      <label className="field"><span>{t('appSettings.ncbiEmail')}</span><input type="email" autoComplete="off" maxLength={254} value={value.ncbi.email} placeholder="admin@example.com" aria-invalid={!!value.ncbi.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.ncbi.email.trim())} onChange={e => setValue({ ...value, ncbi: { ...value.ncbi, email: e.target.value } })} /></label>
      {!!value.ncbi.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.ncbi.email.trim()) && <p className="hint is-error">{t('error.ncbiEmailInvalid')}</p>}
      <p className="hint">{t('appSettings.ncbiEmailWhy')}</p>
      <div className="ncbi-test" data-testid="ncbi-test">
        <button type="button" className="button small" disabled={ncbiTesting} onClick={() => {
          setNcbiTesting(true); setError('');
          const key = clearKey.ncbi ? null : value.ncbi.apiKey;
          void api.settings.testNcbi(key, value.ncbi.email.trim()).then(test => { setNcbiTest({ key: key ?? '', test }); if (!key) void api.settings.ncbiStatus().then(setNcbiStatus).catch(() => {}); }).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setNcbiTesting(false));
        }}>{ncbiTesting ? t('common.working') : t('appSettings.ncbiTestButton')}</button>
        {ncbiTest && ncbiTest.key === (clearKey.ncbi ? '' : value.ncbi.apiKey) ? <p role="status" className={`ncbi-test-result is-${ncbiTest.test.result}`}>{ncbiTestText(ncbiTest.test)}</p>
          : value.ncbi.apiKey ? <p className="hint">{t('appSettings.ncbiKeyChanged')}</p>
          : ncbiStatus?.apiKeyConfigured && !clearKey.ncbi ? <p className="hint">{ncbiStatus.lastTest ? t('appSettings.ncbiSavedTested', { result: ncbiTestText(ncbiStatus.lastTest), time: fmt.date(ncbiStatus.lastTest.testedAt, { dateStyle: 'short', timeStyle: 'short' }) }) : t('appSettings.ncbiSavedUntested')}</p> : null}
      </div>
      <p className="hint">{t('appSettings.ncbiHint')}</p>
    </fieldset>}
    {group === 'server' && <fieldset disabled={busy}>
      {number(t('serverField.backgroundConcurrency'), value.server.backgroundConcurrency, 1, 4, n => server('backgroundConcurrency', n))}
      <label className="field"><span>{t('appSettings.allowlist')}</span><textarea value={value.server.allowedHosts.join('\n')} onChange={e => server('allowedHosts', e.target.value.split('\n'))} onBlur={() => server('allowedHosts', value.server.allowedHosts.map(v => v.trim()).filter(Boolean))} /></label>
      <label className="inline"><input type="checkbox" checked={value.server.dnsOverHttps} onChange={e => server('dnsOverHttps', e.target.checked)} />{t('appSettings.doh')}</label>
      <p className="hint">{t('appSettings.allowlistHint')}</p>
      <label className="field"><span>{t('appSettings.trustedProxies')}</span><textarea value={value.server.trustedProxies.join('\n')} onChange={e => server('trustedProxies', e.target.value.split('\n'))} onBlur={() => server('trustedProxies', value.server.trustedProxies.map(v => v.trim()).filter(Boolean))} /></label>
      <label className="field"><span>{t('serverField.publicOrigin')}</span><input required type="url" value={value.server.publicOrigin} onChange={e => server('publicOrigin', e.target.value)} /></label>
      <label className="inline"><input type="checkbox" checked={value.server.cookieSecure} onChange={e => server('cookieSecure', e.target.checked)} />{t('appSettings.cookieSecure')}</label>
      {number(t('serverField.sessionTtlDays'), value.server.sessionTtlDays, 1, 365, n => server('sessionTtlDays', n))}
      <div className="form-row"><label className="field"><span>{t('appSettings.host')}</span><input required value={value.server.host} onChange={e => server('host', e.target.value)} /></label>{number(t('appSettings.port'), value.server.port, 1, 65535, n => server('port', n))}</div>
      <p className="hint">{t('appSettings.deployHint')}</p>
    </fieldset>}
    {error && <p className="error-note" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <div className={`settings-actions${dirty ? ' is-dirty' : ''}`}>
      <button className="button primary" disabled={busy || !dirty}>{busy ? t('common.saving') : group === 'pubmed' ? t('appSettings.pubmed.save') : t('appSettings.saveGroup', { title })}</button>
      {dirty && <button type="button" className="button" disabled={busy} onClick={() => { setValue(saved); setClearKey({ deepl: false, openai: false, ncbi: false }); setMessage(''); setError(''); }}>{t('appSettings.discard')}</button>}
    </div>
  </form>;
}
