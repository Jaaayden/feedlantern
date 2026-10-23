import { useEffect, useState, type FormEvent } from 'react';
import { translationProviderLabels, type ApplicationSettings, type TranslationProviderId } from '../shared/types';
import { api } from './api';

export function ApplicationSettingsPanel({ revision }: { revision: number }) {
  const [value, setValue] = useState<ApplicationSettings | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  /** Saved API keys are never sent back; these mark keys the administrator chose to remove. */
  const [clearKey, setClearKey] = useState({ deepl: false, openai: false });
  const [testing, setTesting] = useState<TranslationProviderId | ''>(''), [testResult, setTestResult] = useState<{ provider: TranslationProviderId; ok: boolean; text: string }>();
  useEffect(() => { let live = true; void api.settings.get().then(v => { if (live) setValue(v); }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, [revision]);
  async function save(e: FormEvent) {
    e.preventDefault(); if (!value) return;
    setBusy(true); setError(''); setMessage('');
    const key = (service: 'deepl' | 'openai') => clearKey[service] ? null : value.translation[service].apiKey;
    try {
      setValue(await api.settings.save({ ...value, translation: { ...value.translation, deepl: { ...value.translation.deepl, apiKey: key('deepl') as string }, openai: { ...value.translation.openai, apiKey: key('openai') as string } } }));
      setClearKey({ deepl: false, openai: false });
      setMessage('设置已保存。监听地址和端口将在服务重启后生效。');
    }
    catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); }
  }
  if (!value) return <section className="panel settings-form">{error || '正在加载应用设置…'}</section>;
  const server = <K extends keyof ApplicationSettings['server']>(key: K, v: ApplicationSettings['server'][K]) => setValue({ ...value, server: { ...value.server, [key]: v } });
  const translation = value.translation;
  const service = <S extends 'deepl' | 'openai'>(name: S, patch: Partial<ApplicationSettings['translation'][S]>) => setValue({ ...value, translation: { ...translation, [name]: { ...translation[name], ...patch } } });
  async function test(provider: TranslationProviderId) {
    setTesting(provider); setTestResult(undefined);
    try {
      const settings = provider === 'google' ? undefined : { ...translation[provider], apiKeyConfigured: undefined, apiKey: clearKey[provider] ? '' : translation[provider].apiKey };
      const result = await api.settings.testTranslation(provider, settings);
      setTestResult({ provider, ok: true, text: `测试成功：${result.text}` });
    } catch (e) { setTestResult({ provider, ok: false, text: e instanceof Error ? e.message : '测试失败' }); }
    finally { setTesting(''); }
  }
  const testButton = (provider: TranslationProviderId) => <div className="inline">
    <button type="button" className="button small" disabled={!!testing} onClick={() => void test(provider)}>{testing === provider ? '正在测试…' : `测试 ${translationProviderLabels[provider]}`}</button>
    {testResult?.provider === provider && <span role={testResult.ok ? 'status' : 'alert'} className={testResult.ok ? 'hint' : 'error-note'}>{testResult.text}</span>}
  </div>;
  const keyField = (name: 'deepl' | 'openai', label: string) => <>
    <label className="field"><span>{label}</span><input type="password" autoComplete="off" spellCheck={false} value={translation[name].apiKey} placeholder={translation[name].apiKeyConfigured && !clearKey[name] ? '已保存，留空保持不变' : '未设置'} onChange={e => { service(name, { apiKey: e.target.value.trim() } as Partial<ApplicationSettings['translation'][typeof name]>); setClearKey({ ...clearKey, [name]: false }); }} /></label>
    {translation[name].apiKeyConfigured && <label className="inline"><input type="checkbox" checked={clearKey[name]} onChange={e => setClearKey({ ...clearKey, [name]: e.target.checked })} />保存时删除已保存的 Key</label>}
  </>;
  const number = (label: string, v: number, min: number, max: number, change: (n: number) => void) => <label className="field"><span>{label}</span><input type="number" required min={min} max={max} step={1} value={v} onChange={e => change(Number(e.target.value))} /></label>;
  return <form className="panel settings-form application-settings" onSubmit={save} aria-label="应用设置">
    <h2>应用设置</h2><p className="muted">这些设置作用于整个实例；个人通知在下方单独配置。</p>
    <fieldset disabled={busy}><legend>日志与显示</legend>
      <label className="field"><span>订阅视图</span><select value={value.feedView} onChange={e => setValue({ ...value, feedView: e.target.value as 'list' | 'cards' })}><option value="list">列表</option><option value="cards">卡片</option></select></label>
      {number('日志保留天数', value.logRetentionDays, 1, 365, n => setValue({ ...value, logRetentionDays: n }))}
      <p className="hint">缩短保留天数后，超期日志会自动清理。</p>
    </fieldset>
    <fieldset disabled={busy}><legend>翻译服务</legend>
      <label className="field"><span>默认翻译服务</span><select value={translation.defaultProvider} onChange={e => setValue({ ...value, translation: { ...translation, defaultProvider: e.target.value as TranslationProviderId } })}>{(Object.keys(translationProviderLabels) as TranslationProviderId[]).map(id => <option key={id} value={id}>{translationProviderLabels[id]}</option>)}</select></label>
      <p className="hint">订阅可以单独选择服务，未选择的跟随默认。修改默认服务只影响之后的翻译任务，已完成的译文不会重新翻译。每个服务的并发、间隔和限流退避分别计算；订阅链接仅包含翻译完成的文章。</p>
      <h3 className="settings-subheading">Google 免费翻译（实验性，无需密钥）</h3>
      <div className="form-row">{number('Google 请求并发数', translation.concurrency, 1, 16, n => setValue({ ...value, translation: { ...translation, concurrency: n } }))}{number('Google 请求启动间隔（毫秒）', translation.requestIntervalMs, 0, 5000, n => setValue({ ...value, translation: { ...translation, requestIntervalMs: n } }))}</div>
      <p className="hint">默认 6 并发、间隔 100 毫秒；0 表示不额外间隔。遇到限流自动退避。</p>
      <h3 className="settings-subheading">DeepL</h3>
      {keyField('deepl', 'DeepL API Key')}
      <div className="form-row">
        <label className="field"><span>DeepL 套餐</span><select value={translation.deepl.plan} onChange={e => service('deepl', { plan: e.target.value as 'auto' | 'free' | 'pro' })}><option value="auto">自动（以 :fx 结尾的 Key 用免费版接口）</option><option value="free">免费版（api-free.deepl.com）</option><option value="pro">付费版（api.deepl.com）</option></select></label>
        {number('DeepL 请求并发数', translation.deepl.concurrency, 1, 16, n => service('deepl', { concurrency: n }))}{number('DeepL 请求启动间隔（毫秒）', translation.deepl.requestIntervalMs, 0, 5000, n => service('deepl', { requestIntervalMs: n }))}
      </div>
      {testButton('deepl')}
      <h3 className="settings-subheading">OpenAI 兼容接口</h3>
      <div className="form-row">
        <label className="field"><span>接口地址（Base URL）</span><input type="url" value={translation.openai.baseUrl} placeholder="https://api.openai.com/v1" onChange={e => service('openai', { baseUrl: e.target.value.trim() })} /></label>
        <label className="field"><span>模型名称</span><input value={translation.openai.model} maxLength={200} placeholder="gpt-4o-mini" onChange={e => service('openai', { model: e.target.value })} /></label>
      </div>
      {keyField('openai', 'OpenAI 兼容接口 API Key（本地模型可留空）')}
      <label className="field"><span>自定义系统提示词（可选）</span><textarea rows={3} maxLength={4000} value={translation.openai.systemPrompt} placeholder="留空使用内置提示词，例如可以写：面向技术读者，术语保留英文原文。" onChange={e => service('openai', { systemPrompt: e.target.value })} /></label>
      <div className="form-row">{number('OpenAI 兼容接口请求并发数', translation.openai.concurrency, 1, 16, n => service('openai', { concurrency: n }))}{number('OpenAI 兼容接口请求启动间隔（毫秒）', translation.openai.requestIntervalMs, 0, 5000, n => service('openai', { requestIntervalMs: n }))}</div>
      <p className="hint">请求发送到“接口地址/chat/completions”。分段格式和输出校验固定附加在提示词之后：段数或标签对不上会视为失败并自动重试，不会发布。本机或局域网模型（如 Ollama 的 http://127.0.0.1:11434/v1）需先把 127.0.0.1:11434 加入下方“网络访问白名单”。</p>
      {testButton('openai')}
      <p className="hint">API Key 加密保存，不会在页面或轻量配置文件中显示；完整加密备份会包含它们。</p>
    </fieldset>
    <fieldset disabled={busy}><legend>服务器与网络</legend>
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
    </fieldset>
    {error && <p className="error-note" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <button className="button primary" disabled={busy}>{busy ? '正在保存…' : '保存应用设置'}</button>
  </form>;
}
