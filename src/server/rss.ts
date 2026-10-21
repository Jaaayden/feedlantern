import { translationEnabled } from '../shared/types.js';
import { safeHtml } from './rss-source.js';
import { createHash } from 'node:crypto';
import type { Feed, FeedItem } from '../shared/types.js';

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

/** Management can show drafts; public RSS only contains complete translations. */
export function publishedItems(feed: Feed, items: FeedItem[]): FeedItem[] {
  return (translationEnabled(feed) ? items.filter(item => item.translationStatus === 'success' && typeof item.contentHtml === 'string') : items).slice(0, 100);
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
    const description = translationEnabled(feed) && item.contentHtml !== undefined ? safeHtml(item.contentHtml, item.link) : feed.sourceType === 'rss' ? safeHtml(item.description ?? '', item.link) : sanitizeDescription(item.description, feed.url, item.image);
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
    `<ttl>${Math.max(1, Math.round(feed.intervalMinutes))}</ttl>`,
    renderedItems,
    '</channel>',
    '</rss>',
  ].join('');
}

export function rssEtag(feed: Feed, items: FeedItem[]): string {
  const material = JSON.stringify({
    id: feed.id,
    name: feed.name,
    channelTitle: feed.name,
    url: feed.url,
    lastSuccessAt: feed.lastSuccessAt,
    items: publishedItems(feed, items),
  });
  return `"${createHash('sha256').update(material).digest('hex')}"`;
}
