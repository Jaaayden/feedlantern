import type { Page } from 'playwright';
import type { ExtractedItem, PageReport, PaginationReport, PaginationRules, PaginationStop, SelectionRules } from '../shared/types.js';
import { ExtractionError, extractPage } from './extraction.js';
import { normalizeLink } from './links.js';
import { NetworkPolicyError } from './network.js';
import { templateUrl } from './validation.js';
import { LocalizedError, errorText, lt, msg, tl } from './i18n.js';

/** Whole-run limits: a paginated collection never runs or grows past these. */
export const PAGINATION_BUDGET_MS = 180_000;
export const MAX_COLLECTED_ITEMS = 1_000;
/** How long a click (next button, load more) may take to change the list. */
const CLICK_CHANGE_TIMEOUT_MS = 10_000;
const CLICK_TIMEOUT_MS = 5_000;

export interface CollectOptions {
  rules: SelectionRules;
  pagination?: PaginationRules | null;
  /** Open a further page in the same tab (and context), like page 1 was opened. */
  load: (url: string, referer: string) => Promise<void>;
  /** The network policy check, run before following a link or a URL template. */
  assertAllowed: (url: string) => Promise<unknown>;
  /** Let a clicked page finish rendering (configured wait, lazy content). */
  settle: () => Promise<void>;
  /** Links already stored for the feed: a page of only those ends the run. */
  isKnown?: (link: string) => boolean;
  signal?: AbortSignal;
  budgetMs?: number;
  /** Test seams. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/** `firstPage` holds the items of page 1 as extracted (rule health compares those only). */
export interface CollectResult { items: ExtractedItem[]; firstPage: ExtractedItem[]; report: PaginationReport }

class BudgetError extends Error {}

// Plain JS for the page VM (see extraction.ts for why it is a string).
const NEXT_SCRIPT = String.raw`(selector) => {
  let element;
  try { element = document.querySelector(selector); } catch (error) { return { invalid: String(error && error.message || error) }; }
  if (!element) return null;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const hidden = style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 && rect.height === 0;
  const className = typeof element.className === 'string' ? element.className : '';
  const disabled = element.disabled === true || element.getAttribute('aria-disabled') === 'true' || /(?:^|\s)(?:disabled|is-disabled)(?:\s|$)/.test(className);
  const anchor = element.closest('a[href]') || element.querySelector('a[href]');
  const raw = anchor ? (anchor.getAttribute('href') || '').trim() : '';
  const href = raw && !/^(?:#|javascript:)/i.test(raw) ? anchor.href : null;
  return { href: href, hidden: hidden, disabled: disabled };
}`;

const SIGNATURE_SCRIPT = String.raw`(selector) => {
  let elements = [];
  try { elements = Array.from(document.querySelectorAll(selector)); } catch {}
  const first = elements[0] ? (elements[0].textContent || '').replace(/\s+/g, ' ').slice(0, 200) : '';
  return { count: elements.length, key: location.href + '|' + elements.length + '|' + first };
}`;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** A page's error for the report, in the current language; "Couldn't open the page:" is implied. */
function message(error: unknown): string {
  const text = errorText(error);
  const detail = text?.key === 'error.failedWithDetail' && (text.params?.action as { key?: string } | undefined)?.key === 'action.openPage' ? String(text.params?.detail ?? '') : undefined;
  const shown = detail ?? (text ? lt(text) : error instanceof Error ? error.message : String(error));
  return shown.split('\n')[0].slice(0, 200);
}

/**
 * Collect items from page 1 (already open in `page`) and, when pagination is
 * set, from further pages in the same tab. Automatic detection, the editor
 * preview and background refreshes all call this. Page 1 failing fails the
 * run; a later page failing ends it with the items collected so far.
 */
export async function collectPages(page: Page, options: CollectOptions): Promise<CollectResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const budget = options.budgetMs ?? PAGINATION_BUDGET_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const plan = options.pagination;
  const maxPages = plan ? Math.max(1, Math.min(10, plan.maxPages)) : 1;
  const items: ExtractedItem[] = [];
  const seen = new Set<string>();
  const pages: PageReport[] = [];
  const checkAbort = () => { if (options.signal?.aborted) throw options.signal.reason ?? new LocalizedError(msg('error.canceled')); };
  const known = (item: ExtractedItem) => seen.has(normalizeLink(item.link)) || !!options.isKnown?.(item.link);
  const add = (list: ExtractedItem[]): ExtractedItem[] => {
    const fresh: ExtractedItem[] = [];
    for (const item of list) {
      const key = normalizeLink(item.link);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(item);
    }
    items.push(...fresh);
    return fresh;
  };
  const finish = (stop: PaginationStop, stoppedAt: number, text: string): CollectResult => {
    if (items.length > MAX_COLLECTED_ITEMS) items.length = MAX_COLLECTED_ITEMS;
    return { items, firstPage: first, report: { pages, stoppedAt, stop, message: text } };
  };

  // Page 1: any error here is the error of the whole run.
  const first = await extractPage(page, options.rules);
  checkAbort();
  const firstAllKnown = first.every(known);
  const firstFresh = add(first);
  pages.push({ page: 1, url: page.url(), count: first.length, added: firstFresh.length });
  if (!plan || maxPages <= 1) return finish('single', 1, tl('pagination.single'));
  if (options.isKnown && firstAllKnown) return finish('known', 1, tl('pagination.firstKnown'));
  if (items.length >= MAX_COLLECTED_ITEMS) return finish('limit', 1, tl('pagination.limit', { max: MAX_COLLECTED_ITEMS, page: 1 }));

  const visited = new Set([normalizeLink(page.url())]);
  const deadline = started + budget;
  const withinBudget = async <T>(operation: Promise<T>): Promise<T> => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new BudgetError();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BudgetError()), remaining); })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const signature = async () => {
    try { return await page.evaluate(`(${SIGNATURE_SCRIPT})(${JSON.stringify(options.rules.item)})`) as { count: number; key: string }; }
    catch { return { count: -1, key: '' }; }
  };

  for (let number = 2; number <= maxPages; number++) {
    checkAbort();
    const previous = number - 1;
    // Decide where the next page is before pausing, so a last page ends at once.
    let target: { url: string } | { click: true };
    if (plan.mode === 'template') {
      target = { url: templateUrl(plan.urlTemplate ?? '', (plan.start ?? 2) + (number - 2) * (plan.step ?? 1)) };
    } else {
      let found: { invalid?: string; href: string | null; hidden: boolean; disabled: boolean } | null;
      try { found = await page.evaluate(`(${NEXT_SCRIPT})(${JSON.stringify(plan.nextSelector ?? '')})`) as typeof found; }
      catch (error) { pages.push({ page: number, url: page.url(), count: 0, added: 0, error: message(error) }); return finish('failed', number, tl(plan.mode === 'next' ? 'pagination.readNextFailed' : 'pagination.readMoreFailed', { page: number, kept: previous })); }
      const name = msg(plan.mode === 'next' ? 'pagination.nextControl' : 'pagination.moreControl');
      if (found?.invalid) return finish('failed', previous, tl('pagination.selectorInvalid', { control: name, detail: found.invalid.slice(0, 120) }));
      if (!found) return finish('end', previous, tl('pagination.controlMissing', { page: previous, control: name }));
      if (found.disabled) return finish('end', previous, tl('pagination.controlDisabled', { page: previous, control: name }));
      if (plan.mode === 'next' && found.href) target = { url: found.href };
      else if (found.hidden) return finish('end', previous, tl('pagination.controlHidden', { page: previous, control: name }));
      else target = { click: true };
    }
    if ('url' in target && visited.has(normalizeLink(target.url))) return finish('repeat', previous, tl('pagination.sameUrl', { page: number }));
    if (now() + plan.delayMs >= deadline) return finish('budget', previous, tl('pagination.nearBudget', { page: previous }));

    await sleep(plan.delayMs + Math.floor(random() * plan.delayMs * 0.2), options.signal);
    checkAbort();
    let list: ExtractedItem[];
    try {
      list = await withinBudget((async () => {
        if ('url' in target) {
          await options.assertAllowed(target.url);
          visited.add(normalizeLink(target.url));
          await options.load(target.url, page.url());
        } else {
          const before = await signature();
          await page.locator(plan.nextSelector!).first().click({ timeout: CLICK_TIMEOUT_MS });
          await page.waitForLoadState('domcontentloaded', { timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
          // Wait for the list to change: more items (load more) or other items (next button).
          const until = Date.now() + CLICK_CHANGE_TIMEOUT_MS;
          while (Date.now() < until) {
            checkAbort();
            const after = await signature();
            if (plan.mode === 'loadMore' ? after.count > before.count : after.key !== before.key && after.count > 0) break;
            await sleep(250, options.signal);
          }
          await options.settle();
          visited.add(normalizeLink(page.url()));
        }
        try { return await extractPage(page, options.rules); }
        catch (error) {
          if (error instanceof ExtractionError && error.text.key === 'extract.noItems') return [];
          throw error;
        }
      })());
    } catch (error) {
      checkAbort();
      if (error instanceof BudgetError) {
        pages.push({ page: number, url: page.url(), count: 0, added: 0, error: tl('pagination.budgetError') });
        return finish('budget', number, tl('pagination.overBudget', { page: number, kept: previous }));
      }
      const text = message(error);
      const url = 'url' in target ? target.url : page.url();
      if (error instanceof NetworkPolicyError || errorText(error)?.key === 'error.pageBlocked') {
        pages.push({ page: number, url, count: 0, added: 0, error: text });
        return finish('blocked', number, tl('pagination.blocked', { page: number, kept: previous }));
      }
      if (/HTTP (?:404|410)\b/.test(text)) {
        pages.push({ page: number, url, count: 0, added: 0, error: text });
        return finish('end', number, tl('pagination.notFound', { page: number, status: text.match(/HTTP \d+/)![0] }));
      }
      pages.push({ page: number, url, count: 0, added: 0, error: text });
      return finish('failed', number, tl('pagination.failed', { page: number, detail: text, kept: previous }));
    }
    checkAbort();
    // "Load more" keeps earlier items on the page; only the appended ones count.
    const pageItems = plan.mode === 'loadMore' ? list.filter(item => !seen.has(normalizeLink(item.link))) : list;
    const allKnown = pageItems.length > 0 && pageItems.every(known);
    const fresh = add(pageItems);
    pages.push({ page: number, url: page.url(), count: pageItems.length, added: fresh.length });
    if (!list.length) return finish('empty', number, tl('pagination.empty', { page: number }));
    if (!fresh.length) return finish('repeat', number, tl(plan.mode === 'loadMore' ? 'pagination.noNewLoad' : 'pagination.samePage', { page: number }));
    if (items.length >= MAX_COLLECTED_ITEMS) return finish('limit', number, tl('pagination.limit', { max: MAX_COLLECTED_ITEMS, page: number }));
    if (options.isKnown && allKnown) return finish('known', number, tl('pagination.known', { page: number }));
  }
  return finish('max', maxPages, tl('pagination.max', { count: maxPages }));
}

/** One line for the fetch log, e.g. "3 pages (12 + 10 + 0 items); page 3 failed: …". */
export function reportSummary(report: PaginationReport): string {
  const counts = report.pages.filter(page => !page.error).map(page => page.added);
  return tl('pagination.summary', { count: counts.length, items: counts.join(' + '), message: report.message });
}
