import { useState } from 'react';
import { api } from './api';
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
type ServerChange = { key: string; label: string; current: unknown; backup: unknown };
const shown = (value: unknown) => Array.isArray(value) ? (value.length ? value.join('、') : '（空）') : typeof value === 'boolean' ? (value ? '开启' : '关闭') : String(value);
/** The backup's server and network settings next to this instance's, and the opt-in to take them over. */
function ServerChanges({ preview, restoreServer, setRestoreServer }: { preview: Record<string, unknown>; restoreServer: boolean; setRestoreServer: (value: boolean) => void }) {
  if (!preview.serverSettingsIncluded) return <p>这份备份不含服务器与网络设置，恢复后保留本机设置。</p>;
  const changes = (preview.serverChanges ?? []) as ServerChange[];
  return <div className="restore-server">
    <h4>服务器与网络设置</h4>
    {changes.length ? <table className="settings-diff"><thead><tr><th>设置</th><th>本机（默认保留）</th><th>备份</th></tr></thead><tbody>{changes.map(change => <tr key={change.key}><td>{change.label}</td><td>{shown(change.current)}</td><td>{shown(change.backup)}</td></tr>)}</tbody></table> : <p>备份中的服务器与网络设置与本机相同。</p>}
    <label className="checkbox-field"><input type="checkbox" checked={restoreServer} onChange={e => setRestoreServer(e.target.checked)} /><span>同时恢复备份中的服务器与网络设置</span></label>
    <p className="hint">仅在把备份恢复回原来的服务器、或新机器要沿用原地址时勾选。备份里的公开访问地址、可信代理和安全 Cookie 会立即生效，地址与当前访问方式不一致时页面会提示“请求来源不被允许”；监听地址和端口在重启后生效，可能换到另一个端口。白名单和 DNS over HTTPS 也随之替换。</p>
  </div>;
}
export function BackupPanel({ setup = false, onRestored, onImported }: { setup?: boolean; onRestored: () => void; onImported?: () => void }) {
  const [mode, setMode] = useState<'export' | 'restore' | 'config' | 'import' | null>(null);
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [archive, setArchive] = useState<unknown>(null);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [restoreServer, setRestoreServer] = useState(false);
  const reset = () => { setPassword(''); setCurrent(''); setArchive(null); setPreview(null); setError(''); setRestoreServer(false); };
  const body = () => ({ archive, password, ...(setup ? { setupToken: current } : { currentPassword: current }), confirm: true, restoreServerSettings: restoreServer });
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
        else { reset(); setMode(null); onImported?.(); { const bundles = result.bundles as { created: number; skipped: number } | undefined; setStatus(`已导入 ${result.created} 项，跳过 ${result.skipped} 项${bundles ? `；聚合订阅新增 ${bundles.created} 个，跳过 ${bundles.skipped} 个` : ''}。`); } }
      }
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  }
  return <section className="panel settings-form" aria-label={setup ? '从备份恢复' : '备份与迁移'}><h2>{setup ? '从备份恢复' : '备份与迁移'}</h2><p>完整备份包含 Cookie 和订阅密钥，使用独立密码加密。配置导出包含应用及服务器设置和通知渠道密钥，请私密保管；不包含网站 Cookie 和 RSS 密钥。</p><div className="detail-actions">{(setup ? [['restore', '恢复完整备份']] : [['export', '完整备份'], ['restore', '完整恢复'], ['config', '配置导出'], ['import', '配置导入']]).map(([key, label]) => <button type="button" className="button small" disabled={busy} key={key} onClick={() => { reset(); setMode(key as typeof mode); }}>{label}</button>)}</div>
    {mode && <form onSubmit={e => { e.preventDefault(); void run(); }}>
      {['restore', 'export'].includes(mode) && <><label className="field"><span>{setup ? '一次性设置码' : '当前管理员密码'}</span><input type="password" required autoComplete="off" value={current} onChange={e => { setCurrent(e.target.value); setPreview(null); }} /></label><label className="field"><span>备份密码（至少 12 个字符）</span><input type="password" required minLength={12} maxLength={1024} autoComplete="off" value={password} onChange={e => { setPassword(e.target.value); setPreview(null); }} /></label></>}
      {['restore', 'import'].includes(mode) && <label className="field"><span>选择备份或配置 JSON</span><input type="file" required accept=".json,application/json" onChange={async e => { setPreview(null); setArchive(null); const file = e.target.files?.[0]; if (!file) return; try { if (file.size > (mode === 'restore' ? 95_000_000 : 9_000_000)) throw Error('文件超过导入大小限制'); setArchive(JSON.parse(await file.text())); } catch { setError('文件过大或不是有效 JSON'); } }} /></label>}
      {!preview && <button className="button primary" disabled={busy || (['restore', 'import'].includes(mode) && !archive)}>{busy ? '处理中…' : ['restore', 'import'].includes(mode) ? '预览导入' : '下载导出文件'}</button>}
      {preview && <><h3>导入预览</h3>{preview.settings ? <details><summary>{mode === 'restore' ? '将覆盖的应用及通知设置（通知密钥已隐藏）' : '将覆盖的应用、服务器及通知设置（通知密钥已隐藏）'}</summary><pre>{JSON.stringify(preview.settings, null, 2)}</pre></details> : <p>文件没有应用设置，配置导入保留现有设置。</p>}{mode === 'restore' ? <><p>版本 {String(preview.appVersion)} · 时间 {String(preview.createdAt)}</p><p>管理员 {String(preview.username)} · {String(preview.feeds)} 个订阅 · {preview.bundles ? `${String(preview.bundles)} 个聚合订阅 · ` : ''}{String(preview.credentials)} 组凭据 · {String(preview.items)} 条历史</p><p>恢复会替换现有数据并退出登录，之后使用备份中的管理员账号登录。默认保留本机的服务器与网络设置，恢复后仍可从当前地址访问。</p><ServerChanges preview={preview} restoreServer={restoreServer} setRestoreServer={setRestoreServer} /></> : <>{(preview.entries as Array<{ name: string; duplicate: boolean; needsCookie: boolean; needsNetwork?: boolean }>).map((e, i) => <p key={i}>{e.name} · {e.duplicate ? '跳过重复' : e.needsCookie ? '导入并暂停，等待绑定 Cookie' : e.needsNetwork ? '导入并暂停，等待绑定网络配置' : '新增订阅'}</p>)}{((preview.bundles ?? []) as Array<{ name: string; members: number; duplicate: boolean }>).map((b, i) => <p key={`bundle-${i}`}>聚合订阅 {b.name}（{b.members} 个成员）· {b.duplicate ? '跳过同名聚合' : '新增聚合订阅'}</p>)}</>}
      <button type="button" className="button primary" disabled={busy} onClick={() => { if (mode !== 'restore' || window.confirm('覆盖当前全部应用数据并退出登录？')) void run(true); }}>{busy ? '处理中…' : mode === 'restore' ? '确认覆盖恢复' : '确认导入'}</button></>}
      <button type="button" className="button" disabled={busy} onClick={() => { reset(); setMode(null); }}>取消</button>
    </form>}{error && <p className="error-note" role="alert">{error}</p>}{status && <p role="status">{status}</p>}
  </section>;
}
