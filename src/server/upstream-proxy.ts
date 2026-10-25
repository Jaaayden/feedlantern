import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import ipaddr from 'ipaddr.js';
import { LocalizedError, msg, type LocalizedText } from './i18n.js';
import type { MessageKey, Param } from '../shared/i18n.js';

export type ProxyType = 'http' | 'https' | 'socks5';

/** A user's upstream proxy. Credentials stay in this Node process only. */
export interface UpstreamProxy {
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** Raised for every upstream proxy failure. Messages never contain credentials. */
export class ProxyConnectError extends LocalizedError {
  /** The proxy works, but could not reach this target address; another address may. */
  readonly targetFailed: boolean;
  constructor(text: LocalizedText, targetFailed = false) {
    super(text);
    this.name = 'ProxyConnectError';
    this.targetFailed = targetFailed;
  }
}

const typeLabels: Record<ProxyType, MessageKey> = { http: 'proxy.type.http', https: 'proxy.type.https', socks5: 'proxy.type.socks5' };
const TUNNEL_TIMEOUT_MS = 15_000;
const MAX_CONNECT_RESPONSE = 16 * 1024;

export function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * host:port and the proxy kind, without a scheme. The scheme is left out on
 * purpose: user-facing errors replace http(s) URLs with a placeholder.
 */
export function proxyLabel(proxy: Pick<UpstreamProxy, 'type' | 'host' | 'port'>): LocalizedText {
  return msg('proxy.label', { address: `${formatHost(proxy.host)}:${proxy.port}`, type: { key: typeLabels[proxy.type] } });
}

function socketErrorMessage(error: NodeJS.ErrnoException, label: Param): LocalizedText {
  switch (error.code) {
    case 'ECONNREFUSED': return msg('proxy.refused', { proxy: label });
    case 'ETIMEDOUT': return msg('proxy.timeout', { proxy: label });
    case 'EHOSTUNREACH':
    case 'ENETUNREACH': return msg('proxy.unreachable', { proxy: label });
    case 'ECONNRESET':
    case 'EPIPE': return msg('proxy.reset', { proxy: label });
    default:
      if (/certificate|self.signed|CERT_|SSL|TLS/i.test(`${error.code ?? ''} ${error.message}`)) return msg('proxy.tls', { proxy: label });
      return error.code ? msg('proxy.connectFailedCode', { proxy: label, code: error.code }) : msg('proxy.connectFailed', { proxy: label });
  }
}

/** Reads from a paused-mode socket until `complete` returns a byte count, keeping the rest unread. */
function readHandshake(socket: Socket, complete: (data: Buffer) => number | undefined, max = MAX_CONNECT_RESPONSE): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const used = complete(buffer);
      if (used !== undefined) {
        cleanup();
        socket.pause();
        if (used < buffer.length) socket.unshift(buffer.subarray(used));
        resolve(buffer.subarray(0, used));
      } else if (buffer.length > max) {
        cleanup();
        reject(new Error('response too large'));
      }
    };
    const onEnd = () => { cleanup(); reject(new Error('closed')); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.resume();
  });
}

const socksReplies: Record<number, MessageKey> = {
  1: 'proxy.socks.1', 2: 'proxy.socks.2', 3: 'proxy.socks.3', 4: 'proxy.socks.4',
  5: 'proxy.socks.5', 6: 'proxy.socks.6', 7: 'proxy.socks.7', 8: 'proxy.socks.8',
};

async function httpConnect(socket: Socket, proxy: UpstreamProxy, authority: string, label: Param): Promise<void> {
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (proxy.username !== undefined) {
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}`);
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  let head: Buffer;
  try {
    head = await readHandshake(socket, data => {
      const end = data.indexOf('\r\n\r\n');
      return end < 0 ? undefined : end + 4;
    });
  } catch {
    throw new ProxyConnectError(msg('proxy.badConnect', { proxy: label }));
  }
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'))?.[1];
  if (!status) throw new ProxyConnectError(msg('proxy.badConnect', { proxy: label }));
  if (status === '407') {
    throw new ProxyConnectError(proxy.username === undefined
      ? msg('proxy.authRequired', { proxy: label })
      : msg('proxy.authFailed'));
  }
  if (!status.startsWith('2')) throw new ProxyConnectError(msg('proxy.connectRejected', { proxy: label, status }), true);
}

async function socksConnect(socket: Socket, proxy: UpstreamProxy, address: string, port: number, label: Param): Promise<void> {
  const auth = proxy.username !== undefined;
  const invalid = () => new ProxyConnectError(msg('proxy.badSocks', { proxy: label }));
  socket.write(Buffer.from(auth ? [5, 2, 0x00, 0x02] : [5, 1, 0x00]));
  const choice = await readHandshake(socket, data => data.length >= 2 ? 2 : undefined).catch(() => { throw invalid(); });
  if (choice[0] !== 5) throw invalid();
  if (choice[1] === 0xff || (choice[1] === 0x02 && !auth) || ![0x00, 0x02].includes(choice[1])) {
    throw new ProxyConnectError(auth
      ? msg('proxy.socksNoPassword', { proxy: label })
      : msg('proxy.socksAuthRequired', { proxy: label }));
  }
  if (choice[1] === 0x02) {
    const username = Buffer.from(proxy.username ?? '', 'utf8');
    const password = Buffer.from(proxy.password ?? '', 'utf8');
    socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]));
    const result = await readHandshake(socket, data => data.length >= 2 ? 2 : undefined).catch(() => { throw invalid(); });
    if (result[1] !== 0) throw new ProxyConnectError(msg('proxy.socksAuthFailed'));
  }
  const family = isIP(address);
  // A host name (atyp 3) is only used for the fixed DNS-over-HTTPS resolver (see openResolverTunnel).
  const target = family
    ? Buffer.concat([Buffer.from([family === 4 ? 1 : 4]), Buffer.from(ipaddr.parse(address).toByteArray())])
    : Buffer.concat([Buffer.from([3, Buffer.byteLength(address)]), Buffer.from(address)]);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), target, Buffer.from([port >> 8, port & 0xff])]));
  const reply = await readHandshake(socket, data => {
    if (data.length < 5) return undefined;
    const length = data[3] === 1 ? 10 : data[3] === 4 ? 22 : data[3] === 3 ? 7 + data[4] : -1;
    if (length < 0) return data.length;
    return data.length >= length ? length : undefined;
  }).catch(() => { throw invalid(); });
  if (reply[0] !== 5) throw invalid();
  // 1 (general failure) and 2 (ruleset) are about the proxy; the rest are about this address.
  if (reply[1] !== 0) throw new ProxyConnectError(msg('proxy.socksTargetFailed', { proxy: label, reason: socksReplies[reply[1]] ? { key: socksReplies[reply[1]] } : msg('proxy.socksCode', { code: String(reply[1]) }) }), reply[1] >= 3);
}

/**
 * Tries each checked address of a target in order, like a browser does when
 * a host has both IPv6 and IPv4 addresses. Only a failure to reach that
 * address moves on; proxy errors (unreachable, login) are reported at once.
 */
export async function openTunnelToAny(proxy: UpstreamProxy, proxyAddress: string, addresses: readonly string[], port: number, signal?: AbortSignal): Promise<Socket> {
  let last: unknown;
  for (const address of addresses) {
    try {
      return await openTunnel(proxy, proxyAddress, address, port, signal);
    } catch (error) {
      last = error;
      if (!(error instanceof ProxyConnectError) || !error.targetFailed) throw error;
    }
  }
  throw last ?? new ProxyConnectError(msg('proxy.targetFailed', { proxy: proxyLabel(proxy) }), true);
}

/**
 * Opens a TCP tunnel to `address:port` through the upstream proxy. The proxy
 * itself is reached at `proxyAddress`, which the caller has already checked
 * against the network policy. The target is always given to the proxy as the
 * checked IP address, never as a host name, so the proxy cannot resolve it to
 * a different (for example internal) address.
 */
export function openTunnel(proxy: UpstreamProxy, proxyAddress: string, address: string, port: number, signal?: AbortSignal): Promise<Socket> {
  if (!isIP(address)) return Promise.reject(new ProxyConnectError(msg('proxy.tunnelTarget')));
  return tunnel(proxy, proxyAddress, address, port, signal);
}

/**
 * A tunnel to the DNS-over-HTTPS resolver itself, given to the proxy by host
 * name. This is the one exception to "targets are always checked IPs": the
 * resolver is a fixed public endpoint, never a user's target, and resolving
 * it locally is exactly what fails when only the proxy can reach the network.
 */
export function openResolverTunnel(proxy: UpstreamProxy, proxyAddress: string, host: string, port: number, signal?: AbortSignal): Promise<Socket> {
  return tunnel(proxy, proxyAddress, host, port, signal);
}

function tunnel(proxy: UpstreamProxy, proxyAddress: string, address: string, port: number, signal?: AbortSignal): Promise<Socket> {
  const label = proxyLabel(proxy);
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    const raw = netConnect({ host: proxyAddress, port: proxy.port, family: isIP(proxyAddress) || undefined });
    let socket: Socket = raw;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      raw.off('error', onSocketError);
      socket.off('error', onSocketError);
      if (error) {
        socket.destroy();
        raw.destroy();
        reject(error);
      } else resolve(socket);
    };
    const onSocketError = (error: NodeJS.ErrnoException) => finish(new ProxyConnectError(socketErrorMessage(error, label)));
    const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    const timer = setTimeout(() => finish(new ProxyConnectError(msg('proxy.timeout', { proxy: label }))), TUNNEL_TIMEOUT_MS);
    timer.unref?.();
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    raw.on('error', onSocketError);
    const handshake = () => {
      const authority = `${formatHost(address)}:${port}`;
      const step = proxy.type === 'socks5' ? socksConnect(socket, proxy, address, port, label) : httpConnect(socket, proxy, authority, label);
      step.then(() => finish(), error => finish(error instanceof ProxyConnectError ? error : new ProxyConnectError(msg('proxy.handshake', { proxy: label }))));
    };
    raw.once('connect', () => {
      if (proxy.type !== 'https') return handshake();
      const secure = tlsConnect({ socket: raw, servername: isIP(proxy.host) ? undefined : proxy.host, ALPNProtocols: ['http/1.1'] });
      socket = secure;
      secure.on('error', onSocketError);
      secure.once('secureConnect', handshake);
    });
  });
}
