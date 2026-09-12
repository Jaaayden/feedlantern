import type {
  AuthState,
  ApplicationSettings,
  ImportJob,
  CredentialSummary,
  DetectionResult,
  ExtractedItem,
  Feed,
  FetchLogPage,
  FetchStatus,
  FeedInput,
  FeedSettingsInput,
  FeedItem,
  PickRequest,
  PickResult,
  ScreenFrame,
} from '../shared/types';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let csrfToken: string | undefined;
let unauthorizedHandler: (() => void) | undefined;

export function setCsrfToken(token?: string) {
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
  const headers = new Headers(options.headers);
  headers.set('X-FeedLantern', '1');
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

  if (!response.ok) {
    if (response.status === 401) unauthorizedHandler?.();
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : response.statusText || '请求失败，请稍后重试';
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

export const api = {
  backups: {
    export: (currentPassword: string, password: string) => request<unknown>('/api/backups/export', { method: 'POST', body: { currentPassword, password } }),
    restore: (body: unknown, preview: boolean) => request<Record<string, unknown>>(`/api/backups/${preview ? 'preview' : 'restore'}`, { method: 'POST', body }),
    config: () => request<unknown>('/api/backups/config'),
    importConfig: (archive: unknown, confirm = false) => request<Record<string, unknown>>('/api/backups/config', { method: 'POST', body: { archive, confirm } }),
  },
  jobs: {
    list: () => request<ImportJob[]>('/api/import-jobs'),
    create: (entries: Array<{ url: string; credentialId: string | null }>, intervalMinutes: number) => request<ImportJob>('/api/import-jobs', { method: 'POST', body: { entries, intervalMinutes } }),
    action: (id: string, action: 'retry' | 'cancel', entryId?: string) => request<ImportJob>(`/api/import-jobs/${id}/${action}`, { method: 'POST', body: { entryId } }),
    confirm: (id: string, entryId: string, input: FeedInput) => request<{ feed: Feed; feedUrl: string }>(`/api/import-jobs/${id}/confirm`, { method: 'POST', body: { entryId, input } }),
  },
  settings: {
    save: (body: ApplicationSettings) => request<ApplicationSettings>('/api/settings', { method: 'PUT', body }),
    get: () => request<ApplicationSettings>('/api/settings'),
    update: (feedView: 'list' | 'cards') => request<{ feedView: 'list' | 'cards' }>('/api/settings', { method: 'PUT', body: { feedView } }),
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
  },
  credentials: {
    list: () => request<CredentialSummary[]>('/api/credentials'),
    create: (body: CredentialPayload) =>
      request<CredentialSummary>('/api/credentials', { method: 'POST', body }),
    update: (id: string, body: CredentialPayload) =>
      request<CredentialSummary>(`/api/credentials/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    remove: (id: string) => request<void>(`/api/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  feeds: {
    logs: (id: string, status?: FetchStatus, cursor?: string) => {
      const query = new URLSearchParams();
      if (status) query.set('status', status);
      if (cursor) query.set('cursor', cursor);
      return request<FetchLogPage>(`/api/feeds/${encodeURIComponent(id)}/logs?${query}`);
    },
    settings: (id: string, body: FeedSettingsInput) => request<{ feed: Feed; feedUrl: string }>(`/api/feeds/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    title: (id: string, channelTitle: string) => request<{ feed: Feed }>(`/api/feeds/${encodeURIComponent(id)}`, { method: 'PATCH', body: { channelTitle } }),
    bulk: async (ids: string[], action: string) => {
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
            catch (e) { ordered[index] = { id, ok: false, error: e instanceof Error ? e.message : '操作失败' }; }
          }
        }));
        return { results: ordered };
      }
      const size = 200;
      for (let offset = 0; offset < ids.length; offset += size) {
        const chunk = ids.slice(offset, offset + size);
        try { results.push(...(await request<{ results: typeof results }>('/api/feeds/bulk', { method: 'POST', body: { ids: chunk, action } })).results); }
        catch (e) { results.push(...chunk.map(id => ({ id, ok: false, error: e instanceof Error ? e.message : '操作失败' }))); }
      }
      return { results };
    },
    list: () => request<Feed[]>('/api/feeds'),
    create: (body: FeedInput) => request<{ feed: Feed; feedUrl: string }>('/api/feeds', { method: 'POST', body }),
    detail: (id: string) =>
      request<{ feed: Feed; items: FeedItem[]; feedUrl: string }>(`/api/feeds/${encodeURIComponent(id)}`),
    update: (id: string, body: FeedInput) =>
      request<{ feed: Feed; feedUrl: string }>(`/api/feeds/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    refresh: (id: string) => request<void>(`/api/feeds/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: {} }),
    toggle: (id: string) => request<{ feed: Feed }>(`/api/feeds/${encodeURIComponent(id)}/toggle`, { method: 'POST', body: {} }),
    rotate: (id: string) =>
      request<{ feedUrl: string }>(`/api/feeds/${encodeURIComponent(id)}/rotate-token`, { method: 'POST', body: {} }),
    remove: (id: string) => request<void>(`/api/feeds/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  browser: {
    open: (body: { url: string; credentialId: string | null; waitMs: number; waitForSelector?: string }) =>
      request<ScreenFrame>('/api/browser', { method: 'POST', body }),
    frame: (id: string) => request<ScreenFrame>(`/api/browser/${encodeURIComponent(id)}`),
    scroll: (id: string, deltaY: number, point?: { x: number; y: number }) =>
      request<ScreenFrame>(`/api/browser/${encodeURIComponent(id)}/scroll`, { method: 'POST', body: { deltaY, ...point } }),
    click: (id: string, x: number, y: number) =>
      request<ScreenFrame>(`/api/browser/${encodeURIComponent(id)}/click`, { method: 'POST', body: { x, y } }),
    pick: (id: string, body: PickRequest) =>
      request<PickResult>(`/api/browser/${encodeURIComponent(id)}/pick`, { method: 'POST', body }),
    detect: (id: string) =>
      request<DetectionResult>(`/api/browser/${encodeURIComponent(id)}/detect`, { method: 'POST', body: {} }),
    preview: (id: string, rules: FeedInput['rules']) =>
      request<{ items: ExtractedItem[] }>(`/api/browser/${encodeURIComponent(id)}/preview`, { method: 'POST', body: { rules } }),
    close: (id: string) => request<{ ok: true }>(`/api/browser/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true }),
  },
};

export interface CredentialPayload {
  name: string;
  url: string;
  format: 'header' | 'json';
  value: string;
}
