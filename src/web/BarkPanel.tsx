import { useEffect, useState, type FormEvent } from 'react';
import type { ApplicationSettings, BarkSummary } from '../shared/types';
import { api } from './api';

export function BarkPanel({ username, enabled }: { username: string; enabled: boolean }) {
  const [value, setValue] = useState<BarkSummary | null>(null);
  const [url, setUrl] = useState<string | undefined>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  useEffect(() => { let live = true; void api.notifications.get().then(v => { if (live) setValue(v); }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, []);
  const body = (): Partial<ApplicationSettings['bark']> => {
    const { configured, maskedUrl, ...settings } = value!;
    return { ...settings, ...(url !== undefined ? { url } : {}) };
  };
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(''); setMessage('');
    try { setValue(await api.notifications.save(body())); setUrl(undefined); setMessage('个人通知设置已保存。'); }
    catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setError(''); setMessage('');
    try { await api.notifications.test(body()); setMessage(`已向 ${username} 的 Bark 地址发送测试通知，填写的设置尚未因此保存。`); }
    catch (e) { setError(e instanceof Error ? e.message : '发送失败'); } finally { setBusy(false); }
  }
  if (!value) return <section className="panel settings-form">{error || '正在加载个人通知…'}</section>;
  const number = (key: keyof Omit<ApplicationSettings['bark'], 'url' | 'enabled'>, label: string, min: number, max: number) => <label className="field"><span>{label}</span><input type="number" required min={min} max={max} value={value[key]} onChange={e => setValue({ ...value, [key]: Number(e.target.value) })} /></label>;
  return <form className="panel settings-form personal-bark" aria-label="个人 Bark 通知" onSubmit={save}>
    <h2>个人 Bark 通知</h2><p className="muted">接收账号：{username}。只接收此账号订阅的抓取和翻译故障通知。</p>
    <fieldset disabled={busy}><legend>Bark 故障通知</legend>
      <label className="inline"><input type="checkbox" checked={value.enabled} onChange={e => setValue({ ...value, enabled: e.target.checked })} />启用 Bark 告警</label>
      <label className="field"><span>Bark 推送地址</span><input type="password" autoComplete="off" value={url ?? ''} placeholder={value.configured ? '已配置，留空保持原地址' : 'https://api.day.app/设备密钥/'} onChange={e => setUrl(e.target.value || undefined)} /></label>
      {value.configured && <p className="hint">已保存：{value.maskedUrl}</p>}
      <div className="inline"><button type="button" className="button small" onClick={() => { setUrl(''); setValue({ ...value, enabled: false }); }}>清除地址</button><button type="button" className="button small" disabled={!enabled || !(url || url === undefined && value.configured)} onClick={() => void test()}>向 {username} 发送测试通知</button></div>
      {url === '' && <p className="hint">保存后将清除地址并关闭通知。</p>}
      {number('failureThreshold', '连续抓取失败告警阈值（次）', 1, 1000)}
      <div className="form-row">{number('timeoutSeconds', '推送超时（秒）', 1, 60)}{number('maxAttempts', '最多发送次数', 1, 5)}</div>
      <div className="form-row">{number('retryDelaySeconds', '首次重试间隔（秒）', 1, 3600)}{number('laterRetryDelaySeconds', '后续重试间隔（秒）', 1, 3600)}</div>
      {number('cooldownMinutes', '发送失败后冷却（分钟）', 1, 1440)}
      <p className="hint">更换地址或关闭通知会取消此账号的旧待发送通知，不影响其他用户。保存不会发送测试通知。</p>
    </fieldset>
    {error && <p className="error-note" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <button className="button primary" disabled={busy}>保存个人通知</button>
  </form>;
}
