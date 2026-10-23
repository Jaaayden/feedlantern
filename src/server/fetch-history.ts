import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { defaultApplicationSettings, fetchSourceLabels, notificationChannelLabels, notificationChannels, type ApplicationSettings, type AlertStatus, type ChannelDelivery, type Feed, type FetchLog, type FetchLogPage, type FetchSource, type FetchStatus, type NotificationChannel, type NotificationPolicy } from '../shared/types.js';

/** Stored errors and push content must never contain browser call logs or secrets. */
export function safeDiagnostic(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"')]+/gi, '[目标页面]')
    .replace(/(?:cookie|authorization|set-cookie|token|password|device_key|bark_url)\s*["']?\s*[:=][^\n]*/gi, '[敏感信息已隐藏]')
    .replace(/Bearer\s+\S+/gi, '[敏感信息已隐藏]').split(/\r?\n/)[0].slice(0, 300);
}

/** Structured alert details kept beside the text body for channels such as Webhook. */
export interface AlertPayload { feedName: string; error: string; time: string }
/** One channel delivery of an alert; `id` is the delivery id (`<alert id>:<channel>`). */
export interface PendingAlert { id: string; alertId: string; channel: NotificationChannel; body: string; attempts: number; kind?: string; feedId: string; payload: AlertPayload | null }
/** Shared alert policy and the enabled, fully configured channels of a feed's owner. */
export interface FeedNotifications { policy: NotificationPolicy; channels: NotificationChannel[] }

export class FetchHistory {
  constructor(private db: DatabaseSync, private settings: () => ApplicationSettings = () => defaultApplicationSettings, private notificationsForFeed?: (id: string) => FeedNotifications) {
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
    if (!db.prepare('PRAGMA table_info(fetch_alerts)').all().some(row => row.name === 'kind')) db.exec("ALTER TABLE fetch_alerts ADD COLUMN kind TEXT NOT NULL DEFAULT 'fetch'");
    if (!db.prepare('PRAGMA table_info(fetch_incidents)').all().some(row => row.name === 'failure_count')) db.exec('ALTER TABLE fetch_incidents ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0');
    // Multi-page feeds: pages fetched, and where and why collection stopped.
    if (!db.prepare('PRAGMA table_info(fetch_logs)').all().some(row => row.name === 'pages')) db.exec('ALTER TABLE fetch_logs ADD COLUMN pages INTEGER; ALTER TABLE fetch_logs ADD COLUMN note TEXT;');
    db.exec(`CREATE TABLE IF NOT EXISTS translation_incidents (feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE, alert_id TEXT REFERENCES fetch_alerts(id) ON DELETE SET NULL);`);
    if (!db.prepare('PRAGMA table_info(fetch_alerts)').all().some(row => row.name === 'payload')) db.exec('ALTER TABLE fetch_alerts ADD COLUMN payload TEXT');
    // Each alert is delivered to every channel enabled when it was raised. The
    // alert row keeps the aggregate state used for deduplication and cooldown;
    // cancelling an alert (recovery, deletion, setting changes) cancels its deliveries.
    db.exec(`
      CREATE TABLE IF NOT EXISTS fetch_alert_deliveries (
        id TEXT PRIMARY KEY, alert_id TEXT NOT NULL REFERENCES fetch_alerts(id) ON DELETE CASCADE, channel TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','canceled')), attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, last_attempt_at INTEGER, error TEXT, UNIQUE(alert_id, channel)
      );
      CREATE INDEX IF NOT EXISTS fetch_alert_deliveries_due ON fetch_alert_deliveries(status, next_attempt_at);
      CREATE TRIGGER IF NOT EXISTS fetch_alerts_cancel_deliveries AFTER UPDATE OF status ON fetch_alerts WHEN NEW.status='canceled' BEGIN
        UPDATE fetch_alert_deliveries SET status='canceled' WHERE alert_id=NEW.id AND status='pending';
      END;
    `);
  }

  /** Copies alerts raised before channels existed into Bark deliveries (store migration 10). */
  migrateLegacyDeliveries(): void {
    this.db.exec(`INSERT INTO fetch_alert_deliveries(id,alert_id,channel,status,attempts,next_attempt_at,last_attempt_at,error)
      SELECT id || ':bark', id, 'bark', status, attempts, next_attempt_at, last_attempt_at, error FROM fetch_alerts a
      WHERE NOT EXISTS (SELECT 1 FROM fetch_alert_deliveries d WHERE d.alert_id=a.id)`);
  }

  notificationOptions(feedId: string): FeedNotifications {
    if (this.notificationsForFeed) return this.notificationsForFeed(feedId);
    const { enabled, url, ...policy } = this.settings().bark;
    return { policy, channels: enabled && url ? ['bark'] : [] };
  }
  private deliveryOptions(id: string) {
    const row = this.db.prepare('SELECT a.feed_id FROM fetch_alert_deliveries d JOIN fetch_alerts a ON a.id=d.alert_id WHERE d.id=?').get(id);
    return this.notificationOptions(String(row?.feed_id ?? '')).policy;
  }

  private raise(feedId: string, kind: 'fetch' | 'translation' | 'health', body: string, payload: AlertPayload, channels: NotificationChannel[], now: number): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO fetch_alerts(id,feed_id,status,body,next_attempt_at,kind,payload) VALUES (?,?,'pending',?,?,?,?)").run(id, feedId, body, now, kind, JSON.stringify(payload));
    const insert = this.db.prepare("INSERT INTO fetch_alert_deliveries(id,alert_id,channel,status,next_attempt_at) VALUES (?,?,?,'pending',?)");
    for (const channel of channels) insert.run(`${id}:${channel}`, id, channel, now);
    return id;
  }

  translationFailed(feed: Feed, message: string, now = Date.now()): boolean {
    const { policy, channels } = this.notificationOptions(feed.id);
    if (!channels.length) return false;
    const previous = this.db.prepare('SELECT a.* FROM translation_incidents i JOIN fetch_alerts a ON a.id=i.alert_id WHERE i.feed_id=?').get(feed.id);
    if (previous && !(previous.status === 'failed' && now - Number(previous.last_attempt_at) >= policy.cooldownMinutes * 60_000)) return false;
    const error = safeDiagnostic(message);
    const body = `${safeDiagnostic(feed.name)}\nRSS 翻译失败：${error}\n未完成文章不会发布。系统最多尝试 3 次，达到上限后需手动重试。`;
    const id = this.raise(feed.id, 'translation', body, { feedName: safeDiagnostic(feed.name), error, time: new Date(now).toISOString() }, channels, now);
    this.db.prepare('INSERT INTO translation_incidents(feed_id,alert_id) VALUES (?,?) ON CONFLICT(feed_id) DO UPDATE SET alert_id=excluded.alert_id').run(feed.id, id);
    return true;
  }

  /**
   * Rule-health warning: at most one alert per warning episode, sent to every
   * enabled channel and deduplicated apart from fetch failures. `lastAlertedAt`
   * is the previous rule-health alert of this feed (cooldown against flapping).
   */
  ruleHealthAlert(feed: Feed, reasons: string[], lastAlertedAt: number | null, now = Date.now()): { id: string | null; disabled: boolean } {
    const { policy, channels } = this.notificationOptions(feed.id);
    if (!channels.length || policy.ruleHealthAlerts === false) return { id: null, disabled: true };
    if (lastAlertedAt !== null && now - lastAlertedAt < policy.cooldownMinutes * 60_000) return { id: null, disabled: false };
    let host = '';
    try { host = new URL(feed.url).hostname; } catch { /* stored URLs are validated */ }
    const time = new Date(now).toISOString();
    const error = safeDiagnostic(reasons.join('；'));
    const body = `${safeDiagnostic(feed.name)}\n目标：${host}\n发现时间：${time}\n${reasons.map(reason => `· ${safeDiagnostic(reason)}`).join('\n')}\n抓取仍记为成功。请在订阅面板中重新识别规则，或忽略此警告。`;
    return { id: this.raise(feed.id, 'health', body, { feedName: safeDiagnostic(feed.name), error, time }, channels, now), disabled: false };
  }

  translationRecovered(feedId: string): void {
    if (this.db.prepare("SELECT 1 FROM translations WHERE feed_id=? AND status!='success'").get(feedId)) return;
    this.db.prepare("UPDATE fetch_alerts SET status='canceled' WHERE feed_id=? AND kind='translation' AND status='pending'").run(feedId);
    this.db.prepare('DELETE FROM translation_incidents WHERE feed_id=?').run(feedId);
  }

  recover(now = Date.now()): void {
    this.db.prepare("UPDATE fetch_logs SET status='interrupted', finished_at=?, duration_ms=NULL, error='服务重启，抓取已中断' WHERE status='running'").run(new Date(now).toISOString());
    this.prune(now);
  }

  prune(now = Date.now()): void {
    this.db.prepare("DELETE FROM fetch_logs WHERE status != 'running' AND started_at < ?").run(new Date(now - this.settings().logRetentionDays * 86400_000).toISOString());
    this.db.exec(`DELETE FROM fetch_alerts WHERE status != 'pending'
      AND id NOT IN (SELECT alert_id FROM fetch_logs WHERE alert_id IS NOT NULL)
      AND id NOT IN (SELECT alert_id FROM fetch_incidents WHERE alert_id IS NOT NULL)
      AND id NOT IN (SELECT alert_id FROM translation_incidents WHERE alert_id IS NOT NULL)`);
  }

  start(feedId: string, source: FetchSource, startedAt = new Date().toISOString()): number {
    return Number(this.db.prepare("INSERT INTO fetch_logs(feed_id,source,status,started_at) VALUES (?,?,'running',?)").run(feedId, source, startedAt).lastInsertRowid);
  }

  succeed(id: number, feedId: string, durationMs: number, counts: { itemCount: number; newItemCount: number }, detail?: { pages: number; note: string }): void {
    this.db.prepare("UPDATE fetch_logs SET status='success', finished_at=?, duration_ms=?, item_count=?, new_item_count=?, pages=?, note=? WHERE id=? AND status='running'")
      .run(new Date().toISOString(), Math.max(0, Math.round(durationMs)), counts.itemCount, counts.newItemCount, detail?.pages ?? null, detail ? safeDiagnostic(detail.note) : null, id);
    this.db.prepare("UPDATE fetch_alerts SET status='canceled' WHERE feed_id=? AND kind='fetch' AND status='pending'").run(feedId);
    this.db.prepare('DELETE FROM fetch_incidents WHERE feed_id=?').run(feedId);
  }

  /** `notify` is only used without a per-feed provider (tests); stores always resolve the owner's channels. */
  fail(id: number, feed: Feed, source: FetchSource, durationMs: number, message: string, notify: boolean, now = Date.now()): void {
    // Only completed, previously running fetches count; duplicate completion is ignored.
    if (!this.db.prepare("SELECT 1 FROM fetch_logs WHERE id=? AND feed_id=? AND status='running'").get(id, feed.id)) return;
    const { policy, channels } = this.notificationOptions(feed.id);
    const enabled = channels.length > 0 && (!!this.notificationsForFeed || notify);
    const error = safeDiagnostic(message);
    const incident = this.db.prepare(`INSERT INTO fetch_incidents(feed_id,failure_count) VALUES (?,1)
      ON CONFLICT(feed_id) DO UPDATE SET failure_count=failure_count+1 RETURNING failure_count`).get(feed.id)!;
    const failureCount = Number(incident.failure_count);
    const previous = this.db.prepare(`SELECT a.* FROM fetch_incidents i JOIN fetch_alerts a ON a.id=i.alert_id WHERE i.feed_id=?`).get(feed.id);
    let alertId = previous ? String(previous.id) : null;
    if (enabled && failureCount >= policy.failureThreshold && (!previous || previous.status === 'failed' && now - Number(previous.last_attempt_at) >= policy.cooldownMinutes * 60_000)) {
      const body = `${safeDiagnostic(feed.name)}\n目标：${new URL(feed.url).hostname}\n失败时间：${new Date(now).toISOString()}\n连续失败：${failureCount} 次\n来源：${fetchSourceLabels[source]}\n原因：${error}`;
      alertId = this.raise(feed.id, 'fetch', body, { feedName: safeDiagnostic(feed.name), error, time: new Date(now).toISOString() }, channels, now);
      this.db.prepare('UPDATE fetch_incidents SET alert_id=? WHERE feed_id=?').run(alertId, feed.id);
    }
    this.db.prepare("UPDATE fetch_logs SET status='failure', finished_at=?, duration_ms=?, error=?, alert_id=?, notification_disabled=? WHERE id=? AND status='running'")
      .run(new Date(now).toISOString(), Math.max(0, Math.round(durationMs)), error, alertId, !enabled && !alertId ? 1 : 0, id);
  }

  list(feedId: string, status?: FetchStatus, cursor?: number, limit = 20): FetchLogPage {
    const rows = this.db.prepare(`SELECT l.*, a.status AS alert_status, a.error AS alert_error FROM fetch_logs l
      LEFT JOIN fetch_alerts a ON a.id=l.alert_id WHERE l.feed_id=? ${status ? 'AND l.status=?' : ''} ${cursor ? 'AND l.id<?' : ''}
      ORDER BY l.id DESC LIMIT ?`).all(feedId, ...(status ? [status] : []), ...(cursor ? [cursor] : []), limit + 1);
    const alertIds = [...new Set(rows.map(row => row.alert_id).filter(Boolean).map(String))];
    const deliveries = new Map<string, ChannelDelivery[]>();
    if (alertIds.length) {
      for (const row of this.db.prepare(`SELECT alert_id, channel, status, error FROM fetch_alert_deliveries WHERE alert_id IN (${alertIds.map(() => '?').join(',')})`).all(...alertIds)) {
        const list = deliveries.get(String(row.alert_id)) ?? [];
        list.push({ channel: row.channel as NotificationChannel, status: row.status as AlertStatus, error: row.error as string | null });
        deliveries.set(String(row.alert_id), list);
      }
      for (const list of deliveries.values()) list.sort((a, b) => notificationChannels.indexOf(a.channel) - notificationChannels.indexOf(b.channel));
    }
    const logs: FetchLog[] = rows.slice(0, limit).map(row => ({
      id: Number(row.id), feedId: String(row.feed_id), source: row.source as FetchSource, status: row.status as FetchStatus,
      startedAt: String(row.started_at), finishedAt: row.finished_at as string | null, durationMs: row.duration_ms as number | null,
      itemCount: row.item_count as number | null, newItemCount: row.new_item_count as number | null, error: row.error as string | null,
      ...(row.pages !== null && row.pages !== undefined ? { pages: Number(row.pages), note: row.note as string | null } : {}),
      notification: row.alert_status ? { status: row.alert_status as AlertStatus, error: row.alert_error as string | null, channels: deliveries.get(String(row.alert_id)) ?? [] }
        : row.notification_disabled ? { status: 'disabled', error: null } : null,
      ...(row.warning ? { warning: String(row.warning) } : {}),
    }));
    return { logs, nextCursor: rows.length > limit ? String(logs.at(-1)!.id) : null, retentionDays: this.settings().logRetentionDays };
  }

  /** The next due channel delivery of a pending alert whose owner is enabled. */
  nextAlert(now = Date.now()): PendingAlert | null {
    const row = this.db.prepare(`SELECT d.id, d.alert_id, d.channel, d.attempts, a.feed_id, a.body, a.kind, a.payload FROM fetch_alert_deliveries d JOIN fetch_alerts a ON a.id=d.alert_id
      WHERE d.status='pending' AND a.status='pending' AND d.next_attempt_at<=?
      AND EXISTS (SELECT 1 FROM feeds f LEFT JOIN users u ON u.id=f.owner_id WHERE f.id=a.feed_id AND COALESCE(u.enabled,1)=1)
      ORDER BY d.next_attempt_at LIMIT 1`).get(now);
    if (!row) return null;
    let payload: AlertPayload | null = null;
    try { payload = row.payload ? JSON.parse(String(row.payload)) : null; } catch { /* legacy rows have no payload */ }
    return { id: String(row.id), alertId: String(row.alert_id), channel: row.channel as NotificationChannel, feedId: String(row.feed_id), body: String(row.body), attempts: Number(row.attempts), kind: String(row.kind), payload };
  }

  isPending(id: string): boolean {
    return !!this.db.prepare(`SELECT d.id FROM fetch_alert_deliveries d JOIN fetch_alerts a ON a.id=d.alert_id WHERE d.id=? AND d.status='pending' AND a.status='pending'
      AND EXISTS (SELECT 1 FROM feeds f LEFT JOIN users u ON u.id=f.owner_id WHERE f.id=a.feed_id AND COALESCE(u.enabled,1)=1)`).get(id);
  }

  /** A channel was turned off after the alert was raised. */
  cancelDelivery(id: string): void {
    this.db.prepare("UPDATE fetch_alert_deliveries SET status='canceled' WHERE id=? AND status='pending'").run(id);
    this.settle(id);
  }

  /** Recompute the alert from its deliveries: any delivered channel counts as notified. */
  private settle(deliveryId: string): void {
    this.db.prepare(`UPDATE fetch_alerts SET
      status=CASE WHEN EXISTS (SELECT 1 FROM fetch_alert_deliveries d WHERE d.alert_id=fetch_alerts.id AND d.status='pending') THEN 'pending'
        WHEN EXISTS (SELECT 1 FROM fetch_alert_deliveries d WHERE d.alert_id=fetch_alerts.id AND d.status='sent') THEN 'sent'
        WHEN EXISTS (SELECT 1 FROM fetch_alert_deliveries d WHERE d.alert_id=fetch_alerts.id AND d.status='failed') THEN 'failed' ELSE 'canceled' END,
      attempts=COALESCE((SELECT MAX(attempts) FROM fetch_alert_deliveries d WHERE d.alert_id=fetch_alerts.id), 0),
      last_attempt_at=(SELECT MAX(last_attempt_at) FROM fetch_alert_deliveries d WHERE d.alert_id=fetch_alerts.id),
      error=(SELECT error FROM fetch_alert_deliveries d WHERE d.alert_id=fetch_alerts.id AND d.error IS NOT NULL AND d.status!='sent' ORDER BY d.rowid LIMIT 1)
      WHERE id=(SELECT alert_id FROM fetch_alert_deliveries WHERE id=?) AND status='pending'`).run(deliveryId);
  }

  cancelAlert(id: string): void { this.db.prepare("UPDATE fetch_alerts SET status='canceled' WHERE id=?").run(id); }

  resetNotifications(userId?: string): void {
    if (userId !== undefined) {
      this.db.prepare("UPDATE fetch_alerts SET status='canceled' WHERE status='pending' AND feed_id IN (SELECT id FROM feeds WHERE owner_id=?)").run(userId);
      for (const table of ['fetch_incidents','translation_incidents']) this.db.prepare(`DELETE FROM ${table} WHERE feed_id IN (SELECT id FROM feeds WHERE owner_id=?)`).run(userId);
      return;
    }
    this.db.exec("UPDATE fetch_alerts SET status='canceled' WHERE status='pending'; DELETE FROM fetch_incidents; DELETE FROM translation_incidents;");
  }

  interrupt(runId: number): void {
    this.db.prepare("UPDATE fetch_logs SET status='interrupted',finished_at=?,error='账号已停用，本次抓取结果已丢弃' WHERE id=? AND status='running'").run(new Date().toISOString(), runId);
  }

  beginAttempt(id: string, now = Date.now()): boolean {
    // Persist the lease before I/O so a crash cannot cause immediate repeated sends.
    const policy = this.deliveryOptions(id);
    return this.db.prepare("UPDATE fetch_alert_deliveries SET attempts=attempts+1, last_attempt_at=?, next_attempt_at=? WHERE id=? AND status='pending'").run(now, now + Math.max(policy.timeoutSeconds + 5, policy.retryDelaySeconds) * 1000, id).changes > 0;
  }

  finishAttempt(id: string, ok: boolean, now = Date.now(), error?: string): void {
    if (!this.isPending(id)) return;
    const policy = this.deliveryOptions(id);
    const channel = String(this.db.prepare('SELECT channel FROM fetch_alert_deliveries WHERE id=?').get(id)?.channel ?? 'bark') as NotificationChannel;
    this.db.prepare(`UPDATE fetch_alert_deliveries SET status=CASE WHEN ? THEN 'sent' WHEN attempts>=? THEN 'failed' ELSE 'pending' END,
      error=CASE WHEN ? THEN NULL ELSE ? END,
      next_attempt_at=? + CASE WHEN attempts=1 THEN ? ELSE ? END
      WHERE id=? AND status='pending'`).run(ok ? 1 : 0, policy.maxAttempts, ok ? 1 : 0, error ?? `${notificationChannelLabels[channel] ?? channel} 推送失败，请检查网络及私有配置`, now, policy.retryDelaySeconds * 1000, policy.laterRetryDelaySeconds * 1000, id);
    this.settle(id);
  }
}
