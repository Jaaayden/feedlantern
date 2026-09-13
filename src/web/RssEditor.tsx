import { useState, type FormEvent } from 'react';
import type { Feed, ExtractedItem } from '../shared/types';
import { api } from './api';

export function RssContent({ html, title }: { html: string; title: string }) {
  return <iframe className="rss-content" title={title} sandbox="" referrerPolicy="no-referrer" srcDoc={`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{font:15px/1.7 system-ui;margin:8px;color:#263348;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap}table{max-width:100%;border-collapse:collapse}td,th{border:1px solid #ddd;padding:5px}a{color:#355ab3}</style></head><body>${html}</body></html>`} />;
}

export function RssEditor({ initial, saved, cancel }: { initial?: Feed; saved: (id: string) => void; cancel: () => void }) {
  const [url, setUrl] = useState(initial?.url ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [interval, setInterval] = useState(initial?.intervalMinutes ?? 30);
  const [mode, setMode] = useState<'original' | 'chinese' | 'bilingual'>(initial?.translationMode ?? 'bilingual');
  const [preview, setPreview] = useState<{ url: string; items: ExtractedItem[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function inspect() {
    setBusy(true); setError('');
    try { const result = await api.feeds.previewRss(url); setPreview({ url, items: result.items }); if (!name) setName(result.title); }
    catch (e) { setError(e instanceof Error ? e.message : '预览失败'); } finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const body = { sourceType: 'rss' as const, translationMode: mode, name, url, intervalMinutes: interval, rules: { item: '', title: '', link: '' }, credentialId: null, waitMs: 0 };
      const result = initial ? await api.feeds.update(initial.id, body) : await api.feeds.create(body);
      saved(result.feed.id);
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); }
  }
  return <><button className="back-link" onClick={cancel}>返回订阅</button><div className="page-heading"><div><h1>{initial ? '编辑 RSS 翻译' : '把英文订阅变成中文'}</h1><p>输入 RSS 或 Atom 地址，获取中文或双语订阅链接。</p></div></div>
    <div className="notice">Google 免费翻译 · 实验性。无需密钥；源内有全文就翻译全文，只有摘要就翻译摘要。请求受限时可稍后重试，订阅链接仅输出翻译完成的文章。</div>
    <form className="panel settings-form rss-editor-form" onSubmit={submit}>
      <label className="field"><span>RSS / Atom 地址</span><input type="url" required value={url} disabled={busy} onChange={e => { setUrl(e.target.value); setPreview(undefined); }} placeholder="https://example.com/feed.xml" /></label>
      <button type="button" className="button" disabled={busy || !url} onClick={() => void inspect()}>{busy ? '处理中…' : '预览订阅源'}</button>
      <label className="field"><span>订阅名称</span><input required maxLength={200} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
      <label className="field"><span>输出模式</span><select value={mode} disabled={busy} onChange={e => setMode(e.target.value as typeof mode)}><option value="original">原文（不翻译）</option><option value="bilingual">双语（中文在前）</option><option value="chinese">仅中文</option></select></label>
      <label className="field"><span>刷新间隔（分钟）</span><input type="number" min={5} max={1440} required value={interval} disabled={busy} onChange={e => setInterval(Number(e.target.value))} /></label>
      <p className="hint">首次处理最新 20 条。保存后后台翻译，完成的文章会自动加入订阅链接；切换输出模式不会重新翻译。</p>
      {initial && url !== initial.url && <p className="notice">修改来源地址会清除该订阅原有条目，从新来源重新开始。</p>}
      {error && <div className="error-note" role="alert">{error}</div>}
      <button className="button primary" disabled={busy || (!initial && preview?.url !== url)}>{busy ? '处理中…' : '保存 RSS 翻译订阅'}</button>
    </form>
    {preview && <section className="panel rss-source-preview"><h2>原文预览</h2>{!preview.items.length && <p>订阅源有效，目前没有条目。</p>}{preview.items.map((item, index) => <article key={index}><h3>{item.title}</h3><RssContent title={`原文预览 ${index + 1}`} html={item.contentHtml ?? ''} /></article>)}</section>}
  </>;
}
