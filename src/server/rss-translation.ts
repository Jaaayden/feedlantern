import { isFeedSource, translationEnabled } from '../shared/types.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseDocument } from 'htmlparser2';
type AnyNode = ReturnType<typeof parseDocument>['children'][number];
import serialize from 'dom-serializer';
import { digest, safeHtml, type SourceItem, type SourceResult } from './rss-source.js';
import { escapeXml, sanitizeDescription } from './rss.js';
import { TRANSLATION_CACHE_LIMIT } from './backups.js';
import { NetworkPolicy } from './network.js';
import { TranslationError, deeplEndpoints, deeplEngine, keepWhitespace, openaiEngine, providerProblem, providerRate, retryAfterMs, type TranslationEngine, type TranslationSettings } from './translation-providers.js';
import { storedItemLimit } from './feed-output.js';
import { lt, msg, tl, translate, withLocale, type LocalizedText } from './i18n.js';
import { ownerLocale, targetLocale } from './user-locale.js';

export const TRANSLATION_EVENTS_PER_FEED = 200;
import { defaultApplicationSettings, isTargetLanguage, isTranslationProvider, type Feed, type FeedItem, type TargetLanguage, type TranslationProviderId, type TranslationRate } from '../shared/types.js';

export { TranslationError };
/** Replaces the Google channel (tests and the e2e backend use a deterministic one). */
export type Translator = (text: string, signal: AbortSignal, target?: TargetLanguage) => Promise<string>;
/** The original Google + simplified Chinese namespace; existing cache entries keep their keys. */
export const DEFAULT_CACHE_NAMESPACE = 'google-browser:v2:zh-CN';
// Public browser client key shipped in Immersive Translate 1.33.1, not a user's
// Cloud API credential. Protocol: https://download.immersivetranslate.com/immersive-translate.user.js
const googleBrowserClientKey = 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520';
export const googleBatchLimits = { segments: 50, characters: 1800 } as const;

/** Browser translation returns one HTML result per input, in array order. */
export async function googleTranslateBatch(texts: string[], signal: AbortSignal, target: TargetLanguage = 'zh-CN'): Promise<string[]> {
  if (!texts.length) return [];
  if (texts.length > googleBatchLimits.segments) throw new TranslationError(msg('translate.batchTooLarge'));
  const response = await fetch('https://translate-pa.googleapis.com/v1/translateHtml', {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    headers: { 'content-type': 'application/json+protobuf', 'x-goog-api-key': googleBrowserClientKey },
    // Escape text nodes so literal <tags> are translated as text, not interpreted as HTML.
    body: JSON.stringify([[texts.map(escapeXml), 'auto', target], 'te_lib']),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const retryMs = retryAfterMs(response.headers.get('retry-after'));
    const limited = response.status === 429 || retryMs > 0;
    throw new TranslationError(limited ? msg('translate.googleLimited') : response.status === 403 ? msg('translate.googleForbidden') : msg('translate.unavailable', { service: msg('provider.google'), status: String(response.status) }), retryMs, limited);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TranslationError(msg('translate.googleEmptyResponse'));
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > 100_000) throw new TranslationError(msg('translate.responseTooLarge'));
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const textBody = Buffer.concat(chunks).toString('utf8');
  let body: unknown;
  try { body = JSON.parse(textBody); } catch { throw new TranslationError(msg('translate.googleNotTranslation'), 0, /automated queries|unusual traffic|<title>Sorry/i.test(textBody)); }
  if (!Array.isArray(body) || !Array.isArray(body[0]) || body[0].length !== texts.length || !body[0].every((value: unknown) => typeof value === 'string')) throw new TranslationError(msg('translate.mismatch', { service: 'Google' }));
  return (body[0] as string[]).map((html, i) => {
    const parts: string[] = [];
    const collect = (node: AnyNode): void => {
      if (node.type === 'text') parts.push(node.data);
      else if ('children' in node) node.children.forEach(collect);
    };
    parseDocument(html).children.forEach(collect);
    const text = parts.join('').trim();
    if (!text) throw new TranslationError(msg('translate.empty', { service: 'Google' }));
    return keepWhitespace(texts[i], text);
  });
}

export const googleTranslate: Translator = async (text, signal) => (await googleTranslateBatch([text], signal))[0];

interface TranslationBody { actorId?: string; sourceTitle?: string; html: string; title?: string; translatedHtml?: string; bilingualHtml?: string }
interface Job { owner_id: string; item_id: string; feed_id: string; revision: string; attempts: number; body_json: string; title: string; link: string; provider?: string; target_language?: string }

export class RssTranslations {
  constructor(private db: DatabaseSync, private userSignal: (id: string) => AbortSignal = () => new AbortController().signal) {
    db.exec(`CREATE TABLE IF NOT EXISTS rss_sources (feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE, etag TEXT, modified TEXT, seen_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS translations (
        item_id TEXT PRIMARY KEY REFERENCES feed_items(id) ON DELETE CASCADE,
        feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        revision TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, error TEXT, body_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS translations_due ON translations(status,next_at);
      CREATE INDEX IF NOT EXISTS translations_feed_status ON translations(feed_id,status);
      CREATE TABLE IF NOT EXISTS translation_events (id INTEGER PRIMARY KEY AUTOINCREMENT, feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, item_id TEXT, at INTEGER NOT NULL, message TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS translation_events_feed ON translation_events(feed_id,id);
      CREATE TABLE IF NOT EXISTS translation_cache (key TEXT PRIMARY KEY, text TEXT NOT NULL, touched_at INTEGER NOT NULL);`);
  }
  /** Stored in the feed owner's language; the server log is in English. */
  event(job: Job, text: LocalizedText): void {
    if (!this.valid(job)) return;
    this.db.prepare('INSERT INTO translation_events(feed_id,item_id,at,message) VALUES (?,?,?,?)').run(job.feed_id, job.item_id, Date.now(), lt(text));
    console.info(`[RSS translation] feed=${job.feed_id} item=${job.item_id} ${translate('en', text.key, text.params)}`);
  }
  ownerLocale(job: Pick<Job, 'owner_id'>) { return ownerLocale(this.db, job.owner_id); }
  progress(id: string) {
    return {
      tasks: this.db.prepare(`SELECT t.item_id AS id,i.title,t.status,t.attempts,t.next_at AS nextAt,t.error FROM translations t JOIN feed_items i ON i.id=t.item_id WHERE t.feed_id=? ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,i.first_seen_at DESC LIMIT 100`).all(id),
      logs: this.db.prepare('SELECT id,at,message,item_id AS itemId FROM translation_events WHERE feed_id=? ORDER BY id DESC LIMIT 100').all(id),
    };
  }
  syncWebsite(feed: Feed): void {
    if (isFeedSource(feed) || !translationEnabled(feed)) return;
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
    this.db.prepare('DELETE FROM feed_items WHERE feed_id=? AND id NOT IN (SELECT id FROM feed_items WHERE feed_id=? ORDER BY first_seen_at DESC,rowid ASC LIMIT ?)').run(feed.id, feed.id, storedItemLimit(feed));
    return { itemCount: items.length, newItemCount };
  }
  decorate(feed: Feed, items: FeedItem[]): FeedItem[] {
    return items.map(item => {
      const row = this.db.prepare('SELECT status,error,body_json FROM translations WHERE item_id=?').get(item.id);
      const body: TranslationBody = row ? JSON.parse(String(row.body_json)) : { html: item.description ?? '' };
      const done = row?.status === 'success' && typeof body.title === 'string' && !!body.title.trim() && typeof body.translatedHtml === 'string' && typeof body.bilingualHtml === 'string';
      const bilingual = feed.translationMode !== 'translated';
      return { ...item, title: done && body.title ? bilingual ? `${body.title} / ${item.title}` : body.title : item.title,
        // The note is part of the feed, so it follows the feed's target language.
        contentHtml: safeHtml(done ? (bilingual ? body.bilingualHtml : body.translatedHtml) ?? body.html : `<p>${escapeXml(translate(targetLocale(feed.targetLanguage), row?.status === 'failed' ? 'translate.noteFailed' : 'translate.notePending'))}</p>${body.html}`, item.link),
        description: undefined,
        ...(done && body.title ? { translatedTitle: body.title, sourceTitle: item.title } : {}),
        translationStatus: done ? 'success' : row?.status === 'failed' ? 'failed' : 'pending',
        translationError: row?.error ? String(row.error) : undefined };
    });
  }
  stats(id: string) {
    return this.statsForFeeds([id]).get(id)!;
  }
  /** Read only the requested feeds, including zero counts for feeds without jobs. */
  statsForFeeds(ids: readonly string[]): Map<string, NonNullable<Feed['translation']>> {
    const result = new Map(ids.map(id => [id, { pending: 0, success: 0, failed: 0 }]));
    if (!ids.length) return result;
    for (const row of this.db.prepare(`SELECT feed_id,status,COUNT(*) AS count FROM translations
      WHERE feed_id IN (SELECT value FROM json_each(?)) GROUP BY feed_id,status`).all(JSON.stringify(ids))) {
      const status = row.status === 'success' ? 'success' : row.status === 'failed' ? 'failed' : 'pending';
      result.get(String(row.feed_id))![status] += Number(row.count);
    }
    return result;
  }
  retry(id: string, actorId?: string): void {
    this.db.prepare("UPDATE translations SET status='pending',attempts=0,next_at=0,error=NULL,revision=?,body_json=json_set(body_json,'$.actorId',?) WHERE feed_id=? AND status!='success'").run(randomUUID(), actorId ?? null, id);
  }
  suspendActor(id: string): void {
    this.db.prepare("UPDATE translations SET revision=?,status=CASE WHEN status='running' THEN 'pending' ELSE status END WHERE json_extract(body_json,'$.actorId')=? AND status IN ('pending','running')").run(randomUUID(), id);
  }
  cancelActor(id: string): void {
    this.db.prepare("UPDATE translations SET status='failed',revision=?,error=? WHERE json_extract(body_json,'$.actorId')=? AND status IN ('pending','running') AND feed_id IN (SELECT id FROM feeds WHERE owner_id!=?)").run(randomUUID(), tl('translate.actorChanged'), id, id);
  }
  /** A new service or target language: every article is translated again (cache hits stay free). */
  retranslate(id: string): void {
    this.db.prepare("UPDATE translations SET revision=?,status='pending',attempts=0,next_at=0,error=NULL WHERE feed_id=?").run(randomUUID(), id);
  }
  invalidate(id: string): void {
    this.db.prepare("UPDATE translations SET revision=?,status=CASE WHEN status='running' THEN 'pending' ELSE status END WHERE feed_id=?").run(randomUUID(), id);
  }
  recover(): void { this.db.prepare("UPDATE translations SET status='pending' WHERE status='running'").run(); }
  /** The next due article, skipping services that are cooling down or already at capacity. */
  next(defaultProvider: TranslationProviderId = 'google', skip: TranslationProviderId[] = []): Job | undefined {
    return this.db.prepare(`SELECT * FROM (SELECT t.*,f.owner_id,i.title,i.link,i.first_seen_at,COALESCE(f.translation_provider,?) AS provider,f.target_language FROM translations t JOIN feeds f ON f.id=t.feed_id JOIN feed_items i ON i.id=t.item_id
      WHERE f.enabled=1 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=f.owner_id AND u.enabled=0) AND f.translation_mode IN ('translated','bilingual') AND (json_extract(t.body_json,'$.actorId') IS NULL OR EXISTS (SELECT 1 FROM users actor WHERE actor.id=json_extract(t.body_json,'$.actorId') AND actor.enabled=1 AND (actor.id=f.owner_id OR actor.role='admin'))) AND t.status='pending' AND t.next_at<=?)
      WHERE provider NOT IN (SELECT value FROM json_each(?)) ORDER BY next_at,first_seen_at DESC LIMIT 1`).get(defaultProvider, Date.now(), JSON.stringify(skip)) as unknown as Job | undefined;
  }
  signal(job: Job): AbortSignal { const actor = (JSON.parse(job.body_json) as TranslationBody).actorId; return AbortSignal.any([this.userSignal(job.owner_id), ...(actor ? [this.userSignal(actor)] : [])]); }
  valid(job: Job): boolean {
    return !!this.db.prepare("SELECT 1 FROM translations t JOIN feeds f ON f.id=t.feed_id WHERE t.item_id=? AND t.revision=? AND f.enabled=1 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=f.owner_id AND u.enabled=0) AND f.translation_mode IN ('translated','bilingual') AND (json_extract(t.body_json,'$.actorId') IS NULL OR EXISTS (SELECT 1 FROM users actor WHERE actor.id=json_extract(t.body_json,'$.actorId') AND actor.enabled=1 AND (actor.id=f.owner_id OR actor.role='admin')))").get(job.item_id, job.revision);
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
  cached(text: string, namespace = DEFAULT_CACHE_NAMESPACE): string | undefined {
    const key = digest(`${namespace}:${text}`);
    const row = this.db.prepare('SELECT text FROM translation_cache WHERE key=?').get(key);
    if (row) this.db.prepare('UPDATE translation_cache SET touched_at=? WHERE key=?').run(Date.now(), key);
    return row ? String(row.text) : undefined;
  }
  cache(text: string, translated: string, namespace = DEFAULT_CACHE_NAMESPACE): void {
    this.db.prepare('INSERT INTO translation_cache(key,text,touched_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET text=excluded.text,touched_at=excluded.touched_at').run(digest(`${namespace}:${text}`), translated, Date.now());
  }
  /** The UI shows the latest 100 events per feed; this bounds the table however fast events arrive. */
  prune(): void {
    this.db.prepare('DELETE FROM translation_events WHERE at<?').run(Date.now() - 7 * 86400_000);
    this.db.prepare('DELETE FROM translation_events WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY feed_id ORDER BY id DESC) AS n FROM translation_events) WHERE n > ?)').run(TRANSLATION_EVENTS_PER_FEED);
    this.db.prepare('DELETE FROM translation_cache WHERE key NOT IN (SELECT key FROM translation_cache ORDER BY touched_at DESC LIMIT ?)').run(TRANSLATION_CACHE_LIMIT);
  }
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
  ownerId: string;
  text: string;
  engine: TranslationEngine;
  signal: AbortSignal;
  resolve: (text: string) => void;
  reject: (error: unknown) => void;
}

/** Each service has its own queue, concurrency, launch interval and rate-limit cooldown. */
interface Gate { queue: QueuedTranslation[]; active: number; nextLaunch: number; cooldownUntil: number; timer?: NodeJS.Timeout }

export interface TranslationNetwork {
  /** Outbound policy for DeepL and OpenAI-compatible services (the current allow-list and DNS settings). */
  policy?: () => NetworkPolicy;
  /** Test-only replacement for DeepL's fixed endpoints. */
  deeplEndpoints?: { free: string; pro: string };
}
type SettingsSource = number | (() => Partial<TranslationSettings> & TranslationRate);
const providers: TranslationProviderId[] = ['google', 'deepl', 'openai'];

export class TranslationWorker {
  private stopped = true;
  private timer?: NodeJS.Timeout;
  private active = new Map<Promise<void>, TranslationProviderId>();
  private controller = new AbortController();
  private gates = new Map<TranslationProviderId, Gate>();
  private requests = new Map<string, Promise<string>>();
  constructor(private store: RssTranslations, private translate: Translator = googleTranslate,
    private options: SettingsSource = () => defaultApplicationSettings.translation,
    private notify?: (feedId: string, error?: string) => void, private network: TranslationNetwork = {}) {}

  private settings(): TranslationSettings {
    const base = defaultApplicationSettings.translation;
    return typeof this.options === 'number' ? { ...base, concurrency: 6, requestIntervalMs: this.options } : { ...base, ...this.options() };
  }
  private gate(provider: TranslationProviderId): Gate {
    let gate = this.gates.get(provider);
    if (!gate) { gate = { queue: [], active: 0, nextLaunch: 0, cooldownUntil: 0 }; this.gates.set(provider, gate); }
    return gate;
  }
  private articles(provider: TranslationProviderId): number {
    let count = 0; for (const value of this.active.values()) if (value === provider) count++;
    return count;
  }
  /** The engine for one service and target language, built from the current settings. */
  engine(provider: TranslationProviderId, target: TargetLanguage, settings = this.settings()): TranslationEngine {
    const policy = this.network.policy ?? (() => new NetworkPolicy());
    if (provider === 'deepl') return { ...deeplEngine(target, settings.deepl, policy, this.network.deeplEndpoints ?? deeplEndpoints), unavailable: providerProblem(settings, 'deepl') };
    if (provider === 'openai') return { ...openaiEngine(target, settings.openai, policy), unavailable: providerProblem(settings, 'openai') };
    const native = this.translate === googleTranslate;
    return {
      provider: 'google', label: msg('provider.google'), namespace: `google-browser:v2:${target}`,
      batch: native ? googleBatchLimits : { segments: 1, characters: Infinity },
      translate: native ? (texts, signal) => googleTranslateBatch(texts, signal, target) : async (texts, signal) => [await this.translate(texts[0], signal, target)],
    };
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false; this.controller = new AbortController();
    for (const gate of this.gates.values()) gate.nextLaunch = 0;
    this.store.recover(); this.timer = setInterval(() => this.wake(), 1000); this.timer.unref(); this.wake();
  }
  wake(): void {
    if (this.stopped) return;
    for (;;) {
      const settings = this.settings(), now = Date.now();
      const skip = providers.filter(provider => this.gate(provider).cooldownUntil > now || this.articles(provider) >= providerRate(settings, provider).concurrency);
      if (skip.length === providers.length) break;
      const job = this.store.next(settings.defaultProvider, skip); if (!job) break;
      const provider = isTranslationProvider(job.provider) ? job.provider : 'google';
      this.store.begin(job);
      // Progress and errors are stored in the language of the feed's owner.
      const work = withLocale(() => this.store.ownerLocale(job), () => {
        this.store.event(job, msg('translate.started', { attempt: job.attempts + 1 }));
        return this.run(job, provider);
      }).catch(() => { console.error('RSS translation task failed; it resumes after a restart'); }).finally(() => {
        this.active.delete(work); if (!this.stopped) this.wake();
      });
      this.active.set(work, provider);
    }
  }
  private segment(text: string, signal: AbortSignal, ownerId: string, engine: TranslationEngine): Promise<string> {
    signal.throwIfAborted();
    const cached = this.store.cached(text, engine.namespace); if (cached !== undefined) return Promise.resolve(cached);
    const key = `${engine.namespace}\u0000${ownerId}\u0000${text}`;
    const active = this.requests.get(key); if (active) return active;
    const gate = this.gate(engine.provider);
    const work = new Promise<string>((resolve, reject) => {
      gate.queue.push({ ownerId, text, engine, signal, resolve, reject });
    }).finally(() => this.requests.delete(key));
    this.requests.set(key, work);
    if (!gate.timer) gate.timer = setTimeout(() => { gate.timer = undefined; this.pump(engine.provider); }, 10);
    return work;
  }
  /** One gate per service bounds its actual HTTP requests, across articles and nodes. */
  private pump(provider: TranslationProviderId): void {
    const gate = this.gate(provider);
    if (gate.timer) { clearTimeout(gate.timer); gate.timer = undefined; }
    if (this.stopped) return;
    const rate = providerRate(this.settings(), provider);
    while (gate.active < rate.concurrency && gate.queue.length) {
      const wait = Math.max(gate.nextLaunch, gate.cooldownUntil) - Date.now();
      if (wait > 0) {
        gate.timer = setTimeout(() => this.pump(provider), wait); gate.timer.unref(); return;
      }
      const job = gate.queue.shift()!;
      if (job.signal.aborted) { job.reject(job.signal.reason); continue; }
      const batch = [job];
      let size = job.text.length;
      const limits = job.engine.batch;
      while (gate.queue.length && gate.queue[0].ownerId === job.ownerId && gate.queue[0].engine.namespace === job.engine.namespace && batch.length < limits.segments && size + gate.queue[0].text.length <= limits.characters) {
        const next = gate.queue.shift()!;
        if (next.signal.aborted) { next.reject(next.signal.reason); continue; }
        size += next.text.length; batch.push(next);
      }
      gate.nextLaunch = Date.now() + rate.requestIntervalMs;
      gate.active++;
      void (async () => {
        const results = await job.engine.translate(batch.map(part => part.text), job.signal);
        job.signal.throwIfAborted();
        if (results.length !== batch.length) throw new TranslationError(msg('translate.countMismatch'));
        for (let i = 0; i < batch.length; i++) {
          if (!results[i]?.trim()) throw new TranslationError(msg('translate.emptyResult'));
        }
        for (let i = 0; i < batch.length; i++) {
          this.store.cache(batch[i].text, results[i], job.engine.namespace); batch[i].resolve(results[i]);
        }
      })().catch(error => {
        if (!job.signal.aborted && error instanceof TranslationError && error.rateLimited) {
          gate.cooldownUntil = Math.max(gate.cooldownUntil, Date.now() + Math.max(60_000, error.retryAfterMs));
          // Fail queued segments promptly so articles can persist retries without
          // holding partial jobs open throughout the provider's cooldown.
          for (const pending of gate.queue.splice(0)) pending.reject(error);
        }
        for (const part of batch) part.reject(error);
      }).finally(() => { gate.active--; this.pump(provider); });
    }
  }
  private async run(job: Job, provider: TranslationProviderId): Promise<void> {
    const signal = AbortSignal.any([this.controller.signal, this.store.signal(job)]);
    const engine = this.engine(provider, isTargetLanguage(job.target_language) ? job.target_language : 'zh-CN');
    // Unexpected errors may carry raw socket details; only a fixed message is shown and stored.
    const fallback = msg('translate.connectionFailed', { service: engine.label });
    let completed = 0, submitted = 0, cached = 0;
    try {
      if (engine.unavailable) throw new TranslationError(engine.unavailable);
      const translate = async (text: string): Promise<string> => {
        const points = Array.from(text); const parts: string[] = [];
        for (let i = 0; i < points.length; i += 1000) parts.push(points.slice(i, i + 1000).join(''));
        const output = await parallelMap(parts, 16, async part => {
          signal.throwIfAborted(); if (!this.store.valid(job)) throw Error('stale');
          submitted++;
          if (this.store.cached(part, engine.namespace) !== undefined) cached++;
          const result = await this.segment(part, signal, job.owner_id, engine);
          completed++;
          this.store.event(job, msg('translate.progress', { count: completed, submitted, cached }));
          return result;
        });
        return output.join('');
      };
      const original: TranslationBody = JSON.parse(job.body_json);
      const [title, body] = await Promise.allSettled([translate(job.title), translateBody(original.html, translate)]);
      if (title.status === 'rejected') throw title.reason;
      if (body.status === 'rejected') throw body.reason;
      signal.throwIfAborted();
      this.store.event(job, msg('translate.finished', { count: completed, cached }));
      this.store.finish(job, { ...original, title: title.value, ...body.value });
      if (this.store.valid(job)) this.notify?.(job.feed_id);
    } catch (error) {
      const retryMs = error instanceof TranslationError ? error.retryAfterMs : 0;
      const reason = error instanceof TranslationError ? error.text : msg('translate.connectionFailedShort');
      this.store.event(job, signal.aborted ? msg('translate.interrupted') : msg(job.attempts >= 2 ? 'translate.failedFinal' : 'translate.failedRetry', { reason }));
      this.store.fail(job, lt(error instanceof TranslationError ? error.text : msg('translate.checkNetwork', { reason: fallback })), retryMs, signal.aborted);
      if (!signal.aborted && this.store.valid(job)) this.notify?.(job.feed_id, lt(error instanceof TranslationError ? error.text : fallback));
    }
  }
  /** Queue state for one service, or all of them combined. */
  status(provider?: TranslationProviderId) {
    const now = Date.now();
    const gates = (provider ? [provider] : providers).map(id => this.gate(id));
    const cooldown = Math.max(0, ...gates.map(gate => gate.cooldownUntil));
    return {
      provider: provider ?? null, activeArticles: provider ? this.articles(provider) : this.active.size,
      activeRequests: gates.reduce((sum, gate) => sum + gate.active, 0), queuedSegments: gates.reduce((sum, gate) => sum + gate.queue.length, 0),
      cooldownUntil: cooldown > now ? cooldown : null, stopped: this.stopped,
    };
  }
  retry(): void { this.wake(); }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const gate of this.gates.values()) { if (gate.timer) clearTimeout(gate.timer); gate.timer = undefined; }
    this.controller.abort();
    for (const gate of this.gates.values()) for (const pending of gate.queue.splice(0)) pending.reject(this.controller.signal.reason);
    await Promise.allSettled([...this.active.keys()]);
    this.requests.clear();
  }
}
