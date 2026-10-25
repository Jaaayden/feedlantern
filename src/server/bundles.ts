import { createHash } from 'node:crypto';
import { translationEnabled, type Bundle, type Feed, type FeedFormat, type FeedItem } from '../shared/types.js';
import { escapeXml, feedLanguage, feedLanguageTag, fixedDate, isoDate, jsonFeedItem, publishedItems, renderAtomEntry, renderRssItem, safeJson } from './rss.js';
import { normalizeLink } from './store.js';
import { tl } from './i18n.js';

export interface BundleMember { feed: Feed; items: FeedItem[] }
export interface BundleEntry { feed: Feed; item: FeedItem }

/** Publication time when known, otherwise when FeedLantern first saw the item. */
function itemTime(item: FeedItem): number {
  for (const value of [item.publishedAt, item.firstSeenAt]) {
    const time = value ? Date.parse(value) : Number.NaN;
    if (!Number.isNaN(time)) return time;
  }
  return 0;
}

/**
 * Merge the members' public items, newest first. Each member contributes
 * exactly what its own feed address publishes (`publishedItems`: finished
 * translations only, its item filter and its output limit). Items sharing a
 * link are shown once: the copy seen first wins, so a later duplicate in
 * another member never replaces an item a reader already has.
 */
export function mergeBundleItems(members: BundleMember[], limit: number): BundleEntry[] {
  const winners = new Map<string, BundleEntry & { order: number }>();
  let order = 0;
  for (const { feed, items } of members) {
    for (const item of publishedItems(feed, items)) {
      const key = normalizeLink(item.link);
      const current = winners.get(key), candidate = { feed, item, order: order++ };
      if (!current || item.firstSeenAt < current.item.firstSeenAt) winners.set(key, candidate);
    }
  }
  return [...winners.values()]
    .sort((a, b) => itemTime(b.item) - itemTime(a.item) || a.order - b.order)
    .slice(0, limit)
    .map(({ feed, item }) => ({ feed, item }));
}

function lastUpdate(bundle: Bundle, members: BundleMember[]): string {
  const times = members.map(member => member.feed.lastSuccessAt).filter((value): value is string => !!value).sort();
  return times.at(-1) ?? bundle.updatedAt;
}

/**
 * The bundle declares a language only when every member is translated into
 * the same one; a mix of languages (or of originals of unknown language) has
 * no single honest value, so it is left out, as for an untranslated feed.
 */
function sharedLanguage(members: BundleMember[]): Feed | null {
  if (!members.length || !members.every(member => translationEnabled(member.feed))) return null;
  const first = members[0].feed;
  return members.every(member => feedLanguageTag(member.feed) === feedLanguageTag(first)) ? first : null;
}

function describe(members: BundleMember[]): string {
  return tl('output.bundleDescription', { count: members.length });
}

function ttl(members: BundleMember[]): number {
  return Math.max(1, Math.round(members.length ? Math.min(...members.map(member => member.feed.intervalMinutes)) : 60));
}

/**
 * RSS 2.0. The member is named with `<category>` rather than `<source>`:
 * `<source>` requires a URL of the member's own feed, which would either leak
 * that feed's secret address or point at a web page that is not a feed, while
 * readers widely show categories as tags that can be filtered on.
 */
export function renderBundleRss(bundle: Bundle, members: BundleMember[], bundleUrl: string, siteUrl: string): string {
  const language = sharedLanguage(members);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">',
    '<channel>',
    `<title>${escapeXml(bundle.name)}</title>`,
    `<link>${escapeXml(siteUrl)}</link>`,
    `<description>${escapeXml(describe(members))}</description>`,
    `<atom:link href="${escapeXml(bundleUrl)}" rel="self" type="application/rss+xml"/>`,
    `<lastBuildDate>${escapeXml(fixedDate(lastUpdate(bundle, members), bundle.createdAt))}</lastBuildDate>`,
    '<generator>FeedLantern</generator>',
    language ? `<language>${feedLanguage(language)}</language>` : '',
    `<ttl>${ttl(members)}</ttl>`,
    mergeBundleItems(members, bundle.itemLimit).map(({ feed, item }) => renderRssItem(feed, item, `<category>${escapeXml(feed.name)}</category>`)).join(''),
    '</channel>',
    '</rss>',
  ].join('');
}

/** Atom 1.0 with the same entries; the member is an `atom:category`. */
export function renderBundleAtom(bundle: Bundle, members: BundleMember[], bundleUrl: string, siteUrl: string): string {
  const language = sharedLanguage(members);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"${language ? ` xml:lang="${feedLanguageTag(language)}"` : ''}>`,
    `<id>${escapeXml(`urn:feedlantern:bundle:${bundle.id}`)}</id>`,
    `<title type="text">${escapeXml(bundle.name)}</title>`,
    `<subtitle type="text">${escapeXml(describe(members))}</subtitle>`,
    `<updated>${isoDate(lastUpdate(bundle, members), bundle.createdAt)}</updated>`,
    `<link rel="self" type="application/atom+xml" href="${escapeXml(bundleUrl)}"/>`,
    `<link rel="alternate" type="text/html" href="${escapeXml(siteUrl)}"/>`,
    '<author><name>FeedLantern</name></author>',
    '<generator>FeedLantern</generator>',
    mergeBundleItems(members, bundle.itemLimit).map(({ feed, item }) => renderAtomEntry(feed, item, `<category term="${escapeXml(feed.name)}"/>`)).join(''),
    '</feed>',
  ].join('');
}

/** JSON Feed 1.1 with the same items; the member is a tag. */
export function renderBundleJson(bundle: Bundle, members: BundleMember[], bundleUrl: string, siteUrl: string): string {
  const language = sharedLanguage(members);
  return safeJson({
    version: 'https://jsonfeed.org/version/1.1',
    title: bundle.name,
    home_page_url: siteUrl,
    feed_url: bundleUrl,
    description: describe(members),
    ...(language ? { language: feedLanguageTag(language) } : {}),
    authors: [{ name: 'FeedLantern' }],
    items: mergeBundleItems(members, bundle.itemLimit).map(({ feed, item }) => ({ ...jsonFeedItem(feed, item), tags: [feed.name] })),
  });
}

export function bundleEtag(bundle: Bundle, members: BundleMember[], format: FeedFormat = 'rss'): string {
  const material = JSON.stringify({
    ...(format === 'rss' ? {} : { format }),
    id: bundle.id, name: bundle.name, limit: bundle.itemLimit,
    members: members.map(({ feed }) => [feed.id, feed.name, feed.url, feed.intervalMinutes, feed.lastSuccessAt, feed.translationMode, feed.targetLanguage]),
    items: mergeBundleItems(members, bundle.itemLimit).map(({ feed, item }) => [feed.id, item]),
  });
  return `"${createHash('sha256').update(material).digest('hex')}"`;
}
