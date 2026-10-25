import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Cookie } from 'playwright';
import { isFeedSource } from '../shared/types.js';
import type { DetectionResult, ExtractedItem, Feed, RulePreview, RuleRedetectResult, SelectionRules } from '../shared/types.js';
import { AppError } from './auth.js';
import type { Store } from './store.js';
import type { FetchNetworkOptions } from './fetch-options.js';
import { asRecord, friendlyError, parseRules } from './validation.js';
import { lt, msg } from './i18n.js';

const PREVIEW_ITEMS = 5;

interface Capture {
  discover?(options: { url: string; signal?: AbortSignal; cookies?: Cookie[]; waitMs: number; waitForSelector?: string; network?: FetchNetworkOptions }): Promise<{ title: string; detection: DetectionResult }>;
  scrape(options: { url: string; signal?: AbortSignal; cookies?: Cookie[]; waitMs: number; waitForSelector?: string; rules: SelectionRules; network?: FetchNetworkOptions }): Promise<ExtractedItem[]> | ExtractedItem[];
}

export interface RuleHealthRouteContext {
  store: Store;
  browser: () => Capture;
  guard: (request: FastifyRequest) => unknown;
  signal: (request: FastifyRequest) => AbortSignal;
  enqueue: <T>(operation: () => Promise<T> | T, keys: () => string[]) => Promise<T>;
  keys: (id: string) => string[];
  cookies: (feed: Feed) => Cookie[];
  /** The feed's network profile, the same one its refreshes use. */
  network: (feed: Feed) => FetchNetworkOptions | undefined;
  payload: (feed: Feed) => { feed: Feed; feedUrl: string };
}

/**
 * Re-detection and warning handling for "rules may be broken". Both captures
 * use the same background extraction as scheduled refreshes; nothing here
 * changes saved rules (the editor's PUT does that after the user confirms).
 */
export function registerRuleHealthRoutes(app: FastifyInstance, context: RuleHealthRouteContext): void {
  const { store } = context;
  const websiteFeed = (request: FastifyRequest): Feed => {
    context.guard(request);
    const feed = store.getFeed(String(asRecord(request.params).id));
    if (!feed) throw new AppError(404, 'error.feedNotFound');
    if (isFeedSource(feed)) throw new AppError(400, 'error.rssNoRules');
    return feed;
  };
  // Both captures read page 1 only, also for multi-page feeds: rule health is
  // measured on page 1, and automatic detection only ever looks at one page.
  const preview = async (feed: Feed, rules: SelectionRules, signal: AbortSignal): Promise<RulePreview> => {
    try {
      const network = context.network(feed);
      const items = await context.browser().scrape({ url: feed.url, signal, cookies: context.cookies(feed), waitMs: feed.waitMs, waitForSelector: feed.waitForSelector, rules, ...(network ? { network } : {}) });
      return { count: items.length, items: items.slice(0, PREVIEW_ITEMS) };
    } catch (error) {
      if (signal.aborted || error instanceof AppError) throw error;
      return { count: 0, items: [], error: lt(friendlyError(error, msg('extract.noItemsShort'))) };
    }
  };

  app.post('/api/feeds/:id/health/redetect', async (request): Promise<RuleRedetectResult> => {
    const feed = websiteFeed(request);
    const browser = context.browser();
    if (!browser.discover) throw new AppError(501, 'error.detectUnsupported');
    return context.enqueue(async () => {
      const latest = websiteFeed(request);
      const signal = context.signal(request);
      const current = await preview(latest, latest.rules, signal);
      let detection: DetectionResult;
      const network = context.network(latest);
      try { detection = (await browser.discover!({ url: latest.url, signal, cookies: context.cookies(latest), waitMs: latest.waitMs, waitForSelector: latest.waitForSelector, ...(network ? { network } : {}) })).detection; }
      catch (error) { if (signal.aborted || error instanceof AppError) throw error; throw new AppError(502, friendlyError(error, msg('error.detectRetry'))); }
      return { current, detection: { ...detection, candidates: detection.candidates.map(candidate => ({ ...candidate, items: candidate.items.slice(0, PREVIEW_ITEMS), rects: [] })) } };
    }, () => context.keys(feed.id));
  });

  app.post('/api/feeds/:id/health/preview', async (request): Promise<RulePreview> => {
    const feed = websiteFeed(request);
    const rules = parseRules(asRecord(request.body).rules);
    return context.enqueue(async () => preview(websiteFeed(request), rules, context.signal(request)), () => context.keys(feed.id));
  });

  app.post('/api/feeds/:id/health/ignore', async request => {
    const feed = websiteFeed(request);
    store.ruleHealth.ignore(feed.id);
    return context.payload(store.getFeed(feed.id)!);
  });
}
