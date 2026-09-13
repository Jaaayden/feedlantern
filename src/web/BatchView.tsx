import { useEffect, useState } from 'react';
import type { CredentialSummary, ImportEntry, ImportJob } from '../shared/types';
import { api } from './api';
import { Editor } from './App';
const labels = { queued: '排队中', running: '识别中', created: '已创建', existing: '已存在', review: '待确认', failed: '失败', canceled: '已取消' };
export function BatchView({ notify, changed }: { notify: (s: string) => void; changed: () => void }) {
  const [sourceType, setSourceType] = useState<'website' | 'rss'>('website');
  const [mode, setMode] = useState<'chinese' | 'bilingual'>('bilingual');
  const [text, setText] = useState('');
  const [interval, setRefreshInterval] = useState(60);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ job: ImportJob; entry: ImportEntry } | null>(null);
  async function load() { try { setJobs(await api.jobs.list()); } catch (e) { setError(String(e)); } }
  useEffect(() => { void load(); void api.credentials.list().then(setCredentials).catch(e => setError(String(e))); const timer = setInterval(() => void load(), 2000); return () => clearInterval(timer); }, []);
  const seen = new Set<string>();
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean).map(raw => {
    try { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error(); url.hash = ''; const duplicate = seen.has(url.href); seen.add(url.href); return { raw, url: url.href, error: duplicate ? '重复，将跳过' : '' }; }
    catch { return { raw, url: '', error: '无效网址，请修改' }; }
  });
  if (editing) return <Editor draft={{ name: editing.entry.title ?? '', url: editing.entry.url, credentialId: editing.entry.credentialId, intervalMinutes: editing.entry.intervalMinutes, waitMs: 1000, rules: { item: '', title: '', link: '' } }} submitFeed={input => api.jobs.confirm(editing.job.id, editing.entry.id, input)} cancel={() => setEditing(null)} saved={() => { setEditing(null); void load(); changed(); notify('订阅已保存'); }} />;
  async function run(fn: () => Promise<unknown>) { setError(''); setBusy(true); try { await fn(); await load(); changed(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); } }
  return <><div className="page-heading"><h1>批量添加网址</h1></div><p>{sourceType === 'rss' ? '每行粘贴一个 RSS / Atom 地址，自动创建翻译订阅；译文完成后发布。' : '明确的匹配结果会自动创建，其他结果由你确认。'}关闭页面后任务仍会继续。</p>
    <form className="panel settings-form" onSubmit={e => { e.preventDefault(); void run(async () => { await api.jobs.create(lines.filter(l => !l.error).map(l => ({ url: l.url, credentialId: sourceType === 'rss' ? null : bindings[l.url] || null })), interval, sourceType, mode); setText(''); }); }}>
      <label className="field"><span>批量订阅类型</span><select disabled={busy} value={sourceType} onChange={e => setSourceType(e.target.value as 'website' | 'rss')}><option value="website">网页识别</option><option value="rss">RSS 翻译</option></select></label>
      {sourceType === 'rss' && <label className="field"><span>翻译输出模式</span><select disabled={busy} value={mode} onChange={e => setMode(e.target.value as 'chinese' | 'bilingual')}><option value="bilingual">中英双语</option><option value="chinese">仅中文</option></select></label>}
      <label className="field"><span>每行一个网址（最多 100 个）</span><textarea rows={6} required value={text} onChange={e => setText(e.target.value)} /></label>
      <label className="field"><span>刷新间隔（分钟）</span><input type="number" min={5} max={1440} value={interval} onChange={e => setRefreshInterval(Number(e.target.value))} /></label>
      {lines.map((line, i) => <div className="collection-toolbar" key={i}><span>{line.raw} {line.error}</span>{sourceType === 'website' && !line.error && <select aria-label={`Cookie ${line.url}`} value={bindings[line.url] ?? ''} onChange={e => setBindings({ ...bindings, [line.url]: e.target.value })}><option value="">无需 Cookie</option>{credentials.filter(c => c.domains.some(d => { const host = new URL(line.url).hostname; return d.startsWith('.') ? host === d.slice(1) || host.endsWith(d) : host === d; })).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</div>)}
      <button className="button primary" disabled={busy || !lines.length || lines.length > 100 || lines.some(l => !l.url)}>{sourceType === 'rss' ? '开始批量添加翻译' : '开始批量识别'}</button>
    </form>{error && <div className="error-note" role="alert">{error}</div>}
    {jobs.map(job => <section className="panel settings-form" key={job.id}><div className="collection-toolbar"><h2>{new Date(job.createdAt).toLocaleString('zh-CN')}</h2><div className="inline"><button className="button small" disabled={busy} onClick={() => void run(() => api.jobs.action(job.id, 'cancel'))}>取消未开始项</button><button className="button small" disabled={busy} onClick={() => void run(async () => { const ids = job.entries.flatMap(e => e.feedId ? [e.feedId] : []); if (!ids.length) throw Error('尚无订阅地址'); const result = await api.feeds.bulk(ids, 'copy'); await navigator.clipboard.writeText(result.results.filter(r => r.ok).map(r => r.feedUrl).join('\n')); notify('RSS 地址已复制'); })}>复制本批 RSS 地址</button></div></div>
      {job.entries.map(entry => <article key={entry.id} className="batch-entry"><strong>{entry.title || entry.url}</strong><p>{entry.url} · {entry.sourceType === 'rss' ? `RSS 翻译（${entry.translationMode === 'chinese' ? '中文' : '双语'}） · ${entry.state === 'running' ? '读取订阅源中' : entry.state === 'created' ? '已创建，翻译进度见订阅详情' : labels[entry.state]}` : labels[entry.state]}</p>{entry.error && <p role="alert">{entry.error}</p>}{entry.feedId && <button className="button small" disabled={busy} onClick={() => void run(async () => { const result = (await api.feeds.bulk([entry.feedId!], 'copy')).results[0]; if (!result?.ok || !result.feedUrl) throw Error(result?.error ?? '订阅地址不可用'); await navigator.clipboard.writeText(result.feedUrl); notify('RSS 地址已复制'); })}>复制此订阅 RSS 地址</button>}{entry.detection?.candidates.map(c => <p key={c.id}>{c.label} · {c.count} 项：{c.items.slice(0, 2).map(i => i.title).join('；')}</p>)}{entry.sourceType !== 'rss' && ['review', 'failed'].includes(entry.state) && <button className="button small" onClick={() => setEditing({ job, entry })}>打开并调整匹配</button>}{['failed', 'canceled'].includes(entry.state) && <button className="button small" disabled={busy} onClick={() => void run(() => api.jobs.action(job.id, 'retry', entry.id))}>重试</button>}</article>)}
    </section>)}
  </>;
}
