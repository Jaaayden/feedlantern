import { translationEnabled } from '../shared/types.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseDocument } from 'htmlparser2';
type AnyNode = ReturnType<typeof parseDocument>['children'][number];
import serialize from 'dom-serializer';
import { digest, safeHtml, type SourceItem, type SourceResult } from './rss-source.js';
import { escapeXml, sanitizeDescription } from './rss.js';
import type { ApplicationSettings, Feed, FeedItem } from '../shared/types.js';

export type Translator = (text: string, signal: AbortSignal) => Promise<string>;
export class TranslationError extends Error {
  constructor(message: string, public retryAfterMs = 0, public rateLimited = false) { super(message); }
}
// Public browser client key shipped in Immersive Translate 1.33.1, not a user's
// Cloud API credential. Protocol: https://download.immersivetranslate.com/immersive-translate.user.js
const googleBrowserClientKey = 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520';
export const googleBatchLimits = { segments: 50, characters: 1800 } as const;

/** Browser translation returns one HTML result per input, in array order. */
export async function googleTranslateBatch(texts: string[], signal: AbortSignal): Promise<string[]> {
  if (!texts.length) return [];
  if (texts.length > googleBatchLimits.segments) throw new TranslationError('单批翻译片段过多');
  const response = await fetch('https://translate-pa.googleapis.com/v1/translateHtml', {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    headers: { 'content-type': 'application/json+protobuf', 'x-goog-api-key': googleBrowserClientKey },
    // Escape text nodes so literal <tags> are translated as text, not interpreted as HTML.
    body: JSON.stringify([[texts.map(escapeXml), 'auto', 'zh-CN'], 'te_lib']),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const retry = response.headers.get('retry-after');
    const retryMs = retry ? /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now() : 0;
    const limited = response.status === 429 || retryMs > 0;
    throw new TranslationError(limited ? 'Google 浏览器翻译请求受限，请稍后重试' : response.status === 403 ? 'Google 浏览器翻译拒绝访问（HTTP 403），请检查接口可用性' : `Google 翻译服务暂不可用（HTTP ${response.status}）`, Number.isFinite(retryMs) ? Math.max(0, Math.min(retryMs, 86400_000)) : 0, limited);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TranslationError('Google 返回了空响应');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > 100_000) throw new TranslationError('Google 翻译响应过大');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const textBody = Buffer.concat(chunks).toString('utf8');
  let body: unknown;
  try { body = JSON.parse(textBody); } catch { throw new TranslationError('Google 返回了非翻译内容，可能是请求限制页面', 0, /automated queries|unusual traffic|<title>Sorry/i.test(textBody)); }
  if (!Array.isArray(body) || !Array.isArray(body[0]) || body[0].length !== texts.length || !body[0].every((value: unknown) => typeof value === 'string')) throw new TranslationError('Google 批量译文数量或格式不匹配，整批未发布');
  return (body[0] as string[]).map((html, i) => {
    const parts: string[] = [];
    const collect = (node: AnyNode): void => {
      if (node.type === 'text') parts.push(node.data);
      else if ('children' in node) node.children.forEach(collect);
    };
    parseDocument(html).children.forEach(collect);
    const text = parts.join('').trim();
    if (!text) throw new TranslationError('Google 返回了空译文');
    return (texts[i].match(/^\s*/)?.[0] ?? '') + text + (texts[i].match(/\s*$/)?.[0] ?? '');
  });
}

export const googleTranslate: Translator = async (text, signal) => (await googleTranslateBatch([text], signal))[0];

interface TranslationBody { sourceTitle?: string; html: string; title?: string; translatedHtml?: string; bilingualHtml?: string }
interface Job { item_id: string; feed_id: string; revision: string; attempts: number; body_json: string; title: string; link: string }

export class RssTranslations {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS rss_sources (feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE, etag TEXT, modified TEXT, seen_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS translations (
        item_id TEXT PRIMARY KEY REFERENCES feed_items(id) ON DELETE CASCADE,
        feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        revision TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, error TEXT, body_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS translations_due ON translations(status,next_at);
      CREATE TABLE IF NOT EXISTS translation_events (id INTEGER PRIMARY KEY AUTOINCREMENT, feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, item_id TEXT, at INTEGER NOT NULL, message TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS translation_events_feed ON translation_events(feed_id,id);
      CREATE TABLE IF NOT EXISTS translation_cache (key TEXT PRIMARY KEY, text TEXT NOT NULL, touched_at INTEGER NOT NULL);`);
  }
  event(job: Job, message: string): void {
    if (!this.valid(job)) return;
    this.db.prepare('INSERT INTO translation_events(feed_id,item_id,at,message) VALUES (?,?,?,?)').run(job.feed_id, job.item_id, Date.now(), message);
    console.info(`[RSS 翻译] feed=${job.feed_id} item=${job.item_id} ${message}`);
  }
  progress(id: string) {
    return {
      tasks: this.db.prepare(`SELECT t.item_id AS id,i.title,t.status,t.attempts,t.next_at AS nextAt,t.error FROM translations t JOIN feed_items i ON i.id=t.item_id WHERE t.feed_id=? ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,i.first_seen_at DESC LIMIT 100`).all(id),
      logs: this.db.prepare('SELECT id,at,message,item_id AS itemId FROM translation_events WHERE feed_id=? ORDER BY id DESC LIMIT 100').all(id),
    };
  }
  syncWebsite(feed: Feed): void {
    if (feed.sourceType === 'rss' || !translationEnabled(feed)) return;
    for (const row of this.db.prepare('SELECT id,title,description,image,link FROM feed_items WHERE feed_id=?').all(feed.id)) {
      const html = sanitizeDescription(row.description ? String(row.description) : undefined, String(row.link), row.image ? String(row.image) : undefined);
      const previous = this.db.prepare('SELECT body_json FROM translations WHERE item_id=?').get(row.id);
      const body = previous ? JSON.parse(String(previous.body_json)) as TranslationBody : undefined;
      if (body?.html === html && body.sourceTitle === row.title) continue;
      const revision = randomUUID();
      this.db.prepare(`INSERT INTO translations(item_id,feed_id,revision,body_json) VALUES (?,?,?,?)
        ON CONFLICT(item_id) DO UPDATE SET revision=excluded.revision,body_json=excluded.body_json,status='pending',attempts=0,next_at=0,error=NULL
        WHERE translations.revision!=excluded.revision`).run(String(row.id), feed.id, revision, JSON.stringify({ html, sourceTitle: String(row.title) }));
    }
  }
  sourceState(id: string): { etag?: string; modified?: string } {
    const row = this.db.prepare('SELECT etag,modified FROM rss_sources WHERE feed_id=?').get(id);
    return { etag: row?.etag ? String(row.etag) : undefined, modified: row?.modified ? String(row.modified) : undefined };
  }
  hasSource(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM rss_sources WHERE feed_id=?').get(id); }
  saveSource(id: string, result: SourceResult): void {
    this.db.prepare('INSERT INTO rss_sources(feed_id,etag,modified,seen_json) VALUES (?,?,?,?) ON CONFLICT(feed_id) DO UPDATE SET etag=excluded.etag,modified=excluded.modified,seen_json=excluded.seen_json').run(id, result.etag ?? null, result.modified ?? null, JSON.stringify(result.items.map(item => item.key)));
  }
  incoming(id: string, items: SourceItem[]): SourceItem[] {
    const source = this.db.prepare('SELECT seen_json FROM rss_sources WHERE feed_id=?').get(id);
    if (!source) return items.slice(0, 20);
    const seen = new Set<string>(JSON.parse(String(source.seen_json)));
    return items.filter(item => !seen.has(item.key) || !!this.db.prepare('SELECT 1 FROM feed_items WHERE feed_id=? AND normalized_key=?').get(id, item.key));
  }
  resetSource(id: string): void { this.db.prepare('DELETE FROM rss_sources WHERE feed_id=?').run(id); }
  upsert(feed: Feed, items: SourceItem[]): { itemCount: number; newItemCount: number } {
    let newItemCount = 0;
    for (const item of items) {
      const existing = this.db.prepare('SELECT id,title,description FROM feed_items WHERE feed_id=? AND normalized_key=?').get(feed.id, item.key);
      const id = existing ? String(existing.id) : `item_${randomUUID()}`;
      const changed = !existing || existing.title !== item.title || existing.description !== item.html;
      if (!existing) {
        this.db.prepare('INSERT INTO feed_items(id,feed_id,normalized_key,title,link,description,published_at,published_at_source,first_seen_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id, feed.id, item.key, item.title, item.link, item.html, item.publishedAt ?? null, item.publishedAt ? 'absolute' : null, new Date().toISOString());
        newItemCount++;
      } else {
        this.db.prepare('UPDATE feed_items SET title=?,link=?,description=?,published_at=COALESCE(?,published_at) WHERE id=?').run(item.title, item.link, item.html, item.publishedAt ?? null, id);
      }
      if (changed) this.db.prepare(`INSERT INTO translations(item_id,feed_id,revision,body_json) VALUES (?,?,?,?)
        ON CONFLICT(item_id) DO UPDATE SET revision=excluded.revision,body_json=excluded.body_json,status='pending',attempts=0,next_at=0,error=NULL`)
        .run(id, feed.id, randomUUID(), JSON.stringify({ html: item.html }));
    }
    this.db.prepare('DELETE FROM feed_items WHERE feed_id=? AND id NOT IN (SELECT id FROM feed_items WHERE feed_id=? ORDER BY first_seen_at DESC,rowid ASC LIMIT 100)').run(feed.id, feed.id);
    return { itemCount: items.length, newItemCount };
  }
  decorate(feed: Feed, items: FeedItem[]): FeedItem[] {
    return items.map(item => {
      const row = this.db.prepare('SELECT status,error,body_json FROM translations WHERE item_id=?').get(item.id);
      const body: TranslationBody = row ? JSON.parse(String(row.body_json)) : { html: item.description ?? '' };
      const done = row?.status === 'success' && typeof body.title === 'string' && !!body.title.trim() && typeof body.translatedHtml === 'string' && typeof body.bilingualHtml === 'string';
      const bilingual = feed.translationMode !== 'chinese';
      return { ...item, title: done && body.title ? bilingual ? `${body.title} / ${item.title}` : body.title : item.title,
        contentHtml: safeHtml(done ? (bilingual ? body.bilingualHtml : body.translatedHtml) ?? body.html : `<p>【${row?.status === 'failed' ? '翻译失败，暂显示原文' : '等待翻译，暂显示原文'}】</p>${body.html}`, item.link),
        description: undefined,
        translationStatus: done ? 'success' : row?.status === 'failed' ? 'failed' : 'pending',
        translationError: row?.error ? String(row.error) : undefined };
    });
  }
  stats(id: string) {
    const result = { pending: 0, success: 0, failed: 0 };
    for (const row of this.db.prepare('SELECT status,COUNT(*) AS count FROM translations WHERE feed_id=? GROUP BY status').all(id)) {
      const status = row.status === 'success' ? 'success' : row.status === 'failed' ? 'failed' : 'pending';
      result[status] += Number(row.count);
    }
    return result;
  }
  retry(id: string): void {
    this.db.prepare("UPDATE translations SET status='pending',attempts=0,next_at=0,error=NULL,revision=? WHERE feed_id=? AND status!='success'").run(randomUUID(), id);
  }
  invalidate(id: string): void {
    this.db.prepare("UPDATE translations SET revision=?,status=CASE WHEN status='running' THEN 'pending' ELSE status END WHERE feed_id=?").run(randomUUID(), id);
  }
  recover(): void { this.db.prepare("UPDATE translations SET status='pending' WHERE status='running'").run(); }
  next(): Job | undefined {
    return this.db.prepare(`SELECT t.*,i.title,i.link FROM translations t JOIN feeds f ON f.id=t.feed_id JOIN feed_items i ON i.id=t.item_id
      WHERE f.enabled=1 AND f.translation_mode IN ('chinese','bilingual') AND t.status='pending' AND t.next_at<=? ORDER BY t.next_at,i.first_seen_at DESC LIMIT 1`).get(Date.now()) as unknown as Job | undefined;
  }
  valid(job: Job): boolean {
    return !!this.db.prepare("SELECT 1 FROM translations t JOIN feeds f ON f.id=t.feed_id WHERE t.item_id=? AND t.revision=? AND f.enabled=1 AND f.translation_mode IN ('chinese','bilingual')").get(job.item_id, job.revision);
  }
  begin(job: Job): void { this.db.prepare("UPDATE translations SET status='running' WHERE item_id=? AND revision=?").run(job.item_id, job.revision); }
  finish(job: Job, body: TranslationBody): void {
    if (this.valid(job)) this.db.prepare("UPDATE translations SET status='success',body_json=?,error=NULL WHERE item_id=? AND revision=?").run(JSON.stringify(body), job.item_id, job.revision);
  }
  fail(job: Job, message: string, retryMs: number, interrupted: boolean): void {
    if (!this.valid(job)) return;
    const attempts = job.attempts + (interrupted ? 0 : 1);
    this.db.prepare('UPDATE translations SET status=?,attempts=?,next_at=?,error=? WHERE item_id=? AND revision=?')
      .run(attempts >= 3 ? 'failed' : 'pending', attempts, interrupted ? 0 : Date.now() + Math.max(retryMs, attempts === 1 ? 60_000 : 300_000), interrupted ? null : message, job.item_id, job.revision);
  }
  cached(text: string): string | undefined {
    const key = digest(`google-browser:v2:zh-CN:${text}`);
    const row = this.db.prepare('SELECT text FROM translation_cache WHERE key=?').get(key);
    if (row) this.db.prepare('UPDATE translation_cache SET touched_at=? WHERE key=?').run(Date.now(), key);
    return row ? String(row.text) : undefined;
  }
  cache(text: string, translated: string): void {
    this.db.prepare('INSERT INTO translation_cache(key,text,touched_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET text=excluded.text,touched_at=excluded.touched_at').run(digest(`google-browser:v2:zh-CN:${text}`), translated, Date.now());
  }
  prune(): void { this.db.prepare('DELETE FROM translation_events WHERE at<?').run(Date.now() - 7 * 86400_000);  this.db.prepare('DELETE FROM translation_cache WHERE key NOT IN (SELECT key FROM translation_cache ORDER BY touched_at DESC LIMIT 20000)').run(); }
}

const blocks = new Set(['p', 'div', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'figcaption']);
const isElement = (node: AnyNode): node is AnyNode & { name: string; children: AnyNode[] } => 'name' in node && 'children' in node;
const hasBlock = (node: AnyNode): boolean => isElement(node) && node.children.some(child => isElement(child) && (blocks.has(child.name) || hasBlock(child)));

/** Bounded work, ordered results, and no orphan promises on partial failure. */
async function parallelMap<T, R>(values: T[], concurrency: number, map: (value: T) => Promise<R>): Promise<R[]> {
  const output: R[] = new Array(values.length);
  let next = 0, failed = false;
  let error: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed && next < values.length) {
      const index = next++;
      try { output[index] = await map(values[index]); }
      catch (reason) { if (!failed) { failed = true; error = reason; } }
    }
  }));
  if (failed) throw error;
  return output;
}

/** Translate independent text in parallel, then assemble the original DOM order. */
export async function translateBody(html: string, translate: (text: string) => Promise<string>): Promise<{ translatedHtml: string; bilingualHtml: string }> {
  const tree = parseDocument(html);
  const nodes: Array<Extract<AnyNode, { data: string }>> = [];
  function collect(node: AnyNode): void {
    if (node.type === 'text' && /[A-Za-z\u00c0-\u024f]/.test(node.data)) nodes.push(node);
    else if (isElement(node) && !['pre', 'code'].includes(node.name)) node.children.forEach(collect);
  }
  tree.children.forEach(collect);
  const translatedNodes = new Map<AnyNode, string>();
  await parallelMap(nodes, 16, async node => { translatedNodes.set(node, escapeXml(await translate(node.data))); });
  function walk(node: AnyNode): { translated: string; bilingual: string } {
    if (node.type === 'text') {
      const translated = translatedNodes.get(node) ?? escapeXml(node.data);
      return { translated, bilingual: translated === escapeXml(node.data) ? translated : `${translated}<br/>${escapeXml(node.data)}` };
    }
    if (!isElement(node)) return { translated: '', bilingual: '' };
    if (['pre', 'code', 'img', 'br', 'hr'].includes(node.name)) { const raw = serialize(node); return { translated: raw, bilingual: raw }; }
    const outer = serialize(node); const open = outer.slice(0, outer.indexOf('>') + 1); const close = `</${node.name}>`;
    const children = node.children.map(walk);
    const translated = open + children.map(c => c.translated).join('') + close;
    const leafBlock = blocks.has(node.name) && !hasBlock(node);
    const original = serialize(node);
    const bilingual = leafBlock && translated !== original ? open + children.map(c => c.translated).join('') + '<br/>' + node.children.map(c => serialize(c)).join('').replace(/<img\b[^>]*>/gi, '') + close : open + children.map(c => c.bilingual).join('') + close;
    return { translated, bilingual };
  }
  const rendered = tree.children.map(walk);
  return { translatedHtml: rendered.map(r => r.translated).join(''), bilingualHtml: rendered.map(r => r.bilingual).join('') };
}

interface QueuedTranslation {
  text: string;
  signal: AbortSignal;
  resolve: (text: string) => void;
  reject: (error: unknown) => void;
}

export class TranslationWorker {
  private stopped = true;
  private timer?: NodeJS.Timeout;
  private requestTimer?: NodeJS.Timeout;
  private active = new Set<Promise<void>>();
  private controller = new AbortController();
  private nextLaunch = 0;
  private cooldownUntil = 0;
  private requests = new Map<string, Promise<string>>();
  private requestQueue: QueuedTranslation[] = [];
  private activeRequests = 0;
  constructor(private store: RssTranslations, private translate: Translator = googleTranslate,
    private options: number | (() => ApplicationSettings['translation']) = () => ({ concurrency: 6, requestIntervalMs: 100 }),
    private notify?: (feedId: string, error?: string) => void) {}

  private settings(): ApplicationSettings['translation'] {
    return typeof this.options === 'number' ? { concurrency: 6, requestIntervalMs: this.options } : this.options();
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false; this.controller = new AbortController(); this.nextLaunch = 0;
    this.store.recover(); this.timer = setInterval(() => this.wake(), 1000); this.timer.unref(); this.wake();
  }
  wake(): void {
    if (this.stopped || Date.now() < this.cooldownUntil) return;
    while (this.active.size < this.settings().concurrency) {
      const job = this.store.next(); if (!job) break;
      this.store.begin(job);
      this.store.event(job, `开始翻译，第 ${job.attempts + 1} 次尝试`);
      const work = this.run(job).catch(() => { console.error('RSS 翻译后台任务失败，将在重启后恢复'); }).finally(() => {
        this.active.delete(work); if (!this.stopped) this.wake();
      });
      this.active.add(work);
    }
  }
  private segment(text: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const cached = this.store.cached(text); if (cached !== undefined) return Promise.resolve(cached);
    const active = this.requests.get(text); if (active) return active;
    const work = new Promise<string>((resolve, reject) => {
      this.requestQueue.push({ text, signal, resolve, reject });
    }).finally(() => this.requests.delete(text));
    this.requests.set(text, work);
    if (!this.requestTimer) this.requestTimer = setTimeout(() => { this.requestTimer = undefined; this.pumpRequests(); }, 10);
    return work;
  }
  /** A single global gate bounds actual HTTP requests, across articles and nodes. */
  private pumpRequests(): void {
    if (this.requestTimer) { clearTimeout(this.requestTimer); this.requestTimer = undefined; }
    if (this.stopped) return;
    const settings = this.settings();
    while (this.activeRequests < settings.concurrency && this.requestQueue.length) {
      const wait = Math.max(this.nextLaunch, this.cooldownUntil) - Date.now();
      if (wait > 0) {
        this.requestTimer = setTimeout(() => this.pumpRequests(), wait); this.requestTimer.unref(); return;
      }
      const job = this.requestQueue.shift()!;
      if (job.signal.aborted) { job.reject(job.signal.reason); continue; }
      const batch = [job];
      let size = job.text.length;
      if (this.translate === googleTranslate) {
        while (this.requestQueue.length && batch.length < googleBatchLimits.segments && size + this.requestQueue[0].text.length <= googleBatchLimits.characters) {
          const next = this.requestQueue.shift()!;
          if (next.signal.aborted) { next.reject(next.signal.reason); continue; }
          size += next.text.length; batch.push(next);
        }
      }
      this.nextLaunch = Date.now() + settings.requestIntervalMs;
      this.activeRequests++;
      void (async () => {
        const results = this.translate === googleTranslate ? await googleTranslateBatch(batch.map(part => part.text), job.signal) : [await this.translate(job.text, job.signal)];
        job.signal.throwIfAborted();
        for (let i = 0; i < batch.length; i++) {
          if (!results[i]?.trim()) throw new TranslationError('翻译服务返回了空译文');
        }
        for (let i = 0; i < batch.length; i++) {
          this.store.cache(batch[i].text, results[i]); batch[i].resolve(results[i]);
        }
      })().catch(error => {
        if (!job.signal.aborted && error instanceof TranslationError && error.rateLimited) {
          this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.max(60_000, error.retryAfterMs));
          // Fail queued segments promptly so articles can persist retries without
          // holding partial jobs open throughout the provider's cooldown.
          for (const pending of this.requestQueue.splice(0)) pending.reject(error);
        }
        for (const part of batch) part.reject(error);
      }).finally(() => { this.activeRequests--; this.pumpRequests(); });
    }
  }
  private async run(job: Job): Promise<void> {
    const signal = this.controller.signal;
    let completed = 0, submitted = 0, cached = 0;
    try {
      const translate = async (text: string): Promise<string> => {
        const points = Array.from(text); const parts: string[] = [];
        for (let i = 0; i < points.length; i += 1000) parts.push(points.slice(i, i + 1000).join(''));
        const output = await parallelMap(parts, 16, async part => {
          signal.throwIfAborted(); if (!this.store.valid(job)) throw Error('stale');
          submitted++;
          if (this.store.cached(part) !== undefined) cached++;
          const result = await this.segment(part, signal);
          completed++;
          this.store.event(job, `已完成 ${completed} 个片段（已提交 ${submitted}，缓存命中 ${cached}）`);
          return result;
        });
        return output.join('');
      };
      const original: TranslationBody = JSON.parse(job.body_json);
      const [title, body] = await Promise.allSettled([translate(job.title), translateBody(original.html, translate)]);
      if (title.status === 'rejected') throw title.reason;
      if (body.status === 'rejected') throw body.reason;
      signal.throwIfAborted();
      this.store.event(job, `翻译完成，共 ${completed} 个片段，缓存命中 ${cached}，即将发布`);
      this.store.finish(job, { ...original, title: title.value, ...body.value });
      if (this.store.valid(job)) this.notify?.(job.feed_id);
    } catch (error) {
      const retryMs = error instanceof TranslationError ? error.retryAfterMs : 0;
      this.store.event(job, signal.aborted ? '翻译中断，恢复运行后继续' : `${error instanceof TranslationError ? error.message : '翻译连接失败'}；${job.attempts >= 2 ? '已达重试上限' : '已安排自动重试'}`);
      this.store.fail(job, error instanceof TranslationError ? error.message : 'Google 免费翻译连接失败，请检查服务主机网络后重试', retryMs, signal.aborted);
      if (!signal.aborted && this.store.valid(job)) this.notify?.(job.feed_id, error instanceof TranslationError ? error.message : 'Google 免费翻译连接失败');
    }
  }
  status() { return { activeArticles: this.active.size, activeRequests: this.activeRequests, queuedSegments: this.requestQueue.length, cooldownUntil: this.cooldownUntil > Date.now() ? this.cooldownUntil : null, stopped: this.stopped }; }
  retry(): void { this.wake(); }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.controller.abort();
    for (const pending of this.requestQueue.splice(0)) pending.reject(this.controller.signal.reason);
    await Promise.allSettled([...this.active]);
    this.requests.clear();
  }
}
