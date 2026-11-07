import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { BUNDLE_DEDUPE_DEFAULT, type Bundle } from '../shared/types.js';
import { dedupeTitleKey, dedupeUrlKey } from './bundle-dedupe.js';
import { itemTime, type BundleEntry } from './bundles.js';
import { normalizeLink } from './links.js';

/**
 * A bundle is computed from what its members currently publish, and the id a
 * member gives an item is its own. When the copy a bundle keeps changes (the
 * first member scrolled the item out, or a member stored it again after
 * clearing it), the item would reach readers under a new id and show up again.
 * The bundle therefore remembers which id it published for each link (and,
 * depending on the duplicate rule, address or title) and keeps using it.
 */
export const BUNDLE_SEEN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bundle_seen (
    bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    guid TEXT NOT NULL,
    item_time INTEGER NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (bundle_id, kind, key_hash)
  );
  CREATE INDEX IF NOT EXISTS bundle_seen_age ON bundle_seen(bundle_id, last_seen_at);
`;

export type SeenKind = 'link' | 'url' | 'title';
/** What is remembered per bundle: rows older than this are forgotten... */
export const BUNDLE_SEEN_DAYS = 180;
/** ...and the newest rows beyond this many are all that is kept. */
export const BUNDLE_SEEN_ROWS = 20_000;
/** Backups carry at most this many rows (the newest). */
export const BUNDLE_SEEN_BACKUP_ROWS = 500_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

interface SeenKey { kind: SeenKind; hash: string }
interface SeenRow { guid: string; itemTime: number; firstSeenAt: string; lastSeenAt: string }

const hashKey = (kind: SeenKind, key: string): SeenKey => ({ kind, hash: createHash('sha256').update(`${kind}\n${key}`).digest('hex').slice(0, 32) });
const slot = ({ kind, hash }: SeenKey) => `${kind}:${hash}`;

/** The keys an item is remembered by under a duplicate rule; the link is always one of them. */
function seenKeys(entry: BundleEntry, mode: 'link' | 'url' | 'title'): SeenKey[] {
  const { link, title } = entry.item;
  const keys = [hashKey('link', normalizeLink(link))];
  if (mode !== 'link') keys.push(hashKey('url', dedupeUrlKey(link)));
  if (mode === 'title') {
    const key = dedupeTitleKey(title);
    if (key !== null) keys.push(hashKey('title', key));
  }
  return keys;
}

export class BundleSeen {
  private readonly pruned = new Map<string, number>();
  constructor(private readonly db: DatabaseSync) {}

  private load(bundleId: string, keys: SeenKey[]): Map<string, SeenRow> {
    const found = new Map<string, SeenRow>();
    const select = this.db.prepare('SELECT guid,item_time,first_seen_at,last_seen_at FROM bundle_seen WHERE bundle_id=? AND kind=? AND key_hash=?');
    for (const key of keys) {
      const row = select.get(bundleId, key.kind, key.hash);
      if (row) found.set(slot(key), { guid: String(row.guid), itemTime: Number(row.item_time), firstSeenAt: String(row.first_seen_at), lastSeenAt: String(row.last_seen_at) });
    }
    return found;
  }

  /**
   * The entries with the ids they were first published under. An item the
   * bundle has not seen keeps its own id, so the first request after an
   * upgrade changes nothing. With duplicates not merged ("off") each copy is
   * its own item and nothing is remembered.
   */
  stabilize(bundle: Pick<Bundle, 'id' | 'dedupe'>, entries: BundleEntry[], now = new Date()): BundleEntry[] {
    const dedupe = bundle.dedupe ?? BUNDLE_DEDUPE_DEFAULT;
    if (dedupe.mode === 'off' || !entries.length) return entries;
    const mode = dedupe.mode, stamp = now.toISOString(), stale = new Date(now.getTime() - DAY_MS).toISOString();
    const window = mode === 'title' && dedupe.windowDays !== null ? dedupe.windowDays * DAY_MS : null;
    const keyed = entries.map(entry => seenKeys(entry, mode));
    const known = this.load(bundle.id, keyed.flat());
    const used = new Set<string>();
    const writes: Array<{ key: SeenKey; guid: string; time: number; firstSeenAt: string; replace: boolean }> = [];
    const touches: SeenKey[] = [];

    const result = entries.map((entry, index) => {
      const time = itemTime(entry.item);
      let hit: SeenRow | undefined;
      for (const key of keyed[index]) {
        const row = known.get(slot(key));
        if (!row || (key.kind === 'title' && window !== null && Math.abs(time - row.itemTime) > window)) continue;
        if (!hit || row.firstSeenAt < hit.firstSeenAt) hit = row;
      }
      // Two items must never share an id in one feed: if the remembered one is taken, this one keeps its own.
      const remembered = hit !== undefined && !used.has(hit.guid);
      const guid = remembered ? hit!.guid : entry.item.id;
      used.add(guid);
      if (hit === undefined || remembered) {
        for (const key of keyed[index]) {
          const row = known.get(slot(key));
          if (!row) writes.push({ key, guid, time, firstSeenAt: hit?.firstSeenAt ?? stamp, replace: false });
          else if (key.kind === 'title' && row.guid !== guid) writes.push({ key, guid, time, firstSeenAt: stamp, replace: true });
          else if (row.guid === guid && row.lastSeenAt < stale) touches.push(key);
        }
      }
      return guid === entry.item.id ? entry : { feed: entry.feed, item: { ...entry.item, id: guid } };
    });

    if (writes.length || touches.length) {
      this.db.exec('SAVEPOINT bundle_seen');
      try {
        // A key that is already there is only overwritten when `replace` is set (a title that left its window).
        const insert = this.db.prepare(`INSERT INTO bundle_seen(bundle_id,kind,key_hash,guid,item_time,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(bundle_id,kind,key_hash) DO UPDATE SET guid=excluded.guid,item_time=excluded.item_time,first_seen_at=excluded.first_seen_at,last_seen_at=excluded.last_seen_at WHERE ?=1`);
        for (const write of writes) insert.run(bundle.id, write.key.kind, write.key.hash, write.guid, write.time, write.firstSeenAt, stamp, write.replace ? 1 : 0);
        const touch = this.db.prepare('UPDATE bundle_seen SET last_seen_at=?, item_time=CASE WHEN kind=\'title\' THEN ? ELSE item_time END WHERE bundle_id=? AND kind=? AND key_hash=?');
        const times = new Map(entries.flatMap((entry, index) => keyed[index].map(key => [slot(key), itemTime(entry.item)] as const)));
        for (const key of touches) touch.run(stamp, times.get(slot(key)) ?? 0, bundle.id, key.kind, key.hash);
        this.db.exec('RELEASE bundle_seen');
      } catch (error) { this.db.exec('ROLLBACK TO bundle_seen; RELEASE bundle_seen'); throw error; }
    }
    this.prune(bundle.id, now);
    return result;
  }

  /** At most once an hour per bundle: forget old rows and keep the newest `BUNDLE_SEEN_ROWS`. */
  private prune(bundleId: string, now: Date): void {
    const last = this.pruned.get(bundleId);
    if (last !== undefined && now.getTime() - last < HOUR_MS) return;
    this.pruned.set(bundleId, now.getTime());
    this.db.prepare('DELETE FROM bundle_seen WHERE bundle_id=? AND last_seen_at<?').run(bundleId, new Date(now.getTime() - BUNDLE_SEEN_DAYS * DAY_MS).toISOString());
    this.db.prepare('DELETE FROM bundle_seen WHERE bundle_id=? AND rowid IN (SELECT rowid FROM bundle_seen WHERE bundle_id=? ORDER BY last_seen_at DESC, rowid DESC LIMIT -1 OFFSET ?)').run(bundleId, bundleId, BUNDLE_SEEN_ROWS);
  }
}
