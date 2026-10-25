import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ApiTokenScope, ApiTokenSummary, UserSummary } from '../shared/types.js';

/** Personal access tokens look like `fl_` followed by 43 base64url characters. */
export const API_TOKEN_PREFIX = 'fl_';
const TOKEN_PATTERN = /^fl_[A-Za-z0-9_-]{43}$/;
/** Characters of the secret kept in clear so people can tell tokens apart. */
const DISPLAY_LENGTH = API_TOKEN_PREFIX.length + 8;
export const API_TOKEN_LIMIT_PER_USER = 50;
export const API_TOKEN_MAX_DAYS = 3650;
const TOUCH_INTERVAL_MS = 60_000;
/** Expired tokens stay listed for a while so their owner can see what stopped working. */
const EXPIRED_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * Routes a token can never call, in `METHOD /path` form (Fastify path syntax).
 * They stay usable from a signed-in browser session only: signing in and out,
 * passwords, backups, account management, and the tokens themselves.
 */
export const SESSION_ONLY_ROUTES: readonly string[] = [
  'POST /api/auth/setup',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/password',
  'PUT /api/auth/locale',
  'POST /api/backups/export',
  'POST /api/backups/preview',
  'POST /api/backups/restore',
  'GET /api/backups/config',
  'POST /api/backups/config',
  'POST /api/users',
  'PATCH /api/users/:id',
  'POST /api/users/:id/password',
  'DELETE /api/users/:id',
  'GET /api/tokens',
  'POST /api/tokens',
  'DELETE /api/tokens/:id',
  'GET /api/tokens/:id/logs',
];
const sessionOnly = new Set(SESSION_ONLY_ROUTES);

export function tokenAllowedRoute(method: string, route: string): boolean {
  return !sessionOnly.has(`${method === 'HEAD' ? 'GET' : method} ${route}`);
}

export const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ApiTokenOwner {
  tokenId: string;
  name: string;
  prefix: string;
  userId: string;
  username: string;
  role: UserSummary['role'];
  scope: ApiTokenScope;
  expiresAt: string | null;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function summary(row: Record<string, unknown>): ApiTokenSummary {
  return {
    id: String(row.id),
    name: String(row.name),
    scope: row.scope === 'write' ? 'write' : 'read',
    prefix: String(row.prefix),
    createdAt: String(row.created_at),
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
  };
}

/**
 * Stores only a SHA-256 digest of each token. Tokens carry 256 random bits, so
 * a fast digest is enough; the plain value is returned once, on creation.
 */
export class ApiTokens {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(userId: string, input: { name: string; scope: ApiTokenScope; expiresAt: string | null }): { token: ApiTokenSummary; secret: string } {
    const secret = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = `tok_${randomBytes(12).toString('hex')}`;
    this.db.prepare('INSERT INTO api_tokens(id,user_id,name,token_hash,prefix,scope,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, userId, input.name, digest(secret), secret.slice(0, DISPLAY_LENGTH), input.scope, new Date().toISOString(), input.expiresAt);
    return { token: summary(this.db.prepare('SELECT * FROM api_tokens WHERE id=?').get(id)!), secret };
  }

  count(userId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS c FROM api_tokens WHERE user_id=?').get(userId) as { c: number }).c);
  }

  list(userId: string): ApiTokenSummary[] {
    return this.db.prepare('SELECT * FROM api_tokens WHERE user_id=? ORDER BY created_at DESC, id').all(userId).map(summary);
  }

  revoke(userId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM api_tokens WHERE id=? AND user_id=?').run(id, userId).changes) > 0;
  }

  revokeUser(userId: string): void {
    this.db.prepare('DELETE FROM api_tokens WHERE user_id=?').run(userId);
  }

  /** Resolves a presented token to its enabled owner, or null when it is unknown, expired or the owner is disabled. */
  find(secret: string | undefined, now = Date.now()): ApiTokenOwner | null {
    if (!secret || !TOKEN_PATTERN.test(secret)) return null;
    const hash = digest(secret);
    const row = this.db.prepare('SELECT t.*,u.username,u.role FROM api_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND u.enabled=1').get(hash) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (row.expires_at && Date.parse(String(row.expires_at)) <= now) return null;
    // A request checks its token several times; record use at most once a minute.
    const lastUsed = row.last_used_at ? Date.parse(String(row.last_used_at)) : 0;
    if (now - lastUsed >= TOUCH_INTERVAL_MS) this.db.prepare('UPDATE api_tokens SET last_used_at=? WHERE token_hash=?').run(new Date(now).toISOString(), hash);
    return {
      tokenId: String(row.id), name: String(row.name), prefix: String(row.prefix), userId: String(row.user_id), username: String(row.username), role: row.role as UserSummary['role'],
      scope: row.scope === 'write' ? 'write' : 'read', expiresAt: row.expires_at ? String(row.expires_at) : null,
    };
  }

  /**
   * The token a secret belongs to, even when it has expired, so a rejected call
   * can still be shown in that token's call log. Never use this to authenticate.
   */
  identify(secret: string | undefined): { tokenId: string; userId: string; name: string; prefix: string } | null {
    if (!secret || !TOKEN_PATTERN.test(secret)) return null;
    const row = this.db.prepare('SELECT id,user_id,name,prefix FROM api_tokens WHERE token_hash=?').get(digest(secret));
    return row ? { tokenId: String(row.id), userId: String(row.user_id), name: String(row.name), prefix: String(row.prefix) } : null;
  }

  exists(userId: string, id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM api_tokens WHERE id=? AND user_id=?').get(id, userId);
  }

  purgeExpired(now = Date.now()): number {
    return Number(this.db.prepare('DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?').run(new Date(now - EXPIRED_RETENTION_MS).toISOString()).changes);
  }
}
