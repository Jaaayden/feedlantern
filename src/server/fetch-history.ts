import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { defaultApplicationSettings, fetchSourceLabels, type ApplicationSettings, type AlertStatus, type Feed, type FetchLog, type FetchLogPage, type FetchSource, type FetchStatus } from '../shared/types.js';

/** Stored errors and push content must never contain browser call logs or secrets. */
export function safeDiagnostic(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"')]+/gi, '[目标页面]')
    .replace(/(?:cookie|authorization|set-cookie|token|password|device_key|bark_url)\s*["']?\s*[:=][^\n]*/gi, '[敏感信息已隐藏]')
    .replace(/Bearer\s+\S+/gi, '[敏感信息已隐藏]').split(/\r?\n/)[0].slice(0, 300);
}

export interface PendingAlert { id: string; body: string; attempts: number }

export class FetchHistory {
  constructor(private db: DatabaseSync, private settings: () => ApplicationSettings = () => defaultApplicationSettings) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fetch_alerts (
        id TEXT PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','canceled')),
        body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, last_attempt_at INTEGER, error TEXT
      );
      CREATE TABLE IF NOT EXISTS fetch_incidents (
        feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
        alert_id TEXT REFERENCES fetch_alerts(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS fetch_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        source TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','success','failure','interrupted')),
        started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER,
        item_count INTEGER, new_item_count INTEGER, error TEXT,
        alert_id TEXT REFERENCES fetch_alerts(id) ON DELETE SET NULL, notification_disabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS fetch_logs_feed_id ON fetch_logs(feed_id, id DESC);
      CREATE INDEX IF NOT EXISTS fetch_logs_feed_status ON fetch_logs(feed_id, status, id DESC);
      CREATE INDEX IF NOT EXISTS fetch_logs_retention ON fetch_logs(started_at);
      CREATE INDEX IF NOT EXISTS fetch_alerts_due ON fetch_alerts(status, next_attempt_at);
    `);
  }

  recover(now = Date.now()): void {
    this.db.prepare("UPDATE fetch_logs SET status='interrupted', finished_at=?, duration_ms=NULL, error='服务重启，抓取已中断' WHERE status='running'").run(new Date(now).toISOString());
    this.prune(now);
  }

  prune(now = Date.now()): void {
    this.db.prepare("DELETE FROM fetch_logs WHERE status != 'running' AND started_at < ?").run(new Date(now - this.settings().logRetentionDays * 86400_000).toISOString());
    this.db.exec(`DELETE FROM fetch_alerts WHERE status != 'pending'
      AND id NOT IN (SELECT alert_id FROM fetch_logs WHERE alert_id IS NOT NULL)
      AND id NOT IN (SELECT alert_id FROM fetch_incidents WHERE alert_id IS NOT NULL)`);
  }

  start(feedId: string, source: FetchSource, startedAt = new Date().toISOString()): number {
    return Number(this.db.prepare("INSERT INTO fetch_logs(feed_id,source,status,started_at) VALUES (?,?,'running',?)").run(feedId, source, startedAt).lastInsertRowid);
  }

  succeed(id: number, feedId: string, durationMs: number, counts: { itemCount: number; newItemCount: number }): void {
    this.db.prepare("UPDATE fetch_logs SET status='success', finished_at=?, duration_ms=?, item_count=?, new_item_count=? WHERE id=? AND status='running'")
      .run(new Date().toISOString(), Math.max(0, Math.round(durationMs)), counts.itemCount, counts.newItemCount, id);
    this.db.prepare("UPDATE fetch_alerts SET status='canceled' WHERE feed_id=? AND status='pending'").run(feedId);
    this.db.prepare('DELETE FROM fetch_incidents WHERE feed_id=?').run(feedId);
  }

  fail(id: number, feed: Feed, source: FetchSource, durationMs: number, message: string, barkEnabled: boolean, now = Date.now()): void {
    const error = safeDiagnostic(message);
    this.db.prepare("INSERT OR IGNORE INTO fetch_incidents(feed_id) VALUES (?)").run(feed.id);
    const previous = this.db.prepare(`SELECT a.* FROM fetch_incidents i JOIN fetch_alerts a ON a.id=i.alert_id WHERE i.feed_id=?`).get(feed.id);
    let alertId = previous ? String(previous.id) : null;
    if (barkEnabled && (!previous || previous.status === 'failed' && now - Number(previous.last_attempt_at) >= this.settings().bark.cooldownMinutes * 60_000)) {
      alertId = randomUUID();
      const body = `${safeDiagnostic(feed.name)}\n目标：${new URL(feed.url).hostname}\n失败时间：${new Date(now).toISOString()}\n来源：${fetchSourceLabels[source]}\n原因：${error}`;
      this.db.prepare("INSERT INTO fetch_alerts(id,feed_id,status,body,next_attempt_at) VALUES (?,?,'pending',?,?)").run(alertId, feed.id, body, now);
      this.db.prepare('UPDATE fetch_incidents SET alert_id=? WHERE feed_id=?').run(alertId, feed.id);
    }
    this.db.prepare("UPDATE fetch_logs SET status='failure', finished_at=?, duration_ms=?, error=?, alert_id=?, notification_disabled=? WHERE id=? AND status='running'")
      .run(new Date(now).toISOString(), Math.max(0, Math.round(durationMs)), error, alertId, !barkEnabled && !alertId ? 1 : 0, id);
  }

  list(feedId: string, status?: FetchStatus, cursor?: number, limit = 20): FetchLogPage {
    const rows = this.db.prepare(`SELECT l.*, a.status AS alert_status, a.error AS alert_error FROM fetch_logs l
      LEFT JOIN fetch_alerts a ON a.id=l.alert_id WHERE l.feed_id=? ${status ? 'AND l.status=?' : ''} ${cursor ? 'AND l.id<?' : ''}
      ORDER BY l.id DESC LIMIT ?`).all(feedId, ...(status ? [status] : []), ...(cursor ? [cursor] : []), limit + 1);
    const logs: FetchLog[] = rows.slice(0, limit).map(row => ({
      id: Number(row.id), feedId: String(row.feed_id), source: row.source as FetchSource, status: row.status as FetchStatus,
      startedAt: String(row.started_at), finishedAt: row.finished_at as string | null, durationMs: row.duration_ms as number | null,
      itemCount: row.item_count as number | null, newItemCount: row.new_item_count as number | null, error: row.error as string | null,
      notification: row.alert_status ? { status: row.alert_status as AlertStatus, error: row.alert_error as string | null }
        : row.notification_disabled ? { status: 'disabled', error: null } : null,
    }));
    return { logs, nextCursor: rows.length > limit ? String(logs.at(-1)!.id) : null, retentionDays: this.settings().logRetentionDays };
  }

  nextAlert(now = Date.now()): PendingAlert | null {
    const row = this.db.prepare("SELECT id, body, attempts FROM fetch_alerts WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 1").get(now);
    return row ? { id: String(row.id), body: String(row.body), attempts: Number(row.attempts) } : null;
  }

  isPending(id: string): boolean {
    return !!this.db.prepare("SELECT id FROM fetch_alerts WHERE id=? AND status='pending'").get(id);
  }

  resetNotifications(): void {
    this.db.exec("UPDATE fetch_alerts SET status='canceled' WHERE status='pending'; DELETE FROM fetch_incidents;");
  }

  beginAttempt(id: string, now = Date.now()): boolean {
    // Persist the lease before I/O so a crash cannot cause immediate repeated sends.
    const policy = this.settings().bark;
    return this.db.prepare("UPDATE fetch_alerts SET attempts=attempts+1, last_attempt_at=?, next_attempt_at=? WHERE id=? AND status='pending'").run(now, now + Math.max(policy.timeoutSeconds + 5, policy.retryDelaySeconds) * 1000, id).changes > 0;
  }

  finishAttempt(id: string, ok: boolean, now = Date.now()): void {
    const policy = this.settings().bark;
    this.db.prepare(`UPDATE fetch_alerts SET status=CASE WHEN ? THEN 'sent' WHEN attempts>=? THEN 'failed' ELSE 'pending' END,
      error=CASE WHEN ? THEN NULL ELSE 'Bark 推送失败，请检查网络及私有配置' END,
      next_attempt_at=? + CASE WHEN attempts=1 THEN ? ELSE ? END
      WHERE id=? AND status='pending'`).run(ok ? 1 : 0, policy.maxAttempts, ok ? 1 : 0, now, policy.retryDelaySeconds * 1000, policy.laterRetryDelaySeconds * 1000, id);
  }
}
