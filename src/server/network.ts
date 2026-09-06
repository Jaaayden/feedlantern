import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { lookup } from 'node:dns/promises';
import { connect as netConnect, type Socket } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { BrowserContext } from 'playwright';

export interface NetworkPolicyOptions {
  /** Opt in for hosts using a local fake-IP DNS proxy. Results remain checked. */
  dnsOverHttps?: boolean;
  /** Exact URL host values, normally supplied as host:port fixture allowlists. */
  allowedHosts?: readonly string[];
  /** DNS results are cached briefly to avoid resolving every image/script twice. */
  dnsCacheTtlMs?: number;
}

export class NetworkPolicyError extends Error {
  readonly url?: string;

  constructor(message: string, url?: string) {
    super(message);
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
      throw new NetworkPolicyError(`ALLOWED_TARGET_HOSTS 中存在无效 host：${raw}`);
    }
  }
  return result;
}

function parseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new NetworkPolicyError('目标 URL 无效', raw);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NetworkPolicyError('只允许访问 HTTP 或 HTTPS URL', raw);
  }
  if (parsed.username || parsed.password) {
    throw new NetworkPolicyError('目标 URL 不允许携带用户名或密码', raw);
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
    throw new NetworkPolicyError(`无法解析目标主机：${normalized}`);
  }
}

export async function resolveDnsOverHttps(hostname: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  try {
    const response = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) throw new Error('DNS response failed');
    const data = await response.json() as { Status?: number; Answer?: Array<{ type: number; data: string }> };
    const addresses = data.Answer?.filter(record => record.type === 1 && ipaddr.isValid(record.data)).map(record => record.data) ?? [];
    if (data.Status !== 0 || !addresses.length) throw new Error('No DNS addresses');
    return addresses;
  } catch {
    throw new NetworkPolicyError('加密 DNS 查询失败，请检查网络连接或关闭 DNS_OVER_HTTPS 设置');
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
  private readonly cache = new Map<string, { expiresAt: number; addresses: string[] }>();

  constructor(options: NetworkPolicyOptions = {}) {
    this.allowedHosts = normalizeAllowedHosts(options.allowedHosts);
    this.dnsOverHttps = options.dnsOverHttps ?? process.env.DNS_OVER_HTTPS === 'true';
    this.dnsCacheTtlMs = Math.max(0, options.dnsCacheTtlMs ?? 30_000);
  }

  private async lookupCached(hostname: string): Promise<string[]> {
    const normalized = normalizeHostname(hostname);
    const now = Date.now();
    const cached = this.cache.get(normalized);
    if (cached && cached.expiresAt > now) return cached.addresses;
    const addresses = this.dnsOverHttps && !ipaddr.isValid(normalized) && !BLOCKED_HOSTNAMES.has(normalized) && !normalized.endsWith('.localhost')
      ? await resolveDnsOverHttps(normalized)
      : await resolveHostAddresses(normalized);
    this.cache.set(normalized, { expiresAt: now + this.dnsCacheTtlMs, addresses });
    return addresses;
  }

  async assertAllowed(rawUrl: string): Promise<URL> {
    const url = parseUrl(rawUrl);
    if (isExplicitlyAllowed(url, this.allowedHosts)) return url;

    const hostname = normalizeHostname(url.hostname);
    if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
      throw new NetworkPolicyError(`目标主机被 SSRF 策略阻止：${hostname}`, rawUrl);
    }

    const addresses = await this.lookupCached(hostname);
    if (addresses.length === 0 || addresses.some(address => isPrivateOrSpecialAddress(address))) {
      const fakeIp = addresses.some(address => ipaddr.isValid(address) && ipaddr.parse(address).kind() === 'ipv4' && matchesBlockedRange(address, [['198.18.0.0', 15]]));
      throw new NetworkPolicyError(fakeIp
        ? `目标域名被本机 DNS 解析到保留地址（可能启用了代理 Fake-IP）：${hostname}。可设置 DNS_OVER_HTTPS=true 后重启服务`
        : `目标主机解析到私网或特殊地址，已阻止：${hostname}`, rawUrl);
    }
    return url;
  }

  /** Resolve and return the exact address used by the restricted proxy. */
  async resolveForConnection(rawUrl: string): Promise<{ url: URL; address: string }> {
    const url = parseUrl(rawUrl);
    const explicit = isExplicitlyAllowed(url, this.allowedHosts);
    if (!explicit) await this.assertAllowed(rawUrl);
    const addresses = await this.lookupCached(url.hostname);
    const address = addresses.find(item => explicit || !isPrivateOrSpecialAddress(item));
    if (!address) throw new NetworkPolicyError(`目标主机没有可连接的公网地址：${url.hostname}`, rawUrl);
    return { url, address };
  }

  /** Useful for tests and diagnostics without exposing the allowlist. */
  hasExplicitHost(rawUrl: string): boolean {
    return isExplicitlyAllowed(parseUrl(rawUrl), this.allowedHosts);
  }
}

/** Attach request and WebSocket guards before the first page is created. */
export async function installNetworkPolicy(
  context: BrowserContext,
  options: NetworkPolicyOptions = {},
): Promise<NetworkPolicy> {
  const policy = new NetworkPolicy(options);
  await context.route('**/*', async route => {
    try {
      await policy.assertAllowed(route.request().url());
      await route.continue();
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
  close(): Promise<void>;
}

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
  options: NetworkPolicyOptions = {},
): Promise<RestrictedForwardProxy> {
  const policy = new NetworkPolicy(options);
  const sockets = new Set<Socket>();
  const upstreamRequests = new Set<ClientRequest>();
  const server = createServer(async (incoming, outgoing) => {
    incoming.setTimeout(PROXY_TIMEOUT_MS, () => abortIncoming(incoming));
    outgoing.setTimeout(PROXY_TIMEOUT_MS, () => outgoing.destroy());
    const raw = incoming.url ?? '';
    const hostHeader = incoming.headers.host;
    let target: URL;
    try {
      target = new URL(raw, `http://${hostHeader ?? ''}`);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new NetworkPolicyError('代理只支持 HTTP(S) 请求');
      }
      if (target.protocol === 'https:') {
        throw new NetworkPolicyError('HTTPS 请求必须通过 CONNECT 建立隧道');
      }
      const connection = await policy.resolveForConnection(target.toString());
      const port = targetPort(target);
      if (!validPort(port)) throw new NetworkPolicyError('目标端口无效');
      if (incoming.destroyed || outgoing.destroyed) return;

      const headers: Record<string, string | string[] | undefined> = { ...incoming.headers };
      delete headers['proxy-connection'];
      delete headers['connection'];
      delete headers['keep-alive'];
      delete headers['upgrade'];
      headers.host = target.host;
      const upstream = httpRequest({
        protocol: 'http:',
        hostname: normalizeHostname(target.hostname),
        port,
        method: incoming.method,
        path: requestPath(target),
        headers,
        agent: false,
        // Use the already checked address. Node never performs another DNS
        // lookup for this request.
        lookup: (_hostname, _options, callback) => {
          callback(null, connection.address, Number(ipaddr.parse(connection.address).kind().slice(-1)) as 4 | 6);
        },
      });
      upstreamRequests.add(upstream);
      upstream.setTimeout(PROXY_TIMEOUT_MS, () => upstream.destroy(new Error('upstream timeout')));
      upstream.once('close', () => upstreamRequests.delete(upstream));
      const closeUpstream = () => abortRequest(upstream);
      incoming.once('aborted', closeUpstream);
      incoming.once('close', () => {
        if (!incoming.complete) closeUpstream();
      });
      outgoing.once('close', closeUpstream);
      upstream.on('response', response => {
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
      upstream.on('error', error => writeProxyError(outgoing, 502, `上游请求失败：${error.message}`));
      incoming.pipe(upstream);
    } catch (error) {
      const message = error instanceof Error ? error.message : '代理请求被阻止';
      abortIncoming(incoming);
      writeProxyError(outgoing, error instanceof NetworkPolicyError ? 403 : 502, message);
    }
  });

  server.on('connect', async (request, clientSocket, head) => {
    const client = clientSocket as Socket;
    client.setTimeout(PROXY_TIMEOUT_MS, () => client.destroy());
    let target: URL;
    let upstream: Socket | undefined;
    let closed = false;
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (upstream && !upstream.destroyed) upstream.destroy();
    };
    client.once('close', closeBoth);
    client.on('error', closeBoth);
    try {
      const authority = request.url ?? '';
      target = new URL(`https://${authority}/`);
      if (target.username || target.password) throw new NetworkPolicyError('CONNECT 目标不允许凭证');
      if (target.pathname !== '/' || target.search || target.hash) throw new NetworkPolicyError('CONNECT 目标格式无效');
      const connection = await policy.resolveForConnection(target.toString());
      const port = targetPort(target);
      if (!validPort(port)) throw new NetworkPolicyError('CONNECT 目标端口无效');
      if (client.destroyed) return;
      const tunnel = netConnect({
        host: connection.address,
        port,
        family: Number(ipaddr.parse(connection.address).kind().slice(-1)) as 4 | 6,
      }) as Socket;
      upstream = tunnel;
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
    throw new NetworkPolicyError('受限代理未能获取监听端口');
  }
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
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
