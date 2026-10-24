import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { lookup } from 'node:dns/promises';
import { connect as netConnect, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import type { BrowserContext } from 'playwright';
import { headerScopeMatches, type CustomHeader } from './fetch-options.js';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { formatHost, openResolverTunnel, openTunnelToAny, ProxyConnectError, proxyLabel, type UpstreamProxy } from './upstream-proxy.js';
import { LocalizedError, msg, rawText, type LocalizedText } from './i18n.js';

export interface NetworkPolicyOptions {
  /** Opt in for hosts using a local fake-IP DNS proxy. Results remain checked. */
  dnsOverHttps?: boolean;
  /** Exact URL host values, normally supplied as host:port fixture allowlists. */
  allowedHosts?: readonly string[];
  /** DNS results are cached briefly to avoid resolving every image/script twice. */
  dnsCacheTtlMs?: number;
  /**
   * The upstream proxy of the fetch this policy checks. With DNS over HTTPS
   * on, the DoH query goes through the same proxy, because a network that
   * only works through the proxy cannot reach the resolver directly either.
   * Results are still checked here, and the proxy is then given the IP.
   */
  dohProxy?: UpstreamProxy;
  /** The DNS-over-HTTPS JSON endpoint; tests point it at a local fixture. */
  dohUrl?: string;
}

/** Network policy options for a fetch that may use a network profile proxy. */
export function policyOptionsFor(options: NetworkPolicyOptions, proxy: UpstreamProxy | null | undefined): NetworkPolicyOptions {
  return proxy ? { ...options, dohProxy: proxy } : options;
}

export class NetworkPolicyError extends LocalizedError {
  readonly url?: string;

  constructor(text: LocalizedText, url?: string) {
    super(text);
    this.name = 'NetworkPolicyError';
    this.url = url;
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.google',
  'instance-data.ec2.internal',
]);

// These ranges are deliberately conservative. A target that resolves to a
// private or special-use address is rejected unless its exact host:port was
// explicitly allowed for a local fixture.
const IPV4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const IPV6_BLOCKED: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
];

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

function normalizeHostname(host: string): string {
  const normalized = normalizeHost(host);
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
}

function hostKey(url: URL): string {
  // Keep the protocol's default port in the key.  An allowlist entry for
  // https://example.test:443 must not accidentally authorize HTTP on port 80
  // (and bare host:443 entries must match the corresponding HTTPS URL).
  const hostname = normalizeHostname(url.hostname);
  const formatted = hostname.includes(':') ? `[${hostname}]` : hostname;
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  return `${formatted}:${port}`;
}

function normalizeAllowedHosts(values: readonly string[] | undefined): Set<string> {
  const result = new Set<string>();
  for (const raw of values ?? []) {
    const value = raw.trim();
    if (!value) continue;
    try {
      const parsed = new URL(value.includes('://') ? value : `http://${value}`);
      result.add(hostKey(parsed));
    } catch {
      throw new NetworkPolicyError(msg('network.allowedHostInvalid', { host: raw }));
    }
  }
  return result;
}

function parseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new NetworkPolicyError(msg('network.urlInvalid'), raw);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NetworkPolicyError(msg('network.httpOnly'), raw);
  }
  if (parsed.username || parsed.password) {
    throw new NetworkPolicyError(msg('network.noCredentials'), raw);
  }
  return parsed;
}

function matchesBlockedRange(value: string, ranges: Array<[string, number]>): boolean {
  const parsed = ipaddr.parse(value);
  return ranges.some(([network, prefix]) => parsed.match(ipaddr.parse(network), prefix));
}

export function isPrivateOrSpecialAddress(value: string): boolean {
  if (!ipaddr.isValid(value)) return true;
  const parsed = ipaddr.parse(value);
  if (parsed.kind() === 'ipv4') return matchesBlockedRange(value, IPV4_BLOCKED);

  const ipv6 = parsed as ipaddr.IPv6;
  if (ipv6.isIPv4MappedAddress()) {
    return isPrivateOrSpecialAddress(ipv6.toIPv4Address().toString());
  }
  if (matchesBlockedRange(value, IPV6_BLOCKED)) return true;
  // ipaddr.js names public IPv6 addresses "unicast" (not "global"). Reject
  // every other special range (documentation, benchmark, multicast, ...).
  return parsed.range() !== 'unicast';
}

function isExplicitlyAllowed(url: URL, allowedHosts: Set<string>): boolean {
  return allowedHosts.has(hostKey(url));
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const normalized = normalizeHostname(hostname);
  if (ipaddr.isValid(normalized)) return [normalized];
  try {
    const records = await lookup(normalized, { all: true, verbatim: true });
    return records.map(record => record.address);
  } catch {
    throw new NetworkPolicyError(msg('network.unresolved', { host: normalized }));
  }
}

export const DEFAULT_DOH_URL = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 10_000;
const DOH_MAX_BYTES = 64 * 1024;

function dohQuery(hostname: string, endpoint: string): URL {
  const url = new URL(endpoint);
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', 'A');
  return url;
}

/** The A records of a DNS JSON answer, or an error when there are none. */
function dohAddresses(data: { Status?: number; Answer?: Array<{ type: number; data: string }> }): string[] {
  const addresses = data.Answer?.filter(record => record.type === 1 && ipaddr.isValid(record.data)).map(record => record.data) ?? [];
  if (data.Status !== 0 || !addresses.length) throw new Error('No DNS addresses');
  return addresses;
}

export async function resolveDnsOverHttps(hostname: string, fetcher: typeof fetch = fetch, endpoint = DEFAULT_DOH_URL): Promise<string[]> {
  try {
    const response = await fetcher(dohQuery(hostname, endpoint).href, {
      headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(DOH_TIMEOUT_MS), redirect: 'error',
    });
    if (!response.ok) throw new Error('DNS response failed');
    return dohAddresses(await response.json() as Parameters<typeof dohAddresses>[0]);
  } catch {
    throw new NetworkPolicyError(msg('network.dohFailed'));
  }
}

/**
 * The same query, sent through the feed's upstream proxy. The proxy is
 * reached at `proxyAddress`, already checked against the policy; the
 * resolver host is handed to the proxy by name (see openResolverTunnel) and
 * HTTPS still verifies the resolver's certificate end to end.
 */
export async function resolveDnsOverHttpsViaProxy(hostname: string, proxy: UpstreamProxy, proxyAddress: string, endpoint = DEFAULT_DOH_URL): Promise<string[]> {
  const url = dohQuery(hostname, endpoint);
  const secure = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  const signal = AbortSignal.timeout(DOH_TIMEOUT_MS);
  try {
    const tunnel = await openResolverTunnel(proxy, proxyAddress, url.hostname, port, signal);
    const body = await new Promise<string>((resolve, reject) => {
      const request = (secure ? httpsRequest : httpRequest)(url, {
        // One request per tunnel: `connection: close` keeps the socket out of any agent pool.
        signal, headers: { accept: 'application/dns-json', connection: 'close' },
        createConnection: () => {
          if (!secure) { tunnel.resume(); return tunnel; }
          const socket = tlsConnect({ socket: tunnel, servername: url.hostname, ALPNProtocols: ['http/1.1'] });
          tunnel.resume();
          return socket;
        },
      }, response => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error('DNS response failed')); return; }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > DOH_MAX_BYTES) response.destroy(new Error('DNS response too large')); else chunks.push(chunk); });
        response.on('end', () => { tunnel.destroy(); resolve(Buffer.concat(chunks).toString('utf8')); });
        response.on('error', reject);
      });
      request.on('error', error => { tunnel.destroy(); reject(error); });
      request.end();
    });
    return dohAddresses(JSON.parse(body));
  } catch (error) {
    const proxyName = proxyLabel(proxy);
    const reason = error instanceof ProxyConnectError ? error.text : signal.aborted ? msg('network.dohNoResponse', { seconds: DOH_TIMEOUT_MS / 1000 }) : undefined;
    throw new NetworkPolicyError(reason ? msg('network.dohProxyFailedReason', { proxy: proxyName, reason }) : msg('network.dohProxyFailed', { proxy: proxyName }));
  }
}

/**
 * Validates the initial navigation URL and request URLs. The restricted proxy
 * below uses the same policy and connects to the checked address directly;
 * the route remains as a second guard for requests before they reach it.
 */
export class NetworkPolicy {
  private readonly allowedHosts: Set<string>;
  private readonly dnsCacheTtlMs: number;
  private readonly dnsOverHttps: boolean;
  /**
   * Each policy has its own cache, and a policy with `dohProxy` is always a
   * separate instance, so answers obtained through a proxy are never reused
   * for direct connections (or another proxy), and the other way round.
   */
  private readonly cache = new Map<string, { expiresAt: number; addresses: string[] }>();
  private readonly dohProxy?: UpstreamProxy;
  private readonly dohUrl: string;
  /** Resolves the proxy server itself; that lookup can never go through the proxy. */
  private direct?: NetworkPolicy;

  constructor(private readonly options: NetworkPolicyOptions = {}) {
    this.allowedHosts = normalizeAllowedHosts(options.allowedHosts);
    this.dnsOverHttps = options.dnsOverHttps ?? process.env.DNS_OVER_HTTPS === 'true';
    this.dnsCacheTtlMs = Math.max(0, options.dnsCacheTtlMs ?? 30_000);
    this.dohProxy = options.dohProxy;
    this.dohUrl = options.dohUrl ?? DEFAULT_DOH_URL;
  }

  /** The same policy for a fetch through `proxy` (or this one when there is none). */
  forProxy(proxy: UpstreamProxy | null | undefined): NetworkPolicy {
    if (!proxy || proxy === this.dohProxy) return this;
    // Same class, so a subclass (tests, diagnostics) keeps its behaviour.
    return new (this.constructor as new (options: NetworkPolicyOptions) => NetworkPolicy)({ ...this.options, dohProxy: proxy });
  }

  private directPolicy(): NetworkPolicy {
    if (!this.dohProxy) return this;
    this.direct ??= new (this.constructor as new (options: NetworkPolicyOptions) => NetworkPolicy)({ ...this.options, dohProxy: undefined });
    return this.direct;
  }

  private async lookupCached(hostname: string): Promise<string[]> {
    const normalized = normalizeHostname(hostname);
    const now = Date.now();
    const cached = this.cache.get(normalized);
    if (cached && cached.expiresAt > now) return cached.addresses;
    const doh = this.dnsOverHttps && !ipaddr.isValid(normalized) && !BLOCKED_HOSTNAMES.has(normalized) && !normalized.endsWith('.localhost');
    const addresses = !doh ? await resolveHostAddresses(normalized)
      : this.dohProxy ? await resolveDnsOverHttpsViaProxy(normalized, this.dohProxy, await this.resolveProxy(this.dohProxy), this.dohUrl)
        : await resolveDnsOverHttps(normalized, fetch, this.dohUrl);
    this.cache.set(normalized, { expiresAt: now + this.dnsCacheTtlMs, addresses });
    return addresses;
  }

  async assertAllowed(rawUrl: string): Promise<URL> {
    const url = parseUrl(rawUrl);
    if (isExplicitlyAllowed(url, this.allowedHosts)) return url;

    const hostname = normalizeHostname(url.hostname);
    if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
      throw new NetworkPolicyError(msg('network.ssrfBlocked', { host: hostname }), rawUrl);
    }

    const addresses = await this.lookupCached(hostname);
    if (addresses.length === 0 || addresses.some(address => isPrivateOrSpecialAddress(address))) {
      const fakeIp = addresses.some(address => ipaddr.isValid(address) && ipaddr.parse(address).kind() === 'ipv4' && matchesBlockedRange(address, [['198.18.0.0', 15]]));
      throw new NetworkPolicyError(fakeIp
        ? msg('network.fakeIp', { host: hostname })
        : msg('network.privateAddress', { host: hostname }), rawUrl);
    }
    return url;
  }

  /** Resolve and return the exact address used by the restricted proxy. */
  async resolveForConnection(rawUrl: string): Promise<{ url: URL; address: string; addresses?: string[] }> {
    const url = parseUrl(rawUrl);
    const explicit = isExplicitlyAllowed(url, this.allowedHosts);
    if (!explicit) await this.assertAllowed(rawUrl);
    const addresses = (await this.lookupCached(url.hostname)).filter(item => explicit || !isPrivateOrSpecialAddress(item));
    if (!addresses.length) throw new NetworkPolicyError(msg('network.noPublicAddress', { host: url.hostname }), rawUrl);
    // `addresses` are all checked; tunnels through a profile proxy try each in turn.
    return { url, address: addresses[0], addresses };
  }

  /**
   * A user's upstream proxy must pass the same checks as a target: it may not
   * be a loopback, private or metadata address unless its exact host:port is
   * in the administrator's allowedHosts. Returns the checked address to dial.
   */
  async resolveProxy(proxy: Pick<UpstreamProxy, 'type' | 'host' | 'port'>): Promise<string> {
    const raw = `http://${formatHost(proxy.host)}:${proxy.port}/`;
    try {
      return (await this.directPolicy().resolveForConnection(raw)).address;
    } catch (error) {
      if (!(error instanceof NetworkPolicyError)) throw error;
      if (error.text.key === 'network.unresolved') throw new NetworkPolicyError(msg('network.proxyUnresolved', { proxy: proxyLabel(proxy) }));
      throw new NetworkPolicyError(msg('network.proxyPrivate', { proxy: proxyLabel(proxy), address: `${formatHost(proxy.host)}:${proxy.port}` }));
    }
  }

  /** Useful for tests and diagnostics without exposing the allowlist. */
  hasExplicitHost(rawUrl: string): boolean {
    return isExplicitlyAllowed(parseUrl(rawUrl), this.allowedHosts);
  }
}

export interface ContextHeaders {
  /** The feed URL; custom headers go only to this site (see headerScopeMatches). */
  scopeUrl: string;
  headers: readonly CustomHeader[];
}

/** Attach request and WebSocket guards before the first page is created. */
export async function installNetworkPolicy(
  context: BrowserContext,
  options: NetworkPolicyOptions = {},
  extra?: ContextHeaders,
): Promise<NetworkPolicy> {
  const policy = new NetworkPolicy(options);
  await context.route('**/*', async route => {
    try {
      const url = route.request().url();
      await policy.assertAllowed(url);
      if (extra?.headers.length && headerScopeMatches(url, extra.scopeUrl)) {
        const headers = { ...(await route.request().allHeaders()) };
        for (const header of extra.headers) headers[header.name.toLowerCase()] = header.value;
        await route.continue({ headers });
      } else await route.continue();
    } catch {
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  });
  // Service workers are disabled in BrowserService's context options. This
  // route closes page-created WebSockets too, so live streams cannot bypass
  // the request policy or keep an editor session alive indefinitely.
  await context.routeWebSocket('**/*', async websocket => {
    await websocket.close({ code: 1008, reason: 'WebSocket disabled by FeedLantern' }).catch(() => undefined);
  });
  return policy;
}

export interface RestrictedForwardProxy {
  readonly url: string;
  /** Present when the proxy requires its own per-instance login. */
  readonly credentials?: { username: string; password: string };
  /** The latest upstream proxy failure, safe to show to the user. */
  readonly lastError?: LocalizedText;
  /** Forget lastError, before a new navigation. */
  resetError(): void;
  close(): Promise<void>;
}

export interface RestrictedForwardProxyOptions extends NetworkPolicyOptions {
  /**
   * Forward every checked connection through this proxy. The target address
   * is still resolved and checked here, and the proxy is given that IP.
   */
  upstream?: UpstreamProxy;
  /**
   * Demand a random per-instance Basic login. Used with `upstream`, so other
   * local processes cannot borrow the user's proxy through the loopback port.
   */
  requireAuth?: boolean;
}

const PROXY_AUTH_REQUIRED = 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="FeedLantern"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

function writeProxyError(response: import('node:http').ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
  response.end(message);
}

const PROXY_TIMEOUT_MS = 30_000;

function writeConnectError(socket: Socket, status: number): void {
  // The reason phrase is deliberately fixed.  DNS and socket error messages
  // are not valid HTTP reason phrases and may contain CR/LF or other bytes.
  const reason = status === 403 ? 'Forbidden' : 'Bad Gateway';
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
}

function abortRequest(request: ClientRequest): void {
  request.destroy();
}

function abortIncoming(incoming: IncomingMessage): void {
  if (!incoming.destroyed) incoming.destroy();
}

function requestPath(url: URL): string {
  return `${url.pathname || '/'}${url.search}`;
}

function targetPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

/**
 * A small loopback-only forward proxy. The browser still renders pages in
 * Chromium, but every HTTP request is resolved and connected by Node using a
 * checked IP address. CONNECT keeps TLS termination in Chromium, preserving
 * certificate/SNI behaviour while fixing the TCP destination selected by the
 * proxy. This closes the DNS-check/Chromium-second-lookup gap left by a bare
 * browserContext.route() implementation.
 */
export async function createRestrictedForwardProxy(
  options: RestrictedForwardProxyOptions = {},
): Promise<RestrictedForwardProxy> {
  const { upstream, requireAuth, ...policyOptions } = options;
  // With an upstream proxy, DNS-over-HTTPS lookups go through it as well.
  const policy = new NetworkPolicy(policyOptionsFor(policyOptions, upstream));
  const sockets = new Set<Socket>();
  const upstreamRequests = new Set<ClientRequest>();
  const credentials = requireAuth ? { username: 'feedlantern', password: randomBytes(24).toString('base64url') } : undefined;
  const expectedAuth = credentials ? Buffer.from(`Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`) : undefined;
  let lastError: LocalizedText | undefined;
  const authorized = (header: string | string[] | undefined): boolean => {
    if (!expectedAuth) return true;
    const actual = Buffer.from(typeof header === 'string' ? header : '');
    return actual.length === expectedAuth.length && timingSafeEqual(actual, expectedAuth);
  };
  /** A socket to the checked target address, direct or through the upstream proxy. */
  const dial = async (addresses: readonly string[], port: number): Promise<Socket> => {
    if (!upstream) throw new Error('no upstream');
    try {
      const proxyAddress = await policy.resolveProxy(upstream);
      return await openTunnelToAny(upstream, proxyAddress, addresses, port);
    } catch (error) {
      if (error instanceof ProxyConnectError || error instanceof NetworkPolicyError) lastError = error.text;
      throw error;
    }
  };
  const server = createServer(async (incoming, outgoing) => {
    if (!authorized(incoming.headers['proxy-authorization'])) {
      outgoing.writeHead(407, { 'proxy-authenticate': 'Basic realm="FeedLantern"', connection: 'close', 'content-length': '0' });
      outgoing.end();
      return;
    }
    incoming.setTimeout(PROXY_TIMEOUT_MS, () => abortIncoming(incoming));
    outgoing.setTimeout(PROXY_TIMEOUT_MS, () => outgoing.destroy());
    const raw = incoming.url ?? '';
    const hostHeader = incoming.headers.host;
    let target: URL;
    try {
      target = new URL(raw, `http://${hostHeader ?? ''}`);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new NetworkPolicyError(rawText('The proxy only handles HTTP(S) requests'));
      }
      if (target.protocol === 'https:') {
        throw new NetworkPolicyError(rawText('HTTPS requests must use a CONNECT tunnel'));
      }
      const connection = await policy.resolveForConnection(target.toString());
      const port = targetPort(target);
      if (!validPort(port)) throw new NetworkPolicyError(rawText('Invalid target port'));
      if (incoming.destroyed || outgoing.destroyed) return;

      const headers: Record<string, string | string[] | undefined> = { ...incoming.headers };
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];
      delete headers['connection'];
      delete headers['keep-alive'];
      delete headers['upgrade'];
      headers.host = target.host;
      const tunnel = upstream ? await dial(connection.addresses ?? [connection.address], port) : undefined;
      if (incoming.destroyed || outgoing.destroyed) { tunnel?.destroy(); return; }
      const upstreamRequest = httpRequest({
        protocol: 'http:',
        hostname: normalizeHostname(target.hostname),
        port,
        method: incoming.method,
        path: requestPath(target),
        headers,
        ...(tunnel ? { createConnection: () => tunnel } : {
          agent: false,
          // Use the already checked address. Node never performs another DNS
          // lookup for this request.
          lookup: (_hostname: string, _options: unknown, callback: (error: Error | null, address: string, family: 4 | 6) => void) => {
            callback(null, connection.address, Number(ipaddr.parse(connection.address).kind().slice(-1)) as 4 | 6);
          },
        }),
      });
      // The tunnel was left paused after the proxy handshake.
      if (tunnel) upstreamRequest.once('socket', socket => socket.resume());
      upstreamRequests.add(upstreamRequest);
      upstreamRequest.setTimeout(PROXY_TIMEOUT_MS, () => upstreamRequest.destroy(new Error('upstream timeout')));
      upstreamRequest.once('close', () => upstreamRequests.delete(upstreamRequest));
      const closeUpstream = () => abortRequest(upstreamRequest);
      incoming.once('aborted', closeUpstream);
      incoming.once('close', () => {
        if (!incoming.complete) closeUpstream();
      });
      outgoing.once('close', closeUpstream);
      upstreamRequest.on('response', response => {
        if (outgoing.destroyed) {
          response.destroy();
          return;
        }
        response.setTimeout(PROXY_TIMEOUT_MS, () => response.destroy(new Error('upstream response timeout')));
        const responseHeaders = { ...response.headers, connection: 'close' };
        outgoing.writeHead(response.statusCode ?? 502, responseHeaders);
        response.once('close', () => {
          if (!outgoing.writableEnded && !outgoing.destroyed) outgoing.end();
        });
        response.pipe(outgoing);
      });
      upstreamRequest.on('error', error => writeProxyError(outgoing, 502, `Upstream request failed: ${error.message}`));
      incoming.pipe(upstreamRequest);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Proxy request blocked';
      if (error instanceof ProxyConnectError) {
        // An upstream proxy failure is answered with a readable 502, so the
        // browser service can report the reason; a body still arriving is dropped.
        writeProxyError(outgoing, 502, message);
        if (!incoming.complete) outgoing.once('finish', () => abortIncoming(incoming));
        return;
      }
      // A blocked target must fail as a network error, never as a page that
      // loads: Chromium follows redirects to this proxy without the route guard.
      abortIncoming(incoming);
      writeProxyError(outgoing, error instanceof NetworkPolicyError ? 403 : 502, message);
    }
  });

  server.on('connect', async (request, clientSocket, head) => {
    const client = clientSocket as Socket;
    if (!authorized(request.headers['proxy-authorization'])) {
      if (!client.destroyed) client.end(PROXY_AUTH_REQUIRED);
      return;
    }
    client.setTimeout(PROXY_TIMEOUT_MS, () => client.destroy());
    let target: URL;
    let remote: Socket | undefined;
    let closed = false;
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (remote && !remote.destroyed) remote.destroy();
    };
    client.once('close', closeBoth);
    client.on('error', closeBoth);
    try {
      const authority = request.url ?? '';
      target = new URL(`https://${authority}/`);
      if (target.username || target.password) throw new NetworkPolicyError(rawText('CONNECT targets cannot carry credentials'));
      if (target.pathname !== '/' || target.search || target.hash) throw new NetworkPolicyError(rawText('Invalid CONNECT target'));
      const connection = await policy.resolveForConnection(target.toString());
      const port = targetPort(target);
      if (!validPort(port)) throw new NetworkPolicyError(rawText('Invalid CONNECT target port'));
      if (client.destroyed) return;
      if (upstream) {
        const tunnel = await dial(connection.addresses ?? [connection.address], port);
        sockets.add(tunnel);
        remote = tunnel;
        if (closed || client.destroyed) return closeBoth();
        tunnel.setTimeout(PROXY_TIMEOUT_MS, () => closeBoth());
        tunnel.on('error', closeBoth);
        tunnel.once('close', () => {
          sockets.delete(tunnel);
          closeBoth();
        });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) tunnel.write(head);
        client.pipe(tunnel);
        tunnel.pipe(client);
        return;
      }
      const tunnel = netConnect({
        host: connection.address,
        port,
        family: Number(ipaddr.parse(connection.address).kind().slice(-1)) as 4 | 6,
      }) as Socket;
      remote = tunnel;
      sockets.add(tunnel);
      tunnel.setTimeout(PROXY_TIMEOUT_MS, () => closeBoth());
      tunnel.once('connect', () => {
        if (closed || client.destroyed) return closeBoth();
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) tunnel.write(head);
        client.pipe(tunnel);
        tunnel.pipe(client);
      });
      tunnel.on('error', closeBoth);
      tunnel.once('close', () => {
        sockets.delete(tunnel);
        closeBoth();
      });
    } catch (error) {
      writeConnectError(client, error instanceof NetworkPolicyError ? 403 : 502);
    }
  });

  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.headersTimeout = PROXY_TIMEOUT_MS;
  server.requestTimeout = PROXY_TIMEOUT_MS;
  server.timeout = PROXY_TIMEOUT_MS;
  server.keepAliveTimeout = 1_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw new NetworkPolicyError(rawText('The restricted proxy could not get a listening port'));
  }
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    ...(credentials ? { credentials } : {}),
    get lastError() { return lastError; },
    resetError() { lastError = undefined; },
    async close() {
      if (closed) return;
      closed = true;
      for (const request of upstreamRequests) request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => {
        server.close(() => resolve());
      });
    },
  };
}

export function allowedHostListFromEnv(value = process.env.ALLOWED_TARGET_HOSTS): string[] {
  return (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}
