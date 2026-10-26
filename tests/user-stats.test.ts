import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
    assert.deepEqual({ ...byName.alice.stats, lastSeenAt: typeof byName.alice.stats?.lastSeenAt }, { feeds: 3, failingFeeds: 1, attentionFeeds: 0, pausedFeeds: 1, credentials: 1, lastSeenAt: 'string' });
    assert.deepEqual(byName.bob.stats, { feeds: 0, failingFeeds: 0, attentionFeeds: 0, pausedFeeds: 0, credentials: 0, lastSeenAt: null });
    assert.ok(byName.admin.stats?.lastSeenAt);
    assert.ok(!response.body.includes('password'));
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('用户待检查数量与列表一致：包含核心规则警告，排除可选字段提示，同一订阅不重复统计', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-attention-stats-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const alice = store.createUser('alice', 'alice-password');
  const db = new DatabaseSync(store.dbPath);
  try {
    const core = store.createFeed(input, alice.id).feed;
    const optional = store.createFeed(input, alice.id).feed;
    const both = store.createFeed(input, alice.id).feed;
    const warning = (field: string) => JSON.stringify({ reasons: [{ code: 'field-rate', field, baseline: 1, current: 0, message: 'test' }] });
    const insert = db.prepare('INSERT INTO feed_health(feed_id,signature,warning_json) VALUES (?, ?, ?)');
    insert.run(core.id, 'test', warning('title'));
    insert.run(optional.id, 'test', warning('date'));
    insert.run(both.id, 'test', warning('link'));
    store.markFetchFailure(both.id, 'failed', new Date().toISOString());
    const users = store.listUsersWithStats();
    assert.equal(users.find(user => user.id === alice.id)?.stats?.attentionFeeds, 2);
    assert.equal(users.find(user => user.id === alice.id)?.stats?.failingFeeds, 1);
    assert.equal(users.find(user => user.id === 'admin')?.stats?.attentionFeeds, 0);
  } finally { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
