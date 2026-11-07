import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BUNDLE_DEDUPE_DEFAULT, BUNDLE_ITEM_LIMIT, BUNDLE_MAX_FEEDS, type Bundle, type BundleDedupe, type BundleFilter, type BundlePayload, type BundlePreview, type FeedFormat } from '../shared/types.js';
import { AppError } from './auth.js';
import { bundleEtag, mergeBundleItems, previewBundle, renderBundleAtom, renderBundleJson, renderBundleRss, type BundleMember } from './bundles.js';
import { parseBundleDedupe, parseBundleFilter } from './bundle-settings.js';
import type { BundleSettings } from './bundle-store.js';
import { ItemFilterError } from './feed-output.js';
import { etagMatches, renderBundlePreview, wantsHtmlPreview } from './rss-preview.js';
import type { Store } from './store.js';
import { asInteger, asNonEmptyString, asRecord } from './validation.js';
import { headerLocale, msg, withLocale } from './i18n.js';

function parseFeedIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > BUNDLE_MAX_FEEDS || !value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)) {
    throw new AppError(400, msg('error.bundleFeedCount', { max: BUNDLE_MAX_FEEDS }));
  }
  return value as string[];
}

/**
 * Every field is optional for an update; a new bundle needs a name. `dedupe`
 * changes only the fields given and `itemFilter` replaces the whole filter
 * (`null` removes it), both on top of the bundle's current settings.
 */
export function parseBundleInput(value: unknown, partial = false, current?: Bundle): Partial<BundleSettings> {
  const body = asRecord(value), input: Partial<BundleSettings> = {};
  if (!partial || body.name !== undefined) input.name = asNonEmptyString(body.name, msg('label.bundleName'), 200);
  if (!partial || body.feedIds !== undefined) input.feedIds = parseFeedIds(body.feedIds ?? []);
  if (body.itemLimit !== undefined) input.itemLimit = asInteger(body.itemLimit, msg('label.bundleItemLimit'), BUNDLE_ITEM_LIMIT.min, BUNDLE_ITEM_LIMIT.max, BUNDLE_ITEM_LIMIT.default);
  try {
    if (body.dedupe !== undefined) input.dedupe = parseBundleDedupe(body.dedupe, current?.dedupe ?? BUNDLE_DEDUPE_DEFAULT);
    if (body.itemFilter !== undefined) input.itemFilter = parseBundleFilter(body.itemFilter);
  } catch (error) { if (error instanceof ItemFilterError) throw new AppError(400, error.text); throw error; }
  if (partial && !Object.keys(input).length) throw new AppError(400, 'error.bundleSettingsEmpty');
  return input;
}

/** Members are read from what is already stored: a bundle never triggers a fetch. Paused members keep their items. */
export function bundleMembers(store: Store, bundle: Pick<Bundle, 'feedIds'>): BundleMember[] {
  return bundle.feedIds.flatMap(id => {
    const feed = store.getFeed(id);
    return feed ? [{ feed, items: store.getItems(id) }] : [];
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
    if (!bundle) throw new AppError(404, 'error.bundleNotFound');
    return bundle;
  };

  /** A regex filter that already runs out of time on the members' stored items would silently publish everything: refuse it, as for a feed. */
  const checkFilterBudget = (feedIds: string[], settings: { itemLimit: number; dedupe?: BundleDedupe; itemFilter?: BundleFilter | null }) => {
    if (settings.itemFilter?.regex && previewBundle(bundleMembers(store, { feedIds }), settings).filterTimedOut) throw new AppError(400, 'error.regexTimeout');
  };
  const previewOf = (feedIds: string[], settings: { itemLimit: number; dedupe?: BundleDedupe; itemFilter?: BundleFilter | null }): BundlePreview => previewBundle(bundleMembers(store, { feedIds }), settings);

  app.get('/api/bundles', async request => store.bundles.list(guard(request)).map(payload));
  app.post('/api/bundles', async request => {
    const owner = guard(request);
    if (store.bundles.list(owner).length >= 200) throw new AppError(400, 'error.bundleLimit');
    const input = parseBundleInput(request.body) as BundleSettings;
    checkFilterBudget(input.feedIds.filter(id => store.owns('feeds', id, owner)), { itemLimit: input.itemLimit ?? BUNDLE_ITEM_LIMIT.default, ...input });
    return payload(store.bundles.create(input, owner).bundle);
  });
  // What the output would be with unsaved settings. It changes nothing but is a POST (like the feed output preview), so it needs a write token.
  app.post('/api/bundles/preview', async request => {
    const owner = guard(request);
    const input = parseBundleInput({ name: 'preview', ...asRecord(request.body) }) as BundleSettings;
    if (input.feedIds.some(id => !store.owns('feeds', id, owner))) throw new AppError(400, 'error.selectedFeedMissing');
    return previewOf(input.feedIds, { itemLimit: input.itemLimit ?? BUNDLE_ITEM_LIMIT.default, dedupe: input.dedupe, itemFilter: input.itemFilter });
  });
  app.get('/api/bundles/:id', async request => payload(owned(request)));
  app.get('/api/bundles/:id/preview', async request => { const bundle = owned(request); return previewOf(bundle.feedIds, bundle); });
  app.put('/api/bundles/:id', async request => {
    const bundle = owned(request);
    const patch = parseBundleInput(request.body, true, bundle);
    checkFilterBudget(patch.feedIds ?? bundle.feedIds, { ...bundle, ...patch });
    return payload(store.bundles.update(bundle.id, patch)!);
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

  const publicBundle = (format: FeedFormat) => async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { id: string; token: string };
    const extension = format === 'rss' ? '.xml' : format === 'atom' ? '.atom' : '.json';
    const token = params.token.endsWith(extension) ? params.token.slice(0, -extension.length) : params.token;
    // One key guards every format, so rotating it revokes all three addresses.
    if (!store.bundles.checkToken(params.id, token)) throw new AppError(404, 'error.bundleNotFound');
    const bundle = store.bundles.get(params.id)!;
    const members = bundleMembers(store, bundle);
    // Merged once: the tag, the browser page and the feed all describe the same items.
    // Items keep the id they were first published under, whichever member's copy the merge kept this time.
    const entries = store.bundles.seen.stabilize(bundle, mergeBundleItems(members, bundle));
    const publicUrl = `${origin()}/bundles/${encodeURIComponent(bundle.id)}/${encodeURIComponent(token)}${extension}`;
    const siteUrl = `${origin()}/`;
    const query = request.query as Record<string, unknown> | undefined;
    // Only the RSS address has the human-readable browser page.
    const preview = format === 'rss' && wantsHtmlPreview(request.headers, query);
    // The browser page speaks the visitor's language; the bundle's own texts the owner's.
    const locale = preview ? headerLocale(request.headers['accept-language']) : store.ownerLocale(bundle.ownerId);
    const etag = (preview ? bundleEtag(bundle, members, 'rss', entries).replace(/"$/, '-html"') : bundleEtag(bundle, members, format, entries)).replace(/"$/, `-${locale}"`);
    reply.header('Cache-Control', 'private, max-age=60');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Vary', format === 'rss' ? 'Accept, Accept-Language, Sec-Fetch-Dest, Sec-Fetch-Mode' : 'Sec-Fetch-Dest');
    reply.header('ETag', etag);
    if (etagMatches(request.headers['if-none-match'], etag)) return reply.code(304).send();
    return withLocale(locale, () => {
    if (preview) {
      const page = renderBundlePreview(bundle, members, publicUrl, entries);
      reply.header('Content-Security-Policy', page.csp);
      reply.header('X-Frame-Options', 'DENY');
      return reply.type('text/html; charset=utf-8').send(page.html);
    }
    const document = request.headers['sec-fetch-dest'] === 'document';
    if (format === 'json') return reply.type(document ? 'application/json; charset=utf-8' : 'application/feed+json; charset=utf-8').send(renderBundleJson(bundle, members, publicUrl, siteUrl, entries));
    if (format === 'atom') return reply.type(document ? 'application/xml; charset=utf-8' : 'application/atom+xml; charset=utf-8').send(renderBundleAtom(bundle, members, publicUrl, siteUrl, entries));
    const raw = typeof query?.format === 'string' && document;
    return reply.type(raw ? 'application/xml; charset=utf-8' : 'application/rss+xml; charset=utf-8').send(renderBundleRss(bundle, members, publicUrl, siteUrl, entries));
    });
  };
  app.get('/bundles/:id/:token.xml', publicBundle('rss'));
  app.get('/bundles/:id/:token.atom', publicBundle('atom'));
  app.get('/bundles/:id/:token.json', publicBundle('json'));
}

/**
 * Bundles in the lightweight config file refer to members by their index in the exported `feeds` list, in
 * priority order. `dedupe` and `itemFilter` are optional: files from before they existed mean the default behaviour.
 */
export interface ConfigBundle { name: string; itemLimit: number; feeds: number[]; dedupe?: BundleDedupe; itemFilter?: BundleFilter }

export function exportConfigBundles(store: Store, ownerId: string, feedIds: string[]): ConfigBundle[] {
  const index = new Map(feedIds.map((id, position) => [id, position]));
  return store.bundles.list(ownerId).map(bundle => ({
    name: bundle.name, itemLimit: bundle.itemLimit, feeds: bundle.feedIds.flatMap(id => index.has(id) ? [index.get(id)!] : []),
    dedupe: bundle.dedupe, ...(bundle.itemFilter ? { itemFilter: bundle.itemFilter } : {}),
  }));
}

/** `bundles` is optional so older config files (and older FeedLantern versions) keep working. */
export function parseConfigBundles(value: unknown, feedCount: number): ConfigBundle[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new AppError(400, 'error.configBundlesInvalid');
  return value.map(raw => {
    const entry = asRecord(raw);
    const feeds = entry.feeds;
    if (!Array.isArray(feeds) || feeds.length > BUNDLE_MAX_FEEDS || !feeds.every(n => Number.isInteger(n) && n >= 0 && n < feedCount)) throw new AppError(400, 'error.configBundlesInvalid');
    const bundle: ConfigBundle = { name: asNonEmptyString(entry.name, msg('label.bundleName'), 200), itemLimit: asInteger(entry.itemLimit, msg('label.bundleItemLimit'), BUNDLE_ITEM_LIMIT.min, BUNDLE_ITEM_LIMIT.max, BUNDLE_ITEM_LIMIT.default), feeds: [...new Set(feeds as number[])] };
    try {
      if (entry.dedupe !== undefined) bundle.dedupe = parseBundleDedupe(entry.dedupe);
      const itemFilter = parseBundleFilter(entry.itemFilter);
      if (itemFilter) bundle.itemFilter = itemFilter;
    } catch (error) { if (error instanceof ItemFilterError) throw new AppError(400, error.text); throw error; }
    return bundle;
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
    store.bundles.create({ name: bundle.name, itemLimit: bundle.itemLimit, feedIds: members, dedupe: bundle.dedupe, itemFilter: bundle.itemFilter }, ownerId);
    names.add(bundle.name); created++;
  }
  return { created, skipped };
}
