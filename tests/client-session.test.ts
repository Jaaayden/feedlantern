import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, ApiError, onUnauthorized, setCsrfToken } from '../src/web/api.js';

test('切换账号后丢弃旧请求的数据及 401，保留新账号的登录状态', async () => {
  const originalFetch = globalThis.fetch;
  const pending: Array<(response: Response) => void> = [];
  globalThis.fetch = async () => new Promise<Response>(resolve => pending.push(resolve));
  let unauthorized = 0;
  const cleanup = onUnauthorized(() => { unauthorized++; });
  try {
    setCsrfToken('alice');
    const oldData = api.feeds.list(), oldUnauthorized = api.credentials.list();
    setCsrfToken('bob');
    const current = api.feeds.list();
    pending[0](Response.json([{ id: 'alice-private' }]));
    pending[1](Response.json({ error: 'expired' }, { status: 401 }));
    pending[2](Response.json([{ id: 'bob-private' }]));
    await assert.rejects(oldData, (error: unknown) => error instanceof ApiError && error.status === 0);
    await assert.rejects(oldUnauthorized, (error: unknown) => error instanceof ApiError && error.status === 0);
    assert.equal((await current)[0].id, 'bob-private'); assert.equal(unauthorized, 0);
  } finally { cleanup(); setCsrfToken(undefined); globalThis.fetch = originalFetch; }
});

test('切换工作台丢弃旧结果，作用域仅传给资源接口', async () => {
  const { setWorkspaceUser } = await import('../src/web/api.js');
  const originalFetch = globalThis.fetch;
  const pending: Array<(response: Response) => void> = [], scopes: Array<string | null> = [];
  globalThis.fetch = async (_url, options) => { scopes.push(new Headers(options?.headers).get('X-FeedLantern-User')); return new Promise<Response>(resolve => pending.push(resolve)); };
  try {
    setWorkspaceUser('alice'); const old = api.feeds.list();
    setWorkspaceUser('bob'); const next = api.feeds.list(), account = api.auth.status();
    pending[0](Response.json([{ id: 'private-alice' }])); pending[1](Response.json([{ id: 'private-bob' }])); pending[2](Response.json({ userId: 'admin' }));
    await assert.rejects(old, (error: unknown) => error instanceof ApiError && error.status === 0);
    assert.equal((await next)[0].id, 'private-bob'); assert.equal((await account).userId, 'admin');
    assert.deepEqual(scopes, ['alice', 'bob', null]);
  } finally { setWorkspaceUser(undefined); globalThis.fetch = originalFetch; }
});
