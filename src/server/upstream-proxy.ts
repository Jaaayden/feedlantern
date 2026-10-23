import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import ipaddr from 'ipaddr.js';

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
export class ProxyConnectError extends Error {
  /** The proxy works, but could not reach this target address; another address may. */
  readonly targetFailed: boolean;
  constructor(message: string, targetFailed = false) {
    super(message);
    this.name = 'ProxyConnectError';
    this.targetFailed = targetFailed;
  }
}

const typeLabels: Record<ProxyType, string> = { http: 'HTTP 代理', https: 'HTTPS 代理', socks5: 'SOCKS5 代理' };
const TUNNEL_TIMEOUT_MS = 15_000;
const MAX_CONNECT_RESPONSE = 16 * 1024;

export function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * host:port and the proxy kind, without a scheme. The scheme is left out on
 * purpose: user-facing errors replace http(s) URLs with a placeholder.
 */
export function proxyLabel(proxy: Pick<UpstreamProxy, 'type' | 'host' | 'port'>): string {
  return `${formatHost(proxy.host)}:${proxy.port}（${typeLabels[proxy.type]}）`;
}

function socketErrorMessage(error: NodeJS.ErrnoException, label: string): string {
  switch (error.code) {
    case 'ECONNREFUSED': return `无法连接代理服务器 ${label}：连接被拒绝，请检查代理地址和端口`;
    case 'ETIMEDOUT': return `连接代理服务器 ${label} 超时`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH': return `无法连接代理服务器 ${label}：网络不可达`;
    case 'ECONNRESET':
    case 'EPIPE': return `代理服务器 ${label} 中断了连接`;
    default:
      if (/certificate|self.signed|CERT_|SSL|TLS/i.test(`${error.code ?? ''} ${error.message}`)) return `与代理服务器 ${label} 的 TLS 握手失败，请检查证书或代理类型`;
      return `无法连接代理服务器 ${label}${error.code ? `（${error.code}）` : ''}`;
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

const socksReplies: Record<number, string> = {
  1: '代理服务器内部错误',
  2: '代理规则不允许访问该目标',
  3: '代理到目标的网络不可达',
  4: '代理无法访问目标主机',
  5: '目标拒绝了代理的连接',
  6: '代理连接目标超时',
  7: '代理不支持 CONNECT 命令',
  8: '代理不支持该地址类型',
};

async function httpConnect(socket: Socket, proxy: UpstreamProxy, authority: string, label: string): Promise<void> {
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
    throw new ProxyConnectError(`代理服务器 ${label} 没有返回有效的 CONNECT 响应，请检查代理类型`);
  }
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'))?.[1];
  if (!status) throw new ProxyConnectError(`代理服务器 ${label} 没有返回有效的 CONNECT 响应，请检查代理类型`);
  if (status === '407') {
    throw new ProxyConnectError(proxy.username === undefined
      ? `代理服务器 ${label} 要求认证（HTTP 407），请在网络配置中填写代理用户名和密码`
      : `代理认证失败（HTTP 407），请检查网络配置中的代理用户名和密码`);
  }
  if (!status.startsWith('2')) throw new ProxyConnectError(`代理服务器 ${label} 拒绝连接目标（HTTP ${status}）`, true);
}

async function socksConnect(socket: Socket, proxy: UpstreamProxy, address: string, port: number, label: string): Promise<void> {
  const auth = proxy.username !== undefined;
  const invalid = () => new ProxyConnectError(`代理服务器 ${label} 没有返回有效的 SOCKS5 响应，请检查代理类型`);
  socket.write(Buffer.from(auth ? [5, 2, 0x00, 0x02] : [5, 1, 0x00]));
  const choice = await readHandshake(socket, data => data.length >= 2 ? 2 : undefined).catch(() => { throw invalid(); });
  if (choice[0] !== 5) throw invalid();
  if (choice[1] === 0xff || (choice[1] === 0x02 && !auth) || ![0x00, 0x02].includes(choice[1])) {
    throw new ProxyConnectError(auth
      ? `SOCKS5 代理 ${label} 不接受用户名密码认证`
      : `SOCKS5 代理 ${label} 要求认证，请在网络配置中填写代理用户名和密码`);
  }
  if (choice[1] === 0x02) {
    const username = Buffer.from(proxy.username ?? '', 'utf8');
    const password = Buffer.from(proxy.password ?? '', 'utf8');
    socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]));
    const result = await readHandshake(socket, data => data.length >= 2 ? 2 : undefined).catch(() => { throw invalid(); });
    if (result[1] !== 0) throw new ProxyConnectError('SOCKS5 代理认证失败，请检查网络配置中的代理用户名和密码');
  }
  const family = isIP(address);
  const host = Buffer.from(ipaddr.parse(address).toByteArray());
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, family === 4 ? 1 : 4]), host, Buffer.from([port >> 8, port & 0xff])]));
  const reply = await readHandshake(socket, data => {
    if (data.length < 5) return undefined;
    const length = data[3] === 1 ? 10 : data[3] === 4 ? 22 : data[3] === 3 ? 7 + data[4] : -1;
    if (length < 0) return data.length;
    return data.length >= length ? length : undefined;
  }).catch(() => { throw invalid(); });
  if (reply[0] !== 5) throw invalid();
  // 1 (general failure) and 2 (ruleset) are about the proxy; the rest are about this address.
  if (reply[1] !== 0) throw new ProxyConnectError(`SOCKS5 代理 ${label} 无法连接目标：${socksReplies[reply[1]] ?? `错误码 ${reply[1]}`}`, reply[1] >= 3);
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
  throw last ?? new ProxyConnectError(`代理服务器 ${proxyLabel(proxy)} 无法连接目标`, true);
}

/**
 * Opens a TCP tunnel to `address:port` through the upstream proxy. The proxy
 * itself is reached at `proxyAddress`, which the caller has already checked
 * against the network policy. The target is always given to the proxy as the
 * checked IP address, never as a host name, so the proxy cannot resolve it to
 * a different (for example internal) address.
 */
export function openTunnel(proxy: UpstreamProxy, proxyAddress: string, address: string, port: number, signal?: AbortSignal): Promise<Socket> {
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
    const timer = setTimeout(() => finish(new ProxyConnectError(`连接代理服务器 ${label} 超时`)), TUNNEL_TIMEOUT_MS);
    timer.unref?.();
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    raw.on('error', onSocketError);
    const handshake = () => {
      const authority = `${formatHost(address)}:${port}`;
      const step = proxy.type === 'socks5' ? socksConnect(socket, proxy, address, port, label) : httpConnect(socket, proxy, authority, label);
      step.then(() => finish(), error => finish(error instanceof ProxyConnectError ? error : new ProxyConnectError(`代理服务器 ${label} 握手失败`)));
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
