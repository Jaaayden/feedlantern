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
  const bark = <K extends keyof ApplicationSettings['bark']>(key: K, v: ApplicationSettings['bark'][K]) => setValue({ ...value, bark: { ...value.bark, [key]: v } });
  const server = <K extends keyof ApplicationSettings['server']>(key: K, v: ApplicationSettings['server'][K]) => setValue({ ...value, server: { ...value.server, [key]: v } });
  const number = (label: string, v: number, min: number, max: number, change: (n: number) => void) => <label className="field"><span>{label}</span><input type="number" required min={min} max={max} step={1} value={v} onChange={e => change(Number(e.target.value))} /></label>;
  return <form className="panel settings-form application-settings" onSubmit={save} aria-label="应用设置">
    <h2>应用设置</h2><p className="muted">设置随配置导入导出迁移，Bark 地址在数据库中加密保存。</p>
    <fieldset disabled={busy}><legend>日志与显示</legend>
      <label className="field"><span>订阅视图</span><select value={value.feedView} onChange={e => setValue({ ...value, feedView: e.target.value as 'list' | 'cards' })}><option value="list">列表</option><option value="cards">卡片</option></select></label>
      {number('日志保留天数', value.logRetentionDays, 1, 365, n => setValue({ ...value, logRetentionDays: n }))}
      <p className="hint">缩短保留天数后，超期日志会自动清理。</p>
    </fieldset>
    <fieldset disabled={busy}><legend>Bark 故障通知</legend>
      <label className="inline"><input type="checkbox" checked={value.bark.enabled} onChange={e => bark('enabled', e.target.checked)} />启用 Bark 告警</label>
      <label className="field"><span>Bark 推送地址</span><input type="password" autoComplete="off" placeholder="https://api.day.app/设备密钥/" value={value.bark.url} onChange={e => bark('url', e.target.value)} /></label>
      <p className="hint">首次抓取失败告警，连续失败去重，恢复后重新允许告警。保存不会发送测试通知；关闭或更换地址会取消旧的待发送通知。</p>
      <div className="form-row">{number('推送超时（秒）', value.bark.timeoutSeconds, 1, 60, n => bark('timeoutSeconds', n))}{number('最多发送次数', value.bark.maxAttempts, 1, 5, n => bark('maxAttempts', n))}</div>
      <div className="form-row">{number('首次重试间隔（秒）', value.bark.retryDelaySeconds, 1, 3600, n => bark('retryDelaySeconds', n))}{number('后续重试间隔（秒）', value.bark.laterRetryDelaySeconds, 1, 3600, n => bark('laterRetryDelaySeconds', n))}</div>
      {number('发送失败后冷却（分钟）', value.bark.cooldownMinutes, 1, 1440, n => bark('cooldownMinutes', n))}
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
