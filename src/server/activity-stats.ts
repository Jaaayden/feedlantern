import type { DatabaseSync } from 'node:sqlite';
import type { DashboardDay, DashboardPeriod, DashboardStats } from '../shared/types.js';

const DAY = 86_400_000;
const timestamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// Counters live at the account level, independently of retained messages, feeds
// and diagnostic logs. Triggers commit/roll back with the operation they count.
function counterTrigger(name: string, event: string, table: string, owner: string, column: 'collected' | 'translated' | 'feeds_created' | 'feeds_deleted', condition = '1') {
  const lifetime = column === 'collected' || column === 'translated';
  return `CREATE TRIGGER IF NOT EXISTS activity_${name} AFTER ${event} ON ${table}
    WHEN (${condition}) AND EXISTS (SELECT 1 FROM users WHERE id=(${owner})) BEGIN
      INSERT OR IGNORE INTO activity_totals(owner_id,started_at) VALUES ((${owner}),${timestamp});
      ${lifetime ? `UPDATE activity_totals SET ${column}=${column}+1 WHERE owner_id=(${owner});` : ''}
      INSERT INTO activity_daily(owner_id,day,${column}) VALUES ((${owner}),date('now'),1)
        ON CONFLICT(owner_id,day) DO UPDATE SET ${column}=${column}+1;
    END;`;
}

export const ACTIVITY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS activity_totals (
    owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL, collected INTEGER NOT NULL DEFAULT 0 CHECK(collected>=0),
    translated INTEGER NOT NULL DEFAULT 0 CHECK(translated>=0)
  );
  CREATE TABLE IF NOT EXISTS activity_daily (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,
    collected INTEGER NOT NULL DEFAULT 0 CHECK(collected>=0), translated INTEGER NOT NULL DEFAULT 0 CHECK(translated>=0),
    feeds_created INTEGER NOT NULL DEFAULT 0 CHECK(feeds_created>=0), feeds_deleted INTEGER NOT NULL DEFAULT 0 CHECK(feeds_deleted>=0),
    PRIMARY KEY(owner_id,day)
  );
  CREATE INDEX IF NOT EXISTS activity_daily_retention ON activity_daily(day);
  CREATE TRIGGER IF NOT EXISTS activity_user_created AFTER INSERT ON users BEGIN
    INSERT OR IGNORE INTO activity_totals(owner_id,started_at) VALUES (NEW.id,${timestamp});
  END;
  ${counterTrigger('feed_created', 'INSERT', 'feeds', 'NEW.owner_id', 'feeds_created')}
  ${counterTrigger('feed_deleted', 'DELETE', 'feeds', 'OLD.owner_id', 'feeds_deleted')}
  ${counterTrigger('item_collected', 'INSERT', 'feed_items', 'SELECT owner_id FROM feeds WHERE id=NEW.feed_id', 'collected')}
  ${counterTrigger('translation_completed', 'UPDATE OF status', 'translations', 'SELECT owner_id FROM feeds WHERE id=NEW.feed_id', 'translated', "NEW.status='success' AND OLD.status!='success'")}
`;

export class ActivityStats {
  constructor(private readonly db: DatabaseSync) { this.initializeOwners(); }

  /** Existing accounts start recording now; previously deleted history is unknown. */
  initializeOwners(): void {
    this.db.prepare('INSERT OR IGNORE INTO activity_totals(owner_id,started_at) SELECT id,? FROM users').run(new Date().toISOString());
  }

  read(ownerId: string, days: DashboardPeriod = 30, now = new Date()): DashboardStats {
    const totals = this.db.prepare('SELECT started_at,collected,translated FROM activity_totals WHERE owner_id=?').get(ownerId);
    const recordingSince = String(totals?.started_at ?? now.toISOString());
    const today = Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00Z');
    const from = new Date(today - (days - 1) * DAY).toISOString().slice(0, 10);
    const rows = this.db.prepare('SELECT * FROM activity_daily WHERE owner_id=? AND day>=? AND day<=? ORDER BY day').all(ownerId, from, now.toISOString().slice(0, 10));
    const byDay = new Map(rows.map(row => [String(row.day), row]));
    let subscriptions = Number(this.db.prepare('SELECT COUNT(*) AS n FROM feeds WHERE owner_id=?').get(ownerId)?.n ?? 0);
    const daily: DashboardDay[] = [];
    for (let i = 0; i < days; i++) {
      const date = new Date(today - i * DAY).toISOString().slice(0, 10);
      if (date < recordingSince.slice(0, 10)) break;
      const row = byDay.get(date);
      const added = Number(row?.feeds_created ?? 0), removed = Number(row?.feeds_deleted ?? 0);
      daily.unshift({ date, collected: Number(row?.collected ?? 0), translated: Number(row?.translated ?? 0), added, removed, subscriptions });
      subscriptions = Math.max(0, subscriptions - added + removed);
    }
    const translation = { pending: 0, running: 0, failed: 0 };
    for (const row of this.db.prepare(`SELECT t.status,COUNT(*) AS n FROM translations t JOIN feeds f ON f.id=t.feed_id
      JOIN users u ON u.id=f.owner_id WHERE f.owner_id=? AND f.enabled=1 AND u.enabled=1
      AND f.translation_mode IN ('translated','bilingual') GROUP BY t.status`).all(ownerId)) {
      if (row.status === 'pending' || row.status === 'running' || row.status === 'failed') translation[row.status] = Number(row.n);
    }
    const fetching = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM fetch_logs l JOIN feeds f ON f.id=l.feed_id WHERE f.owner_id=? AND l.status='running'`).get(ownerId)?.n ?? 0);
    return { days, recordingSince, updatedAt: now.toISOString(), totals: { collected: Number(totals?.collected ?? 0), translated: Number(totals?.translated ?? 0) }, daily, translation, fetching };
  }

  /** Only daily detail expires. The two lifetime counters are never pruned. */
  prune(now = new Date()): void {
    const oldest = new Date(Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00Z') - 89 * DAY).toISOString().slice(0, 10);
    this.db.prepare('DELETE FROM activity_daily WHERE day<?').run(oldest);
  }
}
