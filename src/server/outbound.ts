import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { NetworkPolicy } from './network.js';

const RESPONSE_LIMIT = 64 * 1024;

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([promise, new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })]);
}

/**
 * POST a JSON body through the same network policy as page capture: the host
 * is resolved and checked once, the connection is pinned to that address and
 * redirects are never followed, so a channel cannot reach private, loopback or
 * cloud-metadata addresses unless the host is explicitly allowlisted.
 */
export async function postJson(raw: string, body: string, options: { signal: AbortSignal; policy: NetworkPolicy; headers?: Record<string, string> }): Promise<{ status: number; text: string }> {
  const { signal, policy } = options;
  const { url, address } = await abortable(policy.resolveForConnection(raw), signal);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST', signal, agent: false, family: isIP(address),
      lookup: (_host, _opts, callback) => callback(null, address, isIP(address)),
      headers: { ...options.headers, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'accept-encoding': 'identity', 'user-agent': 'FeedLantern notifications' },
    }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('error', reject);
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT) { response.destroy(Error('Push service response too large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}
