import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import sanitizeHtml from 'sanitize-html';
import { NetworkPolicy } from './network.js';

export interface SourceItem { key: string; title: string; link: string; html: string; publishedAt?: string }
export interface SourceResult { title: string; items: SourceItem[]; etag?: string; modified?: string; unchanged?: boolean }
export interface SourceOptions { etag?: string; modified?: string; signal?: AbortSignal }
export type SourceFetcher = (url: string, options?: SourceOptions) => Promise<SourceResult>;
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export function safeHtml(html: string, base: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'div', 'span', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'img', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption', 'sup', 'sub'],
    allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt', 'title'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['http', 'https'], allowProtocolRelative: false,
    transformTags: {
      '*': (tagName, attribs) => {
        for (const key of ['href', 'src']) if (attribs[key]) {
          try { const url = new URL(attribs[key], base); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) delete attribs[key]; else attribs[key] = url.href; }
          catch { delete attribs[key]; }
        }
        return { tagName, attribs };
      },
    },
  });
}
const list = (value: any): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const valueText = (value: any): string => typeof value === 'string' || typeof value === 'number' ? String(value) : value?.['#text'] ? String(value['#text']) : '';
const plain = (text: string) => sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} }).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export function parseSource(xml: string, base: string): SourceResult {
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) throw Error('RSS XML 无效或包含不支持的实体声明');
  const doc = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false, htmlEntities: true, stopNodes: ['*.div'] }).parse(xml);
  const atom = !!doc.feed;
  const rdf = doc['rdf:RDF'];
  const channel = atom ? doc.feed : doc.rss?.channel ?? rdf?.channel;
  if (!channel) throw Error('该地址未返回 RSS 1.0、RSS 2.0 或 Atom 1.0 订阅');
  const seen = new Set<string>();
  const items: SourceItem[] = [];
  const ordered = list(atom ? channel.entry : rdf ? rdf.item : channel.item).slice(0, 1000);
  for (const row of ordered) {
    const title = (atom && (!row.title?.['@_type'] || row.title['@_type'] === 'text') ? valueText(row.title) : plain(valueText(row.title))).trim();
    if (!title) continue;
    const rawLink = atom ? list(row.link).find(l => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href'] : valueText(row.link);
    let link = base;
    try { const candidate = new URL(rawLink || base, base); if (['http:', 'https:'].includes(candidate.protocol) && !candidate.username && !candidate.password) link = candidate.href; } catch { /* use source */ }
    const content = atom ? row.content ?? row.summary : row['content:encoded'] ?? row.description;
    let html = valueText(content);
    if (atom && content?.['@_type'] === 'xhtml') {
      // XHTML is parsed separately to preserve its markup instead of flattening it.
      html = valueText(content.div);
    } else if (atom && (!content?.['@_type'] || content['@_type'] === 'text')) html = sanitizeHtml(html.replaceAll('&', '&amp;').replaceAll('<', '&lt;'), { allowedTags: [] });
    if (html.length > 200_000 || title.length > 20_000) throw Error('RSS 单条内容超过支持的长度限制');
    html = safeHtml(html, link);
    const sourceId = valueText(atom ? row.id : row.guid ?? row['@_rdf:about']).trim();
    const key = digest(sourceId ? `id:${sourceId}` : rawLink ? `link:${link}` : `content:${title}\n${html}`);
    if (seen.has(key)) continue;
    seen.add(key);
    const date = valueText(atom ? row.published ?? row.updated : row.pubDate ?? row['dc:date']);
    const timestamp = Date.parse(date);
    items.push({ key, title, link, html, ...(Number.isFinite(timestamp) ? { publishedAt: new Date(timestamp).toISOString() } : {}) });
  }
  // Most sources are newest-first; valid dates make the initial history limit reliable.
  if (items.every(item => item.publishedAt)) items.sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!));
  return { title: plain(valueText(channel.title)).trim() || new URL(base).hostname, items: items.slice(0, 100) };
}

/** Pin each connection to the policy-checked IP, including every redirect. */
export async function fetchSource(raw: string, policy: NetworkPolicy, options: SourceOptions = {}): Promise<SourceResult> {
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(options.signal ? [options.signal] : [])]);
  let target = raw;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const { url, address } = await Promise.race([
      policy.resolveForConnection(target),
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
    signal.throwIfAborted();
    const response = await new Promise<{ status: number; location?: string; body: string; etag?: string; modified?: string }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        signal, agent: false, family: isIP(address), headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'accept-encoding': 'identity', 'user-agent': 'FeedLantern/0.3 RSS', ...(options.etag ? { 'if-none-match': options.etag } : {}), ...(options.modified ? { 'if-modified-since': options.modified } : {}) },
        lookup: (_host, _opts, callback) => callback(null, address, isIP(address)),
      }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('error', reject);
        res.on('data', chunk => { size += chunk.length; if (size > 5_000_000) { res.destroy(Error('订阅源超过 5 MB 限制')); return; } chunks.push(chunk); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body: Buffer.concat(chunks).toString('utf8'), etag: res.headers.etag, modified: res.headers['last-modified'] }));
      });
      request.on('error', reject); request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) { target = new URL(response.location, target).href; continue; }
    if (response.status === 304) return { title: '', items: [], unchanged: true };
    if (response.status !== 200) throw Error(`RSS 获取失败（HTTP ${response.status}）`);
    return { ...parseSource(response.body, target), etag: response.etag, modified: response.modified };
  }
  throw Error('RSS 重定向次数过多');
}
