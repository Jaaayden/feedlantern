import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ExternalLink, Search } from 'lucide-react';
import type { ExtractedItem, FeedItem, ItemOutputStatus, TranslationMode } from '../shared/types';
import { absoluteTime, avatarHue, initial, relativeTime, summaryText } from './format';
import { t } from './i18n';
import { locales, translate } from '../shared/i18n';

const hiddenLabel = (status: ItemOutputStatus) => status === 'excluded' ? t('item.excluded') : status === 'not-included' ? t('item.notIncluded') : status === 'over-limit' ? t('item.overLimit') : undefined;
/** The server's “showing the original” note, in whichever language the feed was written. */
const placeholderNotes = new Set(locales.flatMap(locale => [translate(locale, 'translate.noteFailed'), translate(locale, 'translate.notePending')]));
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
/** Plain text this long or longer gets a “Show more” toggle. */
const LONG_TEXT = 160;
const LEAF_BLOCKS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'FIGCAPTION', 'TD', 'TH', 'DD', 'DT']);

/** Theme colours copied into the sandboxed article frame, which cannot read the page's CSS variables. */
function useFrameTheme(): { scheme: 'light' | 'dark'; ink: string; muted: string; link: string; line: string; code: string } {
  const read = () => {
    const style = getComputedStyle(document.documentElement);
    const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    return {
      scheme: style.colorScheme.includes('dark') ? 'dark' as const : 'light' as const,
      ink: value('--ink-2', '#3d4d45'), muted: value('--muted', '#627168'), link: value('--accent-ink', '#4b651a'), line: value('--line', '#e5e4da'), code: value('--bg-sunken', '#ecebe3'),
    };
  };
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const update = () => setTheme(read());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    return () => { observer.disconnect(); media.removeEventListener('change', update); };
  }, []);
  return theme;
}

interface Article { html: string; text: string; thumb?: string }

/**
 * Reads an item's HTML without running it (DOMParser never executes scripts):
 * drops the “showing the original” placeholder (the item carries a badge instead), marks
 * the original-language half of bilingual paragraphs, and finds a thumbnail.
 */
function readArticle(html: string, bilingual: boolean): Article {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const first = doc.body.firstElementChild;
  if (first?.tagName === 'P' && placeholderNotes.has(first.textContent?.trim() ?? '')) first.remove();
  if (bilingual) {
    // A translated paragraph reads “translation<br>original”; both halves carry the same
    // number of line breaks, so the middle <br> of an odd count separates them.
    for (const block of doc.body.querySelectorAll('*')) {
      if (!LEAF_BLOCKS.has(block.tagName)) continue;
      const breaks = [...block.children].filter(child => child.tagName === 'BR');
      if (breaks.length % 2 !== 1) continue;
      const separator = breaks[(breaks.length - 1) / 2];
      const source = doc.createElement('span');
      source.className = 'fl-source';
      while (separator.nextSibling) source.appendChild(separator.nextSibling);
      if (source.textContent?.trim()) block.appendChild(source);
    }
  }
  const image = [...doc.body.querySelectorAll('img')].map(img => img.getAttribute('src') ?? '').find(src => /^https?:\/\//i.test(src));
  const summary = doc.body.cloneNode(true) as HTMLElement;
  summary.querySelectorAll('.fl-source, pre, figure > figcaption').forEach(node => node.remove());
  summary.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, br, div, tr').forEach(node => node.append(' '));
  return { html: doc.body.innerHTML, text: (summary.textContent ?? '').replace(/\s+/g, ' ').trim(), ...(image ? { thumb: image } : {}) };
}

/**
 * Full article HTML in a sandboxed frame. The HTML was already cleaned by the
 * server; the frame adds a second wall: no scripts (sandbox without
 * allow-scripts and a CSP of default-src 'none'), no forms, and links can only
 * open a new tab, never navigate this page. `allow-same-origin` is needed only
 * so the page can measure the frame and size it to its content.
 */
export function ArticleFrame({ html, title }: { html: string; title: string }) {
  const theme = useFrameTheme();
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const srcDoc = useMemo(() => `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="${theme.scheme}"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><base target="_blank"><style>
:root{color-scheme:${theme.scheme}}html,body{margin:0;background:transparent}body{font:15px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:${theme.ink};overflow-wrap:anywhere;padding:2px 0 4px}
p,ul,ol,blockquote,pre,table,figure{margin:0 0 .85em}h1,h2,h3,h4{font-size:1.05em;line-height:1.5;margin:1.2em 0 .5em}img{max-width:100%;height:auto;border-radius:10px}figure{margin-inline:0}figcaption{font-size:.85em;color:${theme.muted}}
a{color:${theme.link};text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}blockquote{padding-left:14px;border-left:3px solid ${theme.line};color:${theme.muted}}
pre,code{font:13px/1.6 ui-monospace,"SF Mono",Menlo,Consolas,monospace;background:${theme.code};border-radius:6px}pre{padding:10px 12px;white-space:pre-wrap}code{padding:1px 4px}pre code{padding:0}
table{max-width:100%;border-collapse:collapse}td,th{border:1px solid ${theme.line};padding:5px 8px}hr{border:0;border-top:1px solid ${theme.line}}
.fl-source{display:block;margin-top:.2em;font-size:.9em;line-height:1.65;color:${theme.muted}}.fl-source::before{content:"";display:block}
</style></head><body>${html}</body></html>`, [html, theme]);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const doc = frame.contentDocument;
      if (!doc?.body) return;
      setHeight(Math.min(Math.max(doc.documentElement.scrollHeight, 40), 4000));
      if (!observer) { observer = new ResizeObserver(() => setHeight(Math.min(Math.max(doc.documentElement.scrollHeight, 40), 4000))); observer.observe(doc.body); }
    };
    frame.addEventListener('load', measure);
    measure();
    return () => { frame.removeEventListener('load', measure); observer?.disconnect(); };
  }, [srcDoc]);
  return <iframe ref={ref} className="article-frame" title={title} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" style={{ height }} srcDoc={srcDoc} />;
}

function SourceMark({ host }: { host: string }) {
  return <span className="source-mark" aria-hidden="true" style={{ '--hue': avatarHue(host) } as CSSProperties}>{initial(host)}</span>;
}

function ItemRow({ item, index, status, mode }: { item: ExtractedItem; index: number; status?: ItemOutputStatus; mode?: TranslationMode }) {
  const [open, setOpen] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const translated = item.translationStatus !== undefined;
  const done = item.translationStatus === 'success';
  const bilingual = translated && done && mode === 'bilingual';
  // Translated items carry their HTML in contentHtml; untranslated RSS items keep it in the description.
  const html = item.contentHtml ?? (item.description && /<\/?[a-z][^>]*>/i.test(item.description) ? item.description : undefined);
  const article = useMemo(() => html !== undefined ? readArticle(html, bilingual) : null, [html, bilingual]);
  const feedItem = item as Partial<FeedItem>;
  // The feed publishes “translation / original”; here the original is a quieter second line.
  const [headline, original] = bilingual && item.translatedTitle && item.sourceTitle ? [item.translatedTitle, item.sourceTitle] : [item.title, ''];
  const summary = article ? article.text : item.description ? summaryText(item.description) : '';
  const expandable = article ? article.text.length > LONG_TEXT || /<(img|pre|table|ul|ol|blockquote|figure)\b/i.test(article.html) : summary.length > LONG_TEXT;
  const thumb = !thumbFailed ? item.image ?? article?.thumb : undefined;
  const hidden = hiddenLabel(status ?? 'published');
  const host = hostOf(item.link);
  const when = item.publishedAt ?? feedItem.firstSeenAt;
  return <article className={`preview-item${hidden ? ' is-hidden' : ''}${open ? ' is-open' : ''}${thumb ? ' has-thumb' : ''}`} data-output={status} data-translation={item.translationStatus}>
    <div className="item-body">
      <div className="item-meta">
        <SourceMark host={host} /><span className="item-host">{host}</span>
        {when && <time dateTime={when} title={absoluteTime(when)}>{item.publishedAt ? relativeTime(item.publishedAt) : t('item.collected', { time: relativeTime(when) })}{item.publishedAtSource === 'relative' ? t('item.estimated') : ''}</time>}
        {item.translationStatus === 'pending' && <span className="item-tag pending">{t('item.translating')}</span>}
        {item.translationStatus === 'failed' && <span className="item-tag failed" title={item.translationError}>{t('item.translationFailed')}</span>}
        {hidden && <span className="item-tag muted output-badge">{hidden}</span>}
      </div>
      <h3 className="item-title"><a href={item.link} target="_blank" rel="noreferrer">{headline || t('item.noTitle')}<ExternalLink size={13} aria-hidden="true" /></a></h3>
      {original && <p className="item-original-title">{original}</p>}
      {item.translationStatus === 'failed' && item.translationError && <p className="item-error">{item.translationError}</p>}
      {open && article ? <ArticleFrame title={t('item.articleFrame', { n: index + 1 })} html={article.html} /> : summary && <p className={`item-summary${open ? ' is-open' : ''}`}>{summary}</p>}
      {expandable && <button type="button" className="item-expand" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('item.showLess') : t('item.showMore')}<ChevronDown size={14} aria-hidden="true" /></button>}
    </div>
    {thumb && <img className="item-thumb" src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setThumbFailed(true)} />}
  </article>;
}

/** Reader-style list of feed items: used by the feed panel and the editor preview. */
export function ItemPreview({ items, empty, status, mode }: { items: ExtractedItem[]; empty?: string; status?: (item: ExtractedItem) => ItemOutputStatus | undefined; mode?: TranslationMode }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return <div className="empty-preview"><Search size={24} /><p>{empty ?? t('item.emptyPreview')}</p></div>;
  const shown = expanded ? items : items.slice(0, 20);
  return <><div className="item-list">{shown.map((item, index) => <ItemRow key={`${(item as Partial<FeedItem>).id ?? item.link}-${index}`} item={item} index={index} status={status?.(item)} mode={mode} />)}</div>
    {items.length > 20 && !expanded && <button className="button small show-all" onClick={() => setExpanded(true)}>{t('item.showAll', { count: items.length })}</button>}</>;
}
