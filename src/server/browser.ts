import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Cookie, type Page } from 'playwright';
import type {
  DetectionResult,
  ExtractedItem,
  FieldName,
  PickRequest,
  PickResult,
  Rect,
  ScreenFrame,
  SelectionRules,
} from '../shared/types';
import { cookiesForUrl, toPlaywrightCookies } from './cookies';
import { extractPage } from './extraction';
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
const MAX_SCRAPE_SESSIONS = 1;
const SESSION_IDLE_MS = 5 * 60 * 1000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SELECTOR_TIMEOUT_MS = 15_000;
const ACTION_SETTLE_MS = 80;
const BROWSER_OPERATION_TIMEOUT_MS = 60_000;

export interface BrowserOpenOptions {
  url: string;
  cookies?: Cookie[];
  waitMs: number;
  waitForSelector?: string;
}

export interface BrowserScrapeOptions extends BrowserOpenOptions {
  rules: SelectionRules;
}

export interface BrowserServiceOptions {
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
}

interface RawPickResult {
  selector: string;
  rects: Rect[];
  count: number;
  sampleText: string;
  warning?: string;
}

const PICK_SCRIPT = String.raw`(request) => {
  function clean(value) { return (value || '').replace(/\s+/g, ' ').trim(); }
  function escaped(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, function(character) { return '\\' + character; });
  }
  const dynamic = /(?:^|[-_])(?:[a-f0-9]{6,}|\d{3,})(?:$|[-_])/i;
  function stable(value) { return Boolean(value) && value.length <= 64 && !dynamic.test(value); }
  function visibleRect(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  function segment(element) {
    const tag = element.tagName.toLowerCase();
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label', 'role']) {
      const value = element.getAttribute(attr) || '';
      if (stable(value)) return tag + '[' + attr + '="' + escaped(value) + '"]';
    }
    const id = element.id || '';
    if (stable(id)) return '#' + escaped(id);
    const classes = Array.from(element.classList).filter(stable).slice(0, 2).map(function(value) { return '.' + escaped(value); }).join('');
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
  const atPoint = document.elementFromPoint(request.x, request.y);
  if (!atPoint) return { selector: '', rects: [], count: 0, sampleText: '', warning: '坐标处没有可选的 DOM 元素' };
  if (atPoint instanceof HTMLIFrameElement) return { selector: '', rects: [], count: 0, sampleText: '', warning: '暂不支持跨域 iframe 内选取' };
  if (atPoint instanceof HTMLCanvasElement) return { selector: '', rects: [], count: 0, sampleText: '', warning: 'canvas 内没有可持久化的 DOM selector' };
  if (atPoint.getRootNode() instanceof ShadowRoot) return { selector: '', rects: [], count: 0, sampleText: '', warning: '暂不支持 Shadow DOM 内选取' };
  let target = atPoint;
  if (request.target !== 'item') {
    const selectors = {
      title: 'h1,h2,h3,h4,h5,h6,[class*="title"],[class*="headline"]',
      link: 'a[href]',
      description: 'p,[class*="summary"],[class*="description"],[class*="excerpt"]',
      image: 'img,source',
      date: 'time,[datetime],[class*="date"],[class*="time"]',
    };
    const meaningful = target.closest(selectors[request.target] || 'a,h1,h2,h3,h4,h5,h6,time,img,source,p,article,li');
    if (meaningful) target = meaningful;
  }
  let item = null;
  if (request.target === 'item') {
    item = repeatedItem(target);
  } else if (request.itemSelector) {
    try {
      const closest = target.closest(request.itemSelector);
      if (closest) item = { element: closest, selector: request.itemSelector };
    } catch { /* invalid selector is reported below */ }
  }
  const root = item ? item.element : null;
  const selector = request.target === 'item' ? item.selector : root ? pathSelector(target, root) : globalSelector(target);
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
  return {
    selector: selector,
    rects: rects,
    count: matches.length,
    sampleText: clean((matches[0] || target).textContent).slice(0, 500),
    ...(!root && request.target !== 'item' ? { warning: '未提供 itemSelector，字段 selector 按整页生成' } : {}),
  };
}`;

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

  constructor(options: BrowserServiceOptions = {}) {
    this.networkOptions = {
      allowedHosts: options.allowedHosts ?? allowedHostListFromEnv(),
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
        return this.browser;
      } catch (error) {
        await this.proxy.close().catch(() => undefined);
        this.proxy = undefined;
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

  private async preparePage(page: Page, options: BrowserOpenOptions, rejectHttpErrors = false): Promise<void> {
    const waitMs = boundedWait(options.waitMs);
    try {
      const response = await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      if (rejectHttpErrors && response && response.status() >= 400) {
        const hint = response.status() === 401 || response.status() === 403 ? '，请检查 Cookie 或访问权限' : '';
        throw new BrowserServiceError(`目标网页返回 HTTP ${response.status()}${hint}`);
      }
      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, { state: 'attached', timeout: SELECTOR_TIMEOUT_MS });
      }
      if (waitMs > 0) await page.waitForTimeout(waitMs);
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

  private async withSession<T>(id: string, operation: (session: BrowserSession) => Promise<T>): Promise<T> {
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
      }, BROWSER_OPERATION_TIMEOUT_MS);
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

  private async frame(session: BrowserSession): Promise<ScreenFrame> {
    try {
      const image = await session.page.screenshot({ type: 'png', scale: 'css', timeout: 10_000 });
      const viewport = session.page.viewportSize() ?? VIEWPORT;
      return {
        sessionId: session.id,
        image: `data:image/png;base64,${image.toString('base64')}`,
        width: viewport.width,
        height: viewport.height,
        url: session.page.url(),
        title: await session.page.title().catch(() => ''),
      };
    } catch (error) {
      throw cleanError(error, '生成页面截图失败');
    }
  }

  async open(options: BrowserOpenOptions): Promise<ScreenFrame> {
    if (!options || typeof options.url !== 'string' || !options.url.trim()) throw new BrowserServiceError('目标 URL 不能为空');
    if (this.sessions.size + this.openingSessions >= MAX_EDITOR_SESSIONS) throw new BrowserBusyError('已达到最多 2 个浏览器编辑会话');
    this.openingSessions += 1;
    const id = randomUUID();
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    try {
      context = await this.createContext(options.cookies, options.url);
      page = await context.newPage();
      // Keep the visual editor focused on one page. Popups are deliberately
      // closed because a separate page would bypass the REST session model.
      context.on('page', popup => {
        if (popup !== page) void popup.close().catch(() => undefined);
      });
      await this.preparePage(page, options);
      const session: BrowserSession = { id, context, page, busy: false, lastUsedAt: Date.now() };
      this.sessions.set(id, session);
      this.scheduleIdle(session);
      return await this.frame(session);
    } catch (error) {
      this.sessions.delete(id);
      if (context) this.activeContexts.delete(context);
      await context?.close().catch(() => undefined);
      throw error instanceof BrowserServiceError ? error : cleanError(error, '打开页面失败');
    } finally {
      this.openingSessions -= 1;
    }
  }

  async snapshot(id: string): Promise<ScreenFrame> {
    return this.withSession(id, session => this.frame(session));
  }

  async scroll(id: string, deltaY: number): Promise<ScreenFrame> {
    finiteNumber(deltaY, 'deltaY');
    const boundedDelta = Math.max(-100_000, Math.min(100_000, deltaY));
    return this.withSession(id, async session => {
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
      // A click can synchronously start a navigation. Wait briefly for the
      // DOMContentLoaded signal, while leaving long-polling pages responsive.
      await session.page.waitForLoadState('domcontentloaded', { timeout: 2_000 }).catch(() => undefined);
      await session.page.waitForTimeout(ACTION_SETTLE_MS);
      return this.frame(session);
    });
  }

  async pick(id: string, request: PickRequest): Promise<PickResult> {
    finiteNumber(request.x, 'x');
    finiteNumber(request.y, 'y');
    return this.withSession(id, async session => {
      const viewport = session.page.viewportSize() ?? VIEWPORT;
      if (request.x < 0 || request.y < 0 || request.x > viewport.width || request.y > viewport.height) {
        throw new BrowserServiceError('选择坐标超出页面视口');
      }
      try {
        const expression = `(${PICK_SCRIPT})(${JSON.stringify(request)})`;
        const result = await session.page.evaluate(expression) as RawPickResult;
        if (!result.selector && result.warning) throw new BrowserServiceError(result.warning);
        return result;
      } catch (error) {
        if (error instanceof BrowserServiceError) throw error;
        throw normalizeSelectorError(error, '分析选取元素失败');
      }
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

  async discover(options: BrowserOpenOptions): Promise<{ title: string; detection: DetectionResult }> {
    return this.background(options, async page => ({ title: await page.title(), detection: await (await import('./detection.js')).detectPage(page) }));
  }

  async scrape(options: BrowserScrapeOptions): Promise<ExtractedItem[]> {
    return this.background(options, page => extractPage(page, options.rules));
  }

  private async background<T>(options: BrowserOpenOptions, extract: (page: Page) => Promise<T>): Promise<T> {
    if (this.scrapeSessions >= MAX_SCRAPE_SESSIONS) throw new BrowserBusyError('已有抓取任务正在运行');
    this.scrapeSessions += 1;
    let context: BrowserContext | undefined;
    try {
      context = await this.createContext(options.cookies, options.url);
      const page = await context.newPage();
      let timeout: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          void context?.close().catch(() => undefined);
          reject(new BrowserServiceError('后台抓取超时，浏览器会话已关闭'));
        }, BROWSER_OPERATION_TIMEOUT_MS);
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
      this.scrapeSessions -= 1;
      if (context) this.activeContexts.delete(context);
      await context?.close().catch(() => undefined);
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
    await this.closeInternal(id, false);
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
