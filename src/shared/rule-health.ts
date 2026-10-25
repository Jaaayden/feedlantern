import type { Feed, RuleHealthReason, RuleHealthSeverity, RuleHealthWarning } from './types.js';

/** Keep sidebar, dashboard, admin counts and list filters on the same definition. */
export function feedNeedsAttention(feed: Pick<Feed, 'lastError' | 'ruleHealth'>): boolean {
  return !!feed.lastError || !!feed.ruleHealth && !isRuleHealthNotice(feed.ruleHealth);
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
