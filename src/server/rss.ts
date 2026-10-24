import { targetLanguages, translationEnabled } from '../shared/types.js';
import { safeHtml } from './rss-source.js';
import { createHash } from 'node:crypto';
import { classifyItems } from './feed-output.js';
import type { Feed, FeedFormat, FeedItem } from '../shared/types.js';
import { currentLocale, translate } from './i18n.js';
import { targetLocale } from './user-locale.js';

export function escapeXml(value: string): string {
  return value
    .replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function escapeAttribute(value: string): string {
  return escapeXml(value).replaceAll('`', '&#96;');
}

export function validHttpUrl(value: string, baseUrl?: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Escape the extractor's plain-text summary and append only its separately
 * extracted, validated image URL. Description text is never interpreted as
 * HTML, so a literal `<img>` or `<script>` in an article remains text. */
export function sanitizeDescription(value: string | undefined, baseUrl: string, image?: string): string {
  const text = escapeXml(value ?? '');
  const safeImage = image ? validHttpUrl(image, baseUrl) : null;
  return safeImage ? `${text}<img src="${escapeAttribute(safeImage)}" alt="">` : text;
}

function cdata(value: string): string {
  return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

export function fixedDate(value: string | undefined, fallback: string): string {
  const parsed = value ? new Date(value) : new Date(fallback);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toUTCString() : parsed.toUTCString();
}

/**
 * Management can show drafts; public feeds only contain complete
 * translations that pass the item filter, up to the feed's output limit.
 */
export function publishedItems(feed: Feed, items: FeedItem[]): FeedItem[] {
  const { statuses } = classifyItems(feed, items);
  return items.filter((_, index) => statuses[index] === 'published');
}

export function isoDate(value: string | undefined, fallback: string): string {
  const parsed = value ? new Date(value) : new Date(fallback);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

/** The HTML body every format publishes for an item. */
function itemHtml(feed: Feed, item: FeedItem): string {
  return translationEnabled(feed) && item.contentHtml !== undefined ? safeHtml(item.contentHtml, item.link) : feed.sourceType === 'rss' ? safeHtml(item.description ?? '', item.link) : sanitizeDescription(item.description, feed.url, item.image);
}

function feedHost(feed: Feed): string {
  try { return new URL(feed.url).host; } catch { return feed.url; }
}

function channelDescription(feed: Feed): string {
  let host = feed.url;
  try { host = new URL(feed.url).host; } catch { /* keep the raw value */ }
  // A translated feed describes itself in its target language; others in the owner's.
  if (feed.sourceType !== 'rss') return translate(currentLocale(), 'output.websiteDescription', { host });
  return translationEnabled(feed) ? translate(targetLocale(feed.targetLanguage), 'output.translatedDescription', { host }) : translate(currentLocale(), 'output.forwardedDescription', { host });
}

/** Readers such as Inoreader and NetNewsWire show `media:thumbnail` in list views. */
function thumbnail(item: FeedItem, feed: Feed): string {
  if (!item.image) return '';
  const url = validHttpUrl(item.image, feed.url);
  return url ? `<media:thumbnail url="${escapeAttribute(url)}"/>` : '';
}

/** RSS `language` code of a translated feed's output (lower case, e.g. `zh-cn`). */
export function feedLanguage(feed: Pick<Feed, 'targetLanguage'>): string {
  return targetLanguages[feed.targetLanguage ?? 'zh-CN'].rss;
}
/** BCP 47 tag of a translated feed's output, for Atom `xml:lang` and JSON Feed `language`. */
export function feedLanguageTag(feed: Pick<Feed, 'targetLanguage'>): string {
  return feed.targetLanguage ?? 'zh-CN';
}

/** One `<item>` exactly as the feed's own RSS shows it; `extra` is appended XML (a bundle adds the source). */
export function renderRssItem(feed: Feed, item: FeedItem, extra = ''): string {
  // RSS readers interpret the XML-decoded description as HTML. Preserve the
  // HTML escaping through XML decoding, even when there is no image.
  const descriptionXml = cdata(itemHtml(feed, item));
  return [
    '<item>',
    `<title>${escapeXml(item.title)}</title>`,
    `<link>${escapeXml(item.link)}</link>`,
    `<guid isPermaLink="false">${escapeXml(item.id)}</guid>`,
    `<description>${descriptionXml}</description>`,
    item.publishedAt ? `<pubDate>${escapeXml(fixedDate(item.publishedAt, item.firstSeenAt))}</pubDate>` : '',
    thumbnail(item, feed),
    extra,
    '</item>',
  ].join('');
}

/** One Atom `<entry>` as the feed's own Atom shows it; `extra` is appended XML. */
export function renderAtomEntry(feed: Feed, item: FeedItem, extra = ''): string {
  const link = validHttpUrl(item.link);
  return [
    '<entry>',
    `<id>${escapeXml(`urn:feedlantern:item:${item.id}`)}</id>`,
    `<title type="text">${escapeXml(item.title)}</title>`,
    link ? `<link rel="alternate" type="text/html" href="${escapeAttribute(link)}"/>` : '',
    `<updated>${isoDate(item.publishedAt, item.firstSeenAt)}</updated>`,
    item.publishedAt ? `<published>${isoDate(item.publishedAt, item.firstSeenAt)}</published>` : '',
    `<content type="html">${escapeXml(itemHtml(feed, item))}</content>`,
    thumbnail(item, feed),
    extra,
    '</entry>',
  ].join('');
}

/** One JSON Feed item as the feed's own JSON Feed shows it. */
export function jsonFeedItem(feed: Feed, item: FeedItem): Record<string, unknown> {
  const link = validHttpUrl(item.link);
  const image = item.image ? validHttpUrl(item.image, feed.url) : null;
  return {
    id: item.id,
    ...(link ? { url: link } : {}),
    title: item.title,
    content_html: itemHtml(feed, item),
    ...(item.publishedAt ? { date_published: isoDate(item.publishedAt, item.firstSeenAt) } : {}),
    ...(image ? { image } : {}),
  };
}

/** Escape characters that matter if a browser ever treats a JSON body as HTML or script. */
export function safeJson(document: unknown): string {
  return JSON.stringify(document).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function renderRss(feed: Feed, items: FeedItem[], feedUrl: string): string {
  const buildDate = fixedDate(feed.lastSuccessAt ?? feed.createdAt, feed.createdAt);
  const renderedItems = publishedItems(feed, items).map(item => renderRssItem(feed, item)).join('');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">',
    '<channel>',
    `<title>${escapeXml(feed.name)}</title>`,
    `<link>${escapeXml(feed.url)}</link>`,
    `<description>${escapeXml(channelDescription(feed))}</description>`,
    `<atom:link href="${escapeAttribute(feedUrl)}" rel="self" type="application/rss+xml"/>`,
    `<lastBuildDate>${escapeXml(buildDate)}</lastBuildDate>`,
    '<generator>FeedLantern</generator>',
    // Translated feeds publish the target language (translation-first when bilingual).
    translationEnabled(feed) ? `<language>${feedLanguage(feed)}</language>` : '',
    `<ttl>${Math.max(1, Math.round(feed.intervalMinutes))}</ttl>`,
    renderedItems,
    '</channel>',
    '</rss>',
  ].join('');
}

/** Atom 1.0 (RFC 4287) with the same items as the RSS output. */
export function renderAtom(feed: Feed, items: FeedItem[], feedUrl: string): string {
  const entries = publishedItems(feed, items).map(item => renderAtomEntry(feed, item)).join('');
  const site = validHttpUrl(feed.url);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"${translationEnabled(feed) ? ` xml:lang="${feedLanguageTag(feed)}"` : ''}>`,
    `<id>${escapeXml(`urn:feedlantern:feed:${feed.id}`)}</id>`,
    `<title type="text">${escapeXml(feed.name)}</title>`,
    `<subtitle type="text">${escapeXml(channelDescription(feed))}</subtitle>`,
    `<updated>${isoDate(feed.lastSuccessAt ?? feed.createdAt, feed.createdAt)}</updated>`,
    `<link rel="self" type="application/atom+xml" href="${escapeAttribute(feedUrl)}"/>`,
    site ? `<link rel="alternate" type="text/html" href="${escapeAttribute(site)}"/>` : '',
    `<author><name>${escapeXml(feedHost(feed))}</name></author>`,
    '<generator>FeedLantern</generator>',
    entries,
    '</feed>',
  ].join('');
}

/** JSON Feed 1.1 (https://jsonfeed.org/version/1.1) with the same items as the RSS output. */
export function renderJsonFeed(feed: Feed, items: FeedItem[], feedUrl: string): string {
  const site = validHttpUrl(feed.url);
  const document = {
    version: 'https://jsonfeed.org/version/1.1',
    title: feed.name,
    ...(site ? { home_page_url: site } : {}),
    feed_url: feedUrl,
    description: channelDescription(feed),
    ...(translationEnabled(feed) ? { language: feedLanguageTag(feed) } : {}),
    authors: [{ name: feedHost(feed) }],
    items: publishedItems(feed, items).map(item => jsonFeedItem(feed, item)),
  };
  return safeJson(document);
}

export function rssEtag(feed: Feed, items: FeedItem[], format: FeedFormat = 'rss'): string {
  const material = JSON.stringify({
    ...(format === 'rss' ? {} : { format }),
    id: feed.id,
    name: feed.name,
    channelTitle: feed.name,
    url: feed.url,
    lastSuccessAt: feed.lastSuccessAt,
    items: publishedItems(feed, items),
  });
  return `"${createHash('sha256').update(material).digest('hex')}"`;
}
