import type { DatabaseSync } from 'node:sqlite';
import type { ApiTokenCall, ApiTokenCallFilter, ApiTokenCallPage } from '../shared/types.js';

/** At most this many calls are kept in total, and per token, on top of the log retention days. */
export const API_TOKEN_LOG_LIMIT = 20_000;
export const API_TOKEN_LOG_PER_TOKEN = 2_000;
/** Calls are written in batches: after this delay, or as soon as this many are waiting. */
const FLUSH_DELAY_MS = 1_000;
const FLUSH_BATCH = 200;
/** If the database is unavailable, drop the oldest waiting calls rather than grow without bound. */
const BUFFER_LIMIT = 5_000;
const DENIED = '(401,403,429)';

export const API_TOKEN_LOG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS api_token_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    token_name TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    at TEXT NOT NULL,
    method TEXT NOT NULL,
    route TEXT,
    status INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    ip TEXT
  );
  CREATE INDEX IF NOT EXISTS api_token_logs_token ON api_token_logs(token_id, id DESC);
  CREATE INDEX IF NOT EXISTS api_token_logs_user ON api_token_logs(user_id, at);
  CREATE INDEX IF NOT EXISTS api_token_logs_retention ON api_token_logs(at);
`;

/** Who made a call: the token and its owner, never the secret. */
export interface TokenIdentity { tokenId: string; userId: string; name: string; prefix: string }
export type TokenCallRecord = TokenIdentity & Omit<ApiTokenCall, 'id' | 'tokenId' | 'tokenName' | 'tokenPrefix'>;

const filters: Record<ApiTokenCallFilter, string> = {
  success: 'status < 400',
  denied: `status IN ${DENIED}`,
  error: `status >= 400 AND status NOT IN ${DENIED}`,
};

/**
 * Call log of personal access tokens. Requests only append to an in-memory
 * buffer; a timer writes the buffer in one transaction, so logging adds no
 * database write to the request itself. Reads flush first, so they are current.
 */
export class ApiTokenLog {
  private buffer: TokenCallRecord[] = [];
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly db: DatabaseSync, private readonly retentionDays: () => number) {}

  record(call: TokenCallRecord): void {
    if (this.closed) return;
    if (this.buffer.length >= BUFFER_LIMIT) this.buffer.shift();
    this.buffer.push(call);
    if (this.buffer.length >= FLUSH_BATCH) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, FLUSH_DELAY_MS);
      this.timer.unref();
    }
  }

  /** Writes waiting calls. Calls of a token revoked in the meantime are skipped. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.buffer.length || !this.db.isOpen) return;
    const calls = this.buffer;
    this.buffer = [];
    const insert = this.db.prepare(`INSERT INTO api_token_logs(token_id,user_id,token_name,token_prefix,at,method,route,status,duration_ms,ip)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM api_tokens WHERE id=?)`);
    const trimToken = this.db.prepare(`DELETE FROM api_token_logs WHERE token_id=? AND id <= (SELECT id FROM api_token_logs WHERE token_id=? ORDER BY id DESC LIMIT 1 OFFSET ${API_TOKEN_LOG_PER_TOKEN})`);
    try {
      this.db.exec('SAVEPOINT token_log');
      try {
        for (const call of calls) {
          insert.run(call.tokenId, call.userId, call.name.slice(0, 100), call.prefix.slice(0, 20), call.at, call.method.slice(0, 10), call.route?.slice(0, 200) ?? null,
            call.status, Math.max(0, Math.round(call.durationMs)), call.ip?.slice(0, 64) ?? null, call.tokenId);
        }
        for (const id of new Set(calls.map(call => call.tokenId))) trimToken.run(id, id);
        this.db.exec(`DELETE FROM api_token_logs WHERE id <= (SELECT id FROM api_token_logs ORDER BY id DESC LIMIT 1 OFFSET ${API_TOKEN_LOG_LIMIT})`);
        this.db.exec('RELEASE token_log');
      } catch (error) { this.db.exec('ROLLBACK TO token_log; RELEASE token_log'); throw error; }
    } catch {
      // Logging must never break an API call; the calls of this batch are lost.
      console.error(`访问令牌调用日志写入失败，已丢弃 ${calls.length} 条记录`);
    }
  }

  list(userId: string, tokenId: string, filter?: ApiTokenCallFilter, cursor?: number, limit = 20): ApiTokenCallPage {
    this.flush();
    const rows = this.db.prepare(`SELECT * FROM api_token_logs WHERE user_id=? AND token_id=? ${filter ? `AND ${filters[filter]}` : ''} ${cursor ? 'AND id<?' : ''}
      ORDER BY id DESC LIMIT ?`).all(userId, tokenId, ...(cursor ? [cursor] : []), limit + 1);
    const calls: ApiTokenCall[] = rows.slice(0, limit).map(row => ({
      id: Number(row.id), tokenId: String(row.token_id), tokenName: String(row.token_name), tokenPrefix: String(row.token_prefix),
      at: String(row.at), method: String(row.method), route: row.route === null ? null : String(row.route),
      status: Number(row.status), durationMs: Number(row.duration_ms), ip: row.ip === null ? null : String(row.ip),
    }));
    return { calls, nextCursor: rows.length > limit ? String(calls.at(-1)!.id) : null, retentionDays: this.retentionDays(), perTokenLimit: API_TOKEN_LOG_PER_TOKEN };
  }

  /** Calls and failures (status >= 400) of each of a user's tokens since `since`. */
  usage(userId: string, since: number): Map<string, { calls: number; failures: number }> {
    this.flush();
    const rows = this.db.prepare('SELECT token_id, COUNT(*) AS calls, SUM(status >= 400) AS failures FROM api_token_logs WHERE user_id=? AND at>=? GROUP BY token_id')
      .all(userId, new Date(since).toISOString());
    return new Map(rows.map(row => [String(row.token_id), { calls: Number(row.calls), failures: Number(row.failures ?? 0) }]));
  }

  /** Drops calls older than the log retention days (the same setting as fetch logs). */
  prune(now = Date.now()): number {
    this.flush();
    return Number(this.db.prepare('DELETE FROM api_token_logs WHERE at < ?').run(new Date(now - this.retentionDays() * 86_400_000).toISOString()).changes);
  }

  close(): void {
    this.flush();
    this.closed = true;
  }
}
