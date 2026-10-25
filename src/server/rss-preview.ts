import { randomBytes } from 'node:crypto';
import { DomUtils, parseDocument } from 'htmlparser2';
import { isFeedSource, translationEnabled, translationLabel } from '../shared/types.js';
import type { Bundle, Feed, FeedItem } from '../shared/types.js';
import type { BundleMember } from './bundles.js';
import { mergeBundleItems } from './bundles.js';
import { escapeXml, publishedItems } from './rss.js';
import { currentLocale, tl, translator } from './i18n.js';
import { formatDateTime, formatList, intlTag } from '../shared/i18n.js';

type HeaderValue = string | string[] | undefined;
const first = (value: HeaderValue) => (Array.isArray(value) ? value[0] : value) ?? '';

/**
 * Only a top-level browser navigation gets the human-readable page. Feed
 * readers, scripts and in-page fetches never send these Fetch Metadata
 * headers, so they keep receiving the standard RSS document. `?format=xml`
 * always forces XML.
 */
export function wantsHtmlPreview(headers: Record<string, HeaderValue>, query: Record<string, unknown> | undefined): boolean {
  const format = typeof query?.format === 'string' ? query.format.toLowerCase() : '';
  if (format === 'xml' || format === 'rss') return false;
  return first(headers['sec-fetch-dest']) === 'document'
    && first(headers['sec-fetch-mode']) === 'navigate'
    && /\btext\/html\b/i.test(first(headers.accept));
}

/** RFC 9110 If-None-Match: a list of (possibly weak) tags or "*". */
export function etagMatches(header: HeaderValue, etag: string): boolean {
  const value = first(header).trim();
  if (!value) return false;
  if (value === '*') return true;
  const strip = (tag: string) => tag.trim().replace(/^W\//, '');
  return value.split(',').some(tag => strip(tag) === strip(etag));
}

const escape = (value: string) => escapeXml(value);

function plainText(item: FeedItem, feed: Feed): string {
  const html = translationEnabled(feed) && item.contentHtml !== undefined ? item.contentHtml : item.description ?? '';
  const text = isFeedSource(feed) || translationEnabled(feed) ? DomUtils.textContent(parseDocument(html)) : html;
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 220 ? `${compact.slice(0, 220)}…` : compact;
}

function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Server-side text for browsers without scripts; the page script redraws it in the reader's time zone. */
function dateText(value: string | null | undefined): string {
  const locale = currentLocale();
  return formatDateTime(locale, value, locale === 'zh-CN'
    ? { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }
    : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
}

function host(value: string): string {
  try { return new URL(value).host; } catch { return value; }
}

export interface PreviewPage { html: string; csp: string }

interface PreviewContent {
  name: string; kicker: string; meta: string; feedUrl: string; rotateHint: string; empty: string;
  entries: Array<{ feed: Feed; item: FeedItem }>; showSource: boolean;
}

export function renderRssPreview(feed: Feed, items: FeedItem[], feedUrl: string): PreviewPage {
  const source = safeLink(feed.url);
  const updated = dateText(feed.lastSuccessAt);
  const label = translationEnabled(feed) ? translationLabel(feed, translator(currentLocale())) : '';
  const kind = feed.sourceType === 'pubmed'
    ? label ? tl('preview.kindPubmedTranslated', { label }) : tl('preview.kindPubmed')
    : feed.sourceType === 'rss'
    ? label ? tl('preview.kindRssTranslated', { label }) : tl('preview.kindRss')
    : label ? tl('preview.kindWebsiteTranslated', { label }) : tl('preview.kindWebsite');
  const parts = [escape(kind)];
  if (source) parts.push(tl('preview.from', { site: `<a href="${escape(source)}" rel="noreferrer noopener" target="_blank">${escape(host(source))}</a>` }));
  parts.push(escape(tl('preview.interval', { count: feed.intervalMinutes })));
  if (updated) parts.push(tl('preview.updated', { time: `<time datetime="${escape(new Date(feed.lastSuccessAt!).toISOString())}">${escape(updated)}</time>` }));
  const meta = parts.join(' · ');
  return renderPreviewPage({
    name: feed.name, kicker: tl('preview.kickerFeed'), meta, feedUrl, rotateHint: tl('preview.rotateFeed'), empty: tl('preview.emptyFeed'),
    entries: publishedItems(feed, items).slice(0, 30).map(item => ({ feed, item })), showSource: false,
  });
}

/** The same page for a bundle; each item names the member it came from. */
export function renderBundlePreview(bundle: Bundle, members: BundleMember[], bundleUrl: string): PreviewPage {
  const updated = members.map(member => member.feed.lastSuccessAt).filter((value): value is string => !!value).sort().at(-1);
  const names = members.map(member => member.feed.name);
  const shown = names.length > 6 ? tl('preview.andMore', { names: formatList(currentLocale(), names.slice(0, 6), 'unit'), count: names.length }) : formatList(currentLocale(), names);
  const meta = `${escape(shown ? tl('preview.bundleOf', { count: members.length, names: shown }) : tl('preview.bundleCount', { count: members.length }))}${updated ? ` · ${tl('preview.updated', { time: `<time datetime="${escape(new Date(updated).toISOString())}">${escape(dateText(updated))}</time>` })}` : ''}`;
  return renderPreviewPage({
    name: bundle.name, kicker: tl('preview.kickerBundle'), meta, feedUrl: bundleUrl, rotateHint: tl('preview.rotateBundle'), empty: members.length ? tl('preview.emptyBundle') : tl('preview.noMembers'),
    entries: mergeBundleItems(members, bundle.itemLimit).slice(0, 30), showSource: true,
  });
}

function renderPreviewPage({ name, kicker, meta, feedUrl, rotateHint, empty, entries, showSource }: PreviewContent): PreviewPage {
  const nonce = randomBytes(16).toString('base64');
  const rawUrl = `${feedUrl}?format=xml`;
  const list = entries;
  const rows = list.map(({ feed, item }) => {
    const link = safeLink(item.link);
    const summary = plainText(item, feed);
    const iso = item.publishedAt ?? item.firstSeenAt;
    const when = dateText(iso);
    const title = escape(item.title || tl('preview.untitled'));
    return `<li><div class="item-head">${link ? `<a href="${escape(link)}" rel="noreferrer noopener" target="_blank">${title}</a>` : `<span>${title}</span>`}${when ? `<time datetime="${escape(new Date(iso).toISOString())}">${escape(when)}</time>` : ''}</div>${showSource ? `<span class="source">${escape(feed.name)}</span>` : ''}${summary ? `<p>${escape(summary)}</p>` : ''}</li>`;
  }).join('');
  const html = `<!doctype html>
<html lang="${intlTag(currentLocale())}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${escape(name)} · ${escape(kicker)}</title>
<link rel="alternate" type="application/rss+xml" title="${escape(name)}" href="${escape(feedUrl)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style nonce="${nonce}">
:root{--bg:#f4f3ec;--surface:#fff;--ink:#14231d;--ink-2:#3d4d45;--muted:#74837b;--line:#e5e4da;--brand:#1e392f;--brand-ink:#f3f7e8;--glow:#d8e88f;--glow-soft:#eef4d3;--accent:#4b651a;--warn:#9a5b0c;--warn-soft:#fbf0db;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b1512;--surface:#111d19;--ink:#e7eee9;--ink-2:#bccac2;--muted:#84968c;--line:#1f2f29;--brand:#d8e88f;--brand-ink:#11241d;--glow-soft:rgba(216,232,143,.1);--accent:#d3e48a;--warn:#f0c069;--warn-soft:rgba(240,180,80,.1);color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:40px 20px 56px}a{color:inherit}
.hero{padding:28px;border-radius:22px;color:#eef3ea;background:radial-gradient(80% 120% at 100% 0%,rgba(216,232,143,.25),transparent 60%),linear-gradient(165deg,#1f3c31,#0d1f19)}
.kicker{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:700;letter-spacing:.14em;color:#d8e88f}
.kicker svg{width:16px;height:16px}
h1{margin:12px 0 6px;font:700 28px/1.3 "Noto Serif SC","Songti SC",serif}
.meta{margin:0;color:rgba(225,236,220,.75);font-size:14px}.meta a{color:#e8f3b4}
.how{margin-top:20px;padding:22px 24px;border-radius:18px;background:var(--surface);border:1px solid var(--line)}
.how p{margin:0 0 12px;color:var(--ink-2)}
.copy{display:flex;gap:8px;padding:5px;border-radius:13px;border:1px solid var(--line);background:var(--bg)}
.copy input{flex:1;min-width:0;min-height:36px;border:0;background:transparent;color:var(--ink-2);font:12.5px ui-monospace,"SF Mono",Menlo,monospace;padding:0 8px}
.copy button{border:0;border-radius:9px;padding:9px 16px;background:var(--brand);color:var(--brand-ink);font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap}
.small{margin:12px 0 0!important;font-size:13px;color:var(--muted)!important}.small a{color:var(--accent)}
.warn{margin:14px 0 0!important;padding:10px 12px;border-radius:10px;background:var(--warn-soft);color:var(--warn)!important;font-size:13px}
h2{margin:32px 0 12px;font-size:16px}
ol{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:18px;background:var(--surface);overflow:hidden}
li{padding:16px 20px;border-top:1px solid var(--line)}li:first-child{border-top:0}
.item-head{display:flex;justify-content:space-between;gap:16px;align-items:baseline}
.item-head a,.item-head span{font-weight:650;text-decoration:none}.item-head a:hover{color:var(--accent);text-decoration:underline}
li time{flex:none;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
li p{margin:4px 0 0;color:var(--muted);font-size:14px}
li .source{display:inline-block;margin-top:4px;padding:1px 8px;border-radius:999px;background:var(--glow-soft);color:var(--accent);font-size:12px;font-weight:600}
.empty{padding:28px;text-align:center;color:var(--muted)}
footer{margin-top:28px;text-align:center;font-size:12px;color:var(--muted)}
@media (max-width:560px){main{padding:20px 14px 40px}.hero{padding:22px}.copy{flex-direction:column}.item-head{flex-direction:column;gap:2px}}
</style>
</head>
<body>
<main>
<header class="hero">
<span class="kicker"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.2" fill="currentColor"/></svg>${escape(kicker)}</span>
<h1>${escape(name)}</h1>
<p class="meta">${meta}</p>
</header>
<section class="how">
<p>${escape(tl('preview.intro'))}</p>
<div class="copy"><input id="feed-url" readonly value="${escape(feedUrl)}" aria-label="${escape(tl('preview.urlLabel'))}"><button id="copy" type="button">${escape(tl('preview.copy'))}</button></div>
<p class="small">${escape(tl('preview.readerNote'))} <a href="${escape(rawUrl)}">${escape(tl('preview.viewXml'))}</a></p>
<p class="warn">${escape(tl('preview.secret', { place: rotateHint }))}</p>
</section>
<h2>${escape(tl('preview.recent', { count: list.length }))}</h2>
${list.length ? `<ol>${rows}</ol>` : `<ol><li class="empty">${escape(empty)}</li></ol>`}
<footer>${escape(tl('preview.footer'))}</footer>
</main>
<script nonce="${nonce}">
const input=document.getElementById('feed-url'),button=document.getElementById('copy');
button.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(input.value);}catch{input.select();document.execCommand('copy');}button.textContent=${JSON.stringify(tl('preview.copied')).replace(/</g, '\\u003c')};setTimeout(()=>{button.textContent=${JSON.stringify(tl('preview.copy')).replace(/</g, '\\u003c')};},2000);});
input.addEventListener('focus',()=>input.select());
for(const t of document.querySelectorAll('time[datetime]'))t.textContent=new Date(t.dateTime).toLocaleString(${JSON.stringify(intlTag(currentLocale()))},{dateStyle:'medium',timeStyle:'short',hourCycle:'h23'});
</script>
</body>
</html>`;
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  return { html, csp };
}
