import { siteKey } from './task-pool.js';
import { randomUUID } from 'node:crypto';
import type { DetectionResult, Feed, FeedInput, ImportEntry, ImportJob } from '../shared/types.js';
import type { Store } from './store.js';
import { AppError } from './auth.js';

export function normalizeSource(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持不含账号密码的 HTTP(S) 网址');
  url.hash = '';
  return url.href;
}

export class ImportJobs {
  private running = false;
  private stopped = false;
  private claimed = new Set<string>();
  private restartRequested = false;
  constructor(private store: Store, private enqueue: <T>(fn: () => Promise<T>, keys?: string[]) => Promise<T>,
    private discover: (entry: ImportEntry) => Promise<{ title: string; detection: DetectionResult }>,
    private scrape: (input: FeedInput) => Promise<import('../shared/types.js').ExtractedItem[]>,
    private describeError: (error: unknown) => string = () => '识别失败：请检查网址、网络或 Cookie，然后重试或手动调整。',
    private concurrency = 1) {}

  recover() {
    this.stopped = false;
    this.restartRequested = this.running;
    for (const job of this.store.listImportJobs()) {
      for (const entry of job.entries) if (entry.state === 'running') entry.state = 'queued';
      this.store.saveImportJob(job);
    }
    this.wake();
  }
  stop() { this.stopped = true; }
  setConcurrency(value: number) { this.concurrency = value; }
  create(entries: Array<{ url: string; credentialId: string | null; intervalMinutes: number }>): ImportJob {
    if (this.store.listImportJobs().filter(j => j.entries.some(e => ['queued', 'running'].includes(e.state))).length >= 10) throw new AppError(429, '请等待现有批量任务完成');
    const job: ImportJob = { id: randomUUID(), createdAt: new Date().toISOString(), entries: [] };
    const seen = new Set<string>();
    for (const input of entries) {
      const url = normalizeSource(input.url);
      if (seen.has(url)) continue;
      seen.add(url);
      const existing = this.existing(url);
      job.entries.push({ ...input, url, id: randomUUID(), state: existing ? 'existing' : 'queued', feedId: existing?.id });
    }
    this.store.saveImportJob(job); this.wake(); return job;
  }
  get(id: string) {
    const job = this.store.listImportJobs().find(j => j.id === id);
    if (!job) throw new AppError(404, '批量任务不存在');
    return job;
  }
  update(id: string, action: 'cancel' | 'retry', entryId?: string) {
    const job = this.get(id);
    for (const entry of job.entries) {
      if (entryId && entry.id !== entryId) continue;
      if (action === 'cancel' && entry.state === 'queued') entry.state = 'canceled';
      if (action === 'retry' && ['failed', 'canceled'].includes(entry.state)) { entry.state = 'queued'; delete entry.error; }
    }
    this.store.saveImportJob(job); this.wake(); return job;
  }
  async confirm(id: string, entryId: string, input: FeedInput) {
    return this.enqueue(async () => {
      const job = this.get(id), entry = job.entries.find(e => e.id === entryId);
      if (!entry) throw new AppError(404, '任务条目不存在');
      if (entry.feedId) return this.store.getFeed(entry.feedId);
      if (!['review', 'failed'].includes(entry.state)) throw new AppError(409, '该任务当前不能确认');
      if (normalizeSource(input.url) !== entry.url) throw new AppError(400, '确认时不能更改来源网址');
      const existing = this.existing(entry.url);
      if (existing) { entry.state = 'existing'; entry.feedId = existing.id; this.store.saveImportJob(job); return existing; }
      const startedAt = new Date().toISOString(), started = performance.now();
      const items = await this.scrape(input);
      if (!items.length) throw new AppError(400, '未匹配到有效条目，请调整规则');
      return this.complete(job, entry, input, items, startedAt, performance.now() - started);
    }, [siteKey(input.url)]);
  }
  private existing(url: string): Feed | undefined { return this.store.listFeeds().find(f => normalizeSource(f.url) === url); }
  private complete(job: ImportJob, entry: ImportEntry, input: FeedInput, items: import('../shared/types.js').ExtractedItem[], startedAt: string, durationMs: number) {
    return this.store.transaction(() => {
      const existing = this.existing(entry.url);
      if (existing) {
        entry.state = 'existing'; entry.feedId = existing.id;
        const current = this.get(job.id);
        current.entries = current.entries.map(e => e.id === entry.id ? entry : e);
        this.store.saveImportJob(current);
        return existing;
      }
      const { feed } = this.store.createFeed(input);
      const runId = this.store.history.start(feed.id, 'import', startedAt);
      const counts = { itemCount: 0, newItemCount: 0 };
      this.store.upsertItems(feed, items, counts);
      if (!counts.itemCount) throw new AppError(400, '未匹配到有效条目，请调整规则');
      this.store.markFetchStart(feed.id, feed.nextFetchAt);
      this.store.markFetchSuccess(feed.id, feed.nextFetchAt);
      this.store.history.succeed(runId, feed.id, durationMs, counts);
      entry.state = 'created'; entry.feedId = feed.id; delete entry.detection; delete entry.error;
      // Reload so cancel/retry changes made during network I/O aren't lost.
      const current = this.get(job.id);
      current.entries = current.entries.map(e => e.id === entry.id ? entry : e);
      this.store.saveImportJob(current);
      return this.store.getFeed(feed.id)!;
    });
  }
  wake() { if (!this.running && !this.stopped) void this.run().catch(() => { /* persisted running entries recover on restart */ }); }
  private async run() {
    this.running = true;
    try {
      await Promise.allSettled(Array.from({ length: this.concurrency }, () => this.worker()));
    } finally {
      this.running = false;
      if (this.restartRequested) { this.restartRequested = false; this.wake(); }
    }
  }
  private async worker() {
      while (!this.stopped) {
        const job = this.store.listImportJobs().reverse().find(j => j.entries.some(e => e.state === 'queued' && !this.claimed.has(e.id)));
        const pending = job?.entries.find(e => e.state === 'queued' && !this.claimed.has(e.id));
        if (!job || !pending) break;
        this.claimed.add(pending.id);
        try { await this.enqueue(async () => {
          if (this.stopped) return;
          const current = this.get(job.id), entry = current.entries.find(e => e.id === pending.id)!;
          if (entry.state !== 'queued') return;
          const existing = this.existing(entry.url);
          if (existing) { entry.state = 'existing'; entry.feedId = existing.id; this.store.saveImportJob(current); return; }
          entry.state = 'running'; this.store.saveImportJob(current);
          try {
            const startedAt = new Date().toISOString(), started = performance.now();
            const { title, detection } = await this.discover(entry);
            entry.title = title;
            const candidate = detection.candidates.find(c => c.id === detection.recommendedId && c.confidence === 'high');
            if (candidate && candidate.items.length >= 3) {
              this.complete(current, entry, { name: (title.trim() || new URL(entry.url).host).slice(0, 200), url: entry.url, credentialId: entry.credentialId, intervalMinutes: entry.intervalMinutes, waitMs: 1000, rules: candidate.rules, ruleOrigins: Object.fromEntries(Object.keys(candidate.rules).map(k => [k, 'auto'])) }, candidate.items, startedAt, performance.now() - started);
              return;
            }
            entry.state = 'review'; entry.detection = detection;
          } catch (error) { entry.state = 'failed'; entry.error = this.describeError(error); }
          const latest = this.get(job.id);
          latest.entries = latest.entries.map(e => e.id === entry.id ? entry : e);
          this.store.saveImportJob(latest);
        }, [siteKey(pending.url)]);
        } finally { this.claimed.delete(pending.id); }
      }
  }
}
