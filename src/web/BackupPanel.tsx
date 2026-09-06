import { useState } from 'react';
import { api } from './api';
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function BackupPanel({ setup = false, onRestored }: { setup?: boolean; onRestored: () => void }) {
  const [mode, setMode] = useState<'export' | 'restore' | 'config' | 'import' | null>(null);
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [archive, setArchive] = useState<unknown>(null);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const reset = () => { setPassword(''); setCurrent(''); setArchive(null); setPreview(null); setError(''); };
  const body = () => ({ archive, password, ...(setup ? { setupToken: current } : { currentPassword: current }), confirm: true });
  async function run(confirm = false) {
    setBusy(true); setError(''); setStatus('');
    try {
      if (mode === 'export') { download(await api.backups.export(current, password), `feedlantern-backup-${new Date().toISOString().slice(0, 10)}.json`); reset(); setMode(null); setStatus('加密备份已下载，请保管备份密码。'); }
      if (mode === 'config') { download(await api.backups.config(), 'feedlantern-config.json'); setMode(null); setStatus('配置已导出。'); }
      if (mode === 'restore') {
        if (!confirm) setPreview(await api.backups.restore(body(), true));
        else { await api.backups.restore(body(), false); reset(); setMode(null); onRestored(); }
      }
      if (mode === 'import') {
        const result = await api.backups.importConfig(archive, confirm);
        if (!confirm) setPreview(result);
        else { reset(); setMode(null); setStatus(`已导入 ${result.created} 项，跳过 ${result.skipped} 项。`); }
      }
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  }
  return <section className="panel settings-form"><h2>{setup ? '从备份恢复' : '备份与迁移'}</h2><p>完整备份包含 Cookie 和订阅密钥，使用独立密码加密。配置导出不包含凭据，但网址本身可能是私密信息。</p><div className="detail-actions">{(setup ? [['restore', '恢复完整备份']] : [['export', '完整备份'], ['restore', '完整恢复'], ['config', '配置导出'], ['import', '配置导入']]).map(([key, label]) => <button type="button" className="button small" disabled={busy} key={key} onClick={() => { reset(); setMode(key as typeof mode); }}>{label}</button>)}</div>
    {mode && <form onSubmit={e => { e.preventDefault(); void run(); }}>
      {['restore', 'export'].includes(mode) && <><label className="field"><span>{setup ? '一次性设置码' : '当前管理员密码'}</span><input type="password" required autoComplete="off" value={current} onChange={e => { setCurrent(e.target.value); setPreview(null); }} /></label><label className="field"><span>备份密码（至少 12 个字符）</span><input type="password" required minLength={12} maxLength={1024} autoComplete="off" value={password} onChange={e => { setPassword(e.target.value); setPreview(null); }} /></label></>}
      {['restore', 'import'].includes(mode) && <label className="field"><span>选择备份或配置 JSON</span><input type="file" required accept=".json,application/json" onChange={async e => { setPreview(null); setArchive(null); const file = e.target.files?.[0]; if (!file) return; try { if (file.size > (mode === 'restore' ? 95_000_000 : 9_000_000)) throw Error('文件超过导入大小限制'); setArchive(JSON.parse(await file.text())); } catch { setError('文件过大或不是有效 JSON'); } }} /></label>}
      {!preview && <button className="button primary" disabled={busy || (['restore', 'import'].includes(mode) && !archive)}>{busy ? '处理中…' : ['restore', 'import'].includes(mode) ? '预览导入' : '下载导出文件'}</button>}
      {preview && <><h3>导入预览</h3>{mode === 'restore' ? <><p>版本 {String(preview.appVersion)} · 时间 {String(preview.createdAt)}</p><p>管理员 {String(preview.username)} · {String(preview.feeds)} 个订阅 · {String(preview.credentials)} 组凭据 · {String(preview.items)} 条历史</p><p>恢复会替换现有数据并退出登录，之后使用备份中的管理员账号登录。服务器地址和安全配置保持当前设置。</p><details><summary>安全配置差异</summary><pre>{JSON.stringify({ '备份配置': preview.sourceSecurity, '目标配置（保留）': preview.targetSecurity }, null, 2)}</pre></details></> : <>{(preview.entries as Array<{ name: string; duplicate: boolean; needsCookie: boolean }>).map((e, i) => <p key={i}>{e.name} · {e.duplicate ? '跳过重复' : e.needsCookie ? '导入并暂停，等待绑定 Cookie' : '新增订阅'}</p>)}</>}
      <button type="button" className="button primary" disabled={busy} onClick={() => { if (mode !== 'restore' || window.confirm('覆盖当前全部应用数据并退出登录？')) void run(true); }}>{busy ? '处理中…' : mode === 'restore' ? '确认覆盖恢复' : '确认导入'}</button></>}
      <button type="button" className="button" disabled={busy} onClick={() => { reset(); setMode(null); }}>取消</button>
    </form>}{error && <p className="error-note" role="alert">{error}</p>}{status && <p role="status">{status}</p>}
  </section>;
}
