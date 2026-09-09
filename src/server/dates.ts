import type { Page } from 'playwright';

export interface ParsedDate {
  publishedAt: string;
  publishedAtSource: 'absolute' | 'relative';
  dateText: string;
}
export interface DateFields { datetime?: string; direct?: string; text?: string }
export interface DateContext { referenceTime: number; timestamps: Map<string, string> }

export function isoDate(value: string | undefined): string | undefined {
  let clean = (value ?? '').replace(/\s+/g, ' ').trim().replace(/年|月/g, '-').replace(/日/g, '');
  if (!/\b\d{4}\b/.test(clean)) return undefined;
  const calendar = clean.match(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/);
  if (calendar) {
    const [, year, month, day] = calendar.map(Number);
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > maxDay) return undefined;
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i.test(clean)) {
    clean = /^\d{4}-\d{2}-\d{2}T/.test(clean) ? `${clean}Z` : `${clean} UTC`;
  }
  const timestamp = Date.parse(clean);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

const relativePattern = /刚刚|\bjust\s+now\b|(?<![\d.])\d+\s*(?:秒钟?|分钟?|小时|天|周)\s*前|\b\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\s+ago\b/gi;
const absolutePattern = /(?<!\d)\d{4}(?:年\d{1,2}月\d{1,2}日|[-/.]\d{1,2}[-/.]\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}|UTC|GMT))?)?(?!\d)/gi;

function parseText(text: string, referenceTime: number): ParsedDate | undefined {
  const relatives = [...text.matchAll(relativePattern)];
  const matches = [...relatives, ...text.matchAll(absolutePattern)];
  // A metadata container may include both creation and update dates. Never pick
  // one just because it happened to appear first.
  if (matches.length > 1) return undefined;
  const token = matches[0]?.[0] ?? text.trim();
  const absolute = isoDate(token);
  if (absolute) return { publishedAt: absolute, publishedAtSource: 'absolute', dateText: token };
  if (!relatives.length || !Number.isFinite(referenceTime)) return undefined;
  const amount = Number(token.match(/\d+/)?.[0] ?? 0);
  const unit = token.match(/秒钟?|分钟?|小时|天|周|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?/i)?.[0].toLowerCase();
  const seconds = !unit ? 0 : /^(秒|sec)/.test(unit) ? 1 : /^(分|min)/.test(unit) ? 60 : /^(小时|hour|hr)/.test(unit) ? 3600 : /^(天|day)/.test(unit) ? 86400 : 604800;
  const timestamp = referenceTime - amount * seconds * 1000;
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > 8.64e15) return undefined;
  return { publishedAt: new Date(timestamp).toISOString(), publishedAtSource: 'relative', dateText: token };
}

export function parseDateFields(fields: DateFields, referenceTime: number): ParsedDate | undefined {
  const absolute = isoDate(fields.datetime);
  if (absolute) return { publishedAt: absolute, publishedAtSource: 'absolute', dateText: fields.datetime! };
  for (const value of [fields.direct, fields.text]) {
    if (!value?.trim()) continue;
    // Ambiguous direct text must not be reinterpreted as a larger container.
    if ([...value.matchAll(relativePattern), ...value.matchAll(absolutePattern)].length > 1) return undefined;
    const result = parseText(value, referenceTime);
    if (result) return result;
  }
  return undefined;
}

function linkKey(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    url.hash = '';
    return url.href;
  } catch { return undefined; }
}

// BOOT is a JSON object inside an IIFE, not a window global. Scan balanced
// braces with JSON string escaping, then JSON.parse only that object.
function bootJson(script: string): unknown {
  const match = /\bvar\s+BOOT\s*=\s*\{/.exec(script);
  if (!match) return undefined;
  const start = match.index + match[0].length - 1;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < script.length; i++) {
    const c = script[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(script.slice(start, i + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}

export function dateContext(url: string, referenceTime: number, scripts: string[]): DateContext {
  const context: DateContext = { referenceTime, timestamps: new Map() };
  const source = new URL(url);
  if (source.hostname !== 'n.mumingfang.com' || !/^\/intel\/?$/.test(source.pathname)) return context;
  for (const script of scripts) {
    const boot = bootJson(script) as { now?: unknown; first?: { items?: unknown } } | undefined;
    if (!boot || typeof boot !== 'object') continue;
    const epoch = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 253402300799 ? value * 1000 : undefined;
    const now = epoch(boot.now);
    if (now !== undefined) context.referenceTime = now;
    if (!Array.isArray(boot.first?.items)) continue;
    for (const item of boot.first.items) {
      if (!item || typeof item.u !== 'string') continue;
      const key = linkKey(item.u, url), timestamp = epoch(item.a);
      if (key && timestamp !== undefined) context.timestamps.set(key, new Date(timestamp).toISOString());
    }
  }
  return context;
}

export async function readDateContext(page: Page): Promise<DateContext> {
  const source = new URL(page.url());
  const isIntel = source.hostname === 'n.mumingfang.com' && /^\/intel\/?$/.test(source.pathname);
  const data = await page.evaluate(`({ referenceTime: performance.timeOrigin, scripts: ${isIntel ? "Array.from(document.scripts).filter(s => !s.src && s.textContent.includes('BOOT')).map(s => s.textContent.slice(0, 2000000))" : '[]'} })`) as { referenceTime: number; scripts: string[] };
  return dateContext(page.url(), data.referenceTime, data.scripts);
}

export function resolveDate(fields: DateFields, link: string | undefined, base: string, context: DateContext): ParsedDate | undefined {
  const key = link ? linkKey(link, base) : undefined;
  const exact = key ? context.timestamps.get(key) : undefined;
  if (exact) return { publishedAt: exact, publishedAtSource: 'absolute', dateText: parseDateFields(fields, context.referenceTime)?.dateText || fields.direct?.trim() || fields.text?.trim() || exact };
  return parseDateFields(fields, context.referenceTime);
}

export async function previewDateSelection(page: Page, itemSelector: string | undefined, selector: string): Promise<ParsedDate | undefined> {
  const payload = JSON.stringify({ itemSelector, selector });
  const raw = await page.evaluate(`(function(p) {
    const item = p.itemSelector ? document.querySelector(p.itemSelector) : document.documentElement;
    const el = item && (p.selector === ':scope' ? item : item.querySelector(p.selector));
    if (!el) return null;
    const anchor = item.matches('a[href]') ? item : item.querySelector('a[href]');
    return { fields: { datetime: el.getAttribute('datetime'), direct: Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(' '), text: el.textContent }, link: anchor && anchor.href };
  })(${payload})`) as { fields: DateFields; link?: string } | null;
  return raw ? resolveDate(raw.fields, raw.link, page.url(), await readDateContext(page)) : undefined;
}

/** Highlight the date text without changing DOM or persisting text-node selectors. */
export async function dateSelectionRects(page: Page, itemSelector: string | undefined, selector: string): Promise<import('../shared/types').Rect[]> {
  return page.evaluate(`(function(p) {
    const roots = p.itemSelector ? Array.from(document.querySelectorAll(p.itemSelector)) : [document.documentElement];
    const rects = [];
    for (const root of roots) {
      const el = p.selector === ':scope' ? root : root.querySelector(p.selector);
      if (!el) continue;
      const nodes = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) nodes.push(node);
      const text = nodes.map(n => n.textContent).join('');
      const matches = [...text.matchAll(new RegExp(p.relative, 'gi')), ...text.matchAll(new RegExp(p.absolute, 'gi'))];
      if (matches.length !== 1) continue;
      const match = matches[0], start = match.index, end = start + match[0].length;
      const range = document.createRange();
      let offset = 0, started = false;
      for (const n of nodes) {
        const next = offset + n.textContent.length;
        if (!started && start < next) { range.setStart(n, start - offset); started = true; }
        if (started && end <= next) { range.setEnd(n, end - offset); break; }
        offset = next;
      }
      if (!started) continue;
      for (const r of range.getClientRects()) {
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)
          rects.push({ x:r.x, y:r.y, width:r.width, height:r.height });
      }
      if (rects.length >= 100) break;
    }
    return rects.slice(0,100);
  })(${JSON.stringify({ itemSelector, selector, relative: relativePattern.source, absolute: absolutePattern.source })})`) as Promise<import('../shared/types').Rect[]>;
}
