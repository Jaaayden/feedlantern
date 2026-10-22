import { createHash } from 'node:crypto';
import { translationEnabled, type Bundle, type Feed, type FeedItem } from '../shared/types.js';
import { escapeXml, fixedDate, publishedItems, renderRssItem } from './rss.js';
import { normalizeLink } from './store.js';

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
 * exactly what its own RSS address publishes (`publishedItems`), so a
 * translated feed only adds finished translations. Items sharing a link are
 * shown once: the copy seen first wins, so a later duplicate in another
 * member never replaces an item a reader already has.
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
 * RSS 2.0. The member is named with `<category>` rather than `<source>`:
 * `<source>` requires a URL of the member's own feed, which would either leak
 * that feed's secret address or point at a web page that is not a feed, while
 * readers widely show categories as tags that can be filtered on.
 */
export function renderBundleRss(bundle: Bundle, members: BundleMember[], bundleUrl: string, siteUrl: string): string {
  const entries = mergeBundleItems(members, bundle.itemLimit);
  const translated = members.length > 0 && members.every(member => translationEnabled(member.feed));
  const ttl = members.length ? Math.min(...members.map(member => member.feed.intervalMinutes)) : 60;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">',
    '<channel>',
    `<title>${escapeXml(bundle.name)}</title>`,
    `<link>${escapeXml(siteUrl)}</link>`,
    `<description>${escapeXml(`由 FeedLantern 聚合的 ${members.length} 个订阅`)}</description>`,
    `<atom:link href="${escapeXml(bundleUrl)}" rel="self" type="application/rss+xml"/>`,
    `<lastBuildDate>${escapeXml(fixedDate(lastUpdate(bundle, members), bundle.createdAt))}</lastBuildDate>`,
    '<generator>FeedLantern</generator>',
    translated ? '<language>zh-cn</language>' : '',
    `<ttl>${Math.max(1, Math.round(ttl))}</ttl>`,
    entries.map(({ feed, item }) => renderRssItem(feed, item, `<category>${escapeXml(feed.name)}</category>`)).join(''),
    '</channel>',
    '</rss>',
  ].join('');
}

export function bundleEtag(bundle: Bundle, members: BundleMember[]): string {
  const material = JSON.stringify({
    id: bundle.id, name: bundle.name, limit: bundle.itemLimit,
    members: members.map(({ feed }) => [feed.id, feed.name, feed.url, feed.intervalMinutes, feed.lastSuccessAt, feed.translationMode]),
    items: mergeBundleItems(members, bundle.itemLimit).map(({ feed, item }) => [feed.id, item]),
  });
  return `"${createHash('sha256').update(material).digest('hex')}"`;
}
