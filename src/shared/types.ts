export type FieldName = 'title' | 'link' | 'description' | 'image' | 'date';
export type RuleOrigins = Partial<Record<'item' | FieldName, 'auto' | 'manual'>>;
export interface SelectionRules {
  item: string;
  title: string;
  link: string;
  description?: string;
  image?: string;
  date?: string;
}
export interface FeedInput {
  name: string;
  url: string;
  rules: SelectionRules;
  ruleOrigins?: RuleOrigins;
  credentialId: string | null;
  intervalMinutes: number;
  waitMs: number;
  waitForSelector?: string;
}
export interface FeedSettingsInput {
  channelTitle?: string;
  intervalMinutes?: number;
}
export interface Feed extends FeedInput {
  id: string;
  channelTitle?: string;
  enabled: boolean;
  createdAt: string;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  nextFetchAt: string;
  lastError: string | null;
  itemCount: number;
}
export interface ExtractedItem {
  title: string;
  link: string;
  description?: string;
  image?: string;
  publishedAt?: string;
  publishedAtSource?: 'absolute' | 'relative';
}
export interface FeedItem extends ExtractedItem { id: string; firstSeenAt: string }
export type FetchSource = 'scheduled' | 'manual' | 'create' | 'edit' | 'resume' | 'import';
export type FetchStatus = 'running' | 'success' | 'failure' | 'interrupted';
export type AlertStatus = 'pending' | 'sent' | 'failed' | 'canceled' | 'disabled';
export const fetchSourceLabels: Record<FetchSource, string> = { scheduled: '定时', manual: '手动', create: '创建订阅', edit: '修改规则', resume: '恢复订阅', import: '批量创建' };
export interface FetchLog {
  id: number; feedId: string; source: FetchSource; status: FetchStatus;
  startedAt: string; finishedAt: string | null; durationMs: number | null;
  itemCount: number | null; newItemCount: number | null; error: string | null;
  notification: { status: AlertStatus; error: string | null } | null;
}
export interface FetchLogPage { logs: FetchLog[]; nextCursor: string | null; retentionDays: number }
export interface ApplicationSettings {
  feedView: 'list' | 'cards';
  logRetentionDays: number;
  bark: {
    enabled: boolean; url: string; timeoutSeconds: number; maxAttempts: number;
    retryDelaySeconds: number; laterRetryDelaySeconds: number; cooldownMinutes: number;
  };
  server: {
    backgroundConcurrency: number; allowedHosts: string[]; dnsOverHttps: boolean;
    trustedProxies: string[]; publicOrigin: string; cookieSecure: boolean;
    sessionTtlDays: number; host: string; port: number;
  };
}
export const defaultApplicationSettings: ApplicationSettings = {
  feedView: 'list', logRetentionDays: 30,
  bark: { enabled: false, url: '', timeoutSeconds: 10, maxAttempts: 3, retryDelaySeconds: 60, laterRetryDelaySeconds: 300, cooldownMinutes: 30 },
  server: { backgroundConcurrency: 1, allowedHosts: [], dnsOverHttps: false, trustedProxies: [], publicOrigin: 'http://127.0.0.1:4321', cookieSecure: false, sessionTtlDays: 30, host: '127.0.0.1', port: 4321 },
};
export interface CredentialSummary { id: string; name: string; url: string; format: 'header' | 'json'; domains: string[]; count: number; updatedAt: string; expiresAt: string | null }
export interface ScreenFrame { sessionId: string; image: string; width: number; height: number; url: string; title: string }
export interface Rect { x: number; y: number; width: number; height: number }
export interface PickRequest { x: number; y: number; target: 'item' | FieldName; itemSelector?: string; ancestorLevel?: number }
export interface PickResult { selector: string; rects: Rect[]; count: number; sampleText: string; warning?: string; datePreview?: { publishedAt: string; publishedAtSource: 'absolute' | 'relative'; dateText: string } }
export interface DetectionCandidate {
  id: string;
  label: string;
  rules: SelectionRules;
  confidence: 'high' | 'medium' | 'low';
  score: number;
  count: number;
  items: ExtractedItem[];
  rects: Rect[];
  warnings: string[];
}
export interface DetectionResult { candidates: DetectionCandidate[]; recommendedId: string | null; warnings: string[] }
export interface AuthState { setupRequired: boolean; authenticated: boolean; username?: string; csrfToken?: string; version: string }

// JSON API: errors always { error: string }; all mutations require X-FeedLantern: 1.
// GET /api/auth/status -> AuthState; POST /api/auth/setup {setupToken,username,password}
// POST /api/auth/login {username,password}; POST /api/auth/logout {}; successful auth -> AuthState
// POST /api/auth/password {currentPassword,newPassword}; authenticated mutations also require X-CSRF-Token.
// GET /api/credentials -> CredentialSummary[]; POST -> {name,url,format:'header'|'json',value} -> CredentialSummary
// PUT /api/credentials/:id same; DELETE /api/credentials/:id (409 if referenced)
// GET /api/feeds -> Feed[]; POST /api/feeds FeedInput -> {feed,feedUrl}
// GET /api/feeds/:id/logs?status=&cursor=&limit= -> FetchLogPage (admin only, default 20, max 100)
// GET /api/feeds/:id -> {feed,items:FeedItem[],feedUrl}; PUT FeedInput -> {feed,feedUrl}
// POST /api/feeds/:id/refresh {}; POST /api/feeds/:id/toggle {}; POST /api/feeds/:id/rotate-token {}
// DELETE /api/feeds/:id; GET /feeds/:id/:token.xml -> RSS 2.0 (token grants read-only access)
// POST /api/browser {url,credentialId,waitMs,waitForSelector?} -> ScreenFrame
// GET /api/browser/:id -> ScreenFrame; POST /api/browser/:id/scroll {deltaY} -> ScreenFrame
// POST /api/browser/:id/click {x,y} -> ScreenFrame; POST /api/browser/:id/pick PickRequest -> PickResult
// POST /api/browser/:id/preview {rules:SelectionRules} -> {items:ExtractedItem[]}
// POST /api/browser/:id/detect {} -> DetectionResult
// DELETE /api/browser/:id -> {ok:true}

export interface ImportEntry {
  id: string; url: string; credentialId: string | null; intervalMinutes: number;
  state: 'queued' | 'running' | 'created' | 'existing' | 'review' | 'failed' | 'canceled';
  feedId?: string; error?: string; title?: string; detection?: DetectionResult;
}
export interface ImportJob { id: string; createdAt: string; entries: ImportEntry[] }
