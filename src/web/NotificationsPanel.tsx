import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { notificationChannelLabels, notificationChannels, type NotificationChannel, type NotificationPolicy, type NotificationSummary } from '../shared/types';
import { api } from './api';
import { fmt, t } from './i18n';

type Draft = Record<string, string | boolean | undefined>;
type Notice = { error?: string; message?: string };
const messageOf = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

const descriptions: Record<NotificationChannel, string> = {
  get bark() { return t('notifications.desc.bark'); },
  get webhook() { return t('notifications.desc.webhook'); },
  get ntfy() { return t('notifications.desc.ntfy'); },
  get telegram() { return t('notifications.desc.telegram'); },
};

/** Parses "Name: value" lines; an empty text clears every header. */
function parseHeaders(text: string): { name: string; value: string }[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const index = line.indexOf(':');
    if (index <= 0) throw new Error(t('notifications.headerFormat'));
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
  return <label className="field"><span>{label}</span><input type="password" autoComplete="off" value={String(draft[name] ?? '')} placeholder={saved ? t('appSettings.keySaved') : placeholder} onChange={e => setDraft({ ...draft, [name]: e.target.value || undefined })} /></label>;
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
      onSaved(value); setEnabled(value.channels[channel].enabled); setDraft({}); setNotice({ message: t('notifications.channelSaved', { channel: label }) });
    } catch (error) { setNotice({ error: messageOf(error, t('common.saveFailed')) }); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setNotice({});
    try { await api.notifications.test(channel, fieldsOf(channel, draft)); setNotice({ message: t('notifications.testSent', { channel: label, username }) }); }
    catch (error) { setNotice({ error: messageOf(error, t('notifications.sendFailed')) }); } finally { setBusy(false); }
  }
  const clear = (fields: Draft, disable = true) => { setDraft({ ...draft, ...fields }); if (disable) setEnabled(false); };
  const text = (name: string, fieldLabel: string, value: string, placeholder: string) => <label className="field"><span>{fieldLabel}</span><input autoComplete="off" value={String(draft[name] ?? value)} placeholder={placeholder} onChange={e => setDraft({ ...draft, [name]: e.target.value })} /></label>;
  let fields: ReactNode;
  if (channel === 'bark') fields = <>
    <label className="field"><span>{t('notifications.barkUrl')}</span><input type="password" autoComplete="off" value={String(draft.url ?? '')} placeholder={c.bark.configured ? t('notifications.urlKept') : t('notifications.barkPlaceholder')} onChange={e => setDraft({ ...draft, url: e.target.value || undefined })} /></label>
    {c.bark.configured && <p className="hint">{t('notifications.savedValue', { value: c.bark.maskedUrl })}</p>}
  </>;
  else if (channel === 'webhook') fields = <>
    <label className="field"><span>{t('notifications.webhookUrl')}</span><input type="password" autoComplete="off" value={String(draft.url ?? '')} placeholder={c.webhook.configured ? t('notifications.urlKept') : 'https://example.com/hooks/feedlantern'} onChange={e => setDraft({ ...draft, url: e.target.value || undefined })} /></label>
    {c.webhook.configured && <p className="hint">{t('notifications.savedValue', { value: c.webhook.maskedUrl })}</p>}
    <Secret label={t('notifications.secret')} name="secret" draft={draft} setDraft={setDraft} saved={c.webhook.signed} placeholder={t('notifications.secretPlaceholder')} />
    <label className="field"><span>{t('notifications.headers')}</span><textarea rows={2} autoComplete="off" spellCheck={false} value={String(draft.headers ?? '')} placeholder={c.webhook.headerNames.length ? t('notifications.headersSaved', { names: fmt.list(c.webhook.headerNames, 'unit') }) : t('notifications.headersPlaceholder')} onChange={e => setDraft({ ...draft, headers: e.target.value || undefined })} /></label>
    {(c.webhook.signed || c.webhook.headerNames.length > 0) && <div className="inline">
      {c.webhook.signed && <button type="button" className="button small" onClick={() => clear({ secret: '' }, false)}>{t('notifications.removeSecret')}</button>}
      {c.webhook.headerNames.length > 0 && <button type="button" className="button small" onClick={() => clear({ headers: '' }, false)}>{t('notifications.removeHeaders')}</button>}
    </div>}
  </>;
  else if (channel === 'ntfy') fields = <>
    <div className="form-row">{text('server', t('notifications.ntfyServer'), c.ntfy.server, 'https://ntfy.sh/')}{text('topic', t('notifications.ntfyTopic'), c.ntfy.topic, t('notifications.ntfyTopicPlaceholder'))}</div>
    <Secret label={t('notifications.ntfyToken')} name="token" draft={draft} setDraft={setDraft} saved={c.ntfy.tokenConfigured} placeholder={t('notifications.ntfyTokenPlaceholder')} />
  </>;
  else fields = <>
    <Secret label="Bot Token" name="botToken" draft={draft} setDraft={setDraft} saved={c.telegram.tokenConfigured} placeholder={t('notifications.botTokenPlaceholder')} />
    {text('chatId', 'Chat ID', c.telegram.chatId, t('notifications.chatIdPlaceholder'))}
  </>;
  const clearAll: Record<NotificationChannel, Draft> = { bark: { url: '' }, webhook: { url: '', secret: '', headers: '' }, ntfy: { topic: '', token: '' }, telegram: { botToken: '', chatId: '' } };
  const clearing = Object.entries(clearAll[channel]).some(([key]) => draft[key] === '');
  const state = saved.enabled ? [t('users.enabled'), 'good'] : saved.configured ? [t('notifications.off'), ''] : [t('appSettings.notConfigured'), ''];
  return <form className="channel-card" aria-label={t('notifications.channel', { channel: label })} onSubmit={save}>
    <div className="channel-heading"><h3>{label}</h3><span className={`badge ${state[1]}`}>{state[0]}</span></div>
    <p className="hint">{descriptions[channel]}</p>
    <fieldset disabled={busy}>
      <label className="inline"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />{t('notifications.enable', { channel: label })}</label>
      {fields}
      {clearing && <p className="hint">{t('notifications.clearingHint')}</p>}
      <div className="inline">
        <button className="button small primary">{t('notifications.save', { channel: label })}</button>
        <button type="button" className="button small" disabled={!userEnabled || !ready(channel, summary, draft)} onClick={() => void test()}>{t('notifications.sendTest')}</button>
        {saved.configured && <button type="button" className="button small" onClick={() => clear(clearAll[channel])}>{t('notifications.clear')}</button>}
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
    const { failureThreshold, attentionFailureThreshold, timeoutSeconds, maxAttempts, retryDelaySeconds, laterRetryDelaySeconds, cooldownMinutes, ruleHealthAlerts } = policy;
    try { onSaved(await api.notifications.save({ failureThreshold, attentionFailureThreshold, timeoutSeconds, maxAttempts, retryDelaySeconds, laterRetryDelaySeconds, cooldownMinutes, ruleHealthAlerts })); setNotice({ message: t('notifications.policySaved') }); }
    catch (error) { setNotice({ error: messageOf(error, t('common.saveFailed')) }); } finally { setBusy(false); }
  }
  const number = (key: Exclude<keyof NotificationPolicy, 'ruleHealthAlerts'>, label: string, min: number, max: number) => <label className="field"><span>{label}</span><input type="number" required min={min} max={max} value={policy[key]} onChange={e => setPolicy({ ...policy, [key]: Number(e.target.value) })} /></label>;
  return <form className="channel-card" aria-label={t('notifications.policy')} onSubmit={save}>
    <div className="channel-heading"><h3>{t('notifications.policy')}</h3></div>
    <p className="hint">{t('notifications.policyHint')}</p>
    <fieldset disabled={busy}>
      {number('attentionFailureThreshold', t('notifications.attentionThreshold'), 1, 1000)}
      <p className="hint">{t('notifications.attentionHint')}</p>
      {number('failureThreshold', t('notifications.threshold'), 1, 1000)}
      <label className="inline"><input type="checkbox" checked={policy.ruleHealthAlerts !== false} onChange={e => setPolicy({ ...policy, ruleHealthAlerts: e.target.checked })} />{t('notifications.ruleHealth')}</label>
      <p className="hint">{t('notifications.ruleHealthHint')}</p>
      <div className="form-row">{number('timeoutSeconds', t('notifications.timeout'), 1, 60)}{number('maxAttempts', t('notifications.maxAttempts'), 1, 5)}</div>
      <div className="form-row">{number('retryDelaySeconds', t('notifications.retryDelay'), 1, 3600)}{number('laterRetryDelaySeconds', t('notifications.laterRetryDelay'), 1, 3600)}</div>
      {number('cooldownMinutes', t('notifications.cooldown'), 1, 1440)}
      <div className="inline"><button className="button small primary">{t('notifications.savePolicy')}</button></div>
    </fieldset>
    {notice.error && <p className="error-note" role="alert">{notice.error}</p>}{notice.message && <p role="status">{notice.message}</p>}
  </form>;
}

export function NotificationsPanel({ username, enabled, changed }: { username: string; enabled: boolean; changed?: () => void }) {
  const [summary, setSummary] = useState<NotificationSummary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { let live = true; void api.notifications.get().then(v => { if (live) setSummary(v); }).catch(e => { if (live) setError(messageOf(e, t('common.loadFailed'))); }); return () => { live = false; }; }, []);
  const saved = (value: NotificationSummary) => { setSummary(value); changed?.(); };
  if (!summary) return <section className="panel settings-form">{error || t('notifications.loading')}</section>;
  return <section className="panel settings-form notification-panel" aria-label={t('notifications.title')}>
    <h2>{t('notifications.title')}</h2>
    <p className="muted">{t('notifications.lead', { username })}</p>
    <div className="channel-list">
      {notificationChannels.map(channel => <ChannelCard key={channel} channel={channel} summary={summary} username={username} userEnabled={enabled} onSaved={saved} />)}
    </div>
    <PolicyForm summary={summary} onSaved={saved} />
    <p className="hint">{t('notifications.hint')}</p>
  </section>;
}
