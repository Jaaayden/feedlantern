import { useState } from 'react';
import { AlertTriangle, Info, LoaderCircle, RefreshCw } from 'lucide-react';
import type { DetectionCandidate, ExtractedItem, Feed, FieldName, RuleHealthReason, RulePreview, RuleRedetectResult, SelectionRules } from '../shared/types';
import { isRuleHealthNotice, optionalFieldReason } from '../shared/rule-health';
export { feedNeedsAttention as needsAttention } from '../shared/rule-health';
import { fmt, t } from './i18n';
import { api } from './api';
import { absoluteTime, relativeTime } from './format';

type RuleKey = 'item' | FieldName;
const ruleKeys: RuleKey[] = ['item', 'title', 'link', 'description', 'image', 'date'];
const label = (key: RuleKey) => t(`field.${key}`);
const signatureOf = (rules: SelectionRules) => JSON.stringify(ruleKeys.map(key => rules[key] ?? ''));
const messageOf = (error: unknown) => error instanceof Error ? error.message : t('common.notDone');
const percent = (value: number) => `${Math.round(value * 100)}%`;

/** A reason in the current language, from its code; the stored message is the fallback. */
export function reasonText(reason: RuleHealthReason, itemCount: number): string {
  if (reason.code === 'item-count') return t('health.itemCount', { baseline: Math.round(reason.baseline), current: reason.current });
  if (reason.code === 'same-link') return t('health.sameLink', { count: itemCount });
  if (reason.code === 'duplicate-links') return t('health.duplicateLinks', { baseline: percent(reason.baseline), current: percent(reason.current) });
  if (reason.code === 'field-rate' && reason.field) return t('health.fieldRate', { field: label(reason.field), baseline: percent(reason.baseline), current: percent(reason.current) });
  return reason.message;
}

/** Short text for lists: the first reason of the active warning. */
export function ruleHealthSummary(feed: Feed): string {
  const warning = feed.ruleHealth;
  return warning ? t(isRuleHealthNotice(warning) ? 'health.noticeSummary' : 'health.summary', { reasons: warning.reasons.map(reason => reasonText(reason, warning.itemCount)).join(t('punctuation.semicolon')) }) : '';
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
    <h4>{heading}<span className="muted">{t('health.count', { count: preview.count })}</span></h4>
    {preview.error && <p className="card-error">{preview.error}</p>}
    {preview.items.length ? <ol>{preview.items.slice(0, 3).map((item: ExtractedItem, index) => <li key={`${item.link}-${index}`}><a href={item.link} target="_blank" rel="noreferrer">{item.title}</a></li>)}</ol> : !preview.error && <p className="muted">{t('health.noContent')}</p>}
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
  if (!warning || feed.sourceType !== 'website' && feed.sourceType !== undefined) return null;
  const notice = isRuleHealthNotice(warning);
  const affectedFields = new Set(warning.reasons.filter(optionalFieldReason).map(reason => reason.field!));
  const badge = t(notice ? 'health.noticeBadge' : 'health.badge');

  const choose = (candidate: DetectionCandidate | undefined) => {
    setCandidateId(candidate?.id ?? ''); setPreview(null);
    // Changed fields are offered for replacement; manually chosen ones stay unless ticked.
    const next: Partial<Record<RuleKey, boolean>> = {};
    if (candidate) for (const key of ruleKeys) if ((candidate.rules[key] ?? '') !== (feed.rules[key] ?? '')) next[key] = feed.ruleOrigins?.[key] !== 'manual' && (!notice || key !== 'item' && affectedFields.has(key) && !!candidate.rules[key]);
    setReplace(next);
  };
  async function run(label: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError('');
    try { await task(); } catch (e) { setError(messageOf(e)); } finally { setBusy(''); }
  }
  const redetect = () => run(t('health.redetecting'), async () => {
    const value = await api.ruleHealth.redetect(feed.id);
    setResult(value);
    choose(value.detection.candidates.find(c => c.id === value.detection.recommendedId) ?? value.detection.candidates[0]);
  });
  const ignore = () => run(t('health.ignoring'), async () => { await api.ruleHealth.ignore(feed.id); setResult(null); updated(); notify(t('health.ignored')); });

  const candidate = result?.detection.candidates.find(c => c.id === candidateId);
  const changed = candidate ? ruleKeys.filter(key => (candidate.rules[key] ?? '') !== (feed.rules[key] ?? '')) : [];
  const merged = candidate ? merge(feed.rules, candidate.rules, replace) : feed.rules;
  const mergedSignature = signatureOf(merged);
  const anyReplaced = mergedSignature !== signatureOf(feed.rules);
  const mergedPreview: RulePreview | undefined = !candidate ? undefined
    : mergedSignature === signatureOf(candidate.rules) ? { count: candidate.count, items: candidate.items }
    : !anyReplaced ? result!.current
    : preview?.signature === mergedSignature ? preview.value : undefined;
  const previewMerged = () => run(t('health.previewing'), async () => { setPreview({ signature: mergedSignature, value: await api.ruleHealth.preview(feed.id, merged) }); });
  const apply = () => run(t('health.replacing'), async () => {
    const origins = Object.fromEntries(changed.filter(key => replace[key]).map(key => [key, 'auto' as const]));
    await api.feeds.update(feed.id, { sourceType: feed.sourceType, translationMode: feed.translationMode, targetLanguage: feed.targetLanguage, translationProvider: feed.translationProvider, name: feed.name, url: feed.url, rules: merged, ruleOrigins: origins, credentialId: feed.credentialId, intervalMinutes: feed.intervalMinutes, waitMs: feed.waitMs, waitForSelector: feed.waitForSelector });
    setResult(null); updated(); notify(t('health.replaced'));
  });

  return <section className="rule-health" data-severity={notice ? 'notice' : 'warning'} aria-label={badge}>
    <div className="rule-health-head">{notice ? <Info size={17} /> : <AlertTriangle size={17} />}<div>
      <strong>{badge}</strong>
      <ul>{warning.reasons.map(reason => <li key={`${reason.code}-${reason.field ?? ''}`}>{reasonText(reason, warning.itemCount)}</li>)}</ul>
      <p className="hint">{notice ? t('health.noticeImpact', { count: warning.itemCount, fields: [...affectedFields].map(label).join(t('punctuation.semicolon')) }) : t('health.stillSuccess')} <span title={absoluteTime(warning.detectedAt)}>{t('health.detected', { time: relativeTime(warning.detectedAt) })}</span>{t('health.compared', { count: warning.baselineSamples })}</p>
    </div></div>
    <div className="inline rule-health-actions">
      <button type="button" className="button small primary" disabled={!!busy} onClick={() => void redetect()}><RefreshCw size={14} />{t(notice ? 'health.redetectFields' : 'health.redetect')}</button>
      <button type="button" className="button small" disabled={!!busy} onClick={() => void ignore()}>{t('health.ignore')}</button>
      {busy && <span className="inline muted" role="status"><LoaderCircle size={14} className="spin" />{busy}</span>}
    </div>
    {error && <div className="error-note" role="alert">{error}</div>}
    {result && <div className="rule-health-compare">
      {result.detection.candidates.length > 1 && <label className="inline">{t('health.candidates')}<select aria-label={t('health.candidates')} value={candidateId} disabled={!!busy} onChange={e => choose(result.detection.candidates.find(c => c.id === e.target.value))}>{result.detection.candidates.map(c => <option key={c.id} value={c.id}>{t('health.candidateOption', { label: c.label, count: c.count })}</option>)}</select></label>}
      <div className="rule-health-columns">
        <Sample heading={t('health.currentRules')} preview={result.current} />
        {candidate ? <Sample heading={t('health.newRules')} preview={{ count: candidate.count, items: candidate.items }} /> : <section className="rule-health-column" aria-label={t('health.newRules')}><h4>{t('health.newRules')}</h4><p className="muted">{t('health.noCandidate')}</p></section>}
      </div>
      {candidate && (changed.length ? <>
        <table className="rule-health-fields"><thead><tr><th>{t('health.replace')}</th><th>{t('health.field')}</th><th>{t('health.current')}</th><th>{t('health.new')}</th></tr></thead><tbody>
          {changed.map(key => <tr key={key}>
            <td><input type="checkbox" aria-label={t('health.replaceField', { field: label(key) })} disabled={!!busy} checked={!!replace[key]} onChange={e => { setReplace({ ...replace, [key]: e.target.checked }); }} /></td>
            <th scope="row">{label(key)}{feed.ruleOrigins?.[key] === 'manual' && <span className="badge">{t('health.manual')}</span>}</th>
            <td><code>{feed.rules[key] || t('common.none')}</code></td><td><code>{candidate.rules[key] || t('common.none')}</code></td>
          </tr>)}
        </tbody></table>
        <p className="hint">{t(notice ? 'health.noticeReplaceHint' : 'health.replaceHint')}</p>
        {anyReplaced && (mergedPreview ? <Sample heading={t('health.mergedPreview')} preview={mergedPreview} /> : <button type="button" className="button small" disabled={!!busy} onClick={() => void previewMerged()}>{t('health.previewMerged')}</button>)}
        <div className="inline">
          <button type="button" className="button small primary" disabled={!!busy || !anyReplaced || !mergedPreview || !mergedPreview.count} onClick={() => void apply()}>{t('health.replaceSelected')}</button>
          <button type="button" className="button small" disabled={!!busy} onClick={() => setResult(null)}>{t('common.cancel')}</button>
        </div>
      </> : <p className="muted">{t(notice ? 'health.sameFields' : 'health.same')}</p>)}
    </div>}
  </section>;
}
