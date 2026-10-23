import { translationEnabled } from '../shared/types.js';
import { safeHtml } from './rss-source.js';
import { createHash } from 'node:crypto';
import { classifyItems } from './feed-output.js';
import type { Feed, FeedFormat, FeedItem } from '../shared/types.js';

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

function validHttpUrl(value: string, baseUrl?: string): string | null {
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

function fixedDate(value: string | undefined, fallback: string): string {
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

function isoDate(value: string | undefined, fallback: string): string {
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
  if (feed.sourceType !== 'rss') return `由 FeedLantern 从 ${host} 网页生成的订阅`;
  return translationEnabled(feed) ? `由 FeedLantern 翻译的 ${host} RSS 订阅` : `由 FeedLantern 转发的 ${host} RSS 订阅`;
}

/** Readers such as Inoreader and NetNewsWire show `media:thumbnail` in list views. */
function thumbnail(item: FeedItem, feed: Feed): string {
  if (!item.image) return '';
  const url = validHttpUrl(item.image, feed.url);
  return url ? `<media:thumbnail url="${escapeAttribute(url)}"/>` : '';
}

export function renderRss(feed: Feed, items: FeedItem[], feedUrl: string): string {
  const buildDate = fixedDate(feed.lastSuccessAt ?? feed.createdAt, feed.createdAt);
  const renderedItems = publishedItems(feed, items).map((item) => {
    const description = itemHtml(feed, item);
    // RSS readers interpret the XML-decoded description as HTML. Preserve the
    // HTML escaping through XML decoding, even when there is no image.
    const descriptionXml = cdata(description);
    return [
      '<item>',
      `<title>${escapeXml(item.title)}</title>`,
      `<link>${escapeXml(item.link)}</link>`,
      `<guid isPermaLink="false">${escapeXml(item.id)}</guid>`,
      `<description>${descriptionXml}</description>`,
      item.publishedAt ? `<pubDate>${escapeXml(fixedDate(item.publishedAt, item.firstSeenAt))}</pubDate>` : '',
      thumbnail(item, feed),
      '</item>',
    ].join('');
  }).join('');
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
    // Translated feeds publish Chinese (or Chinese-first bilingual) text.
    translationEnabled(feed) ? '<language>zh-cn</language>' : '',
    `<ttl>${Math.max(1, Math.round(feed.intervalMinutes))}</ttl>`,
    renderedItems,
    '</channel>',
    '</rss>',
  ].join('');
}

/** Atom 1.0 (RFC 4287) with the same items as the RSS output. */
export function renderAtom(feed: Feed, items: FeedItem[], feedUrl: string): string {
  const entries = publishedItems(feed, items).map(item => {
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
      '</entry>',
    ].join('');
  }).join('');
  const site = validHttpUrl(feed.url);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"${translationEnabled(feed) ? ' xml:lang="zh-CN"' : ''}>`,
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
    ...(translationEnabled(feed) ? { language: 'zh-CN' } : {}),
    authors: [{ name: feedHost(feed) }],
    items: publishedItems(feed, items).map(item => {
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
    }),
  };
  // Escape characters that matter if a browser ever treats the body as HTML or script.
  return JSON.stringify(document).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
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
