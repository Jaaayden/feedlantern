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
  sourceType?: 'website' | 'rss';
  translationMode?: 'original' | 'chinese' | 'bilingual';
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
  translationMode?: 'original' | 'chinese' | 'bilingual';
  channelTitle?: string;
  intervalMinutes?: number;
}
export type BulkFeedSettingsInput = Pick<FeedSettingsInput, 'translationMode' | 'intervalMinutes'>;
export interface Feed extends FeedInput {
  ownerId?: string;
  id: string;
  channelTitle?: string;
  enabled: boolean;
  createdAt: string;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  nextFetchAt: string;
  lastError: string | null;
  itemCount: number;
  translation?: { pending: number; success: number; failed: number };
}
export interface ExtractedItem {
  contentHtml?: string;
  translationStatus?: 'pending' | 'success' | 'failed';
  translationError?: string;
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
  translation: { concurrency: number; requestIntervalMs: number };
  feedView: 'list' | 'cards';
  logRetentionDays: number;
  bark: {
    enabled: boolean; url: string; failureThreshold: number; timeoutSeconds: number; maxAttempts: number;
    retryDelaySeconds: number; laterRetryDelaySeconds: number; cooldownMinutes: number;
  };
  server: {
    backgroundConcurrency: number; allowedHosts: string[]; dnsOverHttps: boolean;
    trustedProxies: string[]; publicOrigin: string; cookieSecure: boolean;
    sessionTtlDays: number; host: string; port: number;
  };
}
export const defaultApplicationSettings: ApplicationSettings = {
  translation: { concurrency: 6, requestIntervalMs: 100 },
  feedView: 'list', logRetentionDays: 30,
  bark: { enabled: false, url: '', failureThreshold: 10, timeoutSeconds: 10, maxAttempts: 3, retryDelaySeconds: 60, laterRetryDelaySeconds: 300, cooldownMinutes: 30 },
  server: { backgroundConcurrency: 1, allowedHosts: [], dnsOverHttps: false, trustedProxies: [], publicOrigin: 'http://127.0.0.1:4321', cookieSecure: false, sessionTtlDays: 30, host: '127.0.0.1', port: 4321 },
};
export interface CredentialSummary { id: string; name: string; url: string; format: 'header' | 'json'; domains: string[]; count: number; updatedAt: string; expiresAt: string | null }
/**
 * Visible elements of a captured frame, measured in screenshot pixels from the
 * top of the document. `boxes` holds five numbers per element: x, y, width,
 * height and the index of the nearest mapped ancestor (-1 for a root).
 */
export interface ElementMap { boxes: number[]; labels: string[]; links: Record<string, string>; truncated: boolean; /** Some element scrolls on its own (only the remote page can scroll it). */ innerScroll?: boolean }
/** One captured slice of the page, `top` pixels below the document top. */
export interface ScreenSegment { top: number; height: number; image: string }
/**
 * The first captured segment of a page. `height` is how much is captured so
 * far, `documentHeight` how much can be (capped; `truncated` when the page is
 * longer still), `viewportHeight` is Chromium's window. The editor appends
 * later `segments` as the user scrolls; the server never sends them here.
 */
export interface ScreenFrame { sessionId: string; image: string; width: number; height: number; viewportHeight: number; documentHeight: number; url: string; title: string; map?: ElementMap; truncated?: boolean; segments?: ScreenSegment[] }
/** The next segment, with the element map extended to cover it. */
export interface SegmentResult extends ScreenSegment { documentHeight: number; map: ElementMap; truncated?: boolean }
export interface Rect { x: number; y: number; width: number; height: number }
/**
 * Pick by element-map `node` (preferred) or by document coordinates. `exact`
 * keeps the chosen element instead of widening to a repeated item or a
 * meaningful field. With `rules`, the response also previews the updated rules.
 */
export interface PickRequest { x?: number; y?: number; node?: number; exact?: boolean; target: 'item' | FieldName; itemSelector?: string; ancestorLevel?: number; rules?: Partial<SelectionRules> }
export interface PickResult { selector: string; rects: Rect[]; count: number; sampleText: string; warning?: string; node?: number; items?: ExtractedItem[]; previewError?: string; datePreview?: { publishedAt: string; publishedAtSource: 'absolute' | 'relative'; dateText: string } }
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
export interface AuthState { userId?: string; role?: "admin" | "user"; setupRequired: boolean; authenticated: boolean; username?: string; csrfToken?: string; version: string }

// JSON API: errors always { error: string }; all mutations require X-FeedLantern: 1.
// GET /api/auth/status -> AuthState; POST /api/auth/setup {setupToken,username,password}
// POST /api/auth/login {username,password}; POST /api/auth/logout {}; successful auth -> AuthState
// POST /api/auth/password {currentPassword,newPassword}; authenticated mutations also require X-CSRF-Token.
// GET /api/credentials -> CredentialSummary[]; POST -> {name,url,format:'header'|'json',value} -> CredentialSummary
// PUT /api/credentials/:id same; DELETE /api/credentials/:id (409 if referenced)
// GET /api/feeds -> Feed[]; POST /api/feeds FeedInput -> {feed,feedUrl}
// GET /api/feeds/:id/logs?status=&cursor=&limit= -> FetchLogPage (owner only, default 20, max 100)
// GET /api/feeds/:id -> {feed,items:FeedItem[],feedUrl}; PUT FeedInput -> {feed,feedUrl}
// POST /api/feeds/:id/refresh {}; POST /api/feeds/:id/toggle {}; POST /api/feeds/:id/rotate-token {}
// DELETE /api/feeds/:id; GET /feeds/:id/:token.xml -> RSS 2.0 (token grants read-only access)
// POST /api/browser {url,credentialId,waitMs,waitForSelector?} -> ScreenFrame
// GET /api/browser/:id -> ScreenFrame; POST /api/browser/:id/scroll {deltaY} -> ScreenFrame
// POST /api/browser/:id/click {x,y} -> ScreenFrame; POST /api/browser/:id/follow {node} -> ScreenFrame
// POST /api/browser/:id/segment {top} -> SegmentResult (top = height captured so far)
// POST /api/browser/:id/pick PickRequest -> PickResult (with rules: also items/previewError)
// POST /api/browser/:id/preview {rules:SelectionRules} -> {items:ExtractedItem[]}
// POST /api/browser/:id/detect {} -> DetectionResult
// DELETE /api/browser/:id -> {ok:true}

export interface ImportEntry {
  sourceType?: 'website' | 'rss'; translationMode?: 'original' | 'chinese' | 'bilingual';
  id: string; url: string; credentialId: string | null; intervalMinutes: number;
  state: 'queued' | 'running' | 'created' | 'existing' | 'review' | 'failed' | 'canceled';
  feedId?: string; error?: string; title?: string; detection?: DetectionResult;
}
export interface ImportJob { actorId?: string; ownerId?: string; id: string; createdAt: string; entries: ImportEntry[] }

export function translationEnabled(feed: Pick<FeedInput, 'sourceType' | 'translationMode'>): boolean {
  return feed.translationMode === 'chinese' || feed.translationMode === 'bilingual' || feed.sourceType === 'rss' && feed.translationMode !== 'original';
}

export interface UserStats { feeds: number; failingFeeds: number; pausedFeeds: number; credentials: number; lastSeenAt: string | null }
export interface UserSummary { id: string; username: string; role: "admin" | "user"; enabled: boolean; createdAt: string; updatedAt: string; stats?: UserStats }

export type BarkSummary = Omit<ApplicationSettings["bark"], "url"> & { configured: boolean; maskedUrl: string };
