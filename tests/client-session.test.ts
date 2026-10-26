import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, ApiError, onUnauthorized, setCsrfToken, setWorkspaceUser } from '../src/web/api.js';
import { defaultApplicationSettings } from '../src/shared/types.js';

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

test('设置请求合并并短期复用，保存后立即更新，过期或切换账号/工作台重新读取', async t => {
  let now = Date.now(), calls = 0;
  t.mock.method(Date, 'now', () => now);
  const originalFetch = globalThis.fetch;
  let value = structuredClone(defaultApplicationSettings);
  globalThis.fetch = async (_url, options) => {
    calls++;
    if (options?.method === 'PUT') value = { ...value, ...JSON.parse(String(options.body)) };
    return Response.json(value);
  };
  try {
    setCsrfToken('settings-alice');
    await Promise.all([api.settings.get(), api.settings.get(), api.settings.get()]);
    assert.equal(calls, 1);
    assert.equal(api.settings.cached()?.logRetentionDays, value.logRetentionDays);
    await api.settings.get(); assert.equal(calls, 1);
    await api.settings.save({ logRetentionDays: 60 });
    assert.equal((await api.settings.get()).logRetentionDays, 60); assert.equal(calls, 2);
    now += 30_001;
    assert.equal(api.settings.cached(), null);
    await api.settings.get(); assert.equal(calls, 3);
    setWorkspaceUser('other'); assert.equal(api.settings.cached(), null);
    await api.settings.get(); assert.equal(calls, 4);
    setCsrfToken('settings-bob'); assert.equal(api.settings.cached(), null);
    await api.settings.get(); assert.equal(calls, 5);
    await api.backups.importConfig({}, true);
    assert.equal(api.settings.cached(), null);
  } finally { setWorkspaceUser(undefined); setCsrfToken(undefined); globalThis.fetch = originalFetch; }
});

test('保存前的延迟设置响应不能覆盖新缓存，失败请求允许重试', async () => {
  const originalFetch = globalThis.fetch;
  let resolveOld!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    if (options?.method === 'PUT') return Response.json({ ...defaultApplicationSettings, logRetentionDays: 60 });
    if (calls === 1) return new Promise<Response>(resolve => { resolveOld = resolve; });
    return calls === 3 ? Response.json({ error: 'temporary' }, { status: 503 }) : Response.json(defaultApplicationSettings);
  };
  try {
    setCsrfToken('settings-delay');
    const old = api.settings.get();
    await api.settings.save({ logRetentionDays: 60 });
    resolveOld(Response.json(defaultApplicationSettings)); await old;
    assert.equal(api.settings.cached()?.logRetentionDays, 60);
    setCsrfToken('settings-retry');
    await assert.rejects(api.settings.get());
    assert.equal(api.settings.cached(), null);
    await api.settings.get(); assert.equal(calls, 4);
  } finally { setCsrfToken(undefined); globalThis.fetch = originalFetch; }
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
