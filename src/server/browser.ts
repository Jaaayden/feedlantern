import { previewDateSelection, dateSelectionRects } from './dates.js';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Cookie, type Page } from 'playwright';
import type {
  DetectionResult,
  ElementMap,
  ExtractedItem,
  FieldName,
  PickRequest,
  PaginationReport,
  PaginationRules,
  PickResult,
  Rect,
  ScreenFrame,
  SegmentResult,
  SelectionRules,
} from '../shared/types';
import { cookiesForUrl, toPlaywrightCookies } from './cookies';
import { hitTest, linkFor } from '../shared/element-map';
import { redactForLog } from './log';
import { extractPage } from './extraction';
import { collectPages, PAGINATION_BUDGET_MS, type CollectResult } from './pagination';
import { prepareScrollContent } from './page-preparation';
import {
  allowedHostListFromEnv,
  createRestrictedForwardProxy,
  installNetworkPolicy,
  NetworkPolicy,
  type NetworkPolicyOptions,
  type RestrictedForwardProxy,
} from './network';

const VIEWPORT = { width: 1280, height: 800 } as const;
const MAX_EDITOR_SESSIONS = 2;
const SESSION_IDLE_MS = 5 * 60 * 1000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SELECTOR_TIMEOUT_MS = 15_000;
const ACTION_SETTLE_MS = 80;
// The editor scrolls tall screenshots locally. Each capture is one segment,
// well below Chromium's texture limit; the editor asks for the next segment
// when the user scrolls near the bottom, up to MAX_DOCUMENT_HEIGHT in total.
const SEGMENT_HEIGHT = 8_000;
const MAX_DOCUMENT_HEIGHT = 48_000;
const MAX_MAP_NODES = 6_000; // per segment
const DOCUMENT_HEIGHT_SCRIPT = 'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)';
const SCREENSHOT_QUALITY = 75;
const BROWSER_OPERATION_TIMEOUT_MS = 60_000;
// A multi-page run stops itself at its budget; this backstop only catches a hang.
const PAGINATED_OPERATION_TIMEOUT_MS = PAGINATION_BUDGET_MS + 90_000;

export interface BrowserOpenOptions {
  signal?: AbortSignal;
  url: string;
  cookies?: Cookie[];
  waitMs: number;
  waitForSelector?: string;
}

export interface BrowserScrapeOptions extends BrowserOpenOptions {
  rules: SelectionRules;
  pagination?: PaginationRules | null;
  /** Links the feed already stored; a page of only those ends a multi-page run. */
  isKnown?: (link: string) => boolean;
  /** Receives which pages were fetched and why collection stopped, and the items of page 1. */
  onReport?: (report: PaginationReport, firstPage: ExtractedItem[]) => void;
}

function paginated(pagination?: PaginationRules | null): pagination is PaginationRules {
  return !!pagination && pagination.maxPages > 1;
}

export interface BrowserServiceOptions {
  dnsOverHttps?: boolean;
  backgroundConcurrency?: number;
  allowedHosts?: string[];
  executablePath?: string;
}

export class BrowserServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserServiceError';
  }
}

export class BrowserBusyError extends BrowserServiceError {
  constructor(message = '浏览器会话正在处理上一条操作，请稍后重试') {
    super(message);
    this.name = 'BrowserBusyError';
  }
}

interface BrowserSession {
  id: string;
  context: BrowserContext;
  page: Page;
  busy: boolean;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
  pointer?: { x: number; y: number };
  waitMs: number;
  /** Page global holding the elements of the latest element map. */
  mapKey: string;
  map?: ElementMap;
  /** Captured height so far: the first segment plus any later ones. */
  frameHeight?: number;
  /** The page opened at first, for a multi-page preview in a separate tab. */
  sourceUrl: string;
  waitForSelector?: string;
  /** Set while the session itself opens a tab, so the popup guard keeps it. */
  openingTab: boolean;
}

interface RawPickResult {
  selector: string;
  rects: Rect[];
  count: number;
  sampleText: string;
  warning?: string;
}

const PICK_SCRIPT = String.raw`(request, mapKey) => {
  function clean(value) { return (value || '').replace(/\s+/g, ' ').trim(); }
  function escaped(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, function(character) { return '\\' + character; });
  }
  const dynamic = /(?:^|[-_])(?:[a-f0-9]{6,}|\d{3,})(?:$|[-_])/i;
  function stable(value) { return Boolean(value) && value.length <= 64 && !dynamic.test(value); }
  // Rects are in document pixels, matching the full-page screenshot.
  const limitHeight = request.frameHeight || innerHeight;
  function visibleRect(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.x + scrollX;
    const y = rect.y + scrollY;
    if (rect.width <= 0 || rect.height <= 0 || y + rect.height <= 0 || x + rect.width <= 0 || x >= innerWidth || y >= limitHeight) return null;
    return { x: x, y: y, width: rect.width, height: rect.height };
  }
  function segment(element) {
    const tag = element.tagName.toLowerCase();
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label', 'role']) {
      const value = element.getAttribute(attr) || '';
      if (stable(value)) return tag + '[' + attr + '="' + escaped(value) + '"]';
    }
    const id = element.id || '';
    if (stable(id)) return '#' + escaped(id);
    const classes = Array.from(element.classList).filter(stable).filter(function(value) { return !/^(?:animated|animate__animated|aos-animate)$/.test(value); }).slice(0, 2).map(function(value) { return '.' + escaped(value); }).join('');
    return tag + classes;
  }
  function pathSelector(element, stop) {
    if (element === stop) return ':scope';
    const parts = [];
    let current = element;
    let depth = 0;
    while (current && current !== stop && current !== document.body && depth < 12) {
      let part = segment(current);
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(function(child) { return child.tagName === current.tagName; });
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = current.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }
  function queryAll(root, selector) {
    try { return Array.from(root.querySelectorAll(selector)); } catch { return []; }
  }
  function globalSelector(element) {
    const simple = segment(element);
    if (queryAll(document, simple).length === 1) return simple;
    return pathSelector(element);
  }
  function repeatedSelector(element) {
    const simple = segment(element);
    const simpleMatches = queryAll(document, simple);
    if (simpleMatches.length >= 2 && simpleMatches.length <= 500) return simple;
    const parent = element.parentElement;
    if (parent) {
      const parentSimple = segment(parent);
      const scoped = parentSimple + ' > ' + simple;
      const scopedMatches = queryAll(document, scoped);
      if (scopedMatches.length >= 2 && scopedMatches.length <= 500) return scoped;
    }
    return globalSelector(element);
  }
  function repeatedItem(element) {
    const ancestors = [];
    let current = element;
    let depth = 0;
    while (current && current !== document.body && depth < 12) {
      ancestors.push(current);
      current = current.parentElement;
      depth += 1;
    }
    if (request.ancestorLevel !== undefined) {
      const selected = ancestors[Math.max(0, Math.min(ancestors.length - 1, request.ancestorLevel))];
      if (selected) return { element: selected, selector: repeatedSelector(selected) };
    }
    let best;
    ancestors.forEach(function(candidate, index) {
      const selector = repeatedSelector(candidate);
      const matches = queryAll(document, selector);
      if (matches.length < 2 || matches.length > 500) return;
      const tag = candidate.tagName.toLowerCase();
      const textLength = clean(candidate.textContent).length;
      const childCount = candidate.children.length;
      const score = (['article', 'li', 'tr'].includes(tag) ? 5 : 0) + (childCount >= 2 ? 2 : 0) + (textLength >= 20 ? 2 : 0) + (candidate.querySelector('a[href]') ? 1 : 0) - index * 0.05;
      if (!best || score > best.score) best = { element: candidate, selector: selector, score: score };
    });
    return best ? { element: best.element, selector: best.selector } : { element: element, selector: globalSelector(element) };
  }
  const mapState = mapKey ? window[mapKey] : null;
  const mapped = (mapState && mapState.elements) || [];
  let atPoint;
  if (request.node !== undefined && request.node !== null) {
    atPoint = mapped[request.node];
    if (!atPoint || !atPoint.isConnected) return { selector: '', rects: [], count: 0, sampleText: '', warning: '网页内容已经变化，请点击“更新网页画面”后重试' };
  } else atPoint = document.elementFromPoint(request.x, request.y);
  if (!atPoint) return { selector: '', rects: [], count: 0, sampleText: '', warning: '坐标处没有可选的 DOM 元素' };
  if (atPoint instanceof HTMLIFrameElement) return { selector: '', rects: [], count: 0, sampleText: '', warning: '暂不支持跨域 iframe 内选取' };
  if (atPoint instanceof HTMLCanvasElement) return { selector: '', rects: [], count: 0, sampleText: '', warning: 'canvas 内没有可持久化的 DOM selector' };
  if (atPoint.getRootNode() instanceof ShadowRoot) return { selector: '', rects: [], count: 0, sampleText: '', warning: '暂不支持 Shadow DOM 内选取' };
  let target = atPoint;
  // exact: the user widened or narrowed the choice by hand; keep it as-is.
  if (request.target !== 'item' && !request.exact) {
    const selectors = {
      title: 'h1,h2,h3,h4,h5,h6,[class*="title"],[class*="headline"]',
      link: 'a[href]',
      description: 'p,[class*="summary"],[class*="description"],[class*="excerpt"]',
      image: 'img,source',
      date: 'time,[datetime],[class*="date"],[class*="time"]',
      next: 'a[href],button,[role="button"],input[type="submit"],input[type="button"]',
    };
    const meaningful = target.closest(selectors[request.target] || 'a,h1,h2,h3,h4,h5,h6,time,img,source,p,article,li');
    if (meaningful) target = meaningful;
  }
  let item = null;
  if (request.target === 'item') {
    item = request.exact ? { element: target, selector: repeatedSelector(target) } : repeatedItem(target);
  } else if (request.itemSelector) {
    try {
      const closest = target.closest(request.itemSelector);
      if (closest) item = { element: closest, selector: request.itemSelector };
    } catch { /* invalid selector is reported below */ }
  }
  const root = item ? item.element : null;
  // A rel="next" link is the most stable way to find the next page again.
  const relNext = request.target === 'next' && target.matches('a[rel~="next"]') && queryAll(document, 'a[rel~="next"]').length === 1;
  const selector = request.target === 'item' ? item.selector : relNext ? 'a[rel~="next"]' : root ? pathSelector(target, root) : globalSelector(target);
  if (!selector) return { selector: '', rects: [], count: 0, sampleText: '', warning: '无法生成稳定 selector' };
  const roots = root ? queryAll(document, request.itemSelector || item.selector) : [document.documentElement];
  const matches = [];
  if (request.target === 'item') matches.push.apply(matches, queryAll(document, selector));
  else if (root) {
    for (const candidate of roots) {
      if (selector === ':scope') matches.push(candidate);
      else matches.push.apply(matches, queryAll(candidate, selector));
    }
  } else matches.push.apply(matches, queryAll(document, selector));
  const rects = matches.map(visibleRect).filter(function(rect) { return Boolean(rect); }).slice(0, 100);
  const node = mapped.indexOf(request.target === 'item' ? item.element : target);
  return {
    ...(node >= 0 ? { node: node } : {}),
    selector: selector,
    rects: rects,
    count: matches.length,
    sampleText: clean((matches[0] || target).textContent).slice(0, 500),
    ...(!root && request.target !== 'item' && request.target !== 'next' ? { warning: '未提供 itemSelector，字段 selector 按整页生成' } : {}),
  };
}`;

// Record every visible element so the editor can outline what is under the
// pointer without asking the server. The map is cumulative: the first segment
// starts it (reset), later segments only append elements that became visible,
// so existing indexes and parent links never change. The state stays in a page
// global (non-enumerable, random name) so a later pick can address elements by
// index; a navigation clears it, which picks report as a stale frame.
const MAP_SCRIPT = String.raw`(mapKey, limitHeight, maxNodes, reset) => {
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BR', 'WBR', 'OPTION']);
  const dynamic = /(?:^|[-_])(?:[a-f0-9]{6,}|\d{3,})(?:$|[-_])/i;
  const width = innerWidth;
  let state = reset ? null : window[mapKey];
  if (!state || !state.index) {
    state = { elements: [], index: new Map(), boxes: [], labels: [], links: {}, truncated: false, innerScroll: false };
    Object.defineProperty(window, mapKey, { value: state, configurable: true, enumerable: false, writable: true });
  }
  const elements = state.elements;
  const boxes = state.boxes;
  const labels = state.labels;
  const links = state.links;
  function label(element) {
    let text = element.tagName.toLowerCase();
    if (element.id && element.id.length <= 32 && !dynamic.test(element.id)) text += '#' + element.id;
    const classes = Array.from(element.classList).filter(function(value) { return value.length <= 32 && !dynamic.test(value); }).slice(0, 2);
    if (classes.length) text += '.' + classes.join('.');
    return text.slice(0, 64);
  }
  function visit(element, parent) {
    if (elements.length >= maxNodes) { state.truncated = true; return; }
    if (skip.has(element.tagName)) return;
    const style = getComputedStyle(element);
    if (style.display === 'none') return;
    const known = state.index.get(element);
    let own = known === undefined ? parent : known;
    if (!state.innerScroll && (style.overflowY === 'auto' || style.overflowY === 'scroll') && element.scrollHeight > element.clientHeight + 4 && element.clientHeight > 40) state.innerScroll = true;
    if (known === undefined && style.display !== 'contents' && style.visibility !== 'hidden' && style.opacity !== '0') {
      const rect = element.getBoundingClientRect();
      const x = rect.left + scrollX;
      const y = rect.top + scrollY;
      if (rect.width >= 2 && rect.height >= 2 && y < limitHeight && y + rect.height > 0 && x < width && x + rect.width > 0) {
        own = elements.length;
        elements.push(element);
        state.index.set(element, own);
        boxes.push(Math.round(x), Math.round(y), Math.round(rect.width), Math.round(rect.height), parent);
        labels.push(label(element));
        if (element instanceof HTMLAnchorElement && /^https?:/i.test(element.href)) links[own] = element.href;
      }
    }
    if (element.tagName.toLowerCase() === 'svg') return;
    for (const child of Array.from(element.children)) visit(child, own);
  }
  if (document.body) for (const child of Array.from(document.body.children)) visit(child, -1);
  return { boxes: boxes, labels: labels, links: links, truncated: state.truncated, innerScroll: state.innerScroll };
}`;

/** Width and height from a baseline or progressive JPEG header. */
function jpegSize(image: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < image.length) {
    if (image[offset] !== 0xff) return undefined;
    const marker = image[offset + 1];
    const length = image.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: image.readUInt16BE(offset + 5), width: image.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

/**
 * A one-line, actionable message for a Chromium launch failure. Playwright's own
 * message is a multi-line banner, which the API would replace with a generic hint.
 */
export function launchFailureMessage(message: string, executablePath?: string): string | undefined {
  if (!/executable doesn't exist|playwright install/i.test(message)) return undefined;
  if (executablePath) return '找不到 BROWSER_EXECUTABLE_PATH 指定的 Chromium，请检查该路径，或删除这项设置并运行 pnpm browser:install。';
  return '未找到 Chromium 浏览器。请在服务主机的项目目录运行 pnpm browser:install；如果 .env 设置了 PLAYWRIGHT_BROWSERS_PATH，安装时也要使用同样的值。';
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BrowserServiceError(`${field} 必须是有限数字`);
  return value;
}

function boundedWait(value: number): number {
  return Math.max(0, Math.min(120_000, finiteNumber(value, 'waitMs')));
}

function cleanError(error: unknown, fallback: string): BrowserServiceError {
  if (error instanceof BrowserServiceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new BrowserServiceError(`${fallback}：${message}`);
}

function normalizeSelectorError(error: unknown, fallback: string): BrowserServiceError {
  const message = error instanceof Error ? error.message : String(error);
  if (/ERR_BLOCKED_BY_CLIENT/.test(message)) return new BrowserServiceError('网页或重定向被网络安全策略阻止，请检查目标 DNS 是否解析到私网或保留地址');
  if (/Timeout|timed out/i.test(message)) return new BrowserServiceError('网页加载超时，请检查网络连接或调整等待条件');
  if (/ERR_CERT/.test(message)) return new BrowserServiceError('目标网站的 HTTPS 证书无效，无法安全加载');
  if (/selector|queryselector|syntaxerror|strict mode/i.test(message)) return new BrowserServiceError(`CSS selector 无效：${message}`);
  return new BrowserServiceError(`${fallback}：${message}`);
}

export class BrowserService {
  private readonly networkOptions: NetworkPolicyOptions;
  private readonly executablePath?: string;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly activeContexts = new Set<BrowserContext>();
  private browser?: Browser;
  private browserPromise?: Promise<Browser>;
  private proxy?: RestrictedForwardProxy;
  private openingSessions = 0;
  private scrapeSessions = 0;
  private disposing = false;
  /** Last launch failure written to the log; repeats are not logged again. */
  private lastLaunchError?: string;
  private readonly backgroundConcurrency: number;

  constructor(options: BrowserServiceOptions = {}) {
    this.backgroundConcurrency = options.backgroundConcurrency ?? 1;
    if (!Number.isInteger(this.backgroundConcurrency) || this.backgroundConcurrency < 1 || this.backgroundConcurrency > 4) throw new BrowserServiceError('后台并发必须是 1–4 的整数');
    this.networkOptions = {
      allowedHosts: options.allowedHosts ?? allowedHostListFromEnv(),
      dnsOverHttps: options.dnsOverHttps,
    };
    this.executablePath = options.executablePath;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.disposing) throw new BrowserServiceError('浏览器服务正在关闭');
    if (this.browser) return this.browser;
    if (this.browserPromise) return this.browserPromise;
    this.browserPromise = (async () => {
      this.proxy = await createRestrictedForwardProxy(this.networkOptions);
      try {
        // Keep Chromium's sandbox enabled. In Docker, run this process as a
        // non-root user with the seccomp profile recommended by Playwright.
        this.browser = await chromium.launch({
          headless: true,
          chromiumSandbox: true,
          // Do not allow WebRTC UDP or HTTP/3/QUIC to bypass the restricted
          // HTTP(S) proxy and its fixed-address SSRF checks.
          args: [
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--disable-quic',
          ],
          ...(this.executablePath ? { executablePath: this.executablePath } : {}),
        });
        this.lastLaunchError = undefined;
        return this.browser;
      } catch (error) {
        await this.proxy.close().catch(() => undefined);
        this.proxy = undefined;
        const message = error instanceof Error ? error.message : String(error);
        if (message !== this.lastLaunchError) {
          this.lastLaunchError = message;
          console.error(`启动 Chromium 失败：${redactForLog(message)}`);
        }
        const hint = launchFailureMessage(message, this.executablePath);
        if (hint) throw new BrowserServiceError(hint);
        throw cleanError(error, '启动 Chromium 失败');
      }
    })();
    try {
      return await this.browserPromise;
    } catch (error) {
      this.browserPromise = undefined;
      throw error;
    }
  }

  private async createContext(cookies: Cookie[] | undefined, url: string): Promise<BrowserContext> {
    await new NetworkPolicy(this.networkOptions).assertAllowed(url);
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      acceptDownloads: false,
      // Chromium has a built-in loopback bypass.  The explicit token makes
      // even localhost fixture traffic pass through our fixed-address proxy;
      // otherwise a loopback redirect could escape the DNS/IP policy.
      proxy: this.proxy ? { server: this.proxy.url, bypass: '<-loopback>' } : undefined,
    });
    this.activeContexts.add(context);
    try {
      await installNetworkPolicy(context, this.networkOptions);
      if (cookies && cookies.length > 0) {
        const filtered = cookiesForUrl(cookies, url);
        if (filtered.length > 0) await context.addCookies(toPlaywrightCookies(filtered));
      }
      return context;
    } catch (error) {
      this.activeContexts.delete(context);
      await context.close().catch(() => undefined);
      throw cleanError(error, '创建浏览器上下文失败');
    }
  }

  private async preparePage(page: Page, options: BrowserOpenOptions, rejectHttpErrors = false, referer?: string): Promise<void> {
    const waitMs = boundedWait(options.waitMs);
    try {
      const response = await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS, ...(referer ? { referer } : {}) });
      if (rejectHttpErrors && response && response.status() >= 400) {
        const hint = response.status() === 401 || response.status() === 403 ? '，请检查 Cookie 或访问权限' : '';
        throw new BrowserServiceError(`目标网页返回 HTTP ${response.status()}${hint}`);
      }
      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, { state: 'attached', timeout: SELECTOR_TIMEOUT_MS });
      }
      if (waitMs > 0) await page.waitForTimeout(waitMs);
      await prepareScrollContent(page);
    } catch (error) {
      throw normalizeSelectorError(error, '打开页面失败');
    }
  }

  private scheduleIdle(session: BrowserSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (!session.busy && Date.now() - session.lastUsedAt >= SESSION_IDLE_MS) {
        void this.closeInternal(session.id, true);
      } else if (this.sessions.has(session.id)) {
        this.scheduleIdle(session);
      }
    }, SESSION_IDLE_MS);
    session.idleTimer.unref?.();
  }

  private touch(session: BrowserSession): void {
    session.lastUsedAt = Date.now();
    this.scheduleIdle(session);
  }

  private invalidateSession(session: BrowserSession): void {
    this.sessions.delete(session.id);
    this.activeContexts.delete(session.context);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    void session.context.close().catch(() => undefined);
  }

  private getSession(id: string): BrowserSession {
    const session = this.sessions.get(id);
    if (!session) throw new BrowserServiceError('浏览器会话不存在或已过期');
    if (session.page.isClosed() || session.context.pages().length === 0) {
      this.sessions.delete(id);
      throw new BrowserServiceError('浏览器页面已经关闭，请重新打开');
    }
    return session;
  }

  private async withSession<T>(id: string, operation: (session: BrowserSession) => Promise<T>, timeoutMs = BROWSER_OPERATION_TIMEOUT_MS): Promise<T> {
    const session = this.getSession(id);
    if (session.busy) throw new BrowserBusyError();
    session.busy = true;
    this.touch(session);
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        this.invalidateSession(session);
        reject(new BrowserServiceError('浏览器操作超时，页面会话已关闭，请重新打开'));
      }, timeoutMs);
      timeout.unref?.();
    });
    try {
      return await Promise.race([operation(session), deadline]);
    } catch (error) {
      if (error instanceof BrowserServiceError) throw error;
      throw cleanError(error, '浏览器操作失败');
    } finally {
      if (timeout) clearTimeout(timeout);
      session.busy = false;
      if (!timedOut && this.sessions.has(session.id)) this.touch(session);
    }
  }

  /**
   * Capture one segment of the page, starting `top` pixels below the document
   * top, and extend (or with `reset`, restart) the element map to match.
   */
  private async capture(session: BrowserSession, top: number, reset: boolean) {
    const page = session.page;
    const viewport = page.viewportSize() ?? VIEWPORT;
    // Fixed headers render once at the top of a full-page capture; keep every
    // segment and the element map measured from the same scroll position.
    await page.evaluate("window.scrollTo({ left: 0, top: 0, behavior: 'instant' })");
    const measured = Number(await page.evaluate(DOCUMENT_HEIGHT_SCRIPT)) || viewport.height;
    const documentHeight = Math.max(viewport.height, Math.min(MAX_DOCUMENT_HEIGHT, Math.ceil(measured)));
    if (top >= documentHeight) throw new BrowserServiceError('已经显示到网页底部');
    const wanted = Math.min(SEGMENT_HEIGHT, documentHeight - top);
    const tall = top > 0 || wanted > viewport.height;
    const image = await page.screenshot({
      type: 'jpeg', quality: SCREENSHOT_QUALITY, scale: 'css', timeout: 15_000,
      ...(tall ? { fullPage: true, clip: { x: 0, y: top, width: viewport.width, height: wanted } } : {}),
    });
    // The document can shrink between measuring and capturing; trust the image.
    const size = jpegSize(image) ?? { width: viewport.width, height: wanted };
    const loaded = top + size.height;
    const maxNodes = MAX_MAP_NODES * Math.ceil(loaded / SEGMENT_HEIGHT);
    const map = await page.evaluate(`(${MAP_SCRIPT})(${JSON.stringify(session.mapKey)}, ${loaded}, ${maxNodes}, ${reset})`) as ElementMap;
    session.map = map;
    session.frameHeight = loaded;
    return {
      image: `data:image/jpeg;base64,${image.toString('base64')}`,
      width: size.width,
      height: size.height,
      documentHeight: Math.max(documentHeight, loaded),
      truncated: measured > MAX_DOCUMENT_HEIGHT,
      map,
    };
  }

  /** The first segment of the page and a fresh element map. */
  private async frame(session: BrowserSession): Promise<ScreenFrame> {
    try {
      const page = session.page;
      const viewport = page.viewportSize() ?? VIEWPORT;
      const captured = await this.capture(session, 0, true);
      return {
        sessionId: session.id,
        image: captured.image,
        width: captured.width,
        height: captured.height,
        viewportHeight: viewport.height,
        documentHeight: captured.documentHeight,
        url: page.url(),
        title: await page.title().catch(() => ''),
        map: captured.map,
        ...(captured.truncated ? { truncated: true } : {}),
      };
    } catch (error) {
      throw error instanceof BrowserServiceError ? error : cleanError(error, '生成页面截图失败');
    }
  }

  /**
   * The next segment below what the editor already shows. `top` must equal the
   * height captured so far, so a repeated or stale request cannot skip a part.
   */
  async segment(id: string, top: number): Promise<SegmentResult> {
    if (!Number.isInteger(top) || top <= 0) throw new BrowserServiceError('画面分段位置无效');
    return this.withSession(id, async session => {
      if (top !== session.frameHeight) throw new BrowserServiceError('网页画面已经变化，请点击“更新网页画面”后重试');
      try {
        const captured = await this.capture(session, top, false);
        return { top, image: captured.image, height: captured.height, documentHeight: captured.documentHeight, map: captured.map, ...(captured.truncated ? { truncated: true } : {}) };
      } catch (error) {
        throw error instanceof BrowserServiceError ? error : cleanError(error, '生成页面截图失败');
      }
    });
  }

  async open(options: BrowserOpenOptions): Promise<ScreenFrame> {
    if (!options || typeof options.url !== 'string' || !options.url.trim()) throw new BrowserServiceError('目标 URL 不能为空');
    if (this.sessions.size + this.openingSessions >= MAX_EDITOR_SESSIONS) throw new BrowserBusyError('已达到最多 2 个浏览器编辑会话');
    this.openingSessions += 1;
    const id = randomUUID();
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    const abort = () => { void context?.close().catch(() => undefined); };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      options.signal?.throwIfAborted();
      context = await this.createContext(options.cookies, options.url);
      options.signal?.throwIfAborted();
      page = await context.newPage();
      const tabs = { opening: false };
      // Keep the visual editor focused on one page. Popups are deliberately
      // closed because a separate page would bypass the REST session model.
      // Only a tab the session opens itself (multi-page preview) is kept.
      context.on('page', popup => {
        if (popup === page) return;
        if (tabs.opening) { tabs.opening = false; return; }
        void popup.close().catch(() => undefined);
      });
      await this.preparePage(page, options);
      const pointer = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
      await page.mouse.move(pointer.x, pointer.y);
      const session: BrowserSession = {
        id, context, page, busy: false, lastUsedAt: Date.now(), pointer, waitMs: boundedWait(options.waitMs), mapKey: `__feedlantern_${randomUUID().replace(/-/g, '')}`,
        sourceUrl: options.url, waitForSelector: options.waitForSelector,
        get openingTab() { return tabs.opening; }, set openingTab(value: boolean) { tabs.opening = value; },
      };
      this.sessions.set(id, session);
      this.scheduleIdle(session);
      return await this.frame(session);
    } catch (error) {
      this.sessions.delete(id);
      if (context) this.activeContexts.delete(context);
      await context?.close().catch(() => undefined);
      throw error instanceof BrowserServiceError ? error : cleanError(error, '打开页面失败');
    } finally {
      options.signal?.removeEventListener('abort', abort);
      this.openingSessions -= 1;
    }
  }

  async snapshot(id: string): Promise<ScreenFrame> {
    return this.withSession(id, session => this.frame(session));
  }

  async scroll(id: string, deltaY: number, point?: { x: number; y: number }): Promise<ScreenFrame> {
    finiteNumber(deltaY, 'deltaY');
    const boundedDelta = Math.max(-100_000, Math.min(100_000, deltaY));
    return this.withSession(id, async session => {
      const viewport = session.page.viewportSize() ?? VIEWPORT;
      const x = finiteNumber(point?.x ?? viewport.width / 2, 'x');
      const y = finiteNumber(point?.y ?? viewport.height / 2, 'y');
      if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) throw new BrowserServiceError('滚动坐标超出页面视口');
      if (session.pointer?.x !== x || session.pointer?.y !== y) {
        await session.page.mouse.move(x, y);
        session.pointer = { x, y };
      }
      await session.page.mouse.wheel(0, boundedDelta);
      await session.page.waitForTimeout(ACTION_SETTLE_MS);
      return this.frame(session);
    });
  }

  async click(id: string, x: number, y: number): Promise<ScreenFrame> {
    finiteNumber(x, 'x');
    finiteNumber(y, 'y');
    return this.withSession(id, async session => {
      const viewport = session.page.viewportSize() ?? VIEWPORT;
      if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) throw new BrowserServiceError('点击坐标超出页面视口');
      await session.page.mouse.click(x, y);
      session.pointer = { x, y };
      // A click can synchronously start a navigation. Wait briefly for the
      // DOMContentLoaded signal, while leaving long-polling pages responsive.
      await session.page.waitForLoadState('domcontentloaded', { timeout: 2_000 }).catch(() => undefined);
      await session.page.waitForTimeout(ACTION_SETTLE_MS);
      return this.frame(session);
    });
  }

  /**
   * Turn a picked element into a selector. With `request.rules`, the same call
   * also previews the rules with the new selector, saving a second round trip.
   */
  async pick(id: string, request: PickRequest): Promise<PickResult> {
    if (request.node !== undefined) {
      if (!Number.isInteger(request.node) || request.node < 0) throw new BrowserServiceError('选择的元素无效');
    } else {
      finiteNumber(request.x, 'x');
      finiteNumber(request.y, 'y');
    }
    return this.withSession(id, async session => {
      const viewport = session.page.viewportSize() ?? VIEWPORT;
      const frameHeight = session.frameHeight ?? viewport.height;
      let node = request.node;
      if (node === undefined) {
        const x = request.x!, y = request.y!;
        if (x < 0 || y < 0 || x > viewport.width || y > frameHeight) throw new BrowserServiceError('选择坐标超出页面视口');
        if (session.map) {
          node = hitTest(session.map, x, y);
          if (node < 0) throw new BrowserServiceError('坐标处没有可选的 DOM 元素');
        }
      }
      const { rules, ...rest } = request;
      const pageRequest = { ...rest, ...(node !== undefined ? { node } : {}), frameHeight };
      let result: PickResult;
      try {
        const expression = `(${PICK_SCRIPT})(${JSON.stringify(pageRequest)}, ${JSON.stringify(session.mapKey)})`;
        result = await session.page.evaluate(expression) as RawPickResult;
        if (!result.selector && result.warning) throw new BrowserServiceError(result.warning);
        if (request.target === 'date') {
          const datePreview = await previewDateSelection(session.page, request.itemSelector, result.selector);
          const dateRects = datePreview ? await dateSelectionRects(session.page, request.itemSelector, result.selector, frameHeight) : [];
          result = { ...result, ...(datePreview ? { datePreview, sampleText: datePreview.dateText, ...(dateRects.length ? { rects: dateRects } : {}) } : {}), warning: [result.warning, datePreview ? '已从选中区域提取时间；保存的规则仍使用日期所在容器。' : '未找到唯一可解析的日期，请调整选中区域。'].filter(Boolean).join(' ') };
        }
      } catch (error) {
        if (error instanceof BrowserServiceError) throw error;
        throw normalizeSelectorError(error, '分析选取元素失败');
      }
      if (rules && request.target !== 'next') {
        const next = { ...rules, [request.target]: result.selector };
        if (next.item && next.title && next.link) {
          try {
            result.items = await extractPage(session.page, next as SelectionRules);
          } catch (error) {
            result.previewError = (error instanceof BrowserServiceError ? error : cleanError(error, '抽取页面内容失败')).message;
          }
        }
      }
      return result;
    });
  }

  /** Open the link at a mapped element in this session, then recapture. */
  async follow(id: string, node: number): Promise<ScreenFrame> {
    if (!Number.isInteger(node) || node < 0) throw new BrowserServiceError('链接位置无效');
    return this.withSession(id, async session => {
      const href = session.map ? linkFor(session.map, node) : undefined;
      if (!href) throw new BrowserServiceError('这里不是可以打开的链接');
      await new NetworkPolicy(this.networkOptions).assertAllowed(href);
      await this.preparePage(session.page, { url: href, waitMs: session.waitMs });
      return this.frame(session);
    });
  }

  async extract(id: string, rules: SelectionRules): Promise<ExtractedItem[]> {
    return this.withSession(id, async session => {
      try {
        return await extractPage(session.page, rules);
      } catch (error) {
        throw error instanceof BrowserServiceError ? error : cleanError(error, '抽取页面内容失败');
      }
    });
  }

  /**
   * Preview a multi-page collection: page 1 is reopened in a separate tab of
   * this session (same context, cookies and network policy) and collected
   * exactly like a background refresh, so the editor's own page stays put.
   */
  async paginate(id: string, rules: SelectionRules, pagination: PaginationRules): Promise<CollectResult> {
    return this.withSession(id, async session => {
      session.openingTab = true;
      let tab: Page | undefined;
      try {
        tab = await session.context.newPage();
        session.openingTab = false;
        const options = { url: session.sourceUrl, waitMs: session.waitMs, waitForSelector: session.waitForSelector };
        await this.preparePage(tab, options, true);
        return await this.collect(tab, { ...options, rules, pagination });
      } catch (error) {
        throw error instanceof BrowserServiceError ? error : cleanError(error, '预览翻页失败');
      } finally {
        session.openingTab = false;
        await tab?.close().catch(() => undefined);
      }
    }, paginated(pagination) ? PAGINATED_OPERATION_TIMEOUT_MS : BROWSER_OPERATION_TIMEOUT_MS);
  }

  /** Page 1 is open in `page`; collect it and any further pages in the same tab. */
  private collect(page: Page, options: BrowserScrapeOptions): Promise<CollectResult> {
    const policy = new NetworkPolicy(this.networkOptions);
    return collectPages(page, {
      rules: options.rules,
      pagination: options.pagination,
      isKnown: options.isKnown,
      signal: options.signal,
      assertAllowed: url => policy.assertAllowed(url),
      load: (url, referer) => this.preparePage(page, { url, waitMs: options.waitMs, waitForSelector: options.waitForSelector }, true, referer),
      settle: async () => {
        const waitMs = boundedWait(options.waitMs);
        if (waitMs > 0) await page.waitForTimeout(waitMs);
        await prepareScrollContent(page);
      },
    });
  }

  async discover(options: BrowserOpenOptions): Promise<{ title: string; detection: DetectionResult }> {
    return this.background(options, async page => ({ title: await page.title(), detection: await (await import('./detection.js')).detectPage(page) }));
  }

  async scrape(options: BrowserScrapeOptions): Promise<ExtractedItem[]> {
    const result = await this.background(options, page => this.collect(page, options), paginated(options.pagination) ? PAGINATED_OPERATION_TIMEOUT_MS : BROWSER_OPERATION_TIMEOUT_MS);
    options.onReport?.(result.report, result.firstPage);
    return result.items;
  }

  private async background<T>(options: BrowserOpenOptions, extract: (page: Page) => Promise<T>, timeoutMs = BROWSER_OPERATION_TIMEOUT_MS): Promise<T> {
    if (this.scrapeSessions >= this.backgroundConcurrency) throw new BrowserBusyError('已有抓取任务正在运行');
    this.scrapeSessions += 1;
    let context: BrowserContext | undefined;
    const abort = () => { void context?.close().catch(() => undefined); };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      options.signal?.throwIfAborted();
      context = await this.createContext(options.cookies, options.url);
      options.signal?.throwIfAborted();
      const page = await context.newPage();
      let timeout: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          void context?.close().catch(() => undefined);
          reject(new BrowserServiceError('后台抓取超时，浏览器会话已关闭'));
        }, timeoutMs);
        timeout.unref?.();
      });
      try {
        return await Promise.race([(async () => {
          await this.preparePage(page, options, true);
          return extract(page);
        })(), deadline]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } catch (error) {
      if (error instanceof BrowserServiceError) throw error;
      throw cleanError(error, '抓取页面失败');
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (context) this.activeContexts.delete(context);
      await context?.close().catch(() => undefined);
      this.scrapeSessions -= 1;
    }
  }

  async detect(id: string): Promise<DetectionResult> {
    return this.withSession(id, async session => {
      try {
        const module = await import('./detection.js');
        return await module.detectPage(session.page);
      } catch (error) {
        throw cleanError(error, '自动识别页面失败');
      }
    });
  }

  private async closeInternal(id: string, force: boolean): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.busy && !force) throw new BrowserBusyError();
    this.sessions.delete(id);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.activeContexts.delete(session.context);
    await session.context.close().catch(() => undefined);
  }

  async close(id: string): Promise<void> {
    // Explicit user cancellation must release the slot even during a capture.
    await this.closeInternal(id, true);
  }

  async closeEditors(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeInternal(id, true);
  }

  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    const pendingBrowser = this.browserPromise;
    const ids = [...this.sessions.keys()];
    for (const id of ids) await this.closeInternal(id, true);
    for (const context of this.activeContexts) {
      this.activeContexts.delete(context);
      await context.close().catch(() => undefined);
    }
    await pendingBrowser?.catch(() => undefined);
    await this.proxy?.close().catch(() => undefined);
    this.proxy = undefined;
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
  }
}
