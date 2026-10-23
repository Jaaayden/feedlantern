import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { defaultApplicationSettings, type ApplicationSettings, type ExtractedItem, type Feed, type RuleHealthField, type RuleHealthReason, type RuleHealthWarning } from '../shared/types.js';
import { safeDiagnostic } from './fetch-history.js';

/**
 * Thresholds are deliberately conservative: a feed is only judged once it has
 * enough healthy history with the same rules, and only large drops count.
 * Keep these in sync with doc/user-guide.md.
 */
export const RULE_HEALTH = {
  /** Healthy samples with the current rules needed before any judgement. */
  minSamples: 5,
  /** The baseline is the median of this many most recent healthy samples. */
  window: 10,
  /** Flagged (suspicious) samples kept per feed besides the healthy window; all samples also follow the fetch log retention. */
  maxFlagged: 10,
  /** The item count check needs a baseline median of at least this many items. */
  minBaselineItems: 5,
  /** Warn when the item count falls below this share of the baseline median. */
  itemDropRatio: 0.3,
  /** A field rate is only checked when its baseline median is at least this. */
  fieldBaseline: 0.8,
  /** …and warns when the current rate falls to this or below. */
  fieldFloor: 0.3,
  /** Field rates and link checks need at least this many items in the current fetch. */
  minItemsForRates: 3,
  /** Warn about duplicated links when fewer than this share of links are distinct. */
  duplicateRatio: 0.5,
} as const;

export interface RuleHealthSample {
  itemCount: number;
  distinctLinks: number;
  /** Share of items with a distinct title / distinct link / a date / an image / a summary. */
  rates: Record<RuleHealthField, number>;
}

const fieldLabels: Record<RuleHealthField, string> = { title: '标题', link: '链接', date: '日期', image: '图片', description: '摘要' };
const percent = (value: number) => `${Math.round(value * 100)}%`;

function linkKey(link: string): string {
  try { const url = new URL(link); url.hash = ''; return url.toString(); } catch { return link.trim(); }
}

/** Measure the items exactly as extracted, before storage removes duplicate links. */
export function measureItems(items: ExtractedItem[]): RuleHealthSample {
  const count = items.length;
  const rate = (value: number) => count ? value / count : 0;
  const titles = new Set(items.map(item => item.title.trim().toLowerCase()).filter(Boolean));
  const links = new Set(items.map(item => linkKey(item.link)).filter(Boolean));
  return {
    itemCount: count, distinctLinks: links.size,
    rates: {
      title: rate(titles.size), link: rate(links.size),
      date: rate(items.filter(item => item.publishedAt).length),
      image: rate(items.filter(item => item.image).length),
      description: rate(items.filter(item => item.description).length),
    },
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Compare one fetch with recent healthy fetches (newest first). `null` means there is not enough history to judge. */
export function evaluateHealth(sample: RuleHealthSample, history: RuleHealthSample[]): RuleHealthReason[] | null {
  if (history.length < RULE_HEALTH.minSamples) return null;
  const recent = history.slice(0, RULE_HEALTH.window);
  const reasons: RuleHealthReason[] = [];
  const count = median(recent.map(s => s.itemCount));
  if (count >= RULE_HEALTH.minBaselineItems && sample.itemCount < count * RULE_HEALTH.itemDropRatio) {
    reasons.push({ code: 'item-count', baseline: count, current: sample.itemCount, message: `条目数从约 ${Math.round(count)} 条降到 ${sample.itemCount} 条` });
  }
  if (sample.itemCount < RULE_HEALTH.minItemsForRates) return reasons;
  const links = median(recent.map(s => s.rates.link));
  if (links >= RULE_HEALTH.fieldBaseline) {
    if (sample.distinctLinks === 1) reasons.push({ code: 'same-link', baseline: links, current: sample.rates.link, message: `${sample.itemCount} 条内容的链接全部相同` });
    else if (sample.rates.link < RULE_HEALTH.duplicateRatio) reasons.push({ code: 'duplicate-links', baseline: links, current: sample.rates.link, message: `链接大面积重复：不重复的链接从约 ${percent(links)} 降到 ${percent(sample.rates.link)}` });
  }
  for (const field of ['title', 'date', 'image', 'description'] as const) {
    const base = median(recent.map(s => s.rates[field]));
    if (base >= RULE_HEALTH.fieldBaseline && sample.rates[field] <= RULE_HEALTH.fieldFloor) {
      reasons.push({ code: 'field-rate', field, baseline: base, current: sample.rates[field], message: `${fieldLabels[field]}有效率从约 ${percent(base)} 降到 ${percent(sample.rates[field])}` });
    }
  }
  return reasons;
}

/** Saved rules and page together; history from other rules is not comparable. */
export function ruleSignature(feed: Pick<Feed, 'url' | 'rules'>): string {
  const rules = feed.rules;
  return createHash('sha256').update(JSON.stringify([feed.url, rules.item, rules.title, rules.link, rules.description ?? '', rules.image ?? '', rules.date ?? ''])).digest('hex');
}

function parseWarning(value: unknown): RuleHealthWarning | undefined {
  if (typeof value !== 'string') return undefined;
  try { return JSON.parse(value) as RuleHealthWarning; } catch { return undefined; }
}

/**
 * Rule health statistics for website feeds. Samples are diagnostics like fetch
 * logs: bounded per feed, pruned with the log retention and not backed up.
 */
export class RuleHealth {
  constructor(private db: DatabaseSync, private settings: () => ApplicationSettings, private barkForFeed: (id: string) => ApplicationSettings['bark']) {
    if (!db.prepare('PRAGMA table_info(fetch_logs)').all().some(row => row.name === 'warning')) db.exec('ALTER TABLE fetch_logs ADD COLUMN warning TEXT');
  }

  warning(feedId: string): RuleHealthWarning | undefined {
    return parseWarning(this.db.prepare('SELECT warning_json FROM feed_health WHERE feed_id=?').get(feedId)?.warning_json);
  }

  /** Record a successful website fetch and return the active warning, if any. */
  record(feed: Feed, logId: number, items: ExtractedItem[], now = Date.now()): RuleHealthWarning | null {
    if (feed.sourceType === 'rss') return null;
    const signature = ruleSignature(feed);
    const sample = measureItems(items);
    const state = this.db.prepare('SELECT * FROM feed_health WHERE feed_id=?').get(feed.id);
    const previous = state && state.signature === signature ? parseWarning(state.warning_json) : undefined;
    this.db.prepare('DELETE FROM feed_health_samples WHERE feed_id=? AND signature!=?').run(feed.id, signature);
    const history = this.db.prepare('SELECT * FROM feed_health_samples WHERE feed_id=? AND flagged=0 ORDER BY id DESC LIMIT ?').all(feed.id, RULE_HEALTH.window).map(row => ({
      itemCount: Number(row.item_count), distinctLinks: Number(row.distinct_links),
      rates: { title: Number(row.title_rate), link: Number(row.link_rate), date: Number(row.date_rate), image: Number(row.image_rate), description: Number(row.description_rate) },
    }));
    const verdict = evaluateHealth(sample, history);
    // Without enough history an active warning stays: unknown is not healthy.
    const reasons = verdict ?? previous?.reasons ?? [];
    const recordedAt = new Date(now).toISOString();
    this.db.prepare(`INSERT INTO feed_health_samples(feed_id,signature,recorded_at,item_count,distinct_links,title_rate,link_rate,date_rate,image_rate,description_rate,flagged)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(feed.id, signature, recordedAt, sample.itemCount, sample.distinctLinks, sample.rates.title, sample.rates.link, sample.rates.date, sample.rates.image, sample.rates.description, reasons.length ? 1 : 0);
    for (const [flagged, keep] of [[0, RULE_HEALTH.window], [1, RULE_HEALTH.maxFlagged]] as const) {
      this.db.prepare('DELETE FROM feed_health_samples WHERE feed_id=? AND flagged=? AND id NOT IN (SELECT id FROM feed_health_samples WHERE feed_id=? AND flagged=? ORDER BY id DESC LIMIT ?)').run(feed.id, flagged, feed.id, flagged, keep);
    }
    const alertedAt = state?.alerted_at == null ? null : Number(state.alerted_at);
    if (!reasons.length) {
      this.save(feed.id, signature, null, alertedAt);
      this.cancelAlerts(feed.id);
      return null;
    }
    const warning: RuleHealthWarning = { detectedAt: previous?.detectedAt ?? recordedAt, checkedAt: recordedAt, itemCount: sample.itemCount, baselineSamples: verdict ? history.length : previous?.baselineSamples ?? 0, reasons };
    // One notification per warning episode, separate from failure alerts.
    const alert = previous ? { id: null, disabled: false } : this.enqueueAlert(feed, warning, alertedAt, now);
    this.save(feed.id, signature, warning, alert.id ? now : alertedAt);
    this.db.prepare('UPDATE fetch_logs SET warning=?, alert_id=COALESCE(?, alert_id), notification_disabled=? WHERE id=?')
      .run(safeDiagnostic(reasons.map(reason => reason.message).join('；')), alert.id, alert.disabled ? 1 : 0, logId);
    return warning;
  }

  private enqueueAlert(feed: Feed, warning: RuleHealthWarning, alertedAt: number | null, now: number): { id: string | null; disabled: boolean } {
    const bark = this.barkForFeed(feed.id);
    if (!bark.enabled || !bark.url || bark.ruleHealthAlerts === false) return { id: null, disabled: true };
    if (alertedAt !== null && now - alertedAt < bark.cooldownMinutes * 60_000) return { id: null, disabled: false };
    const id = randomUUID();
    let host = '';
    try { host = new URL(feed.url).hostname; } catch { /* stored URLs are validated */ }
    const body = `${safeDiagnostic(feed.name)}\n目标：${host}\n发现时间：${warning.checkedAt}\n${warning.reasons.map(reason => `· ${safeDiagnostic(reason.message)}`).join('\n')}\n抓取仍记为成功。请在订阅面板中重新识别规则，或忽略此警告。`;
    this.db.prepare("INSERT INTO fetch_alerts(id,feed_id,status,body,next_attempt_at,kind) VALUES (?,?,'pending',?,?,'health')").run(id, feed.id, body, now);
    return { id, disabled: false };
  }

  private save(feedId: string, signature: string, warning: RuleHealthWarning | null, alertedAt: number | null): void {
    this.db.prepare(`INSERT INTO feed_health(feed_id,signature,warning_json,alerted_at) VALUES (?,?,?,?)
      ON CONFLICT(feed_id) DO UPDATE SET signature=excluded.signature, warning_json=excluded.warning_json, alerted_at=excluded.alerted_at`)
      .run(feedId, signature, warning ? JSON.stringify(warning) : null, alertedAt);
  }

  private cancelAlerts(feedId: string): void {
    this.db.prepare("UPDATE fetch_alerts SET status='canceled' WHERE feed_id=? AND kind='health' AND status='pending'").run(feedId);
  }

  /** Accept the current result: clear the warning and restart the baseline from the latest sample. */
  ignore(feedId: string): void {
    this.db.prepare('DELETE FROM feed_health_samples WHERE feed_id=? AND id < (SELECT MAX(id) FROM feed_health_samples WHERE feed_id=?)').run(feedId, feedId);
    this.db.prepare('UPDATE feed_health_samples SET flagged=0 WHERE feed_id=?').run(feedId);
    this.db.prepare('UPDATE feed_health SET warning_json=NULL WHERE feed_id=?').run(feedId);
    this.cancelAlerts(feedId);
  }

  /** Edited rules or address: drop the warning and history that no longer apply. */
  sync(feed: Feed): void {
    const signature = ruleSignature(feed);
    this.db.prepare('DELETE FROM feed_health_samples WHERE feed_id=? AND signature!=?').run(feed.id, signature);
    if (this.db.prepare('SELECT 1 FROM feed_health WHERE feed_id=? AND signature!=?').get(feed.id, signature)) {
      this.db.prepare('UPDATE feed_health SET signature=?, warning_json=NULL WHERE feed_id=?').run(signature, feed.id);
      this.cancelAlerts(feed.id);
    }
  }

  prune(now = Date.now()): void {
    const days = this.settings().logRetentionDays ?? defaultApplicationSettings.logRetentionDays;
    this.db.prepare('DELETE FROM feed_health_samples WHERE recorded_at < ?').run(new Date(now - days * 86400_000).toISOString());
  }
}
