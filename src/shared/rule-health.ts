import { defaultApplicationSettings, type Feed, type RuleHealthReason, type RuleHealthSeverity, type RuleHealthWarning } from './types.js';

export function repeatedFetchFailure(feed: Pick<Feed, 'lastError' | 'consecutiveFailures' | 'attentionFailureThreshold'>): boolean {
  return !!feed.lastError && (feed.consecutiveFailures ?? 0) >= (feed.attentionFailureThreshold ?? defaultApplicationSettings.bark.attentionFailureThreshold);
}

/** Keep sidebar, dashboard, admin counts and list filters on the same definition. */
export function feedNeedsAttention(feed: Pick<Feed, 'lastError' | 'ruleHealth' | 'consecutiveFailures' | 'attentionFailureThreshold'>): boolean {
  return repeatedFetchFailure(feed) || !!feed.ruleHealth && !isRuleHealthNotice(feed.ruleHealth);
}

/** Optional metadata can disappear while the feed's articles remain usable. */
export function optionalFieldReason(reason: RuleHealthReason): boolean {
  return reason.code === 'field-rate' && (reason.field === 'date' || reason.field === 'image' || reason.field === 'description');
}

/** Unknown reasons stay warnings; a notice must contain only optional fields. */
export function ruleHealthSeverity(reasons: RuleHealthReason[]): RuleHealthSeverity {
  return reasons.length > 0 && reasons.every(optionalFieldReason) ? 'notice' : 'warning';
}

export function isRuleHealthNotice(health: RuleHealthWarning): boolean {
  return ruleHealthSeverity(health.reasons) === 'notice';
}
