import type { TranslationProgressData } from './TranslationProgress';
import { getLocale, t, tKey } from './i18n';
import { intlTag, type Locale, type Params } from '../shared/i18n';
import type { RulePreview, RuleRedetectResult, SelectionRules } from '../shared/types';
import type {
  ApiTokenCallFilter,
  ApiTokenCallPage,
  ApiTokenScope,
  ApiTokenSummary,
  UserSummary,
  BundleInput,
  BundlePayload,
  NotificationChannel,
  NotificationSummary,
  NotificationUpdate,
  AuthState,
  ApplicationSettings,
  ImportJob,
  CredentialSummary,
  NetworkProfileInput,
  NetworkProfileSummary,
  DetectionResult,
  ExtractedItem,
  Feed,
  FetchLogPage,
  FetchStatus,
  FeedInput,
  FeedSettingsInput,
  BulkFeedSettingsInput,
  FeedItem,
  ItemFilter,
  ItemOutputStatus,
  PaginationReport,
  PaginationRules,
  PickRequest,
  PickResult,
  ScreenFrame,
  SegmentResult,
  TargetLanguage,
  TranslationMode,
  TranslationProviderId,
  TranslationProvidersInfo,
  PubmedPreview,
  PubmedRssCheck,
} from '../shared/types';

/** Why each stored item is or is not published, keyed by item id. */
export interface OutputPreview { outputStatus: Record<string, ItemOutputStatus>; filterTimedOut?: boolean }

export class ApiError extends Error {
  status: number;
  /** Stable error code from the server (`ApiErrorCode`, documented in doc/agent.md). */
  code?: string;
  /** Catalog key of the server's message, used to show it in this interface's language. */
  messageKey?: string;
  params?: Params;

  constructor(message: string, status: number, code?: string, params?: Params, messageKey?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.params = params;
    this.messageKey = messageKey;
  }
}

/**
 * The text of a server error in the current interface language: rendered from
 * its message key when this build knows the key, otherwise the server's message.
 */
function errorMessage(payload: unknown, status: number, statusText: string): ApiError {
  const body = typeof payload === 'object' && payload !== null ? payload as { code?: unknown; message?: unknown; error?: unknown; messageKey?: unknown; params?: unknown } : {};
  const params = body.params && typeof body.params === 'object' ? body.params as Params : undefined;
  const serverText = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : statusText || t('error.requestFailed');
  const code = typeof body.code === 'string' ? body.code : undefined;
  const messageKey = typeof body.messageKey === 'string' ? body.messageKey : undefined;
  const message = messageKey ? tKey(messageKey, params, serverText) : serverText;
  return new ApiError(message, status, code, params, messageKey);
}

let csrfToken: string | undefined;
let sessionGeneration = 0;
let workspaceUser: string | undefined;
export function setWorkspaceUser(id?: string) {
  if (workspaceUser !== id) sessionGeneration++;
  workspaceUser = id;
}
let unauthorizedHandler: (() => void) | undefined;

export function setCsrfToken(token?: string) {
  if (csrfToken !== token) sessionGeneration++;
  csrfToken = token;
}

export function onUnauthorized(handler: () => void) {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = undefined;
  };
}

type RequestOptions = Omit<RequestInit, 'body'> & { body?: unknown };

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const generation = sessionGeneration;
  const headers = new Headers(options.headers);
  headers.set('X-FeedLantern', '1');
  // The server answers errors in this language unless the account chose one (which the UI then uses too).
  headers.set('Accept-Language', intlTag(getLocale()));
  if (workspaceUser && !/^\/api\/(auth|users|backups|settings|tokens)(?:\/|$)/.test(path)) headers.set('X-FeedLantern-User', workspaceUser);
  if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');

  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  let payload: unknown = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    payload = await response.json().catch(() => null);
  } else if (response.status !== 204) {
    payload = await response.text().catch(() => null);
  }

  // A response from the previous login must neither expose its data nor log out the new account.
  if (generation !== sessionGeneration) throw new ApiError(t('error.sessionChanged'), 0);
  if (!response.ok) {
    // A wrong password on the sign-in form is not an expired session.
    if (response.status === 401 && !/^\/api\/auth\/(login|setup)$/.test(path)) unauthorizedHandler?.();
    throw errorMessage(payload, response.status, response.statusText);
  }
  return payload as T;
}

export const api = {
  tokens: {
    /** `userId`: an administrator reading another account's tokens (read-only). */
    list: (userId?: string) => request<ApiTokenSummary[]>('/api/tokens', userId ? { headers: { 'X-FeedLantern-User': userId } } : {}),
    calls: (id: string, options: { status?: ApiTokenCallFilter; cursor?: string; userId?: string } = {}) => {
      const query = new URLSearchParams();
      if (options.status) query.set('status', options.status);
      if (options.cursor) query.set('cursor', options.cursor);
      return request<ApiTokenCallPage>(`/api/tokens/${encodeURIComponent(id)}/logs?${query}`, options.userId ? { headers: { 'X-FeedLantern-User': options.userId } } : {});
    },
    create: (body: { name: string; scope: ApiTokenScope; expiresInDays: number | null }) => request<{ token: ApiTokenSummary; secret: string }>('/api/tokens', { method: 'POST', body }),
    revoke: (id: string) => request<{ ok: boolean }>(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  backups: {
    export: (currentPassword: string, password: string) => request<unknown>('/api/backups/export', { method: 'POST', body: { currentPassword, password } }),
    restore: (body: unknown, preview: boolean) => request<Record<string, unknown>>(`/api/backups/${preview ? 'preview' : 'restore'}`, { method: 'POST', body }),
    config: () => request<unknown>('/api/backups/config'),
    importConfig: (archive: unknown, confirm = false) => request<Record<string, unknown>>('/api/backups/config', { method: 'POST', body: { archive, confirm } }),
  },
  jobs: {
    list: () => request<ImportJob[]>('/api/import-jobs'),
    create: (entries: Array<{ url: string; credentialId: string | null; networkProfileId?: string | null }>, intervalMinutes: number, sourceType: 'website' | 'rss' = 'website', translation: { translationMode?: Exclude<TranslationMode, 'original'>; targetLanguage?: TargetLanguage; translationProvider?: TranslationProviderId | null } = {}) => request<ImportJob>('/api/import-jobs', { method: 'POST', body: { entries, intervalMinutes, sourceType, translationMode: 'bilingual', ...translation } }),
    action: (id: string, action: 'retry' | 'cancel', entryId?: string) => request<ImportJob>(`/api/import-jobs/${id}/${action}`, { method: 'POST', body: { entryId } }),
    confirm: (id: string, entryId: string, input: FeedInput) => request<{ feed: Feed; feedUrl: string }>(`/api/import-jobs/${id}/confirm`, { method: 'POST', body: { entryId, input } }),
  },
  notifications: {
    get: () => request<NotificationSummary>('/api/notifications'),
    save: (body: NotificationUpdate) => request<NotificationSummary>('/api/notifications', { method: 'PUT', body }),
    /** Sends a test through one channel using the saved settings overridden by `fields`; nothing is saved. */
    test: (channel: NotificationChannel, fields: Record<string, unknown>) => request<{ ok: boolean }>('/api/notifications/test', { method: 'POST', body: { ...fields, channel } }),
  },
  users: {
    update: (id: string, body: Partial<Pick<UserSummary, 'username' | 'enabled' | 'role'>>) => request<UserSummary>(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    deletionPreview: (id: string) => request<{ user: UserSummary; feeds: number; bundles?: number; credentials: number; jobs: number }>(`/api/users/${encodeURIComponent(id)}/deletion-preview`),
    delete: (id: string, username: string) => request<{ ok: boolean }>(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE', body: { username } }),
    list: () => request<UserSummary[]>('/api/users'),
    create: (username: string, password: string) => request<UserSummary>('/api/users', { method: 'POST', body: { username, password } }),
    enabled: (id: string, enabled: boolean) => request<UserSummary>(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: { enabled } }),
    password: (id: string, password: string) => request<{ ok: boolean }>(`/api/users/${encodeURIComponent(id)}/password`, { method: 'POST', body: { password } }),
  },
  settings: {
    testBark: (body: ApplicationSettings['bark']) => request<{ ok: boolean }>('/api/settings/bark/test', { method: 'POST', body }),
    /** Partial update: only the fields given are changed (an empty or omitted API key keeps the saved one, null removes it). */
    save: ({ bark: _bark, ...body }: Partial<ApplicationSettings>) => request<ApplicationSettings>('/api/settings', { method: 'PUT', body }),
    get: () => request<ApplicationSettings>('/api/settings'),
    update: (feedView: 'list' | 'cards') => request<{ feedView: 'list' | 'cards' }>('/api/settings', { method: 'PUT', body: { feedView } }),
    /** Translate a sample sentence with unsaved service settings (an empty key uses the saved one). */
    testTranslation: (provider: TranslationProviderId, settings?: unknown, targetLanguage?: TargetLanguage) => request<{ ok: boolean; sample: string; text: string }>('/api/settings/translation/test', { method: 'POST', body: { provider, settings, targetLanguage } }),
  },
  translation: {
    providers: () => request<TranslationProvidersInfo>('/api/translation/providers'),
  },
  auth: {
    status: () => request<AuthState>('/api/auth/status'),
    setup: (body: { setupToken: string; username: string; password: string }) =>
      request<AuthState>('/api/auth/setup', { method: 'POST', body }),
    login: (body: { username: string; password: string }) =>
      request<AuthState>('/api/auth/login', { method: 'POST', body }),
    logout: () => request<void>('/api/auth/logout', { method: 'POST', body: {} }),
    password: (body: { currentPassword: string; newPassword: string }) =>
      request<AuthState>('/api/auth/password', { method: 'POST', body }),
    /** Save the account's interface language; null follows the browser. */
    locale: (locale: Locale | null) => request<AuthState>('/api/auth/locale', { method: 'PUT', body: { locale } }),
  },
  credentials: {
    list: () => request<CredentialSummary[]>('/api/credentials'),
    create: (body: CredentialPayload) =>
      request<CredentialSummary>('/api/credentials', { method: 'POST', body }),
    update: (id: string, body: CredentialPayload) =>
      request<CredentialSummary>(`/api/credentials/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    remove: (id: string) => request<void>(`/api/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  networkProfiles: {
    list: () => request<NetworkProfileSummary[]>('/api/network-profiles'),
    create: (body: NetworkProfileInput) => request<NetworkProfileSummary>('/api/network-profiles', { method: 'POST', body }),
    update: (id: string, body: NetworkProfileInput) => request<NetworkProfileSummary>(`/api/network-profiles/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    remove: (id: string) => request<void>(`/api/network-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    test: (id: string, url: string) => request<{ ok: boolean; status: number }>(`/api/network-profiles/${encodeURIComponent(id)}/test`, { method: 'POST', body: { url } }),
  },
  ruleHealth: {
    redetect: (id: string) => request<RuleRedetectResult>(`/api/feeds/${encodeURIComponent(id)}/health/redetect`, { method: 'POST', body: {} }),
    preview: (id: string, rules: SelectionRules) => request<RulePreview>(`/api/feeds/${encodeURIComponent(id)}/health/preview`, { method: 'POST', body: { rules } }),
    ignore: (id: string) => request<{ feed: Feed; feedUrl: string }>(`/api/feeds/${encodeURIComponent(id)}/health/ignore`, { method: 'POST', body: {} }),
  },
  pubmed: {
    /** Matches and the newest few articles of a PubMed query (NCBI E-utilities, shared rate limit). */
    preview: (query: string, networkProfileId?: string | null, signal?: AbortSignal) => request<PubmedPreview>('/api/pubmed/preview', { method: 'POST', body: { query, ...(networkProfileId ? { networkProfileId } : {}) }, signal }),
  },
  feeds: {
    /** Reads a PubMed RSS feed once and compares it with the query recovered from it; changes nothing. */
    pubmedCheck: (id: string) => request<PubmedRssCheck>(`/api/feeds/${encodeURIComponent(id)}/pubmed-check`, { method: 'POST', body: {} }),
    /** Turns a PubMed RSS feed into a PubMed search with this query; the feed keeps everything else. */
    pubmedConvert: (id: string, query: string, limit?: number) => request<{ feed: Feed; feedUrl: string }>(`/api/feeds/${encodeURIComponent(id)}/pubmed-convert`, { method: 'POST', body: { query, ...(limit ? { limit } : {}) } }),
    previewRss: (url: string, networkProfileId?: string | null) => request<{ title: string; items: ExtractedItem[] }>('/api/rss/preview', { method: 'POST', body: { url, ...(networkProfileId ? { networkProfileId } : {}) } }),
    translationProgress: (id: string) => request<TranslationProgressData>(`/api/feeds/${encodeURIComponent(id)}/translation/progress`),
    retryTranslation: (id: string) => request<unknown>(`/api/feeds/${encodeURIComponent(id)}/translation/retry`, { method: 'POST', body: {} }),
    logs: (id: string, status?: FetchStatus, cursor?: string) => {
      const query = new URLSearchParams();
      if (status) query.set('status', status);
      if (cursor) query.set('cursor', cursor);
      return request<FetchLogPage>(`/api/feeds/${encodeURIComponent(id)}/logs?${query}`);
    },
    settings: (id: string, body: FeedSettingsInput) => request<{ feed: Feed; feedUrl: string }>(`/api/feeds/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    title: (id: string, channelTitle: string) => request<{ feed: Feed }>(`/api/feeds/${encodeURIComponent(id)}`, { method: 'PATCH', body: { channelTitle } }),
    bulk: async (ids: string[], action: string, settings?: BulkFeedSettingsInput) => {
      const results: Array<{ id: string; ok: boolean; feedUrl?: string; error?: string }> = [];
      if (action === 'refresh') {
        // Keep requests short for reverse proxies while allowing the server's
        // bounded pool to overlap independent subscriptions.
        let next = 0;
        const ordered: typeof results = new Array(ids.length);
        await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (next < ids.length) {
            const index = next++, id = ids[index];
            try { ordered[index] = (await request<{ results: typeof results }>('/api/feeds/bulk', { method: 'POST', body: { ids: [id], action } })).results[0]; }
            catch (e) { ordered[index] = { id, ok: false, error: e instanceof Error ? e.message : t('error.actionFailed') }; }
          }
        }));
        return { results: ordered };
      }
      const size = 200;
      for (let offset = 0; offset < ids.length; offset += size) {
        const chunk = ids.slice(offset, offset + size);
        try { results.push(...(await request<{ results: typeof results }>('/api/feeds/bulk', { method: 'POST', body: { ids: chunk, action, settings } })).results); }
        catch (e) { results.push(...chunk.map(id => ({ id, ok: false, error: e instanceof Error ? e.message : t('error.actionFailed') }))); }
      }
      return { results };
    },
    list: () => request<Feed[]>('/api/feeds'),
    create: (body: FeedInput) => request<{ feed: Feed; feedUrl: string }>('/api/feeds', { method: 'POST', body }),
    detail: (id: string) =>
      request<{ feed: Feed; items: FeedItem[]; feedUrl: string } & OutputPreview>(`/api/feeds/${encodeURIComponent(id)}`),
    outputPreview: (id: string, body: { itemFilter: ItemFilter | null; outputLimit: number }) =>
      request<OutputPreview>(`/api/feeds/${encodeURIComponent(id)}/output-preview`, { method: 'POST', body }),
    update: (id: string, body: FeedInput) =>
      request<{ feed: Feed; feedUrl: string }>(`/api/feeds/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    refresh: (id: string) => request<void>(`/api/feeds/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: {} }),
    toggle: (id: string) => request<{ feed: Feed }>(`/api/feeds/${encodeURIComponent(id)}/toggle`, { method: 'POST', body: {} }),
    rotate: (id: string) =>
      request<{ feedUrl: string }>(`/api/feeds/${encodeURIComponent(id)}/rotate-token`, { method: 'POST', body: {} }),
    remove: (id: string) => request<void>(`/api/feeds/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  bundles: {
    list: () => request<BundlePayload[]>('/api/bundles'),
    create: (body: BundleInput) => request<BundlePayload>('/api/bundles', { method: 'POST', body }),
    update: (id: string, body: Partial<BundleInput>) => request<BundlePayload>(`/api/bundles/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    addFeeds: (id: string, feedIds: string[]) => request<BundlePayload>(`/api/bundles/${encodeURIComponent(id)}/feeds`, { method: 'POST', body: { feedIds } }),
    rotate: (id: string) => request<BundlePayload>(`/api/bundles/${encodeURIComponent(id)}/rotate-token`, { method: 'POST', body: {} }),
    remove: (id: string) => request<{ ok: true }>(`/api/bundles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  browser: {
    open: (body: { url: string; credentialId: string | null; networkProfileId?: string | null; waitMs: number; waitForSelector?: string }) =>
      request<ScreenFrame>('/api/browser', { method: 'POST', body }),
    frame: (id: string) => request<ScreenFrame>(`/api/browser/${encodeURIComponent(id)}`),
    scroll: (id: string, deltaY: number, point?: { x: number; y: number }) =>
      request<ScreenFrame>(`/api/browser/${encodeURIComponent(id)}/scroll`, { method: 'POST', body: { deltaY, ...point } }),
    click: (id: string, x: number, y: number) =>
      request<ScreenFrame>(`/api/browser/${encodeURIComponent(id)}/click`, { method: 'POST', body: { x, y } }),
    segment: (id: string, top: number) =>
      request<SegmentResult>(`/api/browser/${encodeURIComponent(id)}/segment`, { method: 'POST', body: { top } }),
    follow: (id: string, node: number) =>
      request<ScreenFrame>(`/api/browser/${encodeURIComponent(id)}/follow`, { method: 'POST', body: { node } }),
    pick: (id: string, body: PickRequest) =>
      request<PickResult>(`/api/browser/${encodeURIComponent(id)}/pick`, { method: 'POST', body }),
    detect: (id: string) =>
      request<DetectionResult>(`/api/browser/${encodeURIComponent(id)}/detect`, { method: 'POST', body: {} }),
    preview: (id: string, rules: FeedInput['rules']) =>
      request<{ items: ExtractedItem[] }>(`/api/browser/${encodeURIComponent(id)}/preview`, { method: 'POST', body: { rules } }),
    /** Collect pages 1…N like a background refresh (slow: waits between pages). */
    paginate: (id: string, rules: FeedInput['rules'], pagination: PaginationRules) =>
      request<{ items: ExtractedItem[]; pagination?: PaginationReport }>(`/api/browser/${encodeURIComponent(id)}/preview`, { method: 'POST', body: { rules, pagination } }),
    close: (id: string) => request<{ ok: true }>(`/api/browser/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true }),
  },
};

export interface CredentialPayload {
  name: string;
  url: string;
  format: 'header' | 'json';
  value: string;
}
