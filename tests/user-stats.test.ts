import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import type { FeedInput, UserSummary } from '../src/shared/types.js';

const input: FeedInput = { name: 'feed', url: 'https://example.test/list', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 };
const browser = { close: async () => {}, dispose: async () => {} } as unknown as BrowserServiceLike;

test('管理员用户列表附带订阅、出错、暂停、凭据数量和最近活跃时间', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-user-stats-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const alice = store.createUser('alice', 'alice-password');
  store.createUser('bob', 'bob-password');
  const first = store.createFeed(input, alice.id).feed;
  store.createFeed(input, alice.id);
  const paused = store.createFeed(input, alice.id).feed;
  store.markFetchFailure(first.id, '打开页面失败', new Date().toISOString());
  store.toggleFeed(paused.id);
  store.createCredential({ name: 'forum', url: 'https://example.test', format: 'header', value: 'a=1' }, { domains: ['example.test'], count: 1, expiresAt: null }, alice.id);
  const session = store.createSession('admin', 60_000);
  store.createSession('alice', 60_000);
  const app = await createApp({ store, dataDir: dir, startScheduler: false, browserService: browser });
  try {
    const headers = { host: '127.0.0.1:4321', cookie: `feedlantern_session=${session.id}`, 'x-feedlantern': '1' };
    const response = await app.inject({ url: '/api/users', headers });
    assert.equal(response.statusCode, 200);
    const users = response.json() as UserSummary[];
    const byName = Object.fromEntries(users.map(user => [user.username, user]));
    assert.deepEqual({ ...byName.alice.stats, lastSeenAt: typeof byName.alice.stats?.lastSeenAt }, { feeds: 3, failingFeeds: 1, pausedFeeds: 1, credentials: 1, lastSeenAt: 'string' });
    assert.deepEqual(byName.bob.stats, { feeds: 0, failingFeeds: 0, pausedFeeds: 0, credentials: 0, lastSeenAt: null });
    assert.ok(byName.admin.stats?.lastSeenAt);
    assert.ok(!response.body.includes('password'));
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
