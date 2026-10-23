import type { UserSummary } from '../shared/types.js';
import { isTargetLanguage, isTranslationProvider, translationEnabled } from '../shared/types.js';
import { RssTranslations } from './rss-translation.js';
import { TRANSLATION_CACHE_LIMIT, type Tables } from './backups.js';
import { FetchHistory } from './fetch-history.js';
import { RuleHealth } from './rule-health.js';
import { BUNDLE_SCHEMA, BundleStore } from './bundle-store.js';
import { ApiTokens } from './api-tokens.js';
import { AppError } from './auth.js';
import { applicationSettingsSchema } from './settings.js';
import { clampOutputLimit, parseItemFilter, storedItemLimit } from './feed-output.js';
import { defaultApplicationSettings, defaultNotificationChannels, type ApplicationSettings, type NotificationChannelSettings } from '../shared/types.js';
import { activeChannels, notificationChannelsSchema, storedNotificationSchema, type ChannelConfigs, type NotificationTarget } from './notify.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CredentialSummary, ExtractedItem, Feed, FeedInput, FeedSettingsInput, FeedItem, ImportJob, ItemFilter, RuleOrigins, SelectionRules } from '../shared/types.js';
import type { ServerConfig } from './config.js';

export interface CredentialValue {
  id?: string;
  name: string;
  url: string;
  format: 'header' | 'json';
  value: unknown;
}

export interface StoredSession {
  id: string;
  csrfToken: string;
  username: string;
  userId: string;
  role: UserSummary["role"];
  expiresAt: number;
}

export interface RefreshResult {
  feed: Feed;
  items: FeedItem[];
}

export interface StoredFeedToken {
  token: string;
  tokenHash: string;
}

const SESSION_TOUCH_INTERVAL_MS = 60_000;

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every(Number.isFinite) || n < 1024 || r < 1 || p < 1) return false;
  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    const actual = Buffer.from(scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: 128 * 1024 * 1024 }));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function encrypt(masterKey: Buffer, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decrypt(masterKey: Buffer, encoded: string): string {
  const [ivEncoded, tagEncoded, ciphertextEncoded] = encoded.split('.');
  if (!ivEncoded || !tagEncoded || !ciphertextEncoded) throw new Error('invalid ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivEncoded, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, 'base64url')), decipher.final()]).toString('utf8');
}

function normalizeLink(link: string, baseUrl?: string): string {
  const raw = link.trim();
  try {
    const parsed = new URL(raw, baseUrl);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) parsed.port = '';
    return parsed.toString();
  } catch {
    return raw.replace(/#.*$/, '');
  }
}

function mergeRuleOrigins(current: RuleOrigins | undefined, next: RuleOrigins | undefined): RuleOrigins | undefined {
  // An omitted origins object means that an older client did not make an
  // explicit choice, so retain the saved provenance. When it is present, the
  // caller has explicitly accepted/replaced the candidate and its values must
  // be allowed to override a previous manual label.
  if (next === undefined) return current;
  if (!current && !next) return undefined;
  return { ...(current ?? {}), ...next };
}

/** A stored filter that no longer validates is dropped rather than breaking the feed. */
function storedItemFilter(value: unknown): ItemFilter | undefined {
  try { return parseItemFilter(parseJson<unknown>(value, null)) ?? undefined; } catch { return undefined; }
}

function rowToFeed(row: Record<string, unknown>): Feed {
  const itemFilter = storedItemFilter(row.item_filter_json);
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    sourceType: row.source_type === 'rss' ? 'rss' : 'website',
    translationMode: row.translation_mode === 'original' ? 'original' : row.translation_mode === 'translated' || row.translation_mode === 'chinese' ? 'translated' : 'bilingual',
    targetLanguage: isTargetLanguage(row.target_language) ? row.target_language : 'zh-CN',
    translationProvider: isTranslationProvider(row.translation_provider) ? row.translation_provider : null,
    name: String(row.name),
    channelTitle: String(row.channel_title ?? row.name),
    url: String(row.url),
    rules: parseJson<SelectionRules>(row.rules_json, { item: '', title: '', link: '' }),
    ruleOrigins: parseJson<RuleOrigins | undefined>(row.rule_origins_json, undefined),
    credentialId: row.credential_id ? String(row.credential_id) : null,
    intervalMinutes: Number(row.interval_minutes),
    waitMs: Number(row.wait_ms),
    waitForSelector: row.wait_for_selector ? String(row.wait_for_selector) : undefined,
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    lastFetchedAt: row.last_fetched_at ? String(row.last_fetched_at) : null,
    lastSuccessAt: row.last_success_at ? String(row.last_success_at) : null,
    nextFetchAt: String(row.next_fetch_at),
    lastError: row.last_error ? String(row.last_error) : null,
    itemCount: Number(row.item_count ?? 0),
    ...(itemFilter ? { itemFilter } : {}),
    outputLimit: clampOutputLimit(row.output_limit === undefined || row.output_limit === null ? undefined : Number(row.output_limit)),
  };
}

function rowToItem(row: Record<string, unknown>): FeedItem {
  return {
    id: String(row.id),
    title: String(row.title),
    link: String(row.link),
    description: row.description ? String(row.description) : undefined,
    image: row.image ? String(row.image) : undefined,
    publishedAt: row.published_at ? String(row.published_at) : undefined,
    publishedAtSource: row.published_at ? (row.published_at_source === 'relative' ? 'relative' : 'absolute') : undefined,
    firstSeenAt: String(row.first_seen_at),
  };
}

export class Store {
  readonly history: FetchHistory;
  readonly ruleHealth: RuleHealth;
  readonly translations: RssTranslations;
  readonly bundles: BundleStore;
  readonly tokens: ApiTokens;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly masterKeyPath: string;
  readonly setupTokenPath: string;
  private readonly db: DatabaseSync;
  private readonly userControllers = new Map<string, AbortController>();
  private readonly masterKey: Buffer;

  constructor(config: Pick<ServerConfig, 'dataDir'> | string) {
    this.dataDir = typeof config === 'string' ? config : config.dataDir;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(this.dataDir, 0o700);
    this.dbPath = join(this.dataDir, 'app.db');
    this.masterKeyPath = join(this.dataDir, 'master.key');
    this.setupTokenPath = join(this.dataDir, 'setup-token');
    this.masterKey = this.loadMasterKey();
    this.db = new DatabaseSync(this.dbPath);
    // Returning free pages to the OS needs auto_vacuum, which can only be chosen before the first table exists.
    if (Number((this.db.prepare('SELECT COUNT(*) AS c FROM sqlite_master').get() as { c: number }).c) === 0) this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    chmodSync(this.dbPath, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY,
        csrf_hash TEXT NOT NULL,
        username TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('header', 'json')),
        encrypted_value TEXT NOT NULL,
        domains_json TEXT NOT NULL,
        cookie_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS feeds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        rule_origins_json TEXT,
        credential_id TEXT REFERENCES credentials(id) ON DELETE RESTRICT,
        interval_minutes INTEGER NOT NULL,
        wait_ms INTEGER NOT NULL,
        wait_for_selector TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_fetched_at TEXT,
        last_success_at TEXT,
        next_fetch_at TEXT NOT NULL,
        last_error TEXT,
        item_count INTEGER NOT NULL DEFAULT 0,
        token_ciphertext TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS feed_items (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        normalized_key TEXT NOT NULL,
        title TEXT NOT NULL,
        link TEXT NOT NULL,
        description TEXT,
        image TEXT,
        published_at TEXT,
        first_seen_at TEXT NOT NULL,
        UNIQUE(feed_id, normalized_key)
      );
      CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS feeds_due_idx ON feeds(enabled, next_fetch_at);
      CREATE INDEX IF NOT EXISTS feed_items_feed_idx ON feed_items(feed_id, first_seen_at DESC);
    `);
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version < 1) {
      this.db.exec(`BEGIN;
        ALTER TABLE feeds ADD COLUMN channel_title TEXT;
        UPDATE feeds SET channel_title = name;
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version = 1;
        COMMIT;`);
    }
    if (version < 2) this.db.exec(`BEGIN; CREATE TABLE import_jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL); PRAGMA user_version = 2; COMMIT;`);
    if (version < 3) this.db.exec(`BEGIN;
      UPDATE feeds SET name = COALESCE(NULLIF(TRIM(channel_title), ''), name);
      UPDATE feeds SET channel_title = name;
      PRAGMA user_version = 3; COMMIT;`);
    if (version < 4) this.db.exec(`BEGIN; ALTER TABLE feed_items ADD COLUMN published_at_source TEXT; PRAGMA user_version = 4; COMMIT;`);
    if (version < 5) this.db.exec(`BEGIN;
      ALTER TABLE feeds ADD COLUMN source_type TEXT NOT NULL DEFAULT 'website';
      ALTER TABLE feeds ADD COLUMN translation_mode TEXT NOT NULL DEFAULT 'bilingual';
      PRAGMA user_version=5; COMMIT;`);
    if (version < 6) this.db.exec("BEGIN; UPDATE feeds SET translation_mode='original' WHERE source_type='website'; PRAGMA user_version=6; COMMIT;");
    if (version < 7) this.db.exec(`BEGIN;
      CREATE TABLE IF NOT EXISTS admin (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX users_single_admin ON users(role) WHERE role='admin';
      INSERT INTO users SELECT 'admin',username,password_hash,'admin',1,0,created_at,updated_at FROM admin;
      DROP TABLE admin;
      DELETE FROM sessions;
      ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id);
      ALTER TABLE credentials ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'admin';
      ALTER TABLE feeds ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'admin';
      ALTER TABLE import_jobs ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'admin';
      CREATE INDEX feeds_owner ON feeds(owner_id);
      CREATE INDEX credentials_owner ON credentials(owner_id);
      CREATE INDEX import_jobs_owner ON import_jobs(owner_id);
      CREATE INDEX sessions_user ON sessions(user_id);
      PRAGMA user_version=7; COMMIT;`);
    if (version < 8) this.db.exec(`BEGIN;
      DROP INDEX IF EXISTS users_single_admin;
      CREATE TABLE user_notifications (user_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=8; COMMIT;`);
    if (version < 9) {
      // Per-feed output settings. Columns are added only when missing, so a
      // database rebuilt from an older layout still upgrades cleanly.
      const columns = new Set(this.db.prepare('PRAGMA table_info(feeds)').all().map(row => String(row.name)));
      this.db.exec(`BEGIN;
        ${columns.has('item_filter_json') ? '' : 'ALTER TABLE feeds ADD COLUMN item_filter_json TEXT;'}
        ${columns.has('output_limit') ? '' : 'ALTER TABLE feeds ADD COLUMN output_limit INTEGER NOT NULL DEFAULT 100;'}
        PRAGMA user_version=9; COMMIT;`);
    }
    this.translations = new RssTranslations(this.db, id => this.userSignal(id));
    this.history = new FetchHistory(this.db, () => this.getSettings(), id => {
      const { policy, configs } = this.notificationTarget(id);
      return { policy, channels: Object.keys(configs) as (keyof ChannelConfigs)[] };
    });
    // Alerts raised before notification channels existed were Bark-only.
    if (version < 10) { this.db.exec('BEGIN'); this.history.migrateLegacyDeliveries(); this.db.exec('PRAGMA user_version=10; COMMIT'); }
    // Personal access tokens: only a SHA-256 digest of the secret is stored.
    if (version < 11) this.db.exec(`BEGIN;
      CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('read','write')),
        created_at TEXT NOT NULL, expires_at TEXT, last_used_at TEXT);
      CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id);
      PRAGMA user_version=11; COMMIT;`);
    this.tokens = new ApiTokens(this.db);
    // Migration numbers are reserved per feature branch, so this one checks its
    // own column instead of trusting the order in which branches were merged.
    const feedColumns = new Set(this.db.prepare('PRAGMA table_info(feeds)').all().map(column => String(column.name)));
    if (!feedColumns.has('target_language')) {
      const current = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      this.db.exec(`BEGIN;
        ALTER TABLE feeds ADD COLUMN target_language TEXT NOT NULL DEFAULT 'zh-CN';
        ALTER TABLE feeds ADD COLUMN translation_provider TEXT;
        UPDATE feeds SET translation_mode='translated' WHERE translation_mode='chinese';
        PRAGMA user_version=${Math.max(13, current)}; COMMIT;`);
    }
    // Feed bundles. 14 is reserved for this migration; like 13 it checks for its own
    // tables, so it also runs when it was not merged last.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bundles'").get()) {
      const current = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      this.db.exec(`BEGIN; ${BUNDLE_SCHEMA} PRAGMA user_version=${Math.max(14, current)}; COMMIT;`);
    }
    this.bundles = new BundleStore(this.db, value => encrypt(this.masterKey, value), value => decrypt(this.masterKey, value), id => this.isUserActive(id));
    // Rule health statistics (derived diagnostics, not part of backups). 15 is
    // reserved for this migration; like 13 and 14 it checks for its own tables.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='feed_health_samples'").get()) {
      const current = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      this.db.exec(`BEGIN;
        CREATE TABLE IF NOT EXISTS feed_health (feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
          signature TEXT NOT NULL, warning_json TEXT, alerted_at INTEGER);
        CREATE TABLE IF NOT EXISTS feed_health_samples (id INTEGER PRIMARY KEY AUTOINCREMENT,
          feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, signature TEXT NOT NULL, recorded_at TEXT NOT NULL,
          item_count INTEGER NOT NULL, distinct_links INTEGER NOT NULL, title_rate REAL NOT NULL, link_rate REAL NOT NULL,
          date_rate REAL NOT NULL, image_rate REAL NOT NULL, description_rate REAL NOT NULL, flagged INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS feed_health_samples_feed ON feed_health_samples(feed_id, flagged, id DESC);
        CREATE INDEX IF NOT EXISTS feed_health_samples_retention ON feed_health_samples(recorded_at);
        PRAGMA user_version=${Math.max(15, current)}; COMMIT;`);
    }
    this.ruleHealth = new RuleHealth(this.db, () => this.getSettings(), this.history);
    this.migrateBark();
    this.ensureSetupToken();
  }

  private loadMasterKey(): Buffer {
    if (existsSync(this.masterKeyPath)) {
      const key = readFileSync(this.masterKeyPath);
      if (key.length !== 32) throw new Error('master key has an invalid length');
      chmodSync(this.masterKeyPath, 0o600);
      return key;
    }
    const key = randomBytes(32);
    writeFileSync(this.masterKeyPath, key, { mode: 0o600, flag: 'wx' });
    chmodSync(this.masterKeyPath, 0o600);
    return key;
  }

  private ensureSetupToken(): void {
    if (this.hasAdmin()) {
      if (existsSync(this.setupTokenPath)) unlinkSync(this.setupTokenPath);
      return;
    }
    if (!existsSync(this.setupTokenPath)) {
      writeFileSync(this.setupTokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    }
    chmodSync(this.setupTokenPath, 0o600);
  }

  close(): void {
    for (const controller of this.userControllers.values()) controller.abort();
    this.db.close();
  }

  hasAdmin(): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS present FROM users WHERE role = 'admin'").get());
  }

  getSetupToken(): string | null {
    if (!existsSync(this.setupTokenPath)) return null;
    try {
      return readFileSync(this.setupTokenPath, 'utf8').trim();
    } catch {
      return null;
    }
  }

  consumeSetupToken(value: string): boolean {
    const expected = this.getSetupToken();
    if (!expected) return false;
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(value);
    if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) return false;
    try {
      unlinkSync(this.setupTokenPath);
    } catch {
      return false;
    }
    return true;
  }

  createAdmin(username: string, password: string): void {
    if (this.hasAdmin()) throw new Error('admin already exists');
    const timestamp = nowIso();
    this.db.prepare("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES ('admin',?,?,'admin',?,?)").run(username, hashPassword(password), timestamp, timestamp);
  }

  getAdmin(): { id: string; username: string; passwordHash: string } | null {
    const row = this.db.prepare("SELECT * FROM users WHERE role='admin'").get();
    return row ? { id: String(row.id), username: String(row.username), passwordHash: String(row.password_hash) } : null;
  }

  getUser(id: string): UserSummary | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(id);
    return row ? Store.userFromRow(row) : undefined;
  }

  private static userFromRow(row: Record<string, unknown>): UserSummary {
    return {
      id: String(row.id), username: String(row.username), role: row.role as UserSummary['role'], enabled: !!row.enabled,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  updateUser(actorId: string, id: string, patch: Partial<Pick<UserSummary, 'username' | 'enabled' | 'role'>>): UserSummary {
    return this.transaction(() => {
      const user = this.getUser(id);
      if (!user) throw new AppError(404, '用户不存在');
      const next = { ...user, ...patch };
      if (actorId === id && !next.enabled) throw new AppError(403, '不能停用自己');
      if (user.role === 'admin' && user.enabled && (!next.enabled || next.role !== 'admin') &&
          !this.listUsers().some(u => u.id !== id && u.role === 'admin' && u.enabled)) throw new AppError(409, '必须保留至少一名启用的管理员');
      if (this.listUsers().some(u => u.id !== id && u.username === next.username)) throw new AppError(409, '用户名已存在');
      const identityChanged = next.username !== user.username || next.role !== user.role;
      if (identityChanged) {
        this.db.prepare('UPDATE users SET username=?,role=?,generation=generation+1,updated_at=? WHERE id=?').run(next.username, next.role, nowIso(), id);
        this.revokeUser(id);
      }
      if (next.enabled !== user.enabled) this.setUserEnabled(id, next.enabled);
      return this.getUser(id)!;
    });
  }

  private revokeUser(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    this.tokens.revokeUser(id);
    this.userControllers.get(id)?.abort(); this.userControllers.delete(id);
    for (const feed of this.listFeeds(id)) this.translations.invalidate(feed.id);
    this.translations.cancelActor(id);
    for (const job of this.listImportJobs()) {
      if (job.actorId !== id || job.ownerId === id) continue;
      for (const entry of job.entries) if (['queued', 'running'].includes(entry.state)) { entry.state = 'canceled'; entry.error = '操作人身份已变化，请重新重试'; }
      this.saveImportJob(job);
    }
  }

  deletionPreview(id: string) {
    const user = this.getUser(id);
    if (!user) throw new AppError(404, '用户不存在');
    return { user, feeds: this.listFeeds(id).length, bundles: this.bundles.list(id).length, credentials: this.listCredentialSummaries(id).length, jobs: this.listImportJobs(id).length };
  }

  deleteUser(actorId: string, id: string, confirmation: string): void {
    this.transaction(() => {
      const user = this.getUser(id);
      if (!user) throw new AppError(404, '用户不存在');
      if (actorId === id) throw new AppError(403, '不能删除自己');
      if (confirmation !== user.username) throw new AppError(400, '请输入目标用户名确认删除');
      if (user.role === 'admin' && user.enabled && !this.listUsers().some(u => u.id !== id && u.role === 'admin' && u.enabled)) throw new AppError(409, '必须保留至少一名启用的管理员');
      this.revokeUser(id);
      for (const table of ['import_jobs', 'bundles', 'feeds', 'credentials']) this.db.prepare(`DELETE FROM ${table} WHERE owner_id=?`).run(id);
      // The shared translation cache can contain this user's source fragments.
      this.db.prepare('DELETE FROM translation_cache').run();
      this.db.prepare('DELETE FROM user_notifications WHERE user_id=?').run(id);
      this.db.prepare('DELETE FROM users WHERE id=?').run(id);
    });
  }

  listUsers(): UserSummary[] {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at,id').all().map(row => Store.userFromRow(row));
  }

  /** Per-user overview for the admin user list: feed health, credentials and latest session activity. */
  listUsersWithStats(): UserSummary[] {
    const feeds = new Map<string, { total: number; failing: number; paused: number }>();
    for (const row of this.db.prepare('SELECT owner_id, COUNT(*) AS total, SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS failing, SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END) AS paused FROM feeds GROUP BY owner_id').all() as Array<Record<string, unknown>>) {
      feeds.set(String(row.owner_id), { total: Number(row.total), failing: Number(row.failing ?? 0), paused: Number(row.paused ?? 0) });
    }
    const credentials = new Map<string, number>();
    for (const row of this.db.prepare('SELECT owner_id, COUNT(*) AS total FROM credentials GROUP BY owner_id').all() as Array<Record<string, unknown>>) credentials.set(String(row.owner_id), Number(row.total));
    const seen = new Map<string, number>();
    for (const row of this.db.prepare('SELECT user_id, MAX(last_seen_at) AS seen FROM sessions WHERE user_id IS NOT NULL GROUP BY user_id').all() as Array<Record<string, unknown>>) seen.set(String(row.user_id), Number(row.seen));
    return this.listUsers().map(user => {
      const feed = feeds.get(user.id);
      const lastSeen = seen.get(user.id);
      return { ...user, stats: { feeds: feed?.total ?? 0, failingFeeds: feed?.failing ?? 0, pausedFeeds: feed?.paused ?? 0, credentials: credentials.get(user.id) ?? 0, lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null } };
    });
  }

  createUser(username: string, password: string): UserSummary {
    const id = randomId('user'), timestamp = nowIso();
    this.db.prepare("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES (?,?,?,'user',?,?)").run(id, username, hashPassword(password), timestamp, timestamp);
    return this.listUsers().find(u => u.id === id)!;
  }

  userGeneration(id = 'admin'): number | null {
    const row = this.db.prepare('SELECT enabled,generation FROM users WHERE id=?').get(id);
    // Store-only extraction fixtures may operate before first-run setup.
    return row ? (row.enabled ? Number(row.generation) : null) : id === 'admin' && !this.hasAdmin() ? 0 : null;
  }
  userSignal(id = 'admin'): AbortSignal {
    if (!this.isUserActive(id)) return AbortSignal.abort();
    let controller = this.userControllers.get(id);
    if (!controller) { controller = new AbortController(); this.userControllers.set(id, controller); }
    return controller.signal;
  }
  isUserActive(id = 'admin'): boolean { return this.userGeneration(id) !== null; }
  isFeedActive(id: string): boolean { const feed = this.getFeed(id); return !!feed && this.isUserActive(feed.ownerId); }

  setUserEnabled(id: string, enabled: boolean): void {
    if (!enabled && this.getUser(id)?.role === 'admin' && !this.listUsers().some(u => u.id !== id && u.role === 'admin' && u.enabled)) throw new AppError(409, '必须保留至少一名启用的管理员');
    this.transaction(() => {
      this.db.prepare('UPDATE users SET enabled=?,generation=generation+1,updated_at=? WHERE id=?').run(enabled ? 1 : 0, nowIso(), id);
      if (!enabled) {
        this.translations.suspendActor(id);
        this.userControllers.get(id)?.abort();
        this.userControllers.delete(id);
        this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
        this.tokens.revokeUser(id);
        for (const feed of this.listFeeds(id)) this.translations.invalidate(feed.id);
      } else {
        this.db.prepare('UPDATE feeds SET next_fetch_at=? WHERE owner_id=? AND enabled=1').run(nowIso(), id);
      }
    });
  }

  owns(table: 'feeds' | 'credentials' | 'import_jobs' | 'bundles', id: string, userId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND owner_id=?`).get(id, userId);
  }

  authenticate(username: string, password: string): boolean {
    const row = this.db.prepare('SELECT password_hash,enabled FROM users WHERE username=?').get(username);
    // Always perform scrypt, including unknown and disabled accounts.
    const valid = verifyPassword(password, row ? String(row.password_hash) : this.dummyPasswordHash);
    return !!row?.enabled && valid;
  }

  private readonly dummyPasswordHash = hashPassword(randomBytes(32).toString('hex'));

  changePassword(password: string, userId = this.getAdmin()?.id ?? 'admin'): void {
    this.transaction(() => {
      this.db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(hashPassword(password), nowIso(), userId);
      this.revokeUser(userId);
    });
  }

  createSession(username: string, ttlMs: number): StoredSession {
    const user = this.listUsers().find(u => u.username === username && u.enabled);
    if (!user) throw new Error('用户不存在或已停用');
    const id = randomBytes(32).toString('base64url');
    const csrfToken = this.deriveCsrfToken(id);
    const createdAt = Date.now();
    const expiresAt = createdAt + ttlMs;
    this.db.prepare('INSERT INTO sessions(id_hash, csrf_hash, username, created_at, expires_at, last_seen_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(hashToken(id), hashToken(csrfToken), username, createdAt, expiresAt, createdAt, user.id);
    return { id, csrfToken, username, expiresAt, userId: user.id, role: user.role };
  }

  findSession(id: string | undefined, ttlMs: number): StoredSession | null {
    if (!id) return null;
    const idHash = hashToken(id);
    const row = this.db.prepare('SELECT s.*,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash = ? AND u.enabled=1').get(idHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    const expiresAt = Number(row.expires_at);
    if (expiresAt <= Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
      return null;
    }
    // A single API request validates the session several times; only touch
    // the row when the recorded activity is stale, to avoid a write per check.
    const seenAt = Date.now();
    if (seenAt - Number(row.last_seen_at) >= SESSION_TOUCH_INTERVAL_MS) this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(seenAt, idHash);
    // The raw CSRF token is deliberately not retained. The app checks a
    // supplied token against the stored digest using checkCsrf().
    return { id, csrfToken: '', username: String(row.username), expiresAt, userId: String(row.user_id), role: row.role as UserSummary['role'] };
  }

  checkCsrf(id: string | undefined, csrfToken: string | undefined): boolean {
    if (!id || !csrfToken) return false;
    const row = this.db.prepare('SELECT csrf_hash FROM sessions WHERE id_hash = ? AND expires_at > ?').get(hashToken(id), Date.now()) as Record<string, unknown> | undefined;
    if (!row) return false;
    const expected = Buffer.from(String(row.csrf_hash));
    const actual = Buffer.from(hashToken(csrfToken));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  issueCsrf(id: string): string {
    const token = this.deriveCsrfToken(id);
    const result = this.db.prepare('UPDATE sessions SET csrf_hash = ?, last_seen_at = ? WHERE id_hash = ? AND expires_at > ?').run(hashToken(token), Date.now(), hashToken(id), Date.now());
    if (!result.changes) throw new Error('session is no longer valid');
    return token;
  }

  private deriveCsrfToken(sessionId: string): string {
    return createHmac('sha256', this.masterKey).update(`feedlantern-csrf:${sessionId}`).digest('base64url');
  }

  destroySession(id: string | undefined): void {
    if (id) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashToken(id));
  }

  /** Hand freed pages back to the OS in small steps (no-op unless the database uses incremental auto_vacuum). */
  compact(pages = 5000): void {
    if (Number((this.db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum) === 2) this.db.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`);
  }

  /** Expired sessions are otherwise only removed when their cookie is presented again. */
  purgeExpiredSessions(now = Date.now()): number {
    return Number(this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes);
  }

  destroyAllSessions(): void {
    this.db.prepare('DELETE FROM sessions').run();
  }

  createCredential(input: CredentialValue, metadata: { domains: string[]; count: number; expiresAt: string | null }, ownerId = 'admin'): CredentialSummary {
    const id = randomId('cred');
    const updatedAt = nowIso();
    this.db.prepare('INSERT INTO credentials(id, name, url, format, encrypted_value, domains_json, cookie_count, updated_at, expires_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      input.name,
      input.url,
      input.format,
      encrypt(this.masterKey, JSON.stringify(input.value)),
      JSON.stringify(metadata.domains),
      metadata.count,
      updatedAt,
      metadata.expiresAt,
      ownerId,
    );
    return { id, name: input.name, url: input.url, format: input.format, domains: metadata.domains, count: metadata.count, updatedAt, expiresAt: metadata.expiresAt };
  }

  updateCredential(id: string, input: CredentialValue, metadata: { domains: string[]; count: number; expiresAt: string | null }): CredentialSummary | null {
    const updatedAt = nowIso();
    const result = this.db.prepare('UPDATE credentials SET name = ?, url = ?, format = ?, encrypted_value = ?, domains_json = ?, cookie_count = ?, updated_at = ?, expires_at = ? WHERE id = ?').run(
      input.name,
      input.url,
      input.format,
      encrypt(this.masterKey, JSON.stringify(input.value)),
      JSON.stringify(metadata.domains),
      metadata.count,
      updatedAt,
      metadata.expiresAt,
      id,
    );
    return result.changes ? this.getCredentialSummary(id) : null;
  }

  getCredentialValue(id: string): CredentialValue | null {
    const row = this.db.prepare('SELECT id, name, url, format, encrypted_value FROM credentials WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    let value: unknown;
    try {
      value = JSON.parse(decrypt(this.masterKey, String(row.encrypted_value)));
    } catch {
      throw new Error('credential data is unreadable');
    }
    return { id: String(row.id), name: String(row.name), url: String(row.url), format: String(row.format) as 'header' | 'json', value };
  }

  getCredentialSummary(id: string): CredentialSummary | null {
    const row = this.db.prepare('SELECT id, name, url, format, domains_json, cookie_count, updated_at, expires_at FROM credentials WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      url: String(row.url),
      format: String(row.format) as 'header' | 'json',
      domains: parseJson<string[]>(row.domains_json, []),
      count: Number(row.cookie_count),
      updatedAt: String(row.updated_at),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
    };
  }

  listCredentialSummaries(ownerId?: string): CredentialSummary[] {
    const rows = this.db.prepare('SELECT id, name, url, format, domains_json, cookie_count, updated_at, expires_at FROM credentials WHERE (? IS NULL OR owner_id=?) ORDER BY updated_at DESC').all(ownerId ?? null, ownerId ?? null) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      url: String(row.url),
      format: String(row.format) as 'header' | 'json',
      domains: parseJson<string[]>(row.domains_json, []),
      count: Number(row.cookie_count),
      updatedAt: String(row.updated_at),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
    }));
  }

  isCredentialReferenced(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM feeds WHERE credential_id = ? LIMIT 1').get(id));
  }

  deleteCredential(id: string): boolean {
    const result = this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
    return Boolean(result.changes);
  }

  createFeed(input: FeedInput, ownerId = 'admin'): { feed: Feed; token: string } {
    if (input.credentialId && !this.owns('credentials', input.credentialId, ownerId)) throw new Error('Cookie 凭据不存在');
    const id = randomId('feed');
    const token = randomBytes(32).toString('base64url');
    const timestamp = nowIso();
    const nextFetchAt = new Date(Date.now() + input.intervalMinutes * 60_000).toISOString();
    this.db.prepare(`INSERT INTO feeds(
      id, name, url, rules_json, rule_origins_json, credential_id, interval_minutes, wait_ms,
      wait_for_selector, enabled, created_at, last_fetched_at, last_success_at, next_fetch_at,
      last_error, item_count, token_ciphertext, token_hash, channel_title, source_type, translation_mode, owner_id, target_language, translation_provider
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.name, input.url, JSON.stringify(input.rules), input.ruleOrigins ? JSON.stringify(input.ruleOrigins) : null, input.credentialId, input.intervalMinutes, input.waitMs, input.waitForSelector ?? null, timestamp, nextFetchAt, encrypt(this.masterKey, token), hashToken(token),
        input.name, input.sourceType ?? 'website', input.translationMode ?? (input.sourceType === 'rss' ? 'bilingual' : 'original'), ownerId, input.targetLanguage ?? 'zh-CN', input.translationProvider ?? null);
    return { feed: this.getFeed(id)!, token };
  }

  updateFeed(id: string, input: FeedInput): Feed | null {
    const existing = this.getFeed(id);
    if (!existing) return null;
    if (input.credentialId && !this.owns('credentials', input.credentialId, existing.ownerId!)) throw new Error('Cookie 凭据不存在');
    this.translations.invalidate(id);
    if ((existing.sourceType === 'rss' || input.sourceType === 'rss') && (existing.url !== input.url || existing.sourceType !== (input.sourceType ?? 'website'))) {
      this.db.prepare('DELETE FROM feed_items WHERE feed_id=?').run(id);
      this.translations.resetSource(id);
    }
    this.db.prepare('UPDATE feeds SET source_type=?,translation_mode=? WHERE id=?').run(input.sourceType ?? 'website', input.translationMode ?? existing.translationMode ?? 'bilingual', id);
    this.setTranslationTarget(existing, input);
    const origins = mergeRuleOrigins(existing.ruleOrigins, input.ruleOrigins);
    const nextFetchAt = new Date(Date.now() + input.intervalMinutes * 60_000).toISOString();
    this.db.prepare(`UPDATE feeds SET name = ?, channel_title = ?, url = ?, rules_json = ?, rule_origins_json = ?, credential_id = ?, interval_minutes = ?, wait_ms = ?, wait_for_selector = ?, next_fetch_at = ?, last_error = NULL WHERE id = ?`)
      .run(input.name, input.name, input.url, JSON.stringify(input.rules), origins ? JSON.stringify(origins) : null, input.credentialId, input.intervalMinutes, input.waitMs, input.waitForSelector ?? null, nextFetchAt, id);
    this.translations.syncWebsite(this.getFeed(id)!);
    this.ruleHealth.sync(this.getFeed(id)!);
    return this.getFeed(id);
  }

  /** Translations made by another service or into another language are redone, never reused. */
  private setTranslationTarget(feed: Feed, input: Pick<FeedSettingsInput, 'targetLanguage' | 'translationProvider'>): void {
    const target = input.targetLanguage ?? feed.targetLanguage ?? 'zh-CN';
    const provider = input.translationProvider === undefined ? feed.translationProvider ?? null : input.translationProvider;
    if (target === feed.targetLanguage && provider === (feed.translationProvider ?? null)) return;
    this.db.prepare('UPDATE feeds SET target_language=?,translation_provider=? WHERE id=?').run(target, provider, feed.id);
    const fallback = this.getSettings().translation.defaultProvider;
    if (target !== feed.targetLanguage || (provider ?? fallback) !== (feed.translationProvider ?? fallback)) this.translations.retranslate(feed.id);
  }

  setChannelTitle(id: string, title: string): Feed | null {
    return this.updateFeedSettings(id, { channelTitle: title });
  }

  updateFeedSettings(id: string, input: FeedSettingsInput): Feed | null {
    const feed = this.getFeed(id);
    if (!feed) return null;
    if (input.translationMode && input.translationMode !== feed.translationMode) this.translations.invalidate(id);
    if (input.translationMode) this.db.prepare('UPDATE feeds SET translation_mode=? WHERE id=?').run(input.translationMode, id);
    this.setTranslationTarget(feed, input);
    const title = input.channelTitle ?? feed.name;
    const interval = input.intervalMinutes ?? feed.intervalMinutes;
    const nextFetchAt = interval === feed.intervalMinutes
      ? feed.nextFetchAt : new Date(Date.now() + interval * 60_000).toISOString();
    this.db.prepare('UPDATE feeds SET name = ?, channel_title = ?, interval_minutes = ?, next_fetch_at = ? WHERE id = ?')
      .run(title, title, interval, nextFetchAt, id);
    // Output settings only change what is published. Lowering the limit keeps
    // stored items until the next fetch trims them (see storedItemLimit).
    if (input.itemFilter !== undefined) this.db.prepare('UPDATE feeds SET item_filter_json = ? WHERE id = ?').run(input.itemFilter ? JSON.stringify(input.itemFilter) : null, id);
    if (input.outputLimit !== undefined) this.db.prepare('UPDATE feeds SET output_limit = ? WHERE id = ?').run(clampOutputLimit(input.outputLimit), id);
    this.translations.syncWebsite(this.getFeed(id)!);
    return this.getFeed(id);
  }

  exportTables(): Tables {
    const tables: Record<string, unknown> = {};
    for (const table of ['users', 'user_notifications', 'credentials', 'feeds', 'feed_items', 'settings', 'rss_sources', 'translations', 'translation_cache', 'bundles', 'bundle_feeds']) {
      // The cache is pruned hourly, so it can briefly exceed the limit the backup format allows.
      const rows = table === 'translation_cache'
        ? this.db.prepare('SELECT * FROM translation_cache ORDER BY touched_at DESC LIMIT ?').all(TRANSLATION_CACHE_LIMIT)
        : this.db.prepare(`SELECT * FROM ${table}`).all();
      tables[table] = rows.map(row => {
        if (table === 'user_notifications') return { ...row, value: decrypt(this.masterKey, String(row.value)) };
        if (table === 'credentials') return { ...row, encrypted_value: decrypt(this.masterKey, String(row.encrypted_value)) };
        if (table === 'feeds' || table === 'bundles') return { ...row, token_ciphertext: decrypt(this.masterKey, String(row.token_ciphertext)) };
        if (table === 'settings' && row.key === 'application') return { ...row, value: decrypt(this.masterKey, String(row.value)) };
        return { ...row };
      });
    }
    return tables as Tables;
  }

  restoreTables(tables: Tables): void {
    const previousServer = this.getSettings().server;
    for (const controller of this.userControllers.values()) controller.abort();
    this.userControllers.clear();
    this.transaction(() => {
      // Like sessions, access tokens are not part of a backup; a restore revokes them all.
      for (const table of ['sessions', 'api_tokens', 'import_jobs', 'bundle_feeds', 'bundles', 'translations', 'rss_sources', 'translation_cache', 'feed_items', 'feeds', 'credentials', 'user_notifications', 'users', 'settings']) this.db.exec(`DELETE FROM ${table}`);
      for (const table of ['users', 'user_notifications', 'credentials', 'feeds', 'feed_items', 'settings', 'rss_sources', 'translations', 'translation_cache', 'bundles', 'bundle_feeds'] as const) {
        for (const value of tables[table] ?? []) {
          const row: Record<string, string | number | null> = { ...value };
          if (table === 'user_notifications') row.value = encrypt(this.masterKey, String(row.value));
          if (table === 'credentials') row.encrypted_value = encrypt(this.masterKey, String(row.encrypted_value));
          if (table === 'settings' && row.key === 'application') row.value = encrypt(this.masterKey, JSON.stringify(applicationSettingsSchema.parse(JSON.parse(String(row.value)))));
          if (table === 'bundles') { row.token_hash = hashToken(String(row.token_ciphertext)); row.token_ciphertext = encrypt(this.masterKey, String(row.token_ciphertext)); }
          if (table === 'feeds') { row.name = String(row.channel_title ?? '').trim() || row.name; row.channel_title = row.name; row.token_hash = hashToken(String(row.token_ciphertext)); row.token_ciphertext = encrypt(this.masterKey, String(row.token_ciphertext)); }
          const keys = Object.keys(row);
          this.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k]));
        }
      }
      // Old backups restore safe defaults, and never reactivate a legacy env URL.
      this.initializeSettings({ ...structuredClone(defaultApplicationSettings), server: previousServer });
      this.migrateBark();
    });
    this.ensureSetupToken();
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('SAVEPOINT operation');
    try { const result = operation(); this.db.exec('RELEASE operation'); return result; }
    catch (error) { this.db.exec('ROLLBACK TO operation; RELEASE operation'); throw error; }
  }

  listImportJobs(ownerId?: string): ImportJob[] {
    return (this.db.prepare('SELECT body,owner_id FROM import_jobs WHERE (? IS NULL OR owner_id=?) ORDER BY rowid DESC').all(ownerId ?? null, ownerId ?? null) as { body: string; owner_id: string }[]).map(row => ({ ...JSON.parse(row.body), ownerId: row.owner_id }));
  }

  saveImportJob(job: ImportJob): void {
    this.db.prepare('INSERT INTO import_jobs(id,body,owner_id) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(job.id, JSON.stringify(job), job.ownerId ?? 'admin');
  }

  private migrateBark(): void {
    if (!this.getUser('admin') && this.listUsers().length) return;
    if (this.db.prepare("SELECT 1 FROM user_notifications WHERE user_id='admin'").get()) return;
    const saved = this.db.prepare("SELECT value FROM settings WHERE key='application'").get();
    if (!saved) return;
    const value = applicationSettingsSchema.parse(JSON.parse(decrypt(this.masterKey, String(saved.value))));
    this.writeBark('admin', value.bark);
    value.bark = structuredClone(defaultApplicationSettings.bark);
    this.db.prepare("UPDATE settings SET value=? WHERE key='application'").run(encrypt(this.masterKey, JSON.stringify(value)));
  }

  /** One account's Bark settings, shared alert policy and other channels (stored encrypted together). */
  getNotifications(userId: string): { bark: ApplicationSettings['bark']; channels: NotificationChannelSettings } {
    const row = this.db.prepare('SELECT value FROM user_notifications WHERE user_id=?').get(userId);
    if (!row) return { bark: structuredClone(defaultApplicationSettings.bark), channels: structuredClone(defaultNotificationChannels) };
    const { channels, ...bark } = storedNotificationSchema.parse(JSON.parse(decrypt(this.masterKey, String(row.value))));
    return { bark, channels: notificationChannelsSchema.parse(channels ?? {}) };
  }
  getBark(userId: string): ApplicationSettings['bark'] { return this.getNotifications(userId).bark; }
  private feedOwner(id: string): string | undefined {
    const row = this.db.prepare('SELECT owner_id FROM feeds WHERE id=?').get(id);
    return row ? String(row.owner_id) : undefined;
  }
  getBarkForFeed(id: string): ApplicationSettings['bark'] {
    const owner = this.feedOwner(id);
    return owner ? this.getBark(owner) : structuredClone(defaultApplicationSettings.bark);
  }
  /** Alert policy and enabled, complete channels of a feed's owner. */
  notificationTarget(feedId: string): NotificationTarget {
    const owner = this.feedOwner(feedId);
    const { bark, channels } = owner ? this.getNotifications(owner) : { bark: structuredClone(defaultApplicationSettings.bark), channels: structuredClone(defaultNotificationChannels) };
    const { enabled: _enabled, url: _url, ...policy } = bark;
    return { policy, configs: activeChannels(bark, channels) };
  }
  private writeNotifications(userId: string, bark: ApplicationSettings['bark'], channels: NotificationChannelSettings): void {
    const value = storedNotificationSchema.parse({ ...bark, channels });
    this.db.prepare('INSERT INTO user_notifications(user_id,value) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value').run(userId, encrypt(this.masterKey, JSON.stringify(value)));
  }
  private writeBark(userId: string, value: ApplicationSettings['bark']): void {
    this.writeNotifications(userId, value, this.getNotifications(userId).channels);
  }
  /**
   * Saves validated notification settings. Changing where alerts go (enabling,
   * disabling or re-targeting any channel) cancels this account's pending alerts,
   * as changing the Bark address always did; other accounts are unaffected.
   */
  setNotifications(userId: string, next: { bark: ApplicationSettings['bark']; channels: NotificationChannelSettings }): void {
    const previous = this.getNotifications(userId);
    const destinations = (value: typeof next) => JSON.stringify(activeChannels(value.bark, value.channels));
    this.transaction(() => {
      this.writeNotifications(userId, next.bark, next.channels);
      if (destinations(previous) !== destinations(next)) this.history.resetNotifications(userId);
      // Turning rule-health alerts off drops the ones not sent yet; failure alerts are unaffected.
      if (previous.bark.ruleHealthAlerts !== false && next.bark.ruleHealthAlerts === false) {
        this.db.prepare("UPDATE fetch_alerts SET status='canceled' WHERE status='pending' AND kind='health' AND feed_id IN (SELECT id FROM feeds WHERE owner_id=?)").run(userId);
      }
    });
  }
  setNotificationChannels(userId: string, channels: NotificationChannelSettings): void {
    this.setNotifications(userId, { bark: this.getBark(userId), channels });
  }
  setBark(userId: string, patch: Partial<ApplicationSettings['bark']>): ApplicationSettings['bark'] {
    const previous = this.getNotifications(userId);
    const value = applicationSettingsSchema.shape.bark.parse({ ...previous.bark, ...patch, ...(patch.url === '' ? { enabled: false } : {}) });
    this.setNotifications(userId, { bark: value, channels: previous.channels });
    return value;
  }

  getSettings(): ApplicationSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'feedView'").get();
    const saved = this.db.prepare("SELECT value FROM settings WHERE key = 'application'").get();
    const settings = saved ? applicationSettingsSchema.parse(JSON.parse(decrypt(this.masterKey, String(saved.value)))) : structuredClone(defaultApplicationSettings);
    return { ...settings, bark: this.getBark('admin'), feedView: row?.value === 'cards' ? 'cards' : 'list' };
  }

  initializeSettings(initial?: ApplicationSettings): void {
    if (this.db.prepare("SELECT key FROM settings WHERE key='application'").get()) return;
    const settings = initial ? { ...initial, feedView: this.getSettings().feedView } : this.getSettings();
    if (this.db.prepare("SELECT 1 FROM user_notifications WHERE user_id='admin'").get()) settings.bark = this.getBark('admin');
    this.setSettings(settings);
  }

  setSettings(value: ApplicationSettings): void {
    const settings = applicationSettingsSchema.parse(value);
    const personalBark = settings.bark;
    settings.bark = structuredClone(defaultApplicationSettings.bark);
    this.transaction(() => {
      if (this.getUser('admin') || !this.listUsers().length) this.setBark('admin', personalBark);
      this.setFeedView(settings.feedView);
      this.db.prepare("INSERT INTO settings(key,value) VALUES ('application',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(encrypt(this.masterKey, JSON.stringify(settings)));
    });
  }

  setFeedView(view: 'list' | 'cards'): void {
    this.db.prepare("INSERT INTO settings(key,value) VALUES ('feedView',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(view);
  }

  getFeed(id: string): Feed | null {
    const row = this.db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM feed_items i WHERE i.feed_id = f.id) AS item_count FROM feeds f WHERE f.id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const feed = rowToFeed(row);
    if (translationEnabled(feed)) feed.translation = this.translations.stats(feed.id);
    const ruleHealth = this.ruleHealth.warning(feed.id);
    if (ruleHealth) feed.ruleHealth = ruleHealth;
    return feed;
  }

  listFeeds(ownerId?: string): Feed[] {
    const rows = this.db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM feed_items i WHERE i.feed_id = f.id) AS item_count FROM feeds f WHERE (? IS NULL OR f.owner_id=?) ORDER BY f.created_at DESC`).all(ownerId ?? null, ownerId ?? null) as Array<Record<string, unknown>>;
    return rows.map(row => {
      const feed = rowToFeed(row);
      if (translationEnabled(feed)) feed.translation = this.translations.stats(feed.id);
      const ruleHealth = this.ruleHealth.warning(feed.id);
      if (ruleHealth) feed.ruleHealth = ruleHealth;
      return feed;
    });
  }

  deleteFeed(id: string): boolean {
    const result = this.db.prepare('DELETE FROM feeds WHERE id = ?').run(id);
    return Boolean(result.changes);
  }

  toggleFeed(id: string): Feed | null {
    const current = this.getFeed(id);
    if (!current) return null;
    this.translations.invalidate(id);
    const enabled = !current.enabled;
    this.db.prepare('UPDATE feeds SET enabled = ?, next_fetch_at = ? WHERE id = ?').run(enabled ? 1 : 0, enabled ? nowIso() : current.nextFetchAt, id);
    return this.getFeed(id);
  }

  getFeedToken(id: string): StoredFeedToken | null {
    const row = this.db.prepare('SELECT token_ciphertext, token_hash FROM feeds WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { token: decrypt(this.masterKey, String(row.token_ciphertext)), tokenHash: String(row.token_hash) };
  }

  rotateFeedToken(id: string): { feed: Feed; token: string } | null {
    const feed = this.getFeed(id);
    if (!feed) return null;
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('UPDATE feeds SET token_ciphertext = ?, token_hash = ? WHERE id = ?').run(encrypt(this.masterKey, token), hashToken(token), id);
    return { feed: this.getFeed(id)!, token };
  }

  checkFeedToken(id: string, token: string): boolean {
    if (!this.isFeedActive(id)) return false;
    const row = this.db.prepare('SELECT token_hash FROM feeds WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return false;
    const expected = Buffer.from(String(row.token_hash));
    const actual = Buffer.from(hashToken(token));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** Newest first. Without a limit, every item the feed currently stores. */
  getItems(id: string, limit?: number): FeedItem[] {
    if (limit === undefined) limit = Math.max(this.countItems(id), 1);
    const rows = this.db.prepare('SELECT id, title, link, description, image, published_at, published_at_source, first_seen_at FROM feed_items WHERE feed_id = ? ORDER BY first_seen_at DESC, rowid ASC LIMIT ?').all(id, limit) as Array<Record<string, unknown>>;
    const items = rows.map(rowToItem);
    const feed = this.getFeed(id);
    return feed && translationEnabled(feed) ? this.translations.decorate(feed, items) : items;
  }

  private countItems(id: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS c FROM feed_items WHERE feed_id = ?').get(id) as { c: number }).c);
  }

  upsertItems(feed: Feed, extracted: ExtractedItem[], counts?: { itemCount: number; newItemCount: number }): FeedItem[] {
    const unique = new Map<string, ExtractedItem>();
    for (const item of extracted) {
      const link = normalizeLink(item.link, feed.url);
      if (!link || !item.title.trim()) continue;
      const key = hashToken(link);
      if (!unique.has(key)) unique.set(key, { ...item, link });
    }
    this.db.exec('SAVEPOINT items');
    let inserted = 0;
    try {
      const firstSeenAt = nowIso();
      const findItem = this.db.prepare('SELECT id, published_at, published_at_source FROM feed_items WHERE feed_id = ? AND normalized_key = ?');
      const updateItem = this.db.prepare('UPDATE feed_items SET title = ?, link = ?, description = ?, image = ?, published_at = ?, published_at_source = ? WHERE id = ?');
      const insertItem = this.db.prepare('INSERT INTO feed_items(id, feed_id, normalized_key, title, link, description, image, published_at, published_at_source, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const [key, item] of unique) {
        const existing = findItem.get(feed.id, key) as Record<string, unknown> | undefined;
        const useIncomingDate = Boolean(item.publishedAt) && (!existing?.published_at || item.publishedAtSource !== 'relative');
        const publishedAt = useIncomingDate ? item.publishedAt! : (existing?.published_at as string | null | undefined) ?? null;
        const publishedAtSource = publishedAt ? (useIncomingDate ? item.publishedAtSource ?? 'absolute' : existing?.published_at_source ?? 'absolute') : null;
        if (existing) {
          updateItem.run(item.title.trim(), item.link, item.description ?? null, item.image ?? null, publishedAt, publishedAtSource as string | null, String(existing.id));
        } else {
          insertItem.run(randomId('item'), feed.id, key, item.title.trim(), item.link, item.description ?? null, item.image ?? null, publishedAt, publishedAtSource as string | null, firstSeenAt);
          inserted++;
        }
      }
      const keep = storedItemLimit(this.getFeed(feed.id) ?? feed);
      this.db.prepare(`DELETE FROM feed_items WHERE feed_id = ? AND id NOT IN (SELECT id FROM feed_items WHERE feed_id = ? ORDER BY first_seen_at DESC, rowid ASC LIMIT ?)`).run(feed.id, feed.id, keep);
      this.translations.syncWebsite(this.getFeed(feed.id)!);
      this.db.exec('RELEASE items');
    } catch (error) {
      try { this.db.exec('ROLLBACK TO items; RELEASE items'); } catch { /* best effort */ }
      throw error;
    }
    if (counts) { counts.itemCount = unique.size; counts.newItemCount = inserted; }
    return this.getItems(feed.id);
  }

  markFetchStart(id: string, nextFetchAt: string): void {
    this.db.prepare('UPDATE feeds SET last_fetched_at = ?, next_fetch_at = ? WHERE id = ?').run(nowIso(), nextFetchAt, id);
  }

  markFetchSuccess(id: string, nextFetchAt: string): Feed | null {
    this.db.prepare('UPDATE feeds SET last_success_at = ?, next_fetch_at = ?, last_error = NULL, item_count = (SELECT COUNT(*) FROM feed_items WHERE feed_id = ?) WHERE id = ?').run(nowIso(), nextFetchAt, id, id);
    return this.getFeed(id);
  }

  markFetchFailure(id: string, message: string, nextFetchAt: string): Feed | null {
    this.db.prepare('UPDATE feeds SET next_fetch_at = ?, last_error = ?, item_count = (SELECT COUNT(*) FROM feed_items WHERE feed_id = ?) WHERE id = ?').run(nextFetchAt, message.slice(0, 500), id, id);
    return this.getFeed(id);
  }

  dueFeeds(now = new Date()): Feed[] {
    const rows = this.db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM feed_items i WHERE i.feed_id = f.id) AS item_count FROM feeds f WHERE f.enabled = 1 AND f.next_fetch_at <= ? ORDER BY f.next_fetch_at ASC`).all(now.toISOString()) as Array<Record<string, unknown>>;
    return rows.filter(row => this.isUserActive(String(row.owner_id))).map(row => {
      const feed = rowToFeed(row);
      if (translationEnabled(feed)) feed.translation = this.translations.stats(feed.id);
      return feed;
    });
  }
}

export { decrypt, encrypt, hashToken, hashPassword, normalizeLink };
