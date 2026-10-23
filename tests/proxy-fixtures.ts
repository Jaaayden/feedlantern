// Local upstream proxies for tests. They only ever connect to 127.0.0.1 targets.
import { createServer as createHttpServer, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import { createServer as createNetServer, connect as netConnect, type AddressInfo, type Socket } from 'node:net';

export interface ProxyLogEntry { target: string; auth?: string; user?: string }
export interface TestProxy { port: number; url: string; log: ProxyLogEntry[]; connections: number; close(): Promise<void> }

function track(server: { on(event: 'connection', listener: (socket: Socket) => void): unknown }) {
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  return sockets;
}

/** An HTTP CONNECT proxy; with a login it answers 407 to anything else. */
export async function startHttpProxy(login?: { username: string; password: string }): Promise<TestProxy> {
  const expected = login ? `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}` : undefined;
  const proxy: TestProxy = { port: 0, url: '', log: [], connections: 0, close: async () => undefined };
  const server = createHttpServer((_request, response) => { response.writeHead(405); response.end(); });
  const sockets = track(server);
  server.on('connection', () => { proxy.connections++; });
  server.on('connect', (request, client: Socket, head) => {
    const auth = request.headers['proxy-authorization'];
    proxy.log.push({ target: request.url ?? '', ...(auth ? { auth } : {}) });
    if (expected && auth !== expected) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const [host, port] = (request.url ?? '').split(/:(?=\d+$)/);
    if (host !== '127.0.0.1') { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = netConnect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  proxy.port = (server.address() as AddressInfo).port;
  proxy.url = `http://127.0.0.1:${proxy.port}`;
  proxy.close = async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return proxy;
}

/** A SOCKS5 proxy (RFC 1928 CONNECT, RFC 1929 login). */
export async function startSocksProxy(login?: { username: string; password: string }): Promise<TestProxy> {
  const proxy: TestProxy = { port: 0, url: '', log: [], connections: 0, close: async () => undefined };
  const server = createNetServer(client => {
    proxy.connections++;
    let stage: 'greeting' | 'auth' | 'request' | 'open' = 'greeting';
    let buffer = Buffer.alloc(0);
    let user: string | undefined;
    client.on('error', () => client.destroy());
    client.on('data', function onData(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting' && buffer.length >= 2 && buffer.length >= 2 + buffer[1]) {
        const methods = [...buffer.subarray(2, 2 + buffer[1])];
        buffer = buffer.subarray(2 + buffer[1]);
        if (login && !methods.includes(2)) { client.end(Buffer.from([5, 0xff])); return; }
        client.write(Buffer.from([5, login ? 2 : 0]));
        stage = login ? 'auth' : 'request';
      }
      if (stage === 'auth' && buffer.length >= 2) {
        const ulen = buffer[1];
        if (buffer.length < 3 + ulen) return;
        const plen = buffer[2 + ulen];
        if (buffer.length < 3 + ulen + plen) return;
        user = buffer.subarray(2, 2 + ulen).toString();
        const pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString();
        buffer = buffer.subarray(3 + ulen + plen);
        if (user !== login!.username || pass !== login!.password) { proxy.log.push({ target: '', user }); client.end(Buffer.from([1, 1])); return; }
        client.write(Buffer.from([1, 0]));
        stage = 'request';
      }
      if (stage === 'request' && buffer.length >= 10 && buffer[3] === 1) {
        const address = [...buffer.subarray(4, 8)].join('.');
        const port = buffer.readUInt16BE(8);
        const rest = buffer.subarray(10);
        stage = 'open';
        client.off('data', onData);
        proxy.log.push({ target: `${address}:${port}`, ...(user ? { user } : {}) });
        const upstream = netConnect(port, address, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length) upstream.write(rest);
          client.pipe(upstream); upstream.pipe(client);
        });
        upstream.on('error', () => { client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); });
        client.on('close', () => upstream.destroy());
      } else if (stage === 'request' && buffer.length >= 4 && buffer[3] !== 1) {
        client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
      }
    });
  });
  const sockets = track(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  proxy.port = (server.address() as AddressInfo).port;
  proxy.url = `socks5://127.0.0.1:${proxy.port}`;
  proxy.close = async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return proxy;
}

export interface RecordedRequest { path: string; host: string; headers: IncomingHttpHeaders }

/** A target server that records every request's headers. */
export async function startTarget(handler: RequestListener): Promise<{ server: Server; port: number; host: string; requests: RecordedRequest[]; close(): Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const server = createHttpServer((request, response) => {
    requests.push({ path: request.url ?? '', host: request.headers.host ?? '', headers: request.headers });
    handler(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server, port, host: `127.0.0.1:${port}`, requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** A closed loopback port, for "proxy unreachable". */
export async function closedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
