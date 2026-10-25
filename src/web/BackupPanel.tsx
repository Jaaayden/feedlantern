import { useState } from 'react';
import { api } from './api';
import { fmt, t } from './i18n';
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
type ServerChange = { key: string; label: string; current: unknown; backup: unknown };
const shown = (value: unknown) => Array.isArray(value) ? (value.length ? fmt.list(value.map(String), 'unit') : t('backup.empty')) : typeof value === 'boolean' ? (value ? t('common.on') : t('common.off')) : String(value);
/** The backup's server and network settings next to this instance's, and the opt-in to take them over. */
function ServerChanges({ preview, restoreServer, setRestoreServer }: { preview: Record<string, unknown>; restoreServer: boolean; setRestoreServer: (value: boolean) => void }) {
  if (!preview.serverSettingsIncluded) return <p>{t('backup.noServerSettings')}</p>;
  const changes = (preview.serverChanges ?? []) as ServerChange[];
  return <div className="restore-server">
    <h4>{t('backup.serverSettings')}</h4>
    {changes.length ? <table className="settings-diff"><thead><tr><th>{t('backup.setting')}</th><th>{t('backup.thisServer')}</th><th>{t('backup.backup')}</th></tr></thead><tbody>{changes.map(change => <tr key={change.key}><td>{t(`serverField.${change.key}` as 'serverField.host')}</td><td>{shown(change.current)}</td><td>{shown(change.backup)}</td></tr>)}</tbody></table> : <p>{t('backup.sameServerSettings')}</p>}
    <label className="checkbox-field"><input type="checkbox" checked={restoreServer} onChange={e => setRestoreServer(e.target.checked)} /><span>{t('backup.restoreServer')}</span></label>
    <p className="hint">{t('backup.restoreServerHint')}</p>
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
      if (mode === 'export') { download(await api.backups.export(current, password), `feedlantern-backup-${new Date().toISOString().slice(0, 10)}.json`); reset(); setMode(null); setStatus(t('backup.exported')); }
      if (mode === 'config') { download(await api.backups.config(), 'feedlantern-config.json'); setMode(null); setStatus(t('backup.configExported')); }
      if (mode === 'restore') {
        if (!confirm) setPreview(await api.backups.restore(body(), true));
        else { await api.backups.restore(body(), false); reset(); setMode(null); onRestored(); }
      }
      if (mode === 'import') {
        const result = await api.backups.importConfig(archive, confirm);
        if (!confirm) setPreview(result);
        else { reset(); setMode(null); onImported?.(); { const bundles = result.bundles as { created: number; skipped: number } | undefined; setStatus(bundles ? t('backup.importedWithBundles', { created: Number(result.created), skipped: Number(result.skipped), bundlesCreated: bundles.created, bundlesSkipped: bundles.skipped }) : t('backup.imported', { created: Number(result.created), skipped: Number(result.skipped) })); } }
      }
    } catch (e) { setError(e instanceof Error ? e.message : t('error.actionFailed')); } finally { setBusy(false); }
  }
  return <section className="panel settings-form" aria-label={setup ? t('backup.restoreTitle') : t('backup.title')}><h2>{setup ? t('backup.restoreTitle') : t('backup.title')}</h2><p>{t('backup.lead')}</p><div className="detail-actions">{(setup ? [['restore', t('backup.restoreFull')]] : [['export', t('backup.export')], ['restore', t('backup.restore')], ['config', t('backup.configExport')], ['import', t('backup.configImport')]]).map(([key, label]) => <button type="button" className="button small" disabled={busy} key={key} onClick={() => { reset(); setMode(key as typeof mode); }}>{label}</button>)}</div>
    {mode && <form onSubmit={e => { e.preventDefault(); void run(); }}>
      {['restore', 'export'].includes(mode) && <><label className="field"><span>{setup ? t('auth.setupCode') : t('backup.currentAdminPassword')}</span><input type="password" required autoComplete="off" value={current} onChange={e => { setCurrent(e.target.value); setPreview(null); }} /></label><label className="field"><span>{t('backup.password')}</span><input type="password" required minLength={12} maxLength={1024} autoComplete="off" value={password} onChange={e => { setPassword(e.target.value); setPreview(null); }} /></label></>}
      {['restore', 'import'].includes(mode) && <label className="field"><span>{t('backup.chooseFile')}</span><input type="file" required accept=".json,application/json" onChange={async e => { setPreview(null); setArchive(null); const file = e.target.files?.[0]; if (!file) return; try { if (file.size > (mode === 'restore' ? 95_000_000 : 9_000_000)) throw Error(t('backup.fileTooLarge')); setArchive(JSON.parse(await file.text())); } catch { setError(t('backup.fileInvalid')); } }} /></label>}
      {!preview && <button className="button primary" disabled={busy || (['restore', 'import'].includes(mode) && !archive)}>{busy ? t('common.working') : ['restore', 'import'].includes(mode) ? t('backup.previewImport') : t('backup.download')}</button>}
      {preview && <><h3>{t('backup.preview')}</h3>{preview.settings ? <details><summary>{mode === 'restore' ? t('backup.overwrittenSettings') : t('backup.overwrittenAllSettings')}</summary><pre>{JSON.stringify(preview.settings, null, 2)}</pre></details> : <p>{t('backup.noSettings')}</p>}{mode === 'restore' ? <><p>{t('backup.versionTime', { version: String(preview.appVersion), time: fmt.date(String(preview.createdAt)) || String(preview.createdAt) })}</p><p>{[t('backup.adminName', { name: String(preview.username) }), t('users.feedCount', { count: Number(preview.feeds) }), ...(preview.bundles ? [t('backup.bundleCount', { count: Number(preview.bundles) })] : []), t('backup.credentialCount', { count: Number(preview.credentials) }), t('backup.itemCount', { count: Number(preview.items) })].join(' · ')}</p><p>{t('backup.restoreWarning')}</p><ServerChanges preview={preview} restoreServer={restoreServer} setRestoreServer={setRestoreServer} /></> : <>{(preview.entries as Array<{ name: string; duplicate: boolean; needsCookie: boolean; needsNetwork?: boolean }>).map((e, i) => <p key={i}>{e.name} · {e.duplicate ? t('backup.skipDuplicate') : e.needsCookie ? t('backup.needsCookie') : e.needsNetwork ? t('backup.needsNetwork') : t('backup.newFeed')}</p>)}{((preview.bundles ?? []) as Array<{ name: string; members: number; duplicate: boolean }>).map((b, i) => <p key={`bundle-${i}`}>{t('backup.bundleEntry', { name: b.name, count: b.members })} · {b.duplicate ? t('backup.skipBundle') : t('backup.newBundle')}</p>)}</>}
      <button type="button" className="button primary" disabled={busy} onClick={() => { if (mode !== 'restore' || window.confirm(t('backup.confirmRestore'))) void run(true); }}>{busy ? t('common.working') : mode === 'restore' ? t('backup.confirmRestoreButton') : t('backup.confirmImport')}</button></>}
      <button type="button" className="button" disabled={busy} onClick={() => { reset(); setMode(null); }}>{t('common.cancel')}</button>
    </form>}{error && <p className="error-note" role="alert">{error}</p>}{status && <p role="status">{status}</p>}
  </section>;
}
