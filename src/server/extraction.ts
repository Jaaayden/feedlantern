import type { Page } from 'playwright';
import { readDateContext, resolveDate, type DateFields } from './dates.js';
export { isoDate } from './dates.js';
import type { ExtractedItem, SelectionRules } from '../shared/types';

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

interface RawExtractedItem {
  title: string;
  link?: string;
  description?: string;
  imageCandidates: string[];
  date?: DateFields;
}

const MAX_ITEMS = 1000;
const MAX_TEXT = 20_000;

// Keep the browser-side program as a string. The development runner uses
// esbuild's function-name helper when serializing nested TypeScript callbacks;
// that helper does not exist in the page VM. A plain JS expression is both
// deterministic and independent of the runner used to start FeedLantern.
const EXTRACTION_SCRIPT = String.raw`(payload) => {
  const rules = payload.rules;
  const maxItems = payload.maxItems;
  const maxText = payload.maxText;
  function clean(value) { return (value || '').replace(/\s+/g, ' ').trim(); }
  function clipped(value) { return clean(value).slice(0, maxText); }
  function field(root, selector) {
    if (!selector) return null;
    if (selector.trim() === ':scope') return root;
    return root.querySelector(selector);
  }
  function textOrAttribute(element, attributes) {
    if (!element) return '';
    const text = clipped(element.textContent);
    if (text) return text;
    for (const name of (attributes || [])) {
      const value = element.getAttribute(name);
      if (value) return clipped(value);
    }
    return '';
  }
  function hrefOf(element) {
    if (!element) return undefined;
    const own = element.getAttribute('href');
    if (own) return own;
    const anchor = element.closest('a');
    return anchor ? anchor.getAttribute('href') : undefined;
  }
  function imageCandidatesOf(element) {
    if (!element) return [];
    const nodes = [element];
    const nested = element.querySelector('img,source');
    if (nested) nodes.push(nested);
    const values = [];
    for (const node of nodes) {
      for (const name of ['currentSrc', 'src', 'data-src', 'data-original', 'data-lazy-src', 'data-url']) {
        const value = name === 'currentSrc'
          ? (node instanceof HTMLImageElement ? node.currentSrc : '')
          : (node.getAttribute(name) || '');
        if (value && !values.includes(value)) values.push(value);
      }
      const srcset = node.getAttribute('srcset');
      if (srcset) {
        for (const candidate of srcset.split(',')) {
          const value = candidate.trim().split(/\s+/)[0];
          if (value && !values.includes(value)) values.push(value);
        }
      }
    }
    return values;
  }
  const elements = Array.from(document.querySelectorAll(rules.item)).slice(0, maxItems);
  return elements.map((item) => {
    const titleElement = field(item, rules.title);
    const linkElement = field(item, rules.link);
    const descriptionElement = field(item, rules.description);
    const imageElement = field(item, rules.image);
    const dateElement = field(item, rules.date);
    return {
      title: textOrAttribute(titleElement, ['alt', 'title', 'aria-label']),
      link: hrefOf(linkElement),
      description: descriptionElement ? textOrAttribute(descriptionElement) : undefined,
      imageCandidates: imageCandidatesOf(imageElement),
      date: dateElement ? { datetime: dateElement.getAttribute('datetime'), direct: clipped(Array.from(dateElement.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(' ')), text: clipped(dateElement.textContent) } : undefined,
    };
  });
}`;

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function httpUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function assertRules(rules: SelectionRules): void {
  if (!rules || typeof rules !== 'object') throw new ExtractionError('抽取规则为空');
  for (const [name, selector] of Object.entries(rules)) {
    if (selector !== undefined && typeof selector !== 'string') {
      throw new ExtractionError(`抽取规则 ${name} 必须是 CSS selector 字符串`);
    }
    if (typeof selector === 'string' && !selector.trim() && ['item', 'title', 'link'].includes(name)) {
      throw new ExtractionError(`抽取规则 ${name} 不能为空`);
    }
  }
}

/**
 * Extract repeated items from the already-rendered page. Field selectors are
 * evaluated relative to each item; `:scope` explicitly selects the item
 * itself because Element.querySelector(':scope') does not return its root.
 */
export async function extractPage(page: Page, rules: SelectionRules): Promise<ExtractedItem[]> {
  assertRules(rules);
  const pageUrl = page.url();
  let baseUrl = pageUrl;
  try {
    // document.baseURI includes an explicit <base href>, which is the same
    // resolution rule used by the browser for relative links and images.
    baseUrl = await page.evaluate('document.baseURI') as string;
  } catch {
    // A closed page is reported by the extraction evaluation below.
  }
  if (!/^https?:\/\//i.test(baseUrl)) throw new ExtractionError('当前页面不是 HTTP(S) 页面，无法生成 RSS');

  let rawItems: RawExtractedItem[];
  try {
    const expression = `(${EXTRACTION_SCRIPT})(${JSON.stringify({ rules, maxItems: MAX_ITEMS, maxText: MAX_TEXT })})`;
    rawItems = await page.evaluate(expression) as RawExtractedItem[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/failed to execute 'queryselector|not a valid selector|syntaxerror/i.test(message)) {
      throw new ExtractionError(`抽取规则包含无效 CSS selector：${message}`);
    }
    throw new ExtractionError(`读取页面 DOM 失败：${message}`);
  }

  const dateContext = rules.date ? await readDateContext(page) : undefined;
  const items: ExtractedItem[] = [];
  for (const raw of rawItems) {
    const title = cleanText(raw.title);
    const link = httpUrl(raw.link, baseUrl);
    // A lazy image frequently leaves a data: placeholder in src. Try every
    // candidate in document order and retain the first usable HTTP URL.
    const image = raw.imageCandidates.map(candidate => httpUrl(candidate, baseUrl)).find(Boolean);
    if (!title || !link) continue;
    const description = cleanText(raw.description).slice(0, MAX_TEXT) || undefined;
    const date = raw.date && dateContext ? resolveDate(raw.date, link, baseUrl, dateContext) : undefined;
    items.push({ title, link, ...(description ? { description } : {}), ...(image ? { image } : {}), ...(date ? { publishedAt: date.publishedAt, publishedAtSource: date.publishedAtSource } : {}) });
  }

  if (items.length === 0) {
    throw new ExtractionError('没有抽取到有效条目：请检查 item/title/link selector，以及页面是否已完成渲染');
  }
  return items;
}
