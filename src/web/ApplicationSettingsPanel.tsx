import { useEffect, useState, type FormEvent } from 'react';
import type { ApplicationSettings } from '../shared/types';
import { api } from './api';

export function ApplicationSettingsPanel({ revision }: { revision: number }) {
  const [value, setValue] = useState<ApplicationSettings | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; void api.settings.get().then(v => { if (live) setValue(v); }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, [revision]);
  async function save(e: FormEvent) {
    e.preventDefault(); if (!value) return;
    setBusy(true); setError(''); setMessage('');
    try { setValue(await api.settings.save(value)); setMessage('设置已保存。监听地址和端口将在服务重启后生效。'); }
    catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); }
  }
  if (!value) return <section className="panel settings-form">{error || '正在加载应用设置…'}</section>;
  const server = <K extends keyof ApplicationSettings['server']>(key: K, v: ApplicationSettings['server'][K]) => setValue({ ...value, server: { ...value.server, [key]: v } });
  const number = (label: string, v: number, min: number, max: number, change: (n: number) => void) => <label className="field"><span>{label}</span><input type="number" required min={min} max={max} step={1} value={v} onChange={e => change(Number(e.target.value))} /></label>;
  return <form className="panel settings-form application-settings" onSubmit={save} aria-label="应用设置">
    <h2>应用设置</h2><p className="muted">这些设置作用于整个实例；个人通知在下方单独配置。</p>
    <fieldset disabled={busy}><legend>日志与显示</legend>
      <label className="field"><span>订阅视图</span><select value={value.feedView} onChange={e => setValue({ ...value, feedView: e.target.value as 'list' | 'cards' })}><option value="list">列表</option><option value="cards">卡片</option></select></label>
      {number('日志保留天数', value.logRetentionDays, 1, 365, n => setValue({ ...value, logRetentionDays: n }))}
      <p className="hint">缩短保留天数后，超期日志会自动清理。</p>
    </fieldset>
    <fieldset disabled={busy}><legend>RSS 翻译速度</legend>
      <div className="form-row">{number('翻译请求并发数', value.translation.concurrency, 1, 16, n => setValue({ ...value, translation: { ...value.translation, concurrency: n } }))}{number('翻译请求启动间隔（毫秒）', value.translation.requestIntervalMs, 0, 5000, n => setValue({ ...value, translation: { ...value.translation, requestIntervalMs: n } }))}</div>
      <p className="hint">默认 6 并发、间隔 100 毫秒；0 表示不额外间隔。保存后生效，实际速度取决于服务响应；遇到限流自动退避。订阅链接仅包含翻译完成的文章。</p>
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
