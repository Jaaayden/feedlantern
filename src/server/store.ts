import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CredentialSummary, ExtractedItem, Feed, FeedInput, FeedItem, RuleOrigins, SelectionRules } from '../shared/types.js';
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

function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
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

function rowToFeed(row: Record<string, unknown>): Feed {
  return {
    id: String(row.id),
    name: String(row.name),
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
    firstSeenAt: String(row.first_seen_at),
  };
}

export class Store {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly masterKeyPath: string;
  readonly setupTokenPath: string;
  private readonly db: DatabaseSync;
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
    chmodSync(this.dbPath, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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
    this.db.close();
  }

  hasAdmin(): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS present FROM admin WHERE id = 1').get());
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
    this.db.prepare('INSERT INTO admin(id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)').run(username, hashPassword(password), timestamp, timestamp);
  }

  getAdmin(): { username: string; passwordHash: string } | null {
    const row = this.db.prepare('SELECT username, password_hash FROM admin WHERE id = 1').get() as Record<string, unknown> | undefined;
    return row ? { username: String(row.username), passwordHash: String(row.password_hash) } : null;
  }

  authenticate(username: string, password: string): boolean {
    const admin = this.getAdmin();
    return Boolean(admin && safeEqualText(username, admin.username) && verifyPassword(password, admin.passwordHash));
  }

  changePassword(password: string): void {
    this.db.prepare('UPDATE admin SET password_hash = ?, updated_at = ? WHERE id = 1').run(hashPassword(password), nowIso());
    this.destroyAllSessions();
  }

  createSession(username: string, ttlMs: number): StoredSession {
    const id = randomBytes(32).toString('base64url');
    const csrfToken = this.deriveCsrfToken(id);
    const createdAt = Date.now();
    const expiresAt = createdAt + ttlMs;
    this.db.prepare('INSERT INTO sessions(id_hash, csrf_hash, username, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)').run(hashToken(id), hashToken(csrfToken), username, createdAt, expiresAt, createdAt);
    return { id, csrfToken, username, expiresAt };
  }

  findSession(id: string | undefined, ttlMs: number): StoredSession | null {
    if (!id) return null;
    const idHash = hashToken(id);
    const row = this.db.prepare('SELECT id_hash, csrf_hash, username, expires_at FROM sessions WHERE id_hash = ?').get(idHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    const expiresAt = Number(row.expires_at);
    if (expiresAt <= Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
      return null;
    }
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(Date.now(), idHash);
    // The raw CSRF token is deliberately not retained. The app checks a
    // supplied token against the stored digest using checkCsrf().
    return { id, csrfToken: '', username: String(row.username), expiresAt };
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

  destroyAllSessions(): void {
    this.db.prepare('DELETE FROM sessions').run();
  }

  createCredential(input: CredentialValue, metadata: { domains: string[]; count: number; expiresAt: string | null }): CredentialSummary {
    const id = randomId('cred');
    const updatedAt = nowIso();
    this.db.prepare('INSERT INTO credentials(id, name, url, format, encrypted_value, domains_json, cookie_count, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      input.name,
      input.url,
      input.format,
      encrypt(this.masterKey, JSON.stringify(input.value)),
      JSON.stringify(metadata.domains),
      metadata.count,
      updatedAt,
      metadata.expiresAt,
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

  listCredentialSummaries(): CredentialSummary[] {
    const rows = this.db.prepare('SELECT id, name, url, format, domains_json, cookie_count, updated_at, expires_at FROM credentials ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>;
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

  createFeed(input: FeedInput): { feed: Feed; token: string } {
    const id = randomId('feed');
    const token = randomBytes(32).toString('base64url');
    const timestamp = nowIso();
    const nextFetchAt = new Date(Date.now() + input.intervalMinutes * 60_000).toISOString();
    this.db.prepare(`INSERT INTO feeds(
      id, name, url, rules_json, rule_origins_json, credential_id, interval_minutes, wait_ms,
      wait_for_selector, enabled, created_at, last_fetched_at, last_success_at, next_fetch_at,
      last_error, item_count, token_ciphertext, token_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, NULL, 0, ?, ?)`)
      .run(id, input.name, input.url, JSON.stringify(input.rules), input.ruleOrigins ? JSON.stringify(input.ruleOrigins) : null, input.credentialId, input.intervalMinutes, input.waitMs, input.waitForSelector ?? null, timestamp, nextFetchAt, encrypt(this.masterKey, token), hashToken(token));
    return { feed: this.getFeed(id)!, token };
  }

  updateFeed(id: string, input: FeedInput): Feed | null {
    const existing = this.getFeed(id);
    if (!existing) return null;
    const origins = mergeRuleOrigins(existing.ruleOrigins, input.ruleOrigins);
    const nextFetchAt = new Date(Date.now() + input.intervalMinutes * 60_000).toISOString();
    this.db.prepare(`UPDATE feeds SET name = ?, url = ?, rules_json = ?, rule_origins_json = ?, credential_id = ?, interval_minutes = ?, wait_ms = ?, wait_for_selector = ?, next_fetch_at = ?, last_error = NULL WHERE id = ?`)
      .run(input.name, input.url, JSON.stringify(input.rules), origins ? JSON.stringify(origins) : null, input.credentialId, input.intervalMinutes, input.waitMs, input.waitForSelector ?? null, nextFetchAt, id);
    return this.getFeed(id);
  }

  getFeed(id: string): Feed | null {
    const row = this.db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM feed_items i WHERE i.feed_id = f.id) AS item_count FROM feeds f WHERE f.id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToFeed(row) : null;
  }

  listFeeds(): Feed[] {
    const rows = this.db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM feed_items i WHERE i.feed_id = f.id) AS item_count FROM feeds f ORDER BY f.created_at DESC`).all() as Array<Record<string, unknown>>;
    return rows.map(rowToFeed);
  }

  deleteFeed(id: string): boolean {
    const result = this.db.prepare('DELETE FROM feeds WHERE id = ?').run(id);
    return Boolean(result.changes);
  }

  toggleFeed(id: string): Feed | null {
    const current = this.getFeed(id);
    if (!current) return null;
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
    const row = this.db.prepare('SELECT token_hash FROM feeds WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return false;
    const expected = Buffer.from(String(row.token_hash));
    const actual = Buffer.from(hashToken(token));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  getItems(id: string, limit = 200): FeedItem[] {
    const rows = this.db.prepare('SELECT id, title, link, description, image, published_at, first_seen_at FROM feed_items WHERE feed_id = ? ORDER BY first_seen_at DESC, rowid ASC LIMIT ?').all(id, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToItem);
  }

  upsertItems(feed: Feed, extracted: ExtractedItem[]): FeedItem[] {
    const unique = new Map<string, ExtractedItem>();
    for (const item of extracted) {
      const link = normalizeLink(item.link, feed.url);
      if (!link || !item.title.trim()) continue;
      const key = hashToken(link);
      if (!unique.has(key)) unique.set(key, { ...item, link });
    }
    this.db.exec('BEGIN');
    try {
      const firstSeenAt = nowIso();
      for (const [key, item] of unique) {
        const existing = this.db.prepare('SELECT id FROM feed_items WHERE feed_id = ? AND normalized_key = ?').get(feed.id, key) as Record<string, unknown> | undefined;
        if (existing) {
          this.db.prepare('UPDATE feed_items SET title = ?, link = ?, description = ?, image = ?, published_at = ? WHERE id = ?').run(item.title.trim(), item.link, item.description ?? null, item.image ?? null, item.publishedAt ?? null, String(existing.id));
        } else {
          this.db.prepare('INSERT INTO feed_items(id, feed_id, normalized_key, title, link, description, image, published_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomId('item'), feed.id, key, item.title.trim(), item.link, item.description ?? null, item.image ?? null, item.publishedAt ?? null, firstSeenAt);
        }
      }
      this.db.prepare(`DELETE FROM feed_items WHERE feed_id = ? AND id NOT IN (SELECT id FROM feed_items WHERE feed_id = ? ORDER BY first_seen_at DESC, rowid ASC LIMIT 200)`).run(feed.id, feed.id);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw error;
    }
    return this.getItems(feed.id, 200);
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
    return rows.map(rowToFeed);
  }
}

export { decrypt, encrypt, hashToken, hashPassword, normalizeLink };
