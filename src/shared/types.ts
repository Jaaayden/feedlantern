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
}
export interface FeedItem extends ExtractedItem { id: string; firstSeenAt: string }
export interface CredentialSummary { id: string; name: string; url: string; format: 'header' | 'json'; domains: string[]; count: number; updatedAt: string; expiresAt: string | null }
export interface ScreenFrame { sessionId: string; image: string; width: number; height: number; url: string; title: string }
export interface Rect { x: number; y: number; width: number; height: number }
export interface PickRequest { x: number; y: number; target: 'item' | FieldName; itemSelector?: string; ancestorLevel?: number }
export interface PickResult { selector: string; rects: Rect[]; count: number; sampleText: string; warning?: string }
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
