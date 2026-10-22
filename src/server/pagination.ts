import type { Page } from 'playwright';
import type { ExtractedItem, PageReport, PaginationReport, PaginationRules, PaginationStop, SelectionRules } from '../shared/types.js';
import { ExtractionError, extractPage } from './extraction.js';
import { normalizeLink } from './links.js';
import { NetworkPolicyError } from './network.js';
import { templateUrl } from './validation.js';

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

export interface CollectResult { items: ExtractedItem[]; report: PaginationReport }

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

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0].slice(0, 200);
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
  const checkAbort = () => { if (options.signal?.aborted) throw options.signal.reason ?? new Error('操作已取消'); };
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
    return { items, report: { pages, stoppedAt, stop, message: text } };
  };

  // Page 1: any error here is the error of the whole run.
  const first = await extractPage(page, options.rules);
  checkAbort();
  const firstAllKnown = first.every(known);
  const firstFresh = add(first);
  pages.push({ page: 1, url: page.url(), count: first.length, added: firstFresh.length });
  if (!plan || maxPages <= 1) return finish('single', 1, '只抓取源网址这一页');
  if (options.isKnown && firstAllKnown) return finish('known', 1, '第 1 页的条目都已见过，不再翻页');
  if (items.length >= MAX_COLLECTED_ITEMS) return finish('limit', 1, `已达到 ${MAX_COLLECTED_ITEMS} 条上限，停在第 1 页`);

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
      catch (error) { pages.push({ page: number, url: page.url(), count: 0, added: 0, error: message(error) }); return finish('failed', number, `第 ${number} 页失败：读取${plan.mode === 'next' ? '下一页链接' : '加载更多按钮'}出错，已保留前 ${previous} 页的条目`); }
      const name = plan.mode === 'next' ? '下一页链接或按钮' : '“加载更多”按钮';
      if (found?.invalid) return finish('failed', previous, `${name}的选择器无效：${found.invalid.slice(0, 120)}`);
      if (!found) return finish('end', previous, `第 ${previous} 页没有找到${name}，翻页结束`);
      if (found.disabled) return finish('end', previous, `第 ${previous} 页的${name}已禁用，翻页结束`);
      if (plan.mode === 'next' && found.href) target = { url: found.href };
      else if (found.hidden) return finish('end', previous, `第 ${previous} 页的${name}不可见，翻页结束`);
      else target = { click: true };
    }
    if ('url' in target && visited.has(normalizeLink(target.url))) return finish('repeat', previous, `第 ${number} 页的地址与已抓取的页面相同，翻页结束`);
    if (now() + plan.delayMs >= deadline) return finish('budget', previous, `已接近单次抓取的总时长上限，停在第 ${previous} 页`);

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
          if (error instanceof ExtractionError && error.message.startsWith('没有抽取到有效条目')) return [];
          throw error;
        }
      })());
    } catch (error) {
      checkAbort();
      if (error instanceof BudgetError) {
        pages.push({ page: number, url: page.url(), count: 0, added: 0, error: '超出单次抓取总时长上限' });
        return finish('budget', number, `第 ${number} 页超出单次抓取总时长上限，已保留前 ${previous} 页的条目`);
      }
      const text = message(error);
      const url = 'url' in target ? target.url : page.url();
      if (error instanceof NetworkPolicyError || /网络安全策略|SSRF|私网或特殊地址/.test(text)) {
        pages.push({ page: number, url, count: 0, added: 0, error: text });
        return finish('blocked', number, `第 ${number} 页被网络安全策略拦截，已保留前 ${previous} 页的条目`);
      }
      if (/HTTP (?:404|410)\b/.test(text)) {
        pages.push({ page: number, url, count: 0, added: 0, error: text });
        return finish('end', number, `第 ${number} 页不存在（${text.match(/HTTP \d+/)![0]}），翻页结束`);
      }
      pages.push({ page: number, url, count: 0, added: 0, error: text });
      return finish('failed', number, `第 ${number} 页失败：${text}，已保留前 ${previous} 页的条目`);
    }
    checkAbort();
    // "Load more" keeps earlier items on the page; only the appended ones count.
    const pageItems = plan.mode === 'loadMore' ? list.filter(item => !seen.has(normalizeLink(item.link))) : list;
    const allKnown = pageItems.length > 0 && pageItems.every(known);
    const fresh = add(pageItems);
    pages.push({ page: number, url: page.url(), count: pageItems.length, added: fresh.length });
    if (!list.length) return finish('empty', number, `第 ${number} 页没有抽取到条目，翻页结束`);
    if (!fresh.length) return finish('repeat', number, plan.mode === 'loadMore' ? `第 ${number} 次加载没有出现新条目，翻页结束` : `第 ${number} 页的条目与前面的页相同，翻页结束`);
    if (items.length >= MAX_COLLECTED_ITEMS) return finish('limit', number, `已达到 ${MAX_COLLECTED_ITEMS} 条上限，停在第 ${number} 页`);
    if (options.isKnown && allKnown) return finish('known', number, `第 ${number} 页的条目都已见过，提前停止`);
  }
  return finish('max', maxPages, `已达到最多 ${maxPages} 页`);
}

/** One line for the fetch log, e.g. "共 3 页（12 + 10 + 0 条）；第 3 页失败：…". */
export function reportSummary(report: PaginationReport): string {
  const counts = report.pages.filter(page => !page.error).map(page => page.added);
  return `共 ${counts.length} 页（${counts.join(' + ')} 条）；${report.message}`;
}
