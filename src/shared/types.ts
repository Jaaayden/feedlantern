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
/**
 * Multi-page collection. Page 1 is always the source URL. `next` follows a
 * picked "next page" link or button, `template` fills `{n}` with
 * `start`, `start + step`, … for pages 2, 3, …, and `loadMore` clicks a button
 * that appends items to the same page.
 */
export interface PaginationRules {
  mode: 'next' | 'template' | 'loadMore';
  /** Total pages including page 1, 1–10. */
  maxPages: number;
  /** Pause before each further page, 2–30 s; a small random jitter is added. */
  delayMs: number;
  nextSelector?: string;
  urlTemplate?: string;
  start?: number;
  step?: number;
}
export const paginationLimits = { maxPages: 10, minDelayMs: 2_000, maxDelayMs: 30_000, defaultDelayMs: 3_000 } as const;
export type PaginationStop = 'single' | 'max' | 'end' | 'repeat' | 'known' | 'empty' | 'failed' | 'blocked' | 'budget' | 'limit';
export interface PageReport { page: number; url: string; count: number; added: number; error?: string }
/** What a multi-page collection fetched, and where and why it stopped. */
export interface PaginationReport { pages: PageReport[]; stoppedAt: number; stop: PaginationStop; message: string }
/** `translated` publishes only the translation; `bilingual` puts the translation first. */
export type TranslationMode = 'original' | 'translated' | 'bilingual';
export type TargetLanguage = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko';
export type TranslationProviderId = 'google' | 'deepl' | 'openai';
export const targetLanguages: Record<TargetLanguage, { label: string; short: string; rss: string }> = {
  'zh-CN': { label: '简体中文', short: '中文', rss: 'zh-cn' },
  'zh-TW': { label: '繁體中文', short: '繁体中文', rss: 'zh-tw' },
  en: { label: 'English（英语）', short: '英语', rss: 'en' },
  ja: { label: '日本語（日语）', short: '日语', rss: 'ja' },
  ko: { label: '한국어（韩语）', short: '韩语', rss: 'ko' },
};
export const translationProviderLabels: Record<TranslationProviderId, string> = { google: 'Google 免费翻译', deepl: 'DeepL', openai: 'OpenAI 兼容接口' };
export const isTargetLanguage = (value: unknown): value is TargetLanguage => typeof value === 'string' && Object.hasOwn(targetLanguages, value);
export const isTranslationProvider = (value: unknown): value is TranslationProviderId => typeof value === 'string' && Object.hasOwn(translationProviderLabels, value);
export function translationLabel(feed: Pick<FeedInput, 'translationMode' | 'targetLanguage'>): string {
  const short = targetLanguages[feed.targetLanguage ?? 'zh-CN'].short;
  if (feed.translationMode === 'translated') return `${short}翻译`;
  return feed.targetLanguage && feed.targetLanguage !== 'zh-CN' ? `双语翻译（${short}）` : '双语翻译';
}
export interface FeedInput {
  /** Omitted: keep the saved setting; null: single page. */
  pagination?: PaginationRules | null;
  sourceType?: 'website' | 'rss';
  translationMode?: TranslationMode;
  /** Defaults to simplified Chinese. */
  targetLanguage?: TargetLanguage;
  /** `null`/omitted follows the instance default provider. */
  translationProvider?: TranslationProviderId | null;
  name: string;
  url: string;
  rules: SelectionRules;
  ruleOrigins?: RuleOrigins;
  credentialId: string | null;
  /** Saved network profile (proxy, User-Agent, Referer, headers). Omitted on update keeps the current one. */
  networkProfileId?: string | null;
  intervalMinutes: number;
  waitMs: number;
  waitForSelector?: string;
}
/**
 * Output-only item filter. Patterns match the item's published title and
 * summary (case-insensitive); stored items are never deleted. An item is
 * dropped when any `exclude` pattern matches, or when `include` is non-empty
 * and none of its patterns match. `regex` treats every pattern as a regular
 * expression instead of a plain keyword.
 */
export interface ItemFilter { include: string[]; exclude: string[]; regex: boolean }
export const ITEM_FILTER_LIMITS = { patterns: 30, patternLength: 200 } as const;
/** Items published per feed output (RSS, Atom and JSON Feed share it). */
export const OUTPUT_LIMIT = { min: 10, max: 500, default: 100 } as const;
/**
 * Items kept in the database per feed. `null` (automatic) keeps 200 for
 * website feeds and 100 for RSS feeds; a set value is never below the
 * output limit. 1000 matches the most items one multi-page fetch collects.
 */
export const RETENTION_LIMIT = { min: 10, max: 1000, websiteAuto: 200, rssAuto: 100 } as const;
export type FeedFormat = 'rss' | 'atom' | 'json';
/** Why a stored item is or is not in the feed output (see `GET /api/feeds/:id`). */
export type ItemOutputStatus = 'published' | 'untranslated' | 'excluded' | 'not-included' | 'over-limit';
export interface FeedSettingsInput {
  translationMode?: TranslationMode;
  targetLanguage?: TargetLanguage;
  translationProvider?: TranslationProviderId | null;
  channelTitle?: string;
  intervalMinutes?: number;
  networkProfileId?: string | null;
  /** `null` removes the filter. */
  itemFilter?: ItemFilter | null;
  outputLimit?: number;
  /** Items kept in the database; `null` returns to the automatic value. */
  retentionLimit?: number | null;
}
export type BulkFeedSettingsInput = Pick<FeedSettingsInput, 'translationMode' | 'targetLanguage' | 'translationProvider' | 'intervalMinutes' | 'outputLimit' | 'retentionLimit' | 'itemFilter'>;
export interface Feed extends FeedInput {
  ownerId?: string;
  id: string;
  channelTitle?: string;
  itemFilter?: ItemFilter;
  /** Items in the output; defaults to OUTPUT_LIMIT.default. */
  outputLimit?: number;
  /** Items kept in the database; `null` or missing means automatic (see RETENTION_LIMIT). */
  retentionLimit?: number | null;
  enabled: boolean;
  createdAt: string;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  nextFetchAt: string;
  lastError: string | null;
  itemCount: number;
  translation?: { pending: number; success: number; failed: number };
  /** Present while the latest successful fetches look like the rules stopped matching the page. */
  ruleHealth?: RuleHealthWarning;
}
export type RuleHealthField = 'title' | 'link' | 'date' | 'image' | 'description';
/** One reason a successful fetch looks broken, compared with the feed's recent median. */
export interface RuleHealthReason { code: 'item-count' | 'field-rate' | 'duplicate-links' | 'same-link'; field?: RuleHealthField; baseline: number; current: number; message: string }
export interface RuleHealthWarning { detectedAt: string; checkedAt: string; itemCount: number; baselineSamples: number; reasons: RuleHealthReason[] }
/** Re-detection on the feed's page: what the saved rules extract now, beside fresh candidates. */
export interface RuleRedetectResult { current: RulePreview; detection: DetectionResult }
export interface RulePreview { count: number; items: ExtractedItem[]; error?: string }
export interface ExtractedItem {
  contentHtml?: string;
  translationStatus?: 'pending' | 'success' | 'failed';
  translationError?: string;
  /** Translated items: the title in each language (`title` is what the feed publishes). */
  translatedTitle?: string;
  sourceTitle?: string;
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
  /** Multi-page feeds: pages fetched and where/why collection stopped. */
  pages?: number | null; note?: string | null;
  /** Aggregate alert state; `channels` lists the result of every channel the alert was sent to. */
  notification: { status: AlertStatus; error: string | null; channels?: ChannelDelivery[] } | null;
  /** Rules-health warning recorded on an otherwise successful fetch. */
  warning?: string | null;
}
export type NotificationChannel = 'bark' | 'webhook' | 'ntfy' | 'telegram';
export const notificationChannels: NotificationChannel[] = ['bark', 'webhook', 'ntfy', 'telegram'];
export const notificationChannelLabels: Record<NotificationChannel, string> = { bark: 'Bark', webhook: 'Webhook', ntfy: 'ntfy', telegram: 'Telegram' };
export interface ChannelDelivery { channel: NotificationChannel; status: AlertStatus; error: string | null }
/** Channels besides Bark. Secrets (`secret`, header values, `token`, `botToken`) are never returned by the API. */
export interface NotificationChannelSettings {
  webhook: { enabled: boolean; url: string; secret: string; headers: { name: string; value: string }[] };
  ntfy: { enabled: boolean; server: string; topic: string; token: string };
  telegram: { enabled: boolean; botToken: string; chatId: string };
}
export const defaultNotificationChannels: NotificationChannelSettings = {
  webhook: { enabled: false, url: '', secret: '', headers: [] },
  ntfy: { enabled: false, server: 'https://ntfy.sh/', topic: '', token: '' },
  telegram: { enabled: false, botToken: '', chatId: '' },
};
/** Threshold, retry and cooldown settings shared by every channel of one account. */
export type NotificationPolicy = Omit<ApplicationSettings['bark'], 'enabled' | 'url'>;
export interface NotificationSummary extends NotificationPolicy {
  channels: {
    bark: { enabled: boolean; configured: boolean; maskedUrl: string };
    webhook: { enabled: boolean; configured: boolean; maskedUrl: string; signed: boolean; headerNames: string[] };
    ntfy: { enabled: boolean; configured: boolean; server: string; topic: string; tokenConfigured: boolean };
    telegram: { enabled: boolean; configured: boolean; chatId: string; tokenConfigured: boolean };
  };
}
/**
 * PUT /api/notifications body. Omitted fields keep their saved value; an empty
 * string clears a secret. `headers` replaces every saved header.
 */
export interface NotificationUpdate extends Partial<NotificationPolicy> {
  channels?: {
    bark?: Partial<{ enabled: boolean; url: string }>;
    webhook?: Partial<NotificationChannelSettings['webhook']>;
    ntfy?: Partial<NotificationChannelSettings['ntfy']>;
    telegram?: Partial<NotificationChannelSettings['telegram']>;
  };
}
export interface FetchLogPage { logs: FetchLog[]; nextCursor: string | null; retentionDays: number }
export interface TranslationRate { concurrency: number; requestIntervalMs: number }
export interface ApplicationSettings {
  /** `concurrency` / `requestIntervalMs` apply to the Google channel; other services have their own. */
  translation: TranslationRate & {
    defaultProvider: TranslationProviderId;
    /** API keys are stored encrypted and never returned by the API (`apiKeyConfigured` instead). */
    deepl: TranslationRate & { apiKey: string; apiKeyConfigured?: boolean; plan: 'auto' | 'free' | 'pro' };
    openai: TranslationRate & { baseUrl: string; model: string; apiKey: string; apiKeyConfigured?: boolean; systemPrompt: string };
  };
  feedView: 'list' | 'cards';
  logRetentionDays: number;
  bark: {
    enabled: boolean; url: string; failureThreshold: number; timeoutSeconds: number; maxAttempts: number;
    retryDelaySeconds: number; laterRetryDelaySeconds: number; cooldownMinutes: number;
    /** Also notify when a feed's rules may have stopped matching (deduplicated apart from failures). */
    ruleHealthAlerts: boolean;
  };
  server: {
    backgroundConcurrency: number; allowedHosts: string[]; dnsOverHttps: boolean;
    trustedProxies: string[]; publicOrigin: string; cookieSecure: boolean;
    sessionTtlDays: number; host: string; port: number;
  };
}
export const defaultApplicationSettings: ApplicationSettings = {
  translation: {
    concurrency: 6, requestIntervalMs: 100, defaultProvider: 'google',
    deepl: { apiKey: '', plan: 'auto', concurrency: 2, requestIntervalMs: 200 },
    openai: { baseUrl: '', model: '', apiKey: '', systemPrompt: '', concurrency: 2, requestIntervalMs: 0 },
  },
  feedView: 'list', logRetentionDays: 30,
  bark: { enabled: false, url: '', failureThreshold: 10, timeoutSeconds: 10, maxAttempts: 3, retryDelaySeconds: 60, laterRetryDelaySeconds: 300, cooldownMinutes: 30, ruleHealthAlerts: true },
  server: { backgroundConcurrency: 1, allowedHosts: [], dnsOverHttps: false, trustedProxies: [], publicOrigin: 'http://127.0.0.1:4321', cookieSecure: false, sessionTtlDays: 30, host: '127.0.0.1', port: 4321 },
};
/** A reusable network profile. Proxy logins and header values are write-only and never returned. */
export interface NetworkProfileSummary {
  id: string;
  name: string;
  proxy: { type: 'http' | 'https' | 'socks5'; host: string; port: number; url: string; authenticated: boolean } | null;
  userAgent: string | null;
  referer: string | null;
  headerNames: string[];
  feedCount: number;
  updatedAt: string;
}
export interface NetworkProfileInput {
  name: string;
  /** http://, https:// or socks5:// with host and port. Empty for no proxy. */
  proxyUrl?: string | null;
  /** Omit to keep the saved login, null to remove it. */
  proxyUsername?: string | null;
  proxyPassword?: string | null;
  userAgent?: string | null;
  referer?: string | null;
  /** A header without `value` keeps its saved value. */
  headers?: Array<{ name: string; value?: string }>;
}
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
export interface PickRequest { x?: number; y?: number; node?: number; exact?: boolean; target: 'item' | FieldName | 'next'; itemSelector?: string; ancestorLevel?: number; rules?: Partial<SelectionRules> }
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
/** GET /api/translation/providers: what any signed-in user may choose for a feed. */
export interface TranslationProvidersInfo { defaultProvider: TranslationProviderId; providers: Array<{ id: TranslationProviderId; label: string; configured: boolean }> }
export interface AuthState { userId?: string; role?: "admin" | "user"; setupRequired: boolean; authenticated: boolean; username?: string; csrfToken?: string; version: string; /** Set when the request was authenticated with a personal access token. */ tokenScope?: ApiTokenScope }
export type ApiTokenScope = 'read' | 'write';
/** A personal access token as listed to its owner; the secret itself is only returned on creation. */
export interface ApiTokenSummary { id: string; name: string; scope: ApiTokenScope; prefix: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; /** Calls and failed calls (status >= 400) recorded in the last 24 hours. */ usage24h?: { calls: number; failures: number } }
/** Filter for a token's call log: success (< 400), denied (401, 403, 429) or error (any other status >= 400). */
export type ApiTokenCallFilter = 'success' | 'denied' | 'error';
/** One API call made with a personal access token. The secret and query strings are never stored. */
export interface ApiTokenCall {
  id: number; tokenId: string; tokenName: string; tokenPrefix: string;
  at: string; method: string;
  /** Route template such as `/api/feeds/:id`; null when the path matched no route. */
  route: string | null;
  status: number; durationMs: number; ip: string | null;
}
export interface ApiTokenCallPage { calls: ApiTokenCall[]; nextCursor: string | null; retentionDays: number; perTokenLimit: number }

// JSON API: errors always { error: string }; all mutations require X-FeedLantern: 1.
// GET /api/auth/status -> AuthState; POST /api/auth/setup {setupToken,username,password}
// POST /api/auth/login {username,password}; POST /api/auth/logout {}; successful auth -> AuthState
// POST /api/auth/password {currentPassword,newPassword}; authenticated mutations also require X-CSRF-Token.
// GET /api/credentials -> CredentialSummary[]; POST -> {name,url,format:'header'|'json',value} -> CredentialSummary
// PUT /api/credentials/:id same; DELETE /api/credentials/:id (409 if referenced)
// GET /api/network-profiles -> NetworkProfileSummary[]; POST NetworkProfileInput -> NetworkProfileSummary
// PUT /api/network-profiles/:id NetworkProfileInput; DELETE (409 if referenced); POST /api/network-profiles/:id/test {url} -> {ok,status}
// GET /api/feeds -> Feed[]; POST /api/feeds FeedInput -> {feed,feedUrl}
// GET /api/feeds/:id/logs?status=&cursor=&limit= -> FetchLogPage (owner only, default 20, max 100)
// GET /api/notifications -> NotificationSummary; PUT NotificationUpdate -> NotificationSummary
// POST /api/notifications/test {channel, ...unsaved channel fields} -> {ok:true} (nothing is saved)
// GET /api/feeds/:id -> {feed,items:FeedItem[],feedUrl}; PUT FeedInput -> {feed,feedUrl}
// POST /api/feeds/:id/refresh {}; POST /api/feeds/:id/toggle {}; POST /api/feeds/:id/rotate-token {}
// GET /api/feeds/:id also returns outputStatus: Record<itemId, ItemOutputStatus>
// PATCH /api/feeds/:id FeedSettingsInput; POST /api/feeds/:id/output-preview {itemFilter?,outputLimit?} -> {outputStatus}
// DELETE /api/feeds/:id; GET /feeds/:id/:token.xml -> RSS 2.0 (token grants read-only access)
// GET /feeds/:id/:token.atom -> Atom 1.0; GET /feeds/:id/:token.json -> JSON Feed 1.1 (same items and token)
// POST /api/browser {url,credentialId,waitMs,waitForSelector?} -> ScreenFrame
// GET /api/browser/:id -> ScreenFrame; POST /api/browser/:id/scroll {deltaY} -> ScreenFrame
// POST /api/browser/:id/click {x,y} -> ScreenFrame; POST /api/browser/:id/follow {node} -> ScreenFrame
// POST /api/browser/:id/segment {top} -> SegmentResult (top = height captured so far)
// POST /api/browser/:id/pick PickRequest -> PickResult (with rules: also items/previewError)
// POST /api/browser/:id/preview {rules:SelectionRules, pagination?} -> {items:ExtractedItem[], pagination?:PaginationReport}
//   (with pagination of 2+ pages: collects the pages like a background refresh, in a separate tab of the session)
// POST /api/browser/:id/detect {} -> DetectionResult
// DELETE /api/browser/:id -> {ok:true}
// POST /api/feeds/:id/health/redetect {} -> RuleRedetectResult (website feeds; saved rules are not changed)
// POST /api/feeds/:id/health/preview {rules:SelectionRules} -> RulePreview
// POST /api/feeds/:id/health/ignore {} -> {feed,feedUrl} (clears the warning, current result becomes the new baseline)
// GET /api/bundles -> BundlePayload[]; POST /api/bundles BundleInput -> BundlePayload
// PUT /api/bundles/:id Partial<BundleInput> -> BundlePayload; POST /api/bundles/:id/feeds {feedIds} -> BundlePayload (adds members)
// POST /api/bundles/:id/rotate-token {} -> BundlePayload; DELETE /api/bundles/:id
// GET /bundles/:id/:token.xml -> RSS 2.0 merging the members' stored items (read-only, never fetches)

/** A bundle merges several of one owner's feeds into a single RSS address. */
export interface BundleInput { name: string; feedIds: string[]; itemLimit?: number }
export interface Bundle { id: string; ownerId?: string; name: string; feedIds: string[]; itemLimit: number; createdAt: string; updatedAt: string }
export interface BundlePayload { bundle: Bundle; bundleUrl: string }
export const BUNDLE_ITEM_LIMIT = { min: 10, max: 500, default: 100 } as const;
export const BUNDLE_MAX_FEEDS = 200;

export interface ImportEntry {
  sourceType?: 'website' | 'rss'; translationMode?: TranslationMode; targetLanguage?: TargetLanguage; translationProvider?: TranslationProviderId | null;
  id: string; url: string; credentialId: string | null; networkProfileId?: string | null; intervalMinutes: number;
  state: 'queued' | 'running' | 'created' | 'existing' | 'review' | 'failed' | 'canceled';
  feedId?: string; error?: string; title?: string; detection?: DetectionResult;
}
export interface ImportJob { actorId?: string; ownerId?: string; id: string; createdAt: string; entries: ImportEntry[] }

/** The `.xml` address the API returns, switched to another output format. */
export function feedFormatUrl(rssUrl: string, format: FeedFormat): string {
  return format === 'rss' ? rssUrl : rssUrl.replace(/\.xml$/, format === 'atom' ? '.atom' : '.json');
}

export function translationEnabled(feed: Pick<FeedInput, 'sourceType' | 'translationMode'>): boolean {
  return feed.translationMode === 'translated' || feed.translationMode === 'bilingual' || feed.sourceType === 'rss' && feed.translationMode !== 'original';
}

export interface UserStats { feeds: number; failingFeeds: number; pausedFeeds: number; credentials: number; lastSeenAt: string | null }
export interface UserSummary { id: string; username: string; role: "admin" | "user"; enabled: boolean; createdAt: string; updatedAt: string; stats?: UserStats }

export type BarkSummary = Omit<ApplicationSettings["bark"], "url"> & { configured: boolean; maskedUrl: string };
