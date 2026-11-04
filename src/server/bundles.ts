import { createHash } from 'node:crypto';
import { BUNDLE_DEDUPE_DEFAULT, translationEnabled, type Bundle, type BundleDedupe, type BundleFilter, type BundleItemRef, type BundleMergeGroup, type BundlePreview, type Feed, type FeedFormat, type FeedItem } from '../shared/types.js';
import { escapeXml, feedLanguage, feedLanguageTag, fixedDate, isoDate, jsonFeedItem, publishedItems, renderAtomEntry, renderRssItem, safeJson } from './rss.js';
import { duplicateReason, findWinners, type DedupeItem } from './bundle-dedupe.js';
import { evaluateFilter, itemFields, type Verdict } from './feed-output.js';
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

/** What decides the merge besides the members: a bundle, or a draft of one. */
export interface BundleMergeSettings { itemLimit: number; dedupe?: BundleDedupe; itemFilter?: BundleFilter | null }

/** Regex work over every member's items takes longer than over one feed's; this is its share of time. */
const BUNDLE_REGEX_BUDGET_MS = 500;
/** Entries of each list in a preview. */
export const BUNDLE_PREVIEW_LIST = 50;

interface Candidate extends BundleEntry { order: number; member: number; time: number }
interface Merge {
  /** Items the members publish themselves, in collection order. */
  candidates: Candidate[];
  filtered: Array<{ candidate: Candidate; verdict: NonNullable<Verdict> }>;
  /** Survivors of the filter, with the index of the copy kept for each. */
  remaining: Candidate[];
  winners: number[];
  /** Kept copies, newest first, before the item limit. */
  kept: Candidate[];
  output: Candidate[];
  timedOut: boolean;
}

/** The fields a bundle filter looks at: the member feed's own (title, summary), plus the member's name if asked. */
function filterFields({ feed, item }: Candidate, filter: BundleFilter): string[] {
  const fields: string[] = itemFields(feed, item);
  return filter.matchSource ? [...fields, feed.name] : fields;
}

/**
 * The whole pipeline, in this order:
 *  1. every member contributes what its own feed address publishes
 *     (`publishedItems`: finished translations only, its item filter, its
 *     output limit);
 *  2. the bundle's filter judges the merged items one by one;
 *  3. duplicates are merged, one copy kept per group;
 *  4. newest first, cut to the bundle's item limit.
 * The limit therefore counts the items that survive the filter and the merge.
 */
function runMerge(members: BundleMember[], settings: BundleMergeSettings): Merge {
  const dedupe = settings.dedupe ?? BUNDLE_DEDUPE_DEFAULT, filter = settings.itemFilter;
  const candidates: Candidate[] = [];
  members.forEach(({ feed, items }, member) => {
    for (const item of publishedItems(feed, items)) candidates.push({ feed, item, order: candidates.length, member, time: itemTime(item) });
  });
  let remaining = candidates, timedOut = false;
  const filtered: Merge['filtered'] = [];
  if (filter && (filter.include.length || filter.exclude.length)) {
    const verdicts = evaluateFilter(filter, candidates.map(candidate => filterFields(candidate, filter)), BUNDLE_REGEX_BUDGET_MS);
    if (verdicts === 'timeout') timedOut = true;
    else {
      remaining = [];
      candidates.forEach((candidate, index) => { const verdict = verdicts[index]; if (verdict) filtered.push({ candidate, verdict }); else remaining.push(candidate); });
    }
  }
  const winners = findWinners(remaining.map(({ item, member, order, time }) => ({ link: item.link, title: item.title, time, firstSeenAt: item.firstSeenAt, member, order })), dedupe);
  const kept = remaining.filter((_, index) => winners[index] === index).sort((a, b) => b.time - a.time || a.order - b.order);
  return { candidates, filtered, remaining, winners, kept, output: kept.slice(0, settings.itemLimit), timedOut };
}

/**
 * Merge the members' public items, newest first. `settings` is the bundle (or
 * just its item limit, which keeps the original behaviour: items sharing a
 * link are shown once, the copy seen first wins, so a later duplicate in
 * another member never replaces an item a reader already has).
 */
export function mergeBundleItems(members: BundleMember[], settings: BundleMergeSettings | number): BundleEntry[] {
  return runMerge(members, typeof settings === 'number' ? { itemLimit: settings } : settings).output.map(({ feed, item }) => ({ feed, item }));
}

function itemRef({ feed, item }: BundleEntry): BundleItemRef {
  return { id: item.id, title: item.title, link: item.link, feedId: feed.id, feedName: feed.name, at: item.publishedAt ?? item.firstSeenAt };
}

/** The numbers and the examples behind a bundle's settings, for the editor and for agents. Lists are cut to `BUNDLE_PREVIEW_LIST`. */
export function previewBundle(members: BundleMember[], settings: BundleMergeSettings): BundlePreview {
  const merge = runMerge(members, settings), dedupe = settings.dedupe ?? BUNDLE_DEDUPE_DEFAULT;
  const items = merge.remaining.map(({ item, member, order, time }): DedupeItem => ({ link: item.link, title: item.title, time, firstSeenAt: item.firstSeenAt, member, order }));
  const groups = new Map<number, BundleMergeGroup>();
  merge.winners.forEach((winner, index) => {
    if (winner === index) return;
    const group = groups.get(winner) ?? { kept: itemRef(merge.remaining[winner]), merged: [] };
    if (group.merged.length < BUNDLE_PREVIEW_LIST) group.merged.push({ ...itemRef(merge.remaining[index]), reason: duplicateReason(items[winner], items[index], dedupe) });
    groups.set(winner, group);
  });
  const merged = merge.remaining.length - merge.kept.length;
  return {
    members: members.length, candidates: merge.candidates.length, filtered: merge.filtered.length, merged,
    overLimit: merge.kept.length - merge.output.length, output: merge.output.length,
    items: merge.output.slice(0, BUNDLE_PREVIEW_LIST).map(itemRef),
    filteredItems: merge.filtered.slice(0, BUNDLE_PREVIEW_LIST).map(({ candidate, verdict }) => ({ ...itemRef(candidate), status: verdict.status, ...(verdict.status === 'excluded' ? { pattern: verdict.pattern } : {}) })),
    groups: [...groups.entries()].sort(([a], [b]) => merge.remaining[b].time - merge.remaining[a].time || a - b).slice(0, BUNDLE_PREVIEW_LIST).map(([, group]) => group),
    listLimit: BUNDLE_PREVIEW_LIST,
    ...(merge.timedOut ? { filterTimedOut: true } : {}),
  };
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
export function renderBundleRss(bundle: Bundle, members: BundleMember[], bundleUrl: string, siteUrl: string, entries = mergeBundleItems(members, bundle)): string {
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
    entries.map(({ feed, item }) => renderRssItem(feed, item, `<category>${escapeXml(feed.name)}</category>`)).join(''),
    '</channel>',
    '</rss>',
  ].join('');
}

/** Atom 1.0 with the same entries; the member is an `atom:category`. */
export function renderBundleAtom(bundle: Bundle, members: BundleMember[], bundleUrl: string, siteUrl: string, entries = mergeBundleItems(members, bundle)): string {
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
    entries.map(({ feed, item }) => renderAtomEntry(feed, item, `<category term="${escapeXml(feed.name)}"/>`)).join(''),
    '</feed>',
  ].join('');
}

/** JSON Feed 1.1 with the same items; the member is a tag. */
export function renderBundleJson(bundle: Bundle, members: BundleMember[], bundleUrl: string, siteUrl: string, entries = mergeBundleItems(members, bundle)): string {
  const language = sharedLanguage(members);
  return safeJson({
    version: 'https://jsonfeed.org/version/1.1',
    title: bundle.name,
    home_page_url: siteUrl,
    feed_url: bundleUrl,
    description: describe(members),
    ...(language ? { language: feedLanguageTag(language) } : {}),
    authors: [{ name: 'FeedLantern' }],
    items: entries.map(({ feed, item }) => ({ ...jsonFeedItem(feed, item), tags: [feed.name] })),
  });
}

export function bundleEtag(bundle: Bundle, members: BundleMember[], format: FeedFormat = 'rss', entries = mergeBundleItems(members, bundle)): string {
  const material = JSON.stringify({
    ...(format === 'rss' ? {} : { format }),
    id: bundle.id, name: bundle.name, limit: bundle.itemLimit,
    members: members.map(({ feed }) => [feed.id, feed.name, feed.url, feed.intervalMinutes, feed.lastSuccessAt, feed.translationMode, feed.targetLanguage]),
    items: entries.map(({ feed, item }) => [feed.id, item]),
  });
  return `"${createHash('sha256').update(material).digest('hex')}"`;
}
