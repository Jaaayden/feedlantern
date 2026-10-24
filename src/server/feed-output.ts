import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { DomUtils, parseDocument } from 'htmlparser2';
import { isFeedSource, ITEM_FILTER_LIMITS, OUTPUT_LIMIT, RETENTION_LIMIT, translationEnabled } from '../shared/types.js';
import type { Feed, FeedItem, ItemFilter, ItemOutputStatus } from '../shared/types.js';
import { LocalizedError, msg, type LocalizedText } from './i18n.js';
import type { Param } from '../shared/i18n.js';

/**
 * Which stored items a feed publishes. RSS, Atom, JSON Feed, the browser
 * preview page and the management UI all go through `classifyItems`, so the
 * output and what the UI marks as filtered can never disagree.
 */

export class ItemFilterError extends LocalizedError {}

/** Characters of the title and of the summary a filter looks at; bounds regex work per item. */
const TITLE_LIMIT = 500;
const SUMMARY_LIMIT = 2_000;
/** Wall-clock budget for running every regex of one feed over all of its items. */
const REGEX_BUDGET_MS = 100;

export function clampOutputLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return OUTPUT_LIMIT.default;
  return Math.min(OUTPUT_LIMIT.max, Math.max(OUTPUT_LIMIT.min, Math.round(value)));
}

/** A stored retention value, or null for automatic. Out-of-range values are clamped. */
export function clampRetentionLimit(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(RETENTION_LIMIT.max, Math.max(RETENTION_LIMIT.min, Math.round(value)));
}

/** Why a retention value cannot be saved next to `outputLimit`, or null when it can. */
export function retentionProblem(retention: unknown, outputLimit: number | undefined): LocalizedText | null {
  if (retention === null) return null;
  if (typeof retention !== 'number' || !Number.isInteger(retention) || retention < RETENTION_LIMIT.min || retention > RETENTION_LIMIT.max) {
    return msg('error.retentionRange', { min: RETENTION_LIMIT.min, max: RETENTION_LIMIT.max });
  }
  const output = clampOutputLimit(outputLimit);
  return retention < output ? msg('error.retentionBelowOutput', { output }) : null;
}

/**
 * Items kept in the database. A feed may set its own value; automatic keeps
 * 200 for website feeds so filters still have candidates and 100 for RSS
 * feeds because every stored item is translated. Never fewer than the output
 * limit. Website fetches additionally keep every item they just saw (see
 * `Store.upsertItems`), so an item still on the page is never deleted and
 * then stored again as new.
 */
export function storedItemLimit(feed: Pick<Feed, 'sourceType' | 'outputLimit' | 'retentionLimit'>): number {
  const automatic = isFeedSource(feed) ? RETENTION_LIMIT.rssAuto : RETENTION_LIMIT.websiteAuto;
  return Math.max(clampRetentionLimit(feed.retentionLimit) ?? automatic, clampOutputLimit(feed.outputLimit));
}

/**
 * Static check for patterns that backtrack exponentially: a repeated group
 * that itself repeats or alternates, such as `(a+)+` or `(a|ab)*`, and
 * backreferences. Runs on a pattern that already compiles with the `u` flag,
 * so the syntax is known to be valid.
 */
export function unsafeRegexReason(source: string): LocalizedText | null {
  interface Frame { repeats: boolean; alternates: boolean }
  const stack: Frame[] = [{ repeats: false, alternates: false }];
  let closed: Frame | null = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const top = stack[stack.length - 1];
    if (char === '\\') {
      const next = source[i + 1] ?? '';
      if (/[1-9k]/.test(next)) return msg('filter.backreference');
      if (/[upP]/.test(next) && source[i + 2] === '{') i = source.indexOf('}', i);
      else i++;
      closed = null;
      continue;
    }
    if (char === '[') {
      for (i++; i < source.length && source[i] !== ']'; i++) if (source[i] === '\\') i++;
      closed = null;
      continue;
    }
    if (char === '(') {
      stack.push({ repeats: false, alternates: false });
      if (source[i + 1] === '?') {
        if (source[i + 2] === '=' || source[i + 2] === '!') i += 2;
        else if (source[i + 2] === '<' && (source[i + 3] === '=' || source[i + 3] === '!')) i += 3;
        else if (source[i + 2] === '<') i = source.indexOf('>', i);
        else i = source.indexOf(':', i);
      }
      closed = null;
      continue;
    }
    if (char === ')') {
      const group = stack.length > 1 ? stack.pop()! : top;
      stack[stack.length - 1].repeats ||= group.repeats;
      closed = group;
      continue;
    }
    if (char === '|') { top.alternates = true; closed = null; continue; }
    const brace = char === '{' ? /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i)) : null;
    if (char === '*' || char === '+' || char === '?' || brace) {
      const max = brace ? (brace[2] === undefined ? Number(brace[1]) : brace[3] ? Number(brace[3]) : Infinity) : char === '?' ? 1 : Infinity;
      if (brace) i += brace[0].length - 1;
      if (source[i + 1] === '?') i++;
      if (max > 1) {
        if (closed && (closed.repeats || closed.alternates)) return msg('filter.nestedRepeat');
        top.repeats = true;
      }
      closed = null;
      continue;
    }
    closed = null;
  }
  return null;
}

function parsePatterns(value: unknown, label: Param, regex: boolean): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new ItemFilterError(msg('filter.listInvalid', { label }));
  const patterns = [...new Set((value as string[]).map(entry => entry.trim()).filter(Boolean))];
  if (patterns.length > ITEM_FILTER_LIMITS.patterns) throw new ItemFilterError(msg('filter.tooMany', { label, max: ITEM_FILTER_LIMITS.patterns }));
  for (const pattern of patterns) {
    if (pattern.length > ITEM_FILTER_LIMITS.patternLength) throw new ItemFilterError(msg('filter.tooLong', { label, max: ITEM_FILTER_LIMITS.patternLength }));
    if (/[\r\n]/.test(pattern)) throw new ItemFilterError(msg('filter.oneLine', { label }));
    if (!regex) continue;
    try { new RegExp(pattern, 'iu'); } catch { throw new ItemFilterError(msg('filter.regexInvalid', { label, pattern })); }
    const reason = unsafeRegexReason(pattern);
    if (reason) throw new ItemFilterError(msg('filter.regexUnsafe', { label, pattern, reason }));
  }
  return patterns;
}

/** Validate a filter from the API, a config import or a backup. Empty filters become null. */
export function parseItemFilter(value: unknown): ItemFilter | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new ItemFilterError(msg('filter.invalid'));
  const record = value as Record<string, unknown>;
  if (record.regex !== undefined && typeof record.regex !== 'boolean') throw new ItemFilterError(msg('filter.invalid'));
  const regex = record.regex === true;
  const include = parsePatterns(record.include, msg('filter.include'), regex);
  const exclude = parsePatterns(record.exclude, msg('filter.exclude'), regex);
  return include.length || exclude.length ? { include, exclude, regex } : null;
}

/**
 * Title and plain-text summary as the feed publishes them. Patterns are
 * tried on each separately, so `^` and `$` anchor to the field.
 */
export function itemFields(feed: Feed, item: FeedItem): [string, string] {
  const html = translationEnabled(feed) && item.contentHtml !== undefined ? item.contentHtml : item.description ?? '';
  const summary = isFeedSource(feed) || translationEnabled(feed) ? DomUtils.textContent(parseDocument(html)) : html;
  return [item.title.slice(0, TITLE_LIMIT), summary.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_LIMIT)];
}

type Verdict = 'excluded' | 'not-included' | null;
type Fields = [string, string];

const sandbox = vm.createContext(Object.create(null) as object);
const runner = new vm.Script('run()');
/** Run synchronously, but let V8 interrupt the call (including a regex mid-backtrack) after `ms`. */
function withTimeout<T>(operation: () => T, ms: number): T {
  (sandbox as { run?: () => T }).run = operation;
  try { return runner.runInContext(sandbox, { timeout: ms }) as T; }
  finally { (sandbox as { run?: () => T }).run = undefined; }
}

// Public feed URLs can be requested repeatedly; remember regex results per
// filter and content so a slow (or timed out) pattern costs once.
const regexCache = new Map<string, Verdict[] | 'timeout'>();
const REGEX_CACHE_SIZE = 200;
const warned = new Set<string>();

function judge(texts: Fields[], test: (pattern: string, text: string) => boolean, filter: ItemFilter): Verdict[] {
  const matches = (patterns: string[], fields: Fields) => patterns.some(pattern => fields.some(text => test(pattern, text)));
  return texts.map(fields => matches(filter.exclude, fields) ? 'excluded' : filter.include.length && !matches(filter.include, fields) ? 'not-included' : null);
}

function regexVerdicts(filter: ItemFilter, texts: Fields[]): Verdict[] | 'timeout' {
  const key = createHash('sha256').update(JSON.stringify([filter, texts])).digest('hex');
  const cached = regexCache.get(key);
  if (cached) { regexCache.delete(key); regexCache.set(key, cached); return cached; }
  const compiled = new Map([...filter.include, ...filter.exclude].map(pattern => [pattern, new RegExp(pattern, 'iu')]));
  let result: Verdict[] | 'timeout';
  try { result = withTimeout(() => judge(texts, (pattern, text) => compiled.get(pattern)!.test(text), filter), REGEX_BUDGET_MS); }
  catch { result = 'timeout'; }
  regexCache.set(key, result);
  if (regexCache.size > REGEX_CACHE_SIZE) regexCache.delete(regexCache.keys().next().value!);
  return result;
}

export interface OutputSelection {
  /** One status per input item, in input order. */
  statuses: ItemOutputStatus[];
  /** The regex filter ran out of time and was not applied. */
  timedOut: boolean;
}

/**
 * Classify stored items (newest first) for a feed's output. `override`
 * previews unsaved settings. Translated feeds only publish finished
 * translations; then the filter applies; then the output limit.
 */
export function classifyItems(feed: Feed, items: FeedItem[], override: { itemFilter?: ItemFilter | null; outputLimit?: number } = {}): OutputSelection {
  const filter = 'itemFilter' in override ? override.itemFilter ?? undefined : feed.itemFilter;
  const limit = clampOutputLimit(override.outputLimit ?? feed.outputLimit);
  const translated = translationEnabled(feed);
  const statuses: ItemOutputStatus[] = items.map(item => translated && !(item.translationStatus === 'success' && typeof item.contentHtml === 'string') ? 'untranslated' : 'published');
  let timedOut = false;
  if (filter && (filter.include.length || filter.exclude.length)) {
    const candidates = statuses.flatMap((status, index) => status === 'published' ? [index] : []);
    const texts = candidates.map(index => itemFields(feed, items[index]));
    const verdicts = filter.regex
      ? regexVerdicts(filter, texts)
      : judge(texts.map(([title, summary]) => [title.toLowerCase(), summary.toLowerCase()]), (pattern, text) => text.includes(pattern.toLowerCase()), filter);
    if (verdicts === 'timeout') {
      timedOut = true;
      if (!warned.has(feed.id)) { warned.add(feed.id); console.warn(`Regex filter of feed ${feed.id} exceeded ${REGEX_BUDGET_MS} ms; output was not filtered this time`); }
    } else {
      verdicts.forEach((verdict, position) => { if (verdict) statuses[candidates[position]] = verdict; });
    }
  }
  let published = 0;
  for (let index = 0; index < statuses.length; index++) {
    if (statuses[index] !== 'published') continue;
    if (published >= limit) statuses[index] = 'over-limit';
    else published++;
  }
  return { statuses, timedOut };
}
