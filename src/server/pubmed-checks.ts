/**
 * Background checks for converting PubMed RSS feeds into PubMed searches.
 *
 * A job lists the feeds to check; it is saved, so it keeps running after the
 * page is closed (and after a restart), and reopening shows its progress and
 * results. Up to `concurrency` feeds are checked at once, but every request
 * to NCBI still goes through the instance's one rate limiter, so concurrency
 * only overlaps waiting for answers. A feed whose result is saved and that has
 * not changed since (same address and name) is not checked again unless asked.
 */
import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LocalizedError, msg } from './i18n.js';
import type { NcbiKeyTest, PubmedCheckEntry, PubmedCheckJob, PubmedRssCheck } from '../shared/types.js';

export const PUBMED_CHECK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pubmed_checks (feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE, signature TEXT NOT NULL, result_json TEXT NOT NULL, checked_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS pubmed_check_jobs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL, body_json TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS pubmed_check_jobs_owner ON pubmed_check_jobs(owner_id, created_at);
  CREATE TABLE IF NOT EXISTS ncbi_key_tests (key_digest TEXT PRIMARY KEY, result_json TEXT NOT NULL);
`;
/** Feeds checked at the same time; requests to NCBI are spaced by the shared limiter regardless. */
export const PUBMED_CHECK_CONCURRENCY = 5;
/** Jobs kept per account (the newest). */
const JOBS_KEPT = 10;

/** What a saved result is valid for: the same kind of feed, address and name (the query is read from them). */
export const checkSignature = (feed: { sourceType?: string; url: string; name: string }) => createHash('sha256').update(JSON.stringify([feed.sourceType ?? 'website', feed.url, feed.name])).digest('hex');

type JobRow = PubmedCheckJob & { ownerId: string; actorId: string };

export class PubmedCheckStore {
  constructor(private readonly db: DatabaseSync) {}
  /** The saved result for a feed, when it was checked in its current form. */
  cached(feedId: string, signature: string): { check: Omit<PubmedRssCheck, 'ncbiKeyConfigured'>; checkedAt: string } | undefined {
    const row = this.db.prepare('SELECT result_json, checked_at FROM pubmed_checks WHERE feed_id=? AND signature=?').get(feedId, signature);
    return row ? { check: JSON.parse(String(row.result_json)), checkedAt: String(row.checked_at) } : undefined;
  }
  save(feedId: string, signature: string, check: Omit<PubmedRssCheck, 'ncbiKeyConfigured'>, at = new Date().toISOString()): void {
    this.db.prepare('INSERT INTO pubmed_checks(feed_id,signature,result_json,checked_at) VALUES (?,?,?,?) ON CONFLICT(feed_id) DO UPDATE SET signature=excluded.signature,result_json=excluded.result_json,checked_at=excluded.checked_at').run(feedId, signature, JSON.stringify(check), at);
  }
  forget(feedId: string): void { this.db.prepare('DELETE FROM pubmed_checks WHERE feed_id=?').run(feedId); }

  insertJob(job: JobRow): void {
    const { ownerId, actorId, ...body } = job;
    this.db.prepare('INSERT INTO pubmed_check_jobs(id,owner_id,actor_id,created_at,state,body_json) VALUES (?,?,?,?,?,?)').run(job.id, ownerId, actorId, job.createdAt, job.state, JSON.stringify(body));
    // Old jobs only matter for their results, which are kept per feed anyway.
    this.db.prepare('DELETE FROM pubmed_check_jobs WHERE owner_id=? AND id NOT IN (SELECT id FROM pubmed_check_jobs WHERE owner_id=? ORDER BY created_at DESC LIMIT ?)').run(ownerId, ownerId, JOBS_KEPT);
  }
  updateJob(job: JobRow): void {
    const { ownerId: _owner, actorId: _actor, ...body } = job;
    this.db.prepare('UPDATE pubmed_check_jobs SET state=?,body_json=? WHERE id=?').run(job.state, JSON.stringify(body), job.id);
  }
  job(id: string): JobRow | undefined {
    const row = this.db.prepare('SELECT * FROM pubmed_check_jobs WHERE id=?').get(id);
    return row ? { ...JSON.parse(String(row.body_json)), ownerId: String(row.owner_id), actorId: String(row.actor_id) } : undefined;
  }
  latestJob(ownerId: string): JobRow | undefined {
    const row = this.db.prepare('SELECT id FROM pubmed_check_jobs WHERE owner_id=? ORDER BY created_at DESC LIMIT 1').get(ownerId);
    return row ? this.job(String(row.id)) : undefined;
  }
  runningJobs(): JobRow[] {
    return this.db.prepare("SELECT id FROM pubmed_check_jobs WHERE state='running' ORDER BY created_at").all().map(row => this.job(String(row.id))!).filter(Boolean);
  }

  /** The last test of an NCBI API key, by a digest of the key (never the key itself). */
  keyTest(digest: string): NcbiKeyTest | undefined {
    const row = this.db.prepare('SELECT result_json FROM ncbi_key_tests WHERE key_digest=?').get(digest);
    return row ? JSON.parse(String(row.result_json)) : undefined;
  }
  saveKeyTest(digest: string, test: NcbiKeyTest): void {
    this.db.exec('DELETE FROM ncbi_key_tests');
    this.db.prepare('INSERT INTO ncbi_key_tests(key_digest,result_json) VALUES (?,?)').run(digest, JSON.stringify(test));
  }
}

export interface CheckFeed { id: string; ownerId?: string; sourceType?: string; url: string; name: string }
export interface PubmedCheckRunnerDeps {
  store: PubmedCheckStore;
  getFeed(id: string): CheckFeed | null;
  /** Checks one feed (requests go through the shared NCBI limiter). */
  check(feed: CheckFeed, signal: AbortSignal): Promise<Omit<PubmedRssCheck, 'ncbiKeyConfigured'>>;
  keyConfigured(): boolean;
  /** Aborts the owner's work when the account is disabled or deleted. */
  ownerSignal(ownerId: string): AbortSignal;
  describe(error: unknown, ownerId: string | undefined): string;
  concurrency?: number;
}

const done = (entry: PubmedCheckEntry) => entry.state !== 'queued' && entry.state !== 'checking';

/** Progress, counts and an estimate of the remaining time, from the feeds checked so far. */
export function jobSnapshot(job: JobRow, keyConfigured: boolean, concurrency = PUBMED_CHECK_CONCURRENCY): PubmedCheckJob {
  const { ownerId: _owner, actorId: _actor, ...body } = job;
  const finished = body.entries.filter(done);
  const timed = finished.filter(entry => !entry.cached && entry.startedAt && entry.finishedAt);
  const remaining = body.entries.length - finished.length;
  const average = timed.length ? timed.reduce((sum, entry) => sum + (Date.parse(entry.finishedAt!) - Date.parse(entry.startedAt!)), 0) / timed.length : undefined;
  const etaSeconds = body.state === 'running' && remaining && average !== undefined ? Math.ceil(remaining * average / Math.min(concurrency, remaining) / 1000) : undefined;
  return {
    ...body, ncbiKeyConfigured: keyConfigured,
    progress: {
      total: body.entries.length, done: finished.length,
      verified: body.entries.filter(entry => entry.state === 'done' && entry.check?.status === 'verified').length,
      review: body.entries.filter(entry => entry.state === 'done' && entry.check?.status === 'review').length,
      failed: body.entries.filter(entry => entry.state === 'failed').length,
      converted: body.entries.filter(entry => entry.state === 'converted').length,
      ...(etaSeconds !== undefined ? { etaSeconds } : {}),
    },
  };
}

export class PubmedCheckRunner {
  private active = 0;
  private readonly controllers = new Map<string, AbortController>();
  private closed = false;
  readonly concurrency: number;
  constructor(private readonly deps: PubmedCheckRunnerDeps) { this.concurrency = deps.concurrency ?? PUBMED_CHECK_CONCURRENCY; }

  /** Restarts work left when the service stopped: feeds being checked go back in the queue. */
  resume(): void {
    for (const job of this.deps.store.runningJobs()) {
      for (const entry of job.entries) if (entry.state === 'checking') entry.state = 'queued';
      this.deps.store.updateJob(job);
    }
    this.pump();
  }

  create(ownerId: string, actorId: string, feeds: CheckFeed[], recheck: boolean): JobRow {
    const now = new Date().toISOString();
    const entries: PubmedCheckEntry[] = feeds.map(feed => {
      const cached = recheck ? undefined : this.deps.store.cached(feed.id, checkSignature(feed));
      return cached ? { feedId: feed.id, name: feed.name, state: 'done', check: cached.check, cached: true, finishedAt: cached.checkedAt } : { feedId: feed.id, name: feed.name, state: 'queued' };
    });
    const job: JobRow = { id: `pmc_${randomUUID()}`, ownerId, actorId, createdAt: now, state: entries.some(entry => entry.state === 'queued') ? 'running' : 'done', entries, ...(entries.some(entry => entry.state === 'queued') ? {} : { finishedAt: now }) };
    this.deps.store.insertJob(job);
    this.pump();
    return job;
  }

  cancel(job: JobRow): JobRow {
    if (job.state !== 'running') return job;
    for (const entry of job.entries) if (entry.state === 'queued') entry.state = 'canceled';
    for (const entry of job.entries) if (entry.state === 'checking') this.controllers.get(`${job.id}:${entry.feedId}`)?.abort();
    this.finishIfIdle(job, 'canceled');
    this.deps.store.updateJob(job);
    return job;
  }

  /** Failed and canceled feeds go back in the queue. */
  retry(job: JobRow): JobRow {
    let again = false;
    for (const entry of job.entries) if (entry.state === 'failed' || entry.state === 'canceled') { entry.state = 'queued'; delete entry.error; again = true; }
    if (again) { job.state = 'running'; delete job.finishedAt; }
    this.deps.store.updateJob(job);
    this.pump();
    return job;
  }

  close(): void { this.closed = true; for (const controller of this.controllers.values()) controller.abort(); }

  private finishIfIdle(job: JobRow, state: 'done' | 'canceled' = 'done'): void {
    if (job.entries.some(entry => entry.state === 'queued' || entry.state === 'checking')) return;
    if (job.state === 'running') { job.state = job.entries.some(entry => entry.state === 'canceled') ? 'canceled' : state; job.finishedAt = new Date().toISOString(); }
  }

  /** Starts queued checks, oldest job first, until `concurrency` are running. */
  private pump(): void {
    if (this.closed) return;
    for (const job of this.deps.store.runningJobs()) {
      for (const entry of job.entries) {
        if (this.active >= this.concurrency) return;
        if (entry.state !== 'queued') continue;
        entry.state = 'checking'; entry.startedAt = new Date().toISOString();
        this.deps.store.updateJob(job);
        this.active++;
        void this.run(job.id, entry.feedId).finally(() => { this.active--; this.pump(); });
      }
    }
  }

  private async run(jobId: string, feedId: string): Promise<void> {
    const key = `${jobId}:${feedId}`;
    const controller = new AbortController();
    this.controllers.set(key, controller);
    let result: Partial<PubmedCheckEntry>;
    const feed = this.deps.getFeed(feedId);
    try {
      // A feed deleted or already converted since the job started.
      if (!feed) throw new LocalizedError(msg('error.feedNotFound'));
      if (feed.sourceType !== 'rss') throw new LocalizedError(msg('error.notPubmedRss'));
      const signal = AbortSignal.any([controller.signal, this.deps.ownerSignal(feed.ownerId ?? 'admin')]);
      const check = await this.deps.check(feed, signal);
      this.deps.store.save(feed.id, checkSignature(feed), check);
      result = { state: 'done', check };
    } catch (error) {
      result = controller.signal.aborted ? { state: 'canceled' } : { state: 'failed', error: this.deps.describe(error, feed?.ownerId) };
    } finally { this.controllers.delete(key); }
    // The job is read again: it may have been canceled or retried meanwhile.
    const job = this.deps.store.job(jobId);
    if (!job) return;
    const entry = job.entries.find(row => row.feedId === feedId);
    if (entry && entry.state === 'checking') Object.assign(entry, result, { finishedAt: new Date().toISOString() });
    this.finishIfIdle(job);
    this.deps.store.updateJob(job);
  }
}
