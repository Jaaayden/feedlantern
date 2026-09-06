import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/server/store.js';

test('凭据值加密保存，summary 不返回敏感内容，FeedItem 按 URL 去重', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-store-'));
  const store = new Store(dataDir);
  try {
    const credential = store.createCredential({ name: 'test', url: 'https://example.test', format: 'header', value: 'secret-cookie=1' }, { domains: ['example.test'], count: 1, expiresAt: null });
    assert.deepEqual(store.listCredentialSummaries(), [credential]);
    assert.ok(!JSON.stringify(store.listCredentialSummaries()).includes('secret-cookie'));
    const encrypted = readFileSync(join(dataDir, 'app.db'));
    assert.ok(!encrypted.includes(Buffer.from('secret-cookie')));
    const created = store.createFeed({ name: 'feed', url: 'https://example.test/list', rules: { item: '.item', title: '.title', link: 'a' }, credentialId: credential.id, intervalMinutes: 60, waitMs: 1000 });
    store.updateFeed(created.feed.id, { ...created.feed, ruleOrigins: { title: 'manual' } });
    const explicitlyReplaced = store.updateFeed(created.feed.id, { ...created.feed, ruleOrigins: { title: 'auto' } });
    assert.equal(explicitlyReplaced?.ruleOrigins?.title, 'auto');
    const omittedOrigins = store.updateFeed(created.feed.id, { ...created.feed, ruleOrigins: undefined });
    assert.equal(omittedOrigins?.ruleOrigins?.title, 'auto');
    const first = store.upsertItems(created.feed, [{ title: 'one', link: 'https://example.test/item#section' }]);
    const second = store.upsertItems(created.feed, [{ title: 'one updated', link: 'https://example.test/item' }, { title: 'two', link: 'https://example.test/two' }]);
    assert.equal(first.length, 1);
    assert.equal(second.length, 2);
    assert.equal(store.getItems(created.feed.id).find((item) => item.link.endsWith('/item'))?.title, 'one updated');
    assert.ok(existsSync(join(dataDir, 'master.key')));
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
