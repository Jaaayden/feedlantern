import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import sanitizeHtml from 'sanitize-html';
import { NetworkPolicy } from './network.js';
import { scopedHeaders, type FetchNetworkOptions } from './fetch-options.js';
import { openTunnelToAny } from './upstream-proxy.js';

export interface SourceItem { key: string; title: string; link: string; html: string; publishedAt?: string }
export interface SourceResult { title: string; items: SourceItem[]; etag?: string; modified?: string; unchanged?: boolean }
export interface SourceOptions { etag?: string; modified?: string; signal?: AbortSignal; network?: FetchNetworkOptions }
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

interface RawResponse { status: number; location?: string; body: string; etag?: string; modified?: string }

/**
 * One HTTP request to the checked address, directly or through the feed's
 * upstream proxy. The proxy address passes the same policy as targets.
 */
async function requestOnce(url: URL, addresses: readonly string[], policy: NetworkPolicy, headers: Record<string, string>, signal: AbortSignal, network?: FetchNetworkOptions, maxBytes = 5_000_000): Promise<RawResponse> {
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  let tunnel: Socket | undefined;
  if (network?.proxy) {
    const proxyAddress = await policy.resolveProxy(network.proxy);
    signal.throwIfAborted();
    tunnel = await openTunnelToAny(network.proxy, proxyAddress, addresses, port, signal);
  }
  // A direct connection keeps the previous behaviour: the first checked address.
  const address = addresses[0];
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise<RawResponse>((resolve, reject) => {
    const connection = tunnel
      ? { createConnection: () => {
        if (url.protocol !== 'https:') { tunnel!.resume(); return tunnel!; }
        const secure = tlsConnect({ socket: tunnel!, servername: isIP(hostname) ? undefined : hostname, ALPNProtocols: ['http/1.1'] });
        tunnel!.resume();
        return secure;
      } }
      : { agent: false as const, family: isIP(address), lookup: (_host: string, _opts: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, address, isIP(address)) };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      signal, headers, ...connection,
    }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('error', reject);
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { res.destroy(Error('订阅源超过 5 MB 限制')); return; } chunks.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body: Buffer.concat(chunks).toString('utf8'), etag: res.headers.etag, modified: res.headers['last-modified'] }));
    });
    request.on('error', error => { tunnel?.destroy(); reject(error); });
    request.end();
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  ]);
}

function requestHeaders(target: string, raw: string, network: FetchNetworkOptions | undefined, accept: string): Record<string, string> {
  return {
    accept, 'accept-encoding': 'identity', 'user-agent': network?.userAgent ?? 'FeedLantern/0.3 RSS',
    ...(network?.referer ? { referer: network.referer } : {}),
    // Custom header values may be secrets; a redirect to another site drops them.
    ...scopedHeaders(network, target, raw),
  };
}

/** Pin each connection to the policy-checked IP, including every redirect. */
export async function fetchSource(raw: string, policy: NetworkPolicy, options: SourceOptions = {}): Promise<SourceResult> {
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(options.signal ? [options.signal] : [])]);
  let target = raw;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const { url, address, addresses = [address] } = await abortable(policy.resolveForConnection(target), signal);
    signal.throwIfAborted();
    const headers = { ...requestHeaders(target, raw, options.network, 'application/rss+xml, application/atom+xml, application/xml, text/xml'), ...(options.etag ? { 'if-none-match': options.etag } : {}), ...(options.modified ? { 'if-modified-since': options.modified } : {}) };
    const response = await requestOnce(url, addresses, policy, headers, signal, options.network);
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) { target = new URL(response.location, target).href; continue; }
    if (response.status === 304) return { title: '', items: [], unchanged: true };
    if (response.status !== 200) throw Error(`RSS 获取失败（HTTP ${response.status}）`);
    return { ...parseSource(response.body, target), etag: response.etag, modified: response.modified };
  }
  throw Error('RSS 重定向次数过多');
}

/** One GET with a network profile applied, for the profile's connection test. Redirects are not followed. */
export async function probeTarget(raw: string, policy: NetworkPolicy, network: FetchNetworkOptions | undefined, signal?: AbortSignal): Promise<{ status: number }> {
  const combined = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
  const { url, address, addresses = [address] } = await abortable(policy.resolveForConnection(raw), combined);
  const response = await requestOnce(url, addresses, policy, requestHeaders(raw, raw, network, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'), combined, network, 1_000_000).catch(error => {
    if (error instanceof Error && /超过 5 MB/.test(error.message)) return { status: 200, body: '' } as RawResponse;
    throw error;
  });
  return { status: response.status };
}
