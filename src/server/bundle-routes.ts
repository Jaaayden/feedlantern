import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BUNDLE_ITEM_LIMIT, BUNDLE_MAX_FEEDS, type Bundle, type BundleInput, type BundlePayload } from '../shared/types.js';
import { AppError } from './auth.js';
import { bundleEtag, renderBundleRss, type BundleMember } from './bundles.js';
import { etagMatches, renderBundlePreview, wantsHtmlPreview } from './rss-preview.js';
import type { Store } from './store.js';
import { asInteger, asNonEmptyString, asRecord } from './validation.js';

function parseFeedIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > BUNDLE_MAX_FEEDS || !value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)) {
    throw new AppError(400, `请选择最多 ${BUNDLE_MAX_FEEDS} 个订阅`);
  }
  return value as string[];
}

/** Every field is optional for an update; a new bundle needs a name. */
export function parseBundleInput(value: unknown, partial = false): Partial<BundleInput> {
  const body = asRecord(value), input: Partial<BundleInput> = {};
  if (!partial || body.name !== undefined) input.name = asNonEmptyString(body.name, '聚合名称', 200);
  if (!partial || body.feedIds !== undefined) input.feedIds = parseFeedIds(body.feedIds ?? []);
  if (body.itemLimit !== undefined) input.itemLimit = asInteger(body.itemLimit, '条目上限', BUNDLE_ITEM_LIMIT.min, BUNDLE_ITEM_LIMIT.max, BUNDLE_ITEM_LIMIT.default);
  if (partial && !Object.keys(input).length) throw new AppError(400, '请提供需要修改的聚合设置');
  return input;
}

/** Members are read from what is already stored: a bundle never triggers a fetch. Paused members keep their items. */
export function bundleMembers(store: Store, bundle: Bundle): BundleMember[] {
  return bundle.feedIds.flatMap(id => {
    const feed = store.getFeed(id);
    return feed ? [{ feed, items: store.getItems(id, 100) }] : [];
  });
}

/**
 * `guard` authenticates the request (CSRF for mutations) and returns the
 * workspace owner; `origin` is the public origin of the current request.
 */
export function registerBundleRoutes(app: FastifyInstance, store: Store, origin: () => string, guard: (request: FastifyRequest) => string): void {
  const bundleUrl = (id: string, token: string) => `${origin()}/bundles/${encodeURIComponent(id)}/${encodeURIComponent(token)}.xml`;
  const payload = (bundle: Bundle): BundlePayload => ({ bundle, bundleUrl: bundleUrl(bundle.id, store.bundles.token(bundle.id)!) });
  const owned = (request: FastifyRequest): Bundle => {
    const owner = guard(request), id = String(asRecord(request.params).id);
    const bundle = store.owns('bundles', id, owner) ? store.bundles.get(id) : null;
    if (!bundle) throw new AppError(404, '聚合订阅不存在');
    return bundle;
  };

  app.get('/api/bundles', async request => store.bundles.list(guard(request)).map(payload));
  app.post('/api/bundles', async request => {
    const owner = guard(request);
    if (store.bundles.list(owner).length >= 200) throw new AppError(400, '每个账号最多创建 200 个聚合订阅');
    return payload(store.bundles.create(parseBundleInput(request.body) as BundleInput, owner).bundle);
  });
  app.get('/api/bundles/:id', async request => payload(owned(request)));
  app.put('/api/bundles/:id', async request => {
    const bundle = owned(request);
    return payload(store.bundles.update(bundle.id, parseBundleInput(request.body, true))!);
  });
  app.post('/api/bundles/:id/feeds', async request => {
    const bundle = owned(request);
    return payload(store.bundles.addFeeds(bundle.id, parseFeedIds(asRecord(request.body).feedIds))!);
  });
  app.post('/api/bundles/:id/rotate-token', async request => {
    const bundle = owned(request);
    store.bundles.rotateToken(bundle.id);
    return payload(store.bundles.get(bundle.id)!);
  });
  app.delete('/api/bundles/:id', async request => {
    store.bundles.delete(owned(request).id);
    return { ok: true };
  });

  app.get('/bundles/:id/:token.xml', async (request, reply) => {
    const params = request.params as { id: string; token: string };
    const token = params.token.endsWith('.xml') ? params.token.slice(0, -4) : params.token;
    if (!store.bundles.checkToken(params.id, token)) throw new AppError(404, '聚合订阅不存在');
    const bundle = store.bundles.get(params.id)!;
    const members = bundleMembers(store, bundle);
    const publicUrl = bundleUrl(bundle.id, token);
    const query = request.query as Record<string, unknown> | undefined;
    const preview = wantsHtmlPreview(request.headers, query);
    const etag = preview ? bundleEtag(bundle, members).replace(/"$/, '-html"') : bundleEtag(bundle, members);
    reply.header('Cache-Control', 'private, max-age=60');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Vary', 'Accept, Sec-Fetch-Dest, Sec-Fetch-Mode');
    reply.header('ETag', etag);
    if (etagMatches(request.headers['if-none-match'], etag)) return reply.code(304).send();
    if (preview) {
      const page = renderBundlePreview(bundle, members, publicUrl);
      reply.header('Content-Security-Policy', page.csp);
      reply.header('X-Frame-Options', 'DENY');
      return reply.type('text/html; charset=utf-8').send(page.html);
    }
    const raw = typeof query?.format === 'string' && request.headers['sec-fetch-dest'] === 'document';
    return reply.type(raw ? 'application/xml; charset=utf-8' : 'application/rss+xml; charset=utf-8').send(renderBundleRss(bundle, members, publicUrl, `${origin()}/`));
  });
}

/** Bundles in the lightweight config file refer to members by their index in the exported `feeds` list. */
export interface ConfigBundle { name: string; itemLimit: number; feeds: number[] }

export function exportConfigBundles(store: Store, ownerId: string, feedIds: string[]): ConfigBundle[] {
  const index = new Map(feedIds.map((id, position) => [id, position]));
  return store.bundles.list(ownerId).map(bundle => ({ name: bundle.name, itemLimit: bundle.itemLimit, feeds: bundle.feedIds.flatMap(id => index.has(id) ? [index.get(id)!] : []) }));
}

/** `bundles` is optional so older config files (and older FeedLantern versions) keep working. */
export function parseConfigBundles(value: unknown, feedCount: number): ConfigBundle[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new AppError(400, '配置中的聚合订阅无效');
  return value.map(raw => {
    const entry = asRecord(raw);
    const feeds = entry.feeds;
    if (!Array.isArray(feeds) || feeds.length > BUNDLE_MAX_FEEDS || !feeds.every(n => Number.isInteger(n) && n >= 0 && n < feedCount)) throw new AppError(400, '配置中的聚合订阅无效');
    return { name: asNonEmptyString(entry.name, '聚合名称', 200), itemLimit: asInteger(entry.itemLimit, '条目上限', BUNDLE_ITEM_LIMIT.min, BUNDLE_ITEM_LIMIT.max, BUNDLE_ITEM_LIMIT.default), feeds: [...new Set(feeds as number[])] };
  });
}

/** A bundle whose name the account already uses is skipped, like a duplicate feed. */
export function previewConfigBundles(store: Store, ownerId: string, bundles: ConfigBundle[]) {
  const names = new Set(store.bundles.list(ownerId).map(bundle => bundle.name));
  return bundles.map(bundle => { const duplicate = names.has(bundle.name); names.add(bundle.name); return { name: bundle.name, members: bundle.feeds.length, duplicate }; });
}

/** `feedIds[i]` is the created or already existing feed for config entry `i`. */
export function importConfigBundles(store: Store, ownerId: string, bundles: ConfigBundle[], feedIds: Array<string | undefined>) {
  const names = new Set(store.bundles.list(ownerId).map(bundle => bundle.name));
  let created = 0, skipped = 0;
  for (const bundle of bundles) {
    if (names.has(bundle.name)) { skipped++; continue; }
    const members = bundle.feeds.flatMap(index => feedIds[index] ? [feedIds[index]!] : []);
    store.bundles.create({ name: bundle.name, itemLimit: bundle.itemLimit, feedIds: members }, ownerId);
    names.add(bundle.name); created++;
  }
  return { created, skipped };
}
