import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { BUNDLE_ITEM_LIMIT, BUNDLE_MAX_FEEDS, type Bundle, type BundleInput } from '../shared/types.js';
import { AppError } from './auth.js';
import { msg } from './i18n.js';

/** Bundles and their members. Members are feeds of the same owner; deleting a feed removes it from every bundle (ON DELETE CASCADE). */
export const BUNDLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bundles (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    item_limit INTEGER NOT NULL DEFAULT ${BUNDLE_ITEM_LIMIT.default},
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    token_ciphertext TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS bundle_feeds (
    bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (bundle_id, feed_id)
  );
  CREATE INDEX IF NOT EXISTS bundles_owner ON bundles(owner_id);
  CREATE INDEX IF NOT EXISTS bundle_feeds_feed ON bundle_feeds(feed_id);
`;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class BundleStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly seal: (value: string) => string,
    private readonly unseal: (value: string) => string,
    private readonly isUserActive: (id: string) => boolean,
  ) {}

  private members(id: string): string[] {
    return (this.db.prepare('SELECT feed_id FROM bundle_feeds WHERE bundle_id=? ORDER BY position, rowid').all(id) as Array<{ feed_id: string }>).map(row => String(row.feed_id));
  }

  private fromRow(row: Record<string, unknown>): Bundle {
    return {
      id: String(row.id), ownerId: String(row.owner_id), name: String(row.name), feedIds: this.members(String(row.id)),
      itemLimit: Number(row.item_limit), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  get(id: string): Bundle | null {
    const row = this.db.prepare('SELECT * FROM bundles WHERE id=?').get(id);
    return row ? this.fromRow(row) : null;
  }

  list(ownerId?: string): Bundle[] {
    return this.db.prepare('SELECT * FROM bundles WHERE (? IS NULL OR owner_id=?) ORDER BY created_at, id').all(ownerId ?? null, ownerId ?? null).map(row => this.fromRow(row));
  }

  /** Only the owner's own feeds can be members; order is kept and duplicates dropped. */
  private checkMembers(ownerId: string, feedIds: string[]): string[] {
    const unique = [...new Set(feedIds)];
    if (unique.length > BUNDLE_MAX_FEEDS) throw new AppError(400, msg('error.bundleTooManyFeeds', { max: BUNDLE_MAX_FEEDS }));
    const owned = this.db.prepare('SELECT 1 FROM feeds WHERE id=? AND owner_id=?');
    if (unique.some(id => !owned.get(id, ownerId))) throw new AppError(400, 'error.selectedFeedMissing');
    return unique;
  }

  private writeMembers(id: string, feedIds: string[]): void {
    this.db.prepare('DELETE FROM bundle_feeds WHERE bundle_id=?').run(id);
    const insert = this.db.prepare('INSERT INTO bundle_feeds(bundle_id,feed_id,position) VALUES (?,?,?)');
    feedIds.forEach((feedId, index) => insert.run(id, feedId, index));
  }

  private inTransaction<T>(operation: () => T): T {
    this.db.exec('SAVEPOINT bundle');
    try { const result = operation(); this.db.exec('RELEASE bundle'); return result; }
    catch (error) { this.db.exec('ROLLBACK TO bundle; RELEASE bundle'); throw error; }
  }

  create(input: BundleInput, ownerId: string): { bundle: Bundle; token: string } {
    return this.inTransaction(() => {
      const feedIds = this.checkMembers(ownerId, input.feedIds);
      const id = `bundle_${randomBytes(16).toString('hex')}`, token = randomBytes(32).toString('base64url'), now = new Date().toISOString();
      this.db.prepare('INSERT INTO bundles(id,owner_id,name,item_limit,created_at,updated_at,token_ciphertext,token_hash) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, ownerId, input.name, input.itemLimit ?? BUNDLE_ITEM_LIMIT.default, now, now, this.seal(token), hash(token));
      this.writeMembers(id, feedIds);
      return { bundle: this.get(id)!, token };
    });
  }

  update(id: string, patch: Partial<BundleInput>): Bundle | null {
    return this.inTransaction(() => {
      const bundle = this.get(id);
      if (!bundle) return null;
      if (patch.feedIds) this.writeMembers(id, this.checkMembers(bundle.ownerId!, patch.feedIds));
      this.db.prepare('UPDATE bundles SET name=?,item_limit=?,updated_at=? WHERE id=?').run(patch.name ?? bundle.name, patch.itemLimit ?? bundle.itemLimit, new Date().toISOString(), id);
      return this.get(id);
    });
  }

  /** Append members, keeping the ones already there in place. */
  addFeeds(id: string, feedIds: string[]): Bundle | null {
    const bundle = this.get(id);
    return bundle && this.update(id, { feedIds: [...bundle.feedIds, ...feedIds] });
  }

  delete(id: string): boolean {
    return Boolean(this.db.prepare('DELETE FROM bundles WHERE id=?').run(id).changes);
  }

  token(id: string): string | null {
    const row = this.db.prepare('SELECT token_ciphertext FROM bundles WHERE id=?').get(id);
    return row ? this.unseal(String(row.token_ciphertext)) : null;
  }

  rotateToken(id: string): string | null {
    const token = randomBytes(32).toString('base64url');
    const result = this.db.prepare('UPDATE bundles SET token_ciphertext=?,token_hash=?,updated_at=? WHERE id=?').run(this.seal(token), hash(token), new Date().toISOString(), id);
    return result.changes ? token : null;
  }

  /** Same rule as a feed address: a disabled owner makes the address unavailable. */
  checkToken(id: string, token: string): boolean {
    const row = this.db.prepare('SELECT owner_id,token_hash FROM bundles WHERE id=?').get(id);
    if (!row || !this.isUserActive(String(row.owner_id))) return false;
    const expected = Buffer.from(String(row.token_hash)), actual = Buffer.from(hash(token));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
