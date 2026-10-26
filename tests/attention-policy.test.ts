import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { feedNeedsAttention } from '../src/shared/rule-health.js';
import type { Feed, FeedInput } from '../src/shared/types.js';

const input: FeedInput = { name: 'Example', url: 'https://example.test/list', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 };
function fail(store: Store, feed: Feed) {
  const run = store.history.start(feed.id, 'manual');
  store.markFetchFailure(feed.id, 'temporary timeout', feed.nextFetchAt);
  store.history.fail(run, feed, 'manual', 1, 'temporary timeout', false);
  return run;
}

test('需要检查按个人阈值累计连续失败，跨重启保留、成功清零且不依赖推送开关', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-attention-'));
  let store = new Store(dir);
  try {
    store.createAdmin('admin', 'admin-password');
    const alice = store.createUser('alice', 'alice-password');
    const feed = store.createFeed(input, alice.id).feed;
    const other = store.createFeed(input).feed;
    assert.equal(feed.attentionFailureThreshold, 3);
    fail(store, feed); const run = fail(store, feed);
    // Re-reporting one completion does not count as another failure.
    store.history.fail(run, feed, 'manual', 1, 'duplicate', false);
    const interrupted = store.history.start(feed.id, 'scheduled'); store.history.interrupt(interrupted);
    assert.equal(store.getFeed(feed.id)?.consecutiveFailures, 2);
    assert.equal(feedNeedsAttention(store.getFeed(feed.id)!), false);
    assert.equal(store.listUsersWithStats().find(user => user.id === alice.id)?.stats?.attentionFeeds, 0);
    store.close(); store = new Store(dir);
    assert.equal(store.getFeed(feed.id)?.consecutiveFailures, 2);
    fail(store, feed);
    assert.equal(feedNeedsAttention(store.getFeed(feed.id)!), true);
    assert.equal(store.listUsersWithStats().find(user => user.id === alice.id)?.stats?.attentionFeeds, 1);
    store.setBark(alice.id, { attentionFailureThreshold: 5 });
    assert.equal(feedNeedsAttention(store.getFeed(feed.id)!), false);
    assert.equal(store.getFeed(other.id)?.attentionFailureThreshold, 3);
    assert.equal(store.getBark(alice.id).failureThreshold, 10);
    assert.equal(store.getBark(alice.id).enabled, false);
    store.setBark(alice.id, { attentionFailureThreshold: 1 });
    assert.equal(feedNeedsAttention(store.getFeed(feed.id)!), true);
    assert.deepEqual(store.listFeeds(alice.id)[0], store.getFeed(feed.id));
    // Channel changes cancel deliveries, but do not make the feed healthy.
    store.setBark(alice.id, { enabled: true, url: 'https://example.test/notification', failureThreshold: 1 });
    assert.equal(store.getFeed(feed.id)?.consecutiveFailures, 3);
    assert.equal(store.history.nextAlert(), null, 'saving does not send catch-up alerts');
    fail(store, feed); const alert = store.history.nextAlert()!;
    assert.ok(alert);
    store.setBark(alice.id, { enabled: false });
    assert.equal(store.history.isPending(alert.id), false);
    assert.equal(store.getFeed(feed.id)?.consecutiveFailures, 4);
    assert.equal(feedNeedsAttention(store.getFeed(feed.id)!), true);
    store.history.resetNotifications();
    assert.equal(store.getFeed(feed.id)?.consecutiveFailures, 4);
    const success = store.history.start(feed.id, 'manual');
    store.history.succeed(success, feed.id, 1, { itemCount: 0, newItemCount: 0 });
    store.markFetchSuccess(feed.id, feed.nextFetchAt);
    assert.equal(store.getFeed(feed.id)?.consecutiveFailures, 0);
    assert.equal(feedNeedsAttention(store.getFeed(feed.id)!), false);
    fail(store, feed);
    assert.equal(store.getFeed(feed.id)?.consecutiveFailures, 1);
    assert.equal(feedNeedsAttention(store.getFeed(feed.id)!), true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('个人检查阈值接口校验、隔离、备份和恢复旧配置的默认值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-attention-api-')), store = new Store(dir);
  store.createAdmin('admin', 'admin-password');
  const alice = store.createUser('alice', 'alice-password');
  const session = store.createSession('alice', 60_000);
  const app = await createApp({ store, dataDir: dir, startScheduler: false, browserService: { dispose: async () => {} } as unknown as BrowserServiceLike });
  const headers = { host: '127.0.0.1:4321', cookie: `feedlantern_session=${session.id}`, 'x-feedlantern': '1', 'x-csrf-token': session.csrfToken };
  try {
    for (const attentionFailureThreshold of [0, -1, 1.5, 1001, '3']) {
      assert.equal((await app.inject({ method: 'PUT', url: '/api/notifications', headers, payload: { attentionFailureThreshold } })).statusCode, 400);
    }
    const changed = await app.inject({ method: 'PUT', url: '/api/notifications', headers, payload: { attentionFailureThreshold: 5 } });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().attentionFailureThreshold, 5);
    assert.equal(changed.json().failureThreshold, 10);
    assert.equal(store.getBark('admin').attentionFailureThreshold, 3);
    const tables = store.exportTables();
    store.setBark(alice.id, { attentionFailureThreshold: 9 });
    store.restoreTables(tables);
    assert.equal(store.getBark(alice.id).attentionFailureThreshold, 5);
    for (const row of tables.user_notifications ?? []) {
      const value = JSON.parse(row.value); delete value.attentionFailureThreshold; row.value = JSON.stringify(value);
    }
    store.restoreTables(tables);
    assert.equal(store.getBark(alice.id).attentionFailureThreshold, 3);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
