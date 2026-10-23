import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp, registeredRoutes, Store, type BrowserServiceLike } from '../src/server/app.js';
import { SESSION_ONLY_ROUTES } from '../src/server/api-tokens.js';
import { documentedRoutes } from '../src/server/openapi.js';

const browser = { open: async () => { throw Error('unused'); }, snapshot: async () => { throw Error('unused'); }, scroll: async () => { throw Error('unused'); }, click: async () => { throw Error('unused'); }, pick: async () => { throw Error('unused'); }, extract: async () => [], scrape: async () => [], close: async () => {}, dispose: async () => {} } as unknown as BrowserServiceLike;

type Doc = { openapi: string; servers: Array<{ url: string }>; paths: Record<string, Record<string, Record<string, unknown>>>; components: { schemas: Record<string, unknown> } };

test('OpenAPI 文档与服务器路由表一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-openapi-')), store = new Store(dir);
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false });
  try {
    await app.ready();
    const routes = new Set(registeredRoutes(app).filter(r => r.url.startsWith('/api/') && r.method !== 'HEAD').map(r => `${r.method} ${r.url}`));
    const documented = new Set(documentedRoutes());
    const undocumented = [...routes].filter(r => !documented.has(r));
    const stale = [...documented].filter(r => !routes.has(r));
    assert.deepEqual(undocumented, [], `这些路由没有写进 src/server/openapi.ts：\n${undocumented.join('\n')}`);
    assert.deepEqual(stale, [], `OpenAPI 文档中的这些接口在服务器上不存在：\n${stale.join('\n')}`);
    assert.equal(documented.size, documentedRoutes().length, 'OpenAPI 文档存在重复接口');
    for (const route of SESSION_ONLY_ROUTES) assert.ok(routes.has(route), `仅限网页会话的接口 ${route} 不存在`);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('GET /api/openapi.json 公开提供合法的 OpenAPI 3.1 文档', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-openapi-')), store = new Store(dir);
  const app = await createApp({ store, dataDir: dir, browserService: browser, startScheduler: false, publicOrigin: 'https://feeds.example.test' });
  try {
    const response = await app.inject({ url: '/api/openapi.json', headers: { host: 'feeds.example.test' } });
    assert.equal(response.statusCode, 200);
    const doc = response.json() as Doc;
    assert.equal(doc.openapi, '3.1.0');
    assert.equal(doc.servers[0].url, 'https://feeds.example.test');
    const operationIds = new Set<string>();
    const refs = JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([A-Za-z]+)"/g);
    for (const [, name] of refs) assert.ok(doc.components.schemas[name], `缺少 schema ${name}`);
    const sessionOnly = new Set(SESSION_ONLY_ROUTES.map(r => r.replace(/:([A-Za-z]+)/g, '{$1}')));
    for (const [path, methods] of Object.entries(doc.paths)) {
      const names = [...path.matchAll(/\{([A-Za-z]+)\}/g)].map(([, name]) => name);
      for (const [method, op] of Object.entries(methods)) {
        assert.ok(!operationIds.has(String(op.operationId)), `operationId 重复：${op.operationId}`);
        operationIds.add(String(op.operationId));
        const params = (op.parameters as Array<{ in?: string; name?: string }> | undefined) ?? [];
        assert.deepEqual(params.filter(p => p.in === 'path').map(p => p.name), names, `${method} ${path} 的路径参数`);
        const access = op['x-feedlantern-access'], token = op['x-feedlantern-token'];
        if (sessionOnly.has(`${method.toUpperCase()} ${path}`)) {
          assert.equal(token, 'forbidden', `${method} ${path}`);
          assert.ok(access === 'session' || access === 'public', `${method} ${path}`);
        } else {
          assert.equal(token, method === 'get' ? 'read' : 'write', `${method} ${path}`);
          if (access !== 'public') assert.equal(access, token, `${method} ${path}`);
        }
      }
    }
    assert.equal(doc.paths['/api/feeds'].get['x-feedlantern-access'], 'read');
    assert.equal(doc.paths['/api/tokens'].post['x-feedlantern-access'], 'session');
    assert.deepEqual(doc.paths['/api/openapi.json'].get.security, []);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
