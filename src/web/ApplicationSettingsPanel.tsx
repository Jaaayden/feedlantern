import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronDown, Star } from 'lucide-react';
import { translationProviderLabels, type ApplicationSettings, type TranslationProviderId } from '../shared/types';
import { api } from './api';

/** The instance-wide settings, split into pages that each save only their own fields. */
export type AppSettingsGroup = 'display' | 'translation' | 'server' | 'pubmed';
type Translation = ApplicationSettings['translation'];
type Service = 'deepl' | 'openai';
/** Everything with a write-only API key. */
type KeyOwner = Service | 'ncbi';

const titles: Record<AppSettingsGroup, [string, string]> = {
  display: ['日志与显示', '订阅列表的默认视图，以及抓取日志、规则健康和访问令牌调用记录的保留天数。'],
  translation: ['翻译服务', '订阅可以单独选择服务，未选择的跟随默认。修改默认服务只影响之后的翻译任务，已完成的译文不会重新翻译。'],
  server: ['服务器与网络', '后台并发、网络白名单、反向代理和会话等实例级设置。'],
  pubmed: ['PubMed（NCBI）', 'PubMed 期刊订阅通过 NCBI 官方的 E-utilities 接口获取。这里的设置对所有用户的 PubMed 订阅生效。'],
};
const providers: TranslationProviderId[] = ['google', 'deepl', 'openai'];
const serviceKeys = { deepl: ['plan', 'concurrency', 'requestIntervalMs'], openai: ['baseUrl', 'model', 'systemPrompt', 'concurrency', 'requestIntervalMs'] } as const;

/** Mirrors the server's providerProblem: what a service still needs before it can translate. */
function missing(translation: Translation, provider: TranslationProviderId, keyKept: boolean): string {
  if (provider === 'deepl' && !(translation.deepl.apiKey || keyKept)) return '填写 DeepL API Key 后才能设为默认';
  if (provider === 'openai' && (!translation.openai.baseUrl || !translation.openai.model)) return '填写接口地址和模型名称后才能设为默认';
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

export function ApplicationSettingsPanel({ group, revision, onDirty }: { group: AppSettingsGroup; revision: number; onDirty: (dirty: boolean) => void }) {
  const [saved, setSaved] = useState<ApplicationSettings | null>(null);
  const [value, setValue] = useState<ApplicationSettings | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  /** Saved API keys are never sent back; these mark keys the administrator chose to remove. */
  const [clearKey, setClearKey] = useState<Record<KeyOwner, boolean>>({ deepl: false, openai: false, ncbi: false });
  const [open, setOpen] = useState<Set<TranslationProviderId>>(new Set());
  const [testing, setTesting] = useState<TranslationProviderId | ''>(''), [testResult, setTestResult] = useState<{ provider: TranslationProviderId; ok: boolean; text: string }>();
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
      setMessage(group === 'server' ? '设置已保存。监听地址和端口将在服务重启后生效。' : '设置已保存。');
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); }
  }
  const [title, intro] = titles[group];
  if (!value || !saved) return <section className="panel settings-form" aria-label={title}>{error || '正在加载应用设置…'}</section>;
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
      setTestResult({ provider, ok: true, text: `测试成功：${result.text}` });
    } catch (e) { setTestResult({ provider, ok: false, text: e instanceof Error ? e.message : '测试失败' }); }
    finally { setTesting(''); }
  }
  const testButton = (provider: TranslationProviderId) => <div className="inline service-test">
    <button type="button" className="button small" disabled={!!testing} onClick={() => void test(provider)}>{testing === provider ? '正在测试…' : `测试 ${translationProviderLabels[provider]}`}</button>
    {testResult?.provider === provider && <span role={testResult.ok ? 'status' : 'alert'} className={testResult.ok ? 'hint' : 'error-note'}>{testResult.text}</span>}
  </div>;
  const keyField = (name: Service, label: string) => <>
    <label className="field"><span>{label}</span><input type="password" autoComplete="off" spellCheck={false} value={translation[name].apiKey} placeholder={keyKept(name) ? '已保存，留空保持不变' : '未设置'} onChange={e => { service(name, { apiKey: e.target.value.trim() } as Partial<Translation[typeof name]>); setClearKey({ ...clearKey, [name]: false }); }} /></label>
    {translation[name].apiKeyConfigured && <label className="inline"><input type="checkbox" checked={clearKey[name]} onChange={e => setClearKey({ ...clearKey, [name]: e.target.checked })} />保存时删除已保存的 Key</label>}
  </>;
  const body: Record<TranslationProviderId, { subtitle: string; content: ReactNode }> = {
    google: { subtitle: '实验性，无需密钥', content: <>
      <div className="form-row">{number('Google 请求并发数', translation.concurrency, 1, 16, n => setValue({ ...value, translation: { ...translation, concurrency: n } }))}{number('Google 请求启动间隔（毫秒）', translation.requestIntervalMs, 0, 5000, n => setValue({ ...value, translation: { ...translation, requestIntervalMs: n } }))}</div>
      <p className="hint">默认 6 并发、间隔 100 毫秒；0 表示不额外间隔。遇到限流自动退避。</p>
    </> },
    deepl: { subtitle: translation.deepl.apiKeyConfigured ? 'API Key 已保存' : '需要 API Key', content: <>
      {keyField('deepl', 'DeepL API Key')}
      <div className="form-row">
        <label className="field"><span>DeepL 套餐</span><select value={translation.deepl.plan} onChange={e => service('deepl', { plan: e.target.value as 'auto' | 'free' | 'pro' })}><option value="auto">自动（以 :fx 结尾的 Key 用免费版接口）</option><option value="free">免费版（api-free.deepl.com）</option><option value="pro">付费版（api.deepl.com）</option></select></label>
        {number('DeepL 请求并发数', translation.deepl.concurrency, 1, 16, n => service('deepl', { concurrency: n }))}{number('DeepL 请求启动间隔（毫秒）', translation.deepl.requestIntervalMs, 0, 5000, n => service('deepl', { requestIntervalMs: n }))}
      </div>
      {testButton('deepl')}
    </> },
    openai: { subtitle: translation.openai.model ? `模型 ${translation.openai.model}` : '需要接口地址和模型', content: <>
      <div className="form-row">
        <label className="field"><span>接口地址（Base URL）</span><input type="url" value={translation.openai.baseUrl} placeholder="https://api.openai.com/v1" onChange={e => service('openai', { baseUrl: e.target.value.trim() })} /></label>
        <label className="field"><span>模型名称</span><input value={translation.openai.model} maxLength={200} placeholder="gpt-4o-mini" onChange={e => service('openai', { model: e.target.value })} /></label>
      </div>
      {keyField('openai', 'OpenAI 兼容接口 API Key（本地模型可留空）')}
      <label className="field"><span>自定义系统提示词（可选）</span><textarea rows={3} maxLength={4000} value={translation.openai.systemPrompt} placeholder="留空使用内置提示词，例如可以写：面向技术读者，术语保留英文原文。" onChange={e => service('openai', { systemPrompt: e.target.value })} /></label>
      <div className="form-row">{number('OpenAI 兼容接口请求并发数', translation.openai.concurrency, 1, 16, n => service('openai', { concurrency: n }))}{number('OpenAI 兼容接口请求启动间隔（毫秒）', translation.openai.requestIntervalMs, 0, 5000, n => service('openai', { requestIntervalMs: n }))}</div>
      <p className="hint">请求发送到“接口地址/chat/completions”。分段格式和输出校验固定附加在提示词之后：段数或标签对不上会视为失败并自动重试，不会发布。本机或局域网模型（如 Ollama 的 http://127.0.0.1:11434/v1）需先把 127.0.0.1:11434 加入“服务器与网络 → 网络访问白名单”。</p>
      {testButton('openai')}
    </> },
  };
  const toggle = (provider: TranslationProviderId) => setOpen(previous => { const next = new Set(previous); if (next.has(provider)) next.delete(provider); else next.add(provider); return next; });

  return <form className="panel settings-form application-settings" onSubmit={save} aria-label={title}>
    <div className="panel-heading"><h2>{title}</h2>{dirty && <span className="badge warn">未保存</span>}</div>
    <p className="muted">{intro}</p>
    {group === 'display' && <fieldset disabled={busy}>
      <label className="field"><span>订阅视图</span><select value={value.feedView} onChange={e => setValue({ ...value, feedView: e.target.value as 'list' | 'cards' })}><option value="list">列表</option><option value="cards">卡片</option></select></label>
      {number('日志保留天数', value.logRetentionDays, 1, 365, n => setValue({ ...value, logRetentionDays: n }))}
      <p className="hint">缩短保留天数后，超期日志会自动清理。</p>
    </fieldset>}
    {group === 'translation' && <fieldset disabled={busy} className="service-cards">
      {providers.map(provider => {
        const isDefault = translation.defaultProvider === provider;
        const problem = missing(translation, provider, provider === 'deepl' ? keyKept('deepl') : false);
        const expanded = open.has(provider);
        return <article key={provider} className={`service-card${expanded ? ' is-open' : ''}${isDefault ? ' is-default' : ''}`} aria-label={translationProviderLabels[provider]}>
          <div className="service-card-head">
            <button type="button" className="service-card-toggle" aria-expanded={expanded} aria-controls={`service-${provider}`} onClick={() => toggle(provider)}>
              <span className="service-card-title"><strong>{translationProviderLabels[provider]}</strong><small>{body[provider].subtitle}</small></span>
              <span className="service-card-badges">
                {isDefault && <span className="badge default"><Star size={11} />默认</span>}
                <span className={`badge ${problem ? '' : 'good'}`}>{problem ? '未配置' : '已配置'}</span>
              </span>
              <ChevronDown size={16} className="chevron" aria-hidden="true" />
            </button>
            {!isDefault && <button type="button" className="button small" disabled={!!problem} title={problem || `新任务默认使用${translationProviderLabels[provider]}`} aria-label={`设为默认 ${translationProviderLabels[provider]}`} onClick={() => setValue({ ...value, translation: { ...translation, defaultProvider: provider } })}>设为默认</button>}
          </div>
          {!isDefault && problem && !expanded && <p className="service-card-note">{problem}。</p>}
          {expanded && <div className="service-card-body" id={`service-${provider}`}>{body[provider].content}</div>}
        </article>;
      })}
      <p className="hint">每个服务的并发、间隔和限流退避分别计算；订阅链接仅包含翻译完成的文章。API Key 加密保存，不会在页面或轻量配置文件中显示；完整加密备份会包含它们。</p>
    </fieldset>}
    {group === 'pubmed' && <fieldset disabled={busy}>
      <label className="field"><span>NCBI API Key（可选）</span><input type="password" autoComplete="off" spellCheck={false} value={value.ncbi.apiKey} placeholder={value.ncbi.apiKeyConfigured && !clearKey.ncbi ? '已保存，留空保持不变' : '未设置'} onChange={e => { setValue({ ...value, ncbi: { ...value.ncbi, apiKey: e.target.value.trim() } }); setClearKey({ ...clearKey, ncbi: false }); }} /></label>
      {value.ncbi.apiKeyConfigured && <label className="inline"><input type="checkbox" checked={clearKey.ncbi} onChange={e => setClearKey({ ...clearKey, ncbi: e.target.checked })} />保存时删除已保存的 Key</label>}
      <label className="field"><span>联系邮箱（可选）</span><input type="email" autoComplete="off" maxLength={254} value={value.ncbi.email} placeholder="admin@example.com" onChange={e => setValue({ ...value, ncbi: { ...value.ncbi, email: e.target.value } })} /></label>
      <p className="hint">NCBI 要求程序在请求中注明工具名（FeedLantern 固定发送 tool=feedlantern），并建议附上联系邮箱，以便在请求异常时联系你；留空则不发送邮箱。不填 API Key 时，所有 PubMed 订阅共用每秒最多 3 个请求的额度，填写后提高到每秒 10 个；API Key 可在 NCBI 账号设置中免费申请，加密保存，不会在页面或轻量配置文件中显示。</p>
    </fieldset>}
    {group === 'server' && <fieldset disabled={busy}>
      {number('后台并发数', value.server.backgroundConcurrency, 1, 4, n => server('backgroundConcurrency', n))}
      <label className="field"><span>网络访问白名单（每行一个 hostname:port）</span><textarea value={value.server.allowedHosts.join('\n')} onChange={e => server('allowedHosts', e.target.value.split('\n'))} onBlur={() => server('allowedHosts', value.server.allowedHosts.map(v => v.trim()).filter(Boolean))} /></label>
      <label className="inline"><input type="checkbox" checked={value.server.dnsOverHttps} onChange={e => server('dnsOverHttps', e.target.checked)} />启用 DNS over HTTPS</label>
      <p className="hint">白名单用于明确允许的内网目标；其他目标保持地址安全校验。修改抓取网络设置会关闭现有网页编辑会话。</p>
      <label className="field"><span>可信反向代理（每行一个 IP 或 CIDR）</span><textarea value={value.server.trustedProxies.join('\n')} onChange={e => server('trustedProxies', e.target.value.split('\n'))} onBlur={() => server('trustedProxies', value.server.trustedProxies.map(v => v.trim()).filter(Boolean))} /></label>
      <label className="field"><span>公开访问地址</span><input required type="url" value={value.server.publicOrigin} onChange={e => server('publicOrigin', e.target.value)} /></label>
      <label className="inline"><input type="checkbox" checked={value.server.cookieSecure} onChange={e => server('cookieSecure', e.target.checked)} />强制安全会话 Cookie（仅 HTTPS）</label>
      {number('登录会话有效期（天）', value.server.sessionTtlDays, 1, 365, n => server('sessionTtlDays', n))}
      <div className="form-row"><label className="field"><span>监听地址（重启生效）</span><input required value={value.server.host} onChange={e => server('host', e.target.value)} /></label>{number('监听端口（重启生效）', value.server.port, 1, 65535, n => server('port', n))}</div>
      <p className="hint">容器端口映射、数据卷目录和浏览器安装位置由部署环境管理，不随应用配置更改。</p>
    </fieldset>}
    {error && <p className="error-note" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <div className={`settings-actions${dirty ? ' is-dirty' : ''}`}>
      <button className="button primary" disabled={busy || !dirty}>{busy ? '正在保存…' : group === 'pubmed' ? '保存 PubMed 设置' : `保存${title}`}</button>
      {dirty && <button type="button" className="button" disabled={busy} onClick={() => { setValue(saved); setClearKey({ deepl: false, openai: false, ncbi: false }); setMessage(''); setError(''); }}>放弃修改</button>}
    </div>
  </form>;
}
