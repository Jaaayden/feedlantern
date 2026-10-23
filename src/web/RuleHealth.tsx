import { useState } from 'react';
import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react';
import type { DetectionCandidate, ExtractedItem, Feed, FieldName, RulePreview, RuleRedetectResult, SelectionRules } from '../shared/types';
import { api } from './api';
import { absoluteTime, relativeTime } from './format';

type RuleKey = 'item' | FieldName;
const labels: Record<RuleKey, string> = { item: '条目容器', title: '标题', link: '链接', description: '摘要', image: '图片', date: '日期' };
const ruleKeys = Object.keys(labels) as RuleKey[];
const signatureOf = (rules: SelectionRules) => JSON.stringify(ruleKeys.map(key => rules[key] ?? ''));
const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试';

/** A feed needs checking when the last fetch failed or its rules may have stopped matching. */
export function needsAttention(feed: Feed): boolean { return !!feed.lastError || !!feed.ruleHealth; }

/** Short text for lists: the first reason of the active warning. */
export function ruleHealthSummary(feed: Feed): string {
  return feed.ruleHealth ? `规则可能失效：${feed.ruleHealth.reasons.map(reason => reason.message).join('；')}` : '';
}

function merge(current: SelectionRules, candidate: SelectionRules, replace: Partial<Record<RuleKey, boolean>>): SelectionRules {
  const rules: SelectionRules = { item: '', title: '', link: '' };
  for (const key of ruleKeys) {
    const value = (replace[key] ? candidate[key] : current[key]) ?? '';
    if (value || key === 'item' || key === 'title' || key === 'link') rules[key] = value;
  }
  return rules;
}

function Sample({ heading, preview }: { heading: string; preview: RulePreview }) {
  return <section className="rule-health-column" aria-label={heading}>
    <h4>{heading}<span className="muted">{preview.count} 条</span></h4>
    {preview.error && <p className="card-error">{preview.error}</p>}
    {preview.items.length ? <ol>{preview.items.slice(0, 3).map((item: ExtractedItem, index) => <li key={`${item.link}-${index}`}><a href={item.link} target="_blank" rel="noreferrer">{item.title}</a></li>)}</ol> : !preview.error && <p className="muted">没有内容</p>}
  </section>;
}

/** Warning, re-detection and side-by-side comparison inside the feed panel. */
export function RuleHealthNotice({ feed, updated, notify }: { feed: Feed; updated: () => void; notify: (message: string) => void }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<RuleRedetectResult | null>(null);
  const [candidateId, setCandidateId] = useState('');
  const [replace, setReplace] = useState<Partial<Record<RuleKey, boolean>>>({});
  const [preview, setPreview] = useState<{ signature: string; value: RulePreview } | null>(null);
  const warning = feed.ruleHealth;
  if (!warning || feed.sourceType === 'rss') return null;

  const choose = (candidate: DetectionCandidate | undefined) => {
    setCandidateId(candidate?.id ?? ''); setPreview(null);
    // Changed fields are offered for replacement; manually chosen ones stay unless ticked.
    const next: Partial<Record<RuleKey, boolean>> = {};
    if (candidate) for (const key of ruleKeys) if ((candidate.rules[key] ?? '') !== (feed.rules[key] ?? '')) next[key] = feed.ruleOrigins?.[key] !== 'manual';
    setReplace(next);
  };
  async function run(label: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError('');
    try { await task(); } catch (e) { setError(messageOf(e)); } finally { setBusy(''); }
  }
  const redetect = () => run('正在打开网页并重新识别', async () => {
    const value = await api.ruleHealth.redetect(feed.id);
    setResult(value);
    choose(value.detection.candidates.find(c => c.id === value.detection.recommendedId) ?? value.detection.candidates[0]);
  });
  const ignore = () => run('正在忽略警告', async () => { await api.ruleHealth.ignore(feed.id); setResult(null); updated(); notify('已忽略警告，将以当前结果作为新的基线'); });

  const candidate = result?.detection.candidates.find(c => c.id === candidateId);
  const changed = candidate ? ruleKeys.filter(key => (candidate.rules[key] ?? '') !== (feed.rules[key] ?? '')) : [];
  const merged = candidate ? merge(feed.rules, candidate.rules, replace) : feed.rules;
  const mergedSignature = signatureOf(merged);
  const anyReplaced = mergedSignature !== signatureOf(feed.rules);
  const mergedPreview: RulePreview | undefined = !candidate ? undefined
    : mergedSignature === signatureOf(candidate.rules) ? { count: candidate.count, items: candidate.items }
    : !anyReplaced ? result!.current
    : preview?.signature === mergedSignature ? preview.value : undefined;
  const previewMerged = () => run('正在预览所选组合', async () => { setPreview({ signature: mergedSignature, value: await api.ruleHealth.preview(feed.id, merged) }); });
  const apply = () => run('正在替换规则', async () => {
    const origins = Object.fromEntries(changed.filter(key => replace[key]).map(key => [key, 'auto' as const]));
    await api.feeds.update(feed.id, { sourceType: feed.sourceType, translationMode: feed.translationMode, targetLanguage: feed.targetLanguage, translationProvider: feed.translationProvider, name: feed.name, url: feed.url, rules: merged, ruleOrigins: origins, credentialId: feed.credentialId, intervalMinutes: feed.intervalMinutes, waitMs: feed.waitMs, waitForSelector: feed.waitForSelector });
    setResult(null); updated(); notify('匹配规则已更新');
  });

  return <section className="rule-health" aria-label="规则可能失效">
    <div className="rule-health-head"><AlertTriangle size={17} /><div>
      <strong>规则可能失效</strong>
      <ul>{warning.reasons.map(reason => <li key={`${reason.code}-${reason.field ?? ''}`}>{reason.message}</li>)}</ul>
      <p className="hint">抓取仍记为成功，已有条目不受影响。<span title={absoluteTime(warning.detectedAt)}>{relativeTime(warning.detectedAt)}发现</span>，与最近 {warning.baselineSamples} 次正常抓取比较。</p>
    </div></div>
    <div className="inline rule-health-actions">
      <button type="button" className="button small primary" disabled={!!busy} onClick={() => void redetect()}><RefreshCw size={14} />重新识别</button>
      <button type="button" className="button small" disabled={!!busy} onClick={() => void ignore()}>忽略此警告</button>
      {busy && <span className="inline muted" role="status"><LoaderCircle size={14} className="spin" />{busy}</span>}
    </div>
    {error && <div className="error-note" role="alert">{error}</div>}
    {result && <div className="rule-health-compare">
      {result.detection.candidates.length > 1 && <label className="inline">新识别候选<select aria-label="新识别候选" value={candidateId} disabled={!!busy} onChange={e => choose(result.detection.candidates.find(c => c.id === e.target.value))}>{result.detection.candidates.map(c => <option key={c.id} value={c.id}>{c.label}（{c.count} 条）</option>)}</select></label>}
      <div className="rule-health-columns">
        <Sample heading="当前规则" preview={result.current} />
        {candidate ? <Sample heading="新识别规则" preview={{ count: candidate.count, items: candidate.items }} /> : <section className="rule-health-column" aria-label="新识别规则"><h4>新识别规则</h4><p className="muted">没有找到可靠的列表，可以在「编辑匹配规则」中手动调整。</p></section>}
      </div>
      {candidate && (changed.length ? <>
        <table className="rule-health-fields"><thead><tr><th>替换</th><th>字段</th><th>当前</th><th>新识别</th></tr></thead><tbody>
          {changed.map(key => <tr key={key}>
            <td><input type="checkbox" aria-label={`替换${labels[key]}`} disabled={!!busy} checked={!!replace[key]} onChange={e => { setReplace({ ...replace, [key]: e.target.checked }); }} /></td>
            <th scope="row">{labels[key]}{feed.ruleOrigins?.[key] === 'manual' && <span className="badge">手动选择</span>}</th>
            <td><code>{feed.rules[key] || '（无）'}</code></td><td><code>{candidate.rules[key] || '（无）'}</code></td>
          </tr>)}
        </tbody></table>
        <p className="hint">手动选择过的字段默认保留，勾选后才会替换。替换后立即按新规则抓取一次，并重新积累基线。</p>
        {anyReplaced && (mergedPreview ? <Sample heading="替换后预览" preview={mergedPreview} /> : <button type="button" className="button small" disabled={!!busy} onClick={() => void previewMerged()}>预览所选组合</button>)}
        <div className="inline">
          <button type="button" className="button small primary" disabled={!!busy || !anyReplaced || !mergedPreview || !mergedPreview.count} onClick={() => void apply()}>替换所选字段</button>
          <button type="button" className="button small" disabled={!!busy} onClick={() => setResult(null)}>取消</button>
        </div>
      </> : <p className="muted">新识别的规则与当前规则相同。如果页面内容本身变少了，可以忽略此警告。</p>)}
    </div>}
  </section>;
}
