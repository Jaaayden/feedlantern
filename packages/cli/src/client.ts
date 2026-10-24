import {
  errorCodeForStatus,
  type ApiErrorCode,
  type ApiTokenCallFilter,
  type ApiTokenCallPage,
  type ApiTokenSummary,
  type AuthState,
  type BulkFeedSettingsInput,
  type BundleInput,
  type BundlePayload,
  type DetectionResult,
  type ExtractedItem,
  type Feed,
  type FeedInput,
  type FeedItem,
  type FeedSettingsInput,
  type FetchLogPage,
  type FetchStatus,
  type ImportJob,
  type ItemOutputStatus,
  type PaginationReport,
  type PaginationRules,
  type RulePreview,
  type ScreenFrame,
  type SelectionRules,
} from '../../../src/shared/types.js';
import { FeedLanternError } from './errors.js';
import { t } from './messages.js';
import { CLI_VERSION } from './version.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface FeedPayload { feed: Feed; feedUrl: string }
export interface FeedDetail extends FeedPayload { items: FeedItem[]; outputStatus: Record<string, ItemOutputStatus>; filterTimedOut?: boolean }
export type BulkAction = 'copy' | 'pause' | 'resume' | 'refresh' | 'delete' | 'settings';
export interface BulkResult { id: string; ok: boolean; error?: string; feedUrl?: string }
export interface RssPreview { title: string; items: Array<{ title: string; link: string; contentHtml?: string }> }
export interface BrowserOpenInput { url: string; credentialId?: string | null; networkProfileId?: string | null; waitMs?: number; waitForSelector?: string }
export interface ImportJobInput {
  entries: Array<{ url: string; credentialId?: string | null; networkProfileId?: string | null }>;
  intervalMinutes?: number; sourceType?: 'website' | 'rss'; translationMode?: 'translated' | 'bilingual'; targetLanguage?: string; translationProvider?: string | null;
}

/** A request the client did not send because it runs in dry-run mode. */
export interface PlannedRequest { method: HttpMethod; url: string; headers: Record<string, string>; body?: unknown }

export interface ClientOptions {
  /** Instance origin, such as `https://feeds.example.com`. */
  url: string;
  /** Personal access token (`fl_…`). Without one only public routes work. */
  token?: string;
  /** Administrators: act in this user's workspace (X-FeedLantern-User). */
  workspaceUser?: string;
  /** Record writes instead of sending them; reads are still sent. */
  dryRun?: boolean;
  /** Per-request timeout; detection and first fetches can take a minute. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Thin typed wrapper around the FeedLantern HTTP API (see `/api/openapi.json`).
 * Every failure becomes a FeedLanternError carrying the HTTP status and the
 * server's machine-readable `code`.
 */
export class FeedLanternClient {
  readonly url: string;
  readonly dryRun: boolean;
  /** Writes skipped in dry-run mode, in order. */
  readonly planned: PlannedRequest[] = [];
  private readonly token?: string;
  private readonly workspaceUser?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    if (!options.url) throw new FeedLanternError({ code: 'not_configured', status: 0, message: t('config.noUrl') });
    let origin: URL;
    try { origin = new URL(options.url); } catch { throw new FeedLanternError({ code: 'usage', status: 0, message: t('config.badUrl', { url: options.url }) }); }
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') throw new FeedLanternError({ code: 'usage', status: 0, message: t('config.badUrl', { url: options.url }) });
    this.url = options.url.replace(/\/+$/, '');
    this.token = options.token;
    this.workspaceUser = options.workspaceUser;
    this.dryRun = options.dryRun ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  get hasToken(): boolean { return !!this.token; }

  private headers(body: boolean): Record<string, string> {
    return {
      Accept: 'application/json',
      'User-Agent': `feedlantern-cli/${CLI_VERSION}`,
      'X-FeedLantern': '1',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(this.workspaceUser ? { 'X-FeedLantern-User': this.workspaceUser } : {}),
    };
  }

  /**
   * Sends one request. In dry-run mode a write is recorded in `planned` and
   * resolves to `undefined` without contacting the server.
   */
  async request<T>(method: HttpMethod, path: string, options: { body?: unknown; query?: Record<string, string | number | undefined>; auth?: boolean } = {}): Promise<T> {
    const query = Object.entries(options.query ?? {}).filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== '');
    const target = `${this.url}${path}${query.length ? `?${new URLSearchParams(query.map(([key, value]) => [key, String(value)]))}` : ''}`;
    const hasBody = method !== 'GET' && method !== 'DELETE' || options.body !== undefined;
    const headers = this.headers(hasBody);
    if (options.auth === false) delete headers.Authorization;
    if (this.dryRun && method !== 'GET') {
      const { Authorization: _secret, ...shown } = headers;
      this.planned.push({ method, url: target, headers: { ...shown, ...(_secret ? { Authorization: 'Bearer fl_…' } : {}) }, ...(hasBody ? { body: options.body ?? {} } : {}) });
      return undefined as T;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        method, headers, redirect: 'manual',
        ...(hasBody ? { body: JSON.stringify(options.body ?? {}) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as Error).name === 'TimeoutError';
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      throw new FeedLanternError({
        code: timedOut ? 'timeout' : 'network', status: 0, method, path,
        message: timedOut ? t('errors.timeout', { seconds: Math.round(this.timeoutMs / 1000) }) : t('errors.network', { url: this.url, reason: cause?.code ?? cause?.message ?? (error as Error).message }),
      });
    }
    const text = await response.text();
    let payload: unknown;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = undefined; }
    if (!response.ok) {
      const body = payload && typeof payload === 'object' ? payload as { error?: unknown; code?: unknown } : {};
      const code = typeof body.code === 'string' ? body.code as ApiErrorCode : response.status >= 300 && response.status < 400 ? 'bad_response' : errorCodeForStatus(response.status);
      const message = typeof body.error === 'string' ? body.error : t('errors.httpStatus', { status: response.status });
      throw new FeedLanternError({ code, status: response.status, message, method, path });
    }
    if (payload === undefined) throw new FeedLanternError({ code: 'bad_response', status: response.status, method, path, message: t('errors.notJson', { url: this.url }) });
    return payload as T;
  }

  // Meta
  authStatus(): Promise<AuthState> { return this.request('GET', '/api/auth/status'); }
  /** Public status without the token: tells reachability apart from a bad token. */
  publicStatus(): Promise<AuthState> { return this.request('GET', '/api/auth/status', { auth: false }); }
  currentToken(): Promise<ApiTokenSummary> { return this.request('GET', '/api/tokens/current'); }
  tokenLogs(query: { status?: ApiTokenCallFilter; limit?: number; cursor?: string } = {}): Promise<ApiTokenCallPage> { return this.request('GET', '/api/tokens/current/logs', { query }); }
  openApi(): Promise<Record<string, unknown>> { return this.request('GET', '/api/openapi.json'); }

  // Feeds
  listFeeds(): Promise<Feed[]> { return this.request('GET', '/api/feeds'); }
  getFeed(id: string): Promise<FeedDetail> { return this.request('GET', `/api/feeds/${encodeURIComponent(id)}`); }
  createFeed(input: FeedInput): Promise<FeedPayload> { return this.request('POST', '/api/feeds', { body: input }); }
  replaceFeed(id: string, input: FeedInput): Promise<FeedPayload> { return this.request('PUT', `/api/feeds/${encodeURIComponent(id)}`, { body: input }); }
  updateFeedSettings(id: string, input: FeedSettingsInput): Promise<FeedPayload> { return this.request('PATCH', `/api/feeds/${encodeURIComponent(id)}`, { body: input }); }
  deleteFeed(id: string): Promise<{ ok: true }> { return this.request('DELETE', `/api/feeds/${encodeURIComponent(id)}`); }
  refreshFeed(id: string): Promise<FeedPayload> { return this.request('POST', `/api/feeds/${encodeURIComponent(id)}/refresh`); }
  toggleFeed(id: string): Promise<FeedPayload> { return this.request('POST', `/api/feeds/${encodeURIComponent(id)}/toggle`); }
  feedLogs(id: string, query: { status?: FetchStatus; limit?: number; cursor?: string } = {}): Promise<FetchLogPage> { return this.request('GET', `/api/feeds/${encodeURIComponent(id)}/logs`, { query }); }
  previewOnFeed(id: string, rules: SelectionRules): Promise<RulePreview> { return this.request('POST', `/api/feeds/${encodeURIComponent(id)}/health/preview`, { body: { rules } }); }
  bulk(action: BulkAction, ids: string[], settings?: BulkFeedSettingsInput): Promise<{ results: BulkResult[] }> { return this.request('POST', '/api/feeds/bulk', { body: { ids, action, ...(settings ? { settings } : {}) } }); }
  rssPreview(url: string, networkProfileId?: string | null): Promise<RssPreview> { return this.request('POST', '/api/rss/preview', { body: { url, ...(networkProfileId ? { networkProfileId } : {}) } }); }

  // Remote editor (browser) sessions, used for detection and rule previews.
  openBrowser(input: BrowserOpenInput): Promise<ScreenFrame> { return this.request('POST', '/api/browser', { body: input }); }
  detect(sessionId: string): Promise<DetectionResult> { return this.request('POST', `/api/browser/${encodeURIComponent(sessionId)}/detect`, { body: {} }); }
  preview(sessionId: string, rules: SelectionRules, pagination?: PaginationRules | null): Promise<{ items: ExtractedItem[]; pagination?: PaginationReport }> {
    return this.request('POST', `/api/browser/${encodeURIComponent(sessionId)}/preview`, { body: { rules, ...(pagination ? { pagination } : {}) } });
  }
  closeBrowser(sessionId: string): Promise<{ ok: true }> { return this.request('DELETE', `/api/browser/${encodeURIComponent(sessionId)}`); }

  // Bundles
  listBundles(): Promise<BundlePayload[]> { return this.request('GET', '/api/bundles'); }
  getBundle(id: string): Promise<BundlePayload> { return this.request('GET', `/api/bundles/${encodeURIComponent(id)}`); }
  createBundle(input: BundleInput): Promise<BundlePayload> { return this.request('POST', '/api/bundles', { body: input }); }
  updateBundle(id: string, input: Partial<BundleInput>): Promise<BundlePayload> { return this.request('PUT', `/api/bundles/${encodeURIComponent(id)}`, { body: input }); }
  addBundleFeeds(id: string, feedIds: string[]): Promise<BundlePayload> { return this.request('POST', `/api/bundles/${encodeURIComponent(id)}/feeds`, { body: { feedIds } }); }
  deleteBundle(id: string): Promise<{ ok: true }> { return this.request('DELETE', `/api/bundles/${encodeURIComponent(id)}`); }

  // Import jobs (batch creation from a list of URLs)
  listImports(): Promise<ImportJob[]> { return this.request('GET', '/api/import-jobs'); }
  createImport(input: ImportJobInput): Promise<ImportJob> { return this.request('POST', '/api/import-jobs', { body: input }); }
  updateImport(id: string, action: 'cancel' | 'retry', entryId?: string): Promise<ImportJob> {
    return this.request('POST', `/api/import-jobs/${encodeURIComponent(id)}/${action}`, { body: entryId ? { entryId } : {} });
  }
}
