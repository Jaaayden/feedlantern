import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { notificationChannelLabels, notificationChannels, type NotificationChannel, type NotificationPolicy, type NotificationSummary } from '../shared/types';
import { api } from './api';

type Draft = Record<string, string | boolean | undefined>;
type Notice = { error?: string; message?: string };
const messageOf = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

const descriptions: Record<NotificationChannel, string> = {
  bark: '推送到 iPhone 上的 Bark App。',
  webhook: '以 JSON POST 到你的服务，可附加请求头和 HMAC-SHA256 签名。',
  ntfy: '发布到 ntfy 主题，可使用自建服务器和访问令牌。',
  telegram: '通过 Telegram Bot 发送到个人、群组或频道。',
};

/** Parses "Name: value" lines; an empty text clears every header. */
function parseHeaders(text: string): { name: string; value: string }[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const index = line.indexOf(':');
    if (index <= 0) throw new Error('请求头每行一个，格式为“名称: 值”');
    return { name: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
  });
}

/** Only fields the user typed are sent, so saved secrets never need to round-trip. */
function fieldsOf(channel: NotificationChannel, draft: Draft): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft)) if (value !== undefined) fields[key] = value;
  if (channel === 'webhook' && typeof fields.headers === 'string') fields.headers = parseHeaders(fields.headers);
  return fields;
}

function ready(channel: NotificationChannel, summary: NotificationSummary, draft: Draft): boolean {
  const filled = (key: string, saved: boolean) => draft[key] === undefined ? saved : !!draft[key];
  const c = summary.channels;
  if (channel === 'bark') return filled('url', c.bark.configured);
  if (channel === 'webhook') return filled('url', c.webhook.configured);
  if (channel === 'ntfy') return filled('server', !!c.ntfy.server) && filled('topic', !!c.ntfy.topic);
  return filled('botToken', c.telegram.tokenConfigured) && filled('chatId', !!c.telegram.chatId);
}

function Secret({ label, name, draft, setDraft, saved, placeholder }: { label: string; name: string; draft: Draft; setDraft: (d: Draft) => void; saved: boolean; placeholder: string }) {
  return <label className="field"><span>{label}</span><input type="password" autoComplete="off" value={String(draft[name] ?? '')} placeholder={saved ? '已保存，留空保持不变' : placeholder} onChange={e => setDraft({ ...draft, [name]: e.target.value || undefined })} /></label>;
}

function ChannelCard({ channel, summary, username, userEnabled, onSaved }: { channel: NotificationChannel; summary: NotificationSummary; username: string; userEnabled: boolean; onSaved: (value: NotificationSummary) => void }) {
  const label = notificationChannelLabels[channel];
  const saved = summary.channels[channel];
  const [enabled, setEnabled] = useState(saved.enabled);
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<Notice>({});
  const c = summary.channels;
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice({});
    try {
      const value = await api.notifications.save({ channels: { [channel]: { ...fieldsOf(channel, draft), enabled } } });
      onSaved(value); setEnabled(value.channels[channel].enabled); setDraft({}); setNotice({ message: `${label} 设置已保存。` });
    } catch (error) { setNotice({ error: messageOf(error, '保存失败') }); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setNotice({});
    try { await api.notifications.test(channel, fieldsOf(channel, draft)); setNotice({ message: `已通过 ${label} 向 ${username} 发送测试通知，填写的设置尚未因此保存。` }); }
    catch (error) { setNotice({ error: messageOf(error, '发送失败') }); } finally { setBusy(false); }
  }
  const clear = (fields: Draft, disable = true) => { setDraft({ ...draft, ...fields }); if (disable) setEnabled(false); };
  const text = (name: string, fieldLabel: string, value: string, placeholder: string) => <label className="field"><span>{fieldLabel}</span><input autoComplete="off" value={String(draft[name] ?? value)} placeholder={placeholder} onChange={e => setDraft({ ...draft, [name]: e.target.value })} /></label>;
  let fields: ReactNode;
  if (channel === 'bark') fields = <>
    <label className="field"><span>Bark 推送地址</span><input type="password" autoComplete="off" value={String(draft.url ?? '')} placeholder={c.bark.configured ? '已配置，留空保持原地址' : 'https://api.day.app/设备密钥/'} onChange={e => setDraft({ ...draft, url: e.target.value || undefined })} /></label>
    {c.bark.configured && <p className="hint">已保存：{c.bark.maskedUrl}</p>}
  </>;
  else if (channel === 'webhook') fields = <>
    <label className="field"><span>Webhook 地址</span><input type="password" autoComplete="off" value={String(draft.url ?? '')} placeholder={c.webhook.configured ? '已配置，留空保持原地址' : 'https://example.com/hooks/feedlantern'} onChange={e => setDraft({ ...draft, url: e.target.value || undefined })} /></label>
    {c.webhook.configured && <p className="hint">已保存：{c.webhook.maskedUrl}</p>}
    <Secret label="签名密钥（可选）" name="secret" draft={draft} setDraft={setDraft} saved={c.webhook.signed} placeholder="用于 X-FeedLantern-Signature-256 签名头" />
    <label className="field"><span>自定义请求头（可选）</span><textarea rows={2} autoComplete="off" spellCheck={false} value={String(draft.headers ?? '')} placeholder={c.webhook.headerNames.length ? `已保存：${c.webhook.headerNames.join('、')}。留空保持不变，填写后整体替换` : '每行一个，例如 Authorization: Bearer …'} onChange={e => setDraft({ ...draft, headers: e.target.value || undefined })} /></label>
    {(c.webhook.signed || c.webhook.headerNames.length > 0) && <div className="inline">
      {c.webhook.signed && <button type="button" className="button small" onClick={() => clear({ secret: '' }, false)}>移除签名密钥</button>}
      {c.webhook.headerNames.length > 0 && <button type="button" className="button small" onClick={() => clear({ headers: '' }, false)}>移除自定义请求头</button>}
    </div>}
  </>;
  else if (channel === 'ntfy') fields = <>
    <div className="form-row">{text('server', 'ntfy 服务器地址', c.ntfy.server, 'https://ntfy.sh/')}{text('topic', 'ntfy 主题', c.ntfy.topic, '例如 feedlantern-alerts')}</div>
    <Secret label="访问令牌（可选）" name="token" draft={draft} setDraft={setDraft} saved={c.ntfy.tokenConfigured} placeholder="受保护的主题需要，例如 tk_…" />
  </>;
  else fields = <>
    <Secret label="Bot Token" name="botToken" draft={draft} setDraft={setDraft} saved={c.telegram.tokenConfigured} placeholder="123456:ABC…，由 @BotFather 提供" />
    {text('chatId', 'Chat ID', c.telegram.chatId, '数字 ID 或 @频道名')}
  </>;
  const clearAll: Record<NotificationChannel, Draft> = { bark: { url: '' }, webhook: { url: '', secret: '', headers: '' }, ntfy: { topic: '', token: '' }, telegram: { botToken: '', chatId: '' } };
  const clearing = Object.entries(clearAll[channel]).some(([key]) => draft[key] === '');
  const state = saved.enabled ? ['已启用', 'good'] : saved.configured ? ['未启用', ''] : ['未配置', ''];
  return <form className="channel-card" aria-label={`${label} 渠道`} onSubmit={save}>
    <div className="channel-heading"><h3>{label}</h3><span className={`badge ${state[1]}`}>{state[0]}</span></div>
    <p className="hint">{descriptions[channel]}</p>
    <fieldset disabled={busy}>
      <label className="inline"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />启用 {label} 告警</label>
      {fields}
      {clearing && <p className="hint">保存后将清除已填写的配置；必填项被清除时渠道会自动停用。</p>}
      <div className="inline">
        <button className="button small primary">保存 {label}</button>
        <button type="button" className="button small" disabled={!userEnabled || !ready(channel, summary, draft)} onClick={() => void test()}>发送测试通知</button>
        {saved.configured && <button type="button" className="button small" onClick={() => clear(clearAll[channel])}>清除配置</button>}
      </div>
    </fieldset>
    {notice.error && <p className="error-note" role="alert">{notice.error}</p>}{notice.message && <p role="status">{notice.message}</p>}
  </form>;
}

function PolicyForm({ summary, onSaved }: { summary: NotificationSummary; onSaved: (value: NotificationSummary) => void }) {
  const [policy, setPolicy] = useState<NotificationPolicy>(summary);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<Notice>({});
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice({});
    const { failureThreshold, timeoutSeconds, maxAttempts, retryDelaySeconds, laterRetryDelaySeconds, cooldownMinutes, ruleHealthAlerts } = policy;
    try { onSaved(await api.notifications.save({ failureThreshold, timeoutSeconds, maxAttempts, retryDelaySeconds, laterRetryDelaySeconds, cooldownMinutes, ruleHealthAlerts })); setNotice({ message: '告警策略已保存。' }); }
    catch (error) { setNotice({ error: messageOf(error, '保存失败') }); } finally { setBusy(false); }
  }
  const number = (key: Exclude<keyof NotificationPolicy, 'ruleHealthAlerts'>, label: string, min: number, max: number) => <label className="field"><span>{label}</span><input type="number" required min={min} max={max} value={policy[key]} onChange={e => setPolicy({ ...policy, [key]: Number(e.target.value) })} /></label>;
  return <form className="channel-card" aria-label="告警策略" onSubmit={save}>
    <div className="channel-heading"><h3>告警策略</h3></div>
    <p className="hint">对所有渠道生效；每个渠道分别重试并记录发送结果。</p>
    <fieldset disabled={busy}>
      {number('failureThreshold', '连续抓取失败告警阈值（次）', 1, 1000)}
      <label className="inline"><input type="checkbox" checked={policy.ruleHealthAlerts !== false} onChange={e => setPolicy({ ...policy, ruleHealthAlerts: e.target.checked })} />规则可能失效时通知</label>
      <p className="hint">抓取成功但条目数骤降、字段大面积缺失或链接全部相同时提醒；每次出现只通知一次，与抓取失败告警分开计算。</p>
      <div className="form-row">{number('timeoutSeconds', '推送超时（秒）', 1, 60)}{number('maxAttempts', '每个渠道最多发送次数', 1, 5)}</div>
      <div className="form-row">{number('retryDelaySeconds', '首次重试间隔（秒）', 1, 3600)}{number('laterRetryDelaySeconds', '后续重试间隔（秒）', 1, 3600)}</div>
      {number('cooldownMinutes', '发送失败后冷却（分钟）', 1, 1440)}
      <div className="inline"><button className="button small primary">保存告警策略</button></div>
    </fieldset>
    {notice.error && <p className="error-note" role="alert">{notice.error}</p>}{notice.message && <p role="status">{notice.message}</p>}
  </form>;
}

export function NotificationsPanel({ username, enabled }: { username: string; enabled: boolean }) {
  const [summary, setSummary] = useState<NotificationSummary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { let live = true; void api.notifications.get().then(v => { if (live) setSummary(v); }).catch(e => { if (live) setError(messageOf(e, '加载失败')); }); return () => { live = false; }; }, []);
  if (!summary) return <section className="panel settings-form">{error || '正在加载通知…'}</section>;
  return <section className="panel settings-form notification-panel" aria-label="通知">
    <h2>通知</h2>
    <p className="muted">只发送给账号 {username}：包括此账号订阅的抓取、翻译故障和规则失效预警，会同时发到所有已启用的渠道。</p>
    <div className="channel-list">
      {notificationChannels.map(channel => <ChannelCard key={channel} channel={channel} summary={summary} username={username} userEnabled={enabled} onSaved={setSummary} />)}
    </div>
    <PolicyForm summary={summary} onSaved={setSummary} />
    <p className="hint">启用、停用渠道或更换推送目标会取消此账号尚未发出的旧通知，不影响其他用户。保存不会发送测试通知；Webhook、ntfy 等地址不能指向内网或本机，除非管理员把它加入目标白名单。</p>
  </section>;
}
