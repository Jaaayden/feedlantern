/**
 * Synthetic SQL benchmark; never opens an application database or the network.
 * Run: pnpm exec tsx scripts/translation-stats-performance.ts
 * Measures translation statistics only, not HTTP or complete list rendering.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { RssTranslations } from '../src/server/rss-translation.js';
import type { Feed } from '../src/shared/types.js';

type Stats = NonNullable<Feed['translation']>;
const db = new DatabaseSync(':memory:');
try {
  db.exec('CREATE TABLE feeds(id TEXT PRIMARY KEY); CREATE TABLE feed_items(id TEXT PRIMARY KEY);');
  const translations = new RssTranslations(db);
  const ids = Array.from({ length: 200 }, (_, i) => `feed-${i}`);
  const body = JSON.stringify({ html: '<p>Synthetic article content.</p>'.repeat(200) });
  const insertFeed = db.prepare('INSERT INTO feeds(id) VALUES (?)');
  const insertItem = db.prepare('INSERT INTO feed_items(id) VALUES (?)');
  const insertTranslation = db.prepare('INSERT INTO translations(item_id,feed_id,revision,status,body_json) VALUES (?,?,?,?,?)');
  const statuses = ['success', 'success', 'success', 'pending', 'running', 'failed'];
  db.exec('BEGIN');
  for (const id of ids) {
    insertFeed.run(id);
    for (let i = 0; i < 30; i++) {
      const itemId = `${id}-${i}`;
      insertItem.run(itemId);
      insertTranslation.run(itemId, id, 'revision', statuses[i % statuses.length], body);
    }
  }
  db.exec('COMMIT');

  // The former list path prepares and executes this query once per feed.
  const perFeed = () => new Map(ids.map(id => {
    const stats: Stats = { pending: 0, success: 0, failed: 0 };
    for (const row of db.prepare('SELECT status,COUNT(*) AS count FROM translations WHERE feed_id=? GROUP BY status').all(id)) {
      stats[row.status === 'success' ? 'success' : row.status === 'failed' ? 'failed' : 'pending'] += Number(row.count);
    }
    return [id, stats];
  }));
  const expected = new Map(ids.map(id => [id, { pending: 10, success: 15, failed: 5 }]));
  const measure = (read: () => Map<string, Stats>) => {
    assert.deepEqual(read(), expected); // Warm once and verify every count.
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const result = read();
      samples.push(performance.now() - started);
      assert.deepEqual(result, expected);
    }
    samples.sort((a, b) => a - b);
    return { medianMs: Number(samples[2].toFixed(3)), maxMs: Number(samples[4].toFixed(3)) };
  };

  db.exec('DROP INDEX translations_feed_status');
  const before = measure(perFeed);
  db.exec('CREATE INDEX translations_feed_status ON translations(feed_id,status)');
  const indexedPerFeed = measure(perFeed);
  const indexedBatch = measure(() => translations.statsForFeeds(ids));
  console.log(JSON.stringify({
    scope: 'Synthetic in-memory translation statistics, not production HTTP latency',
    node: process.version, sqlite: db.prepare('SELECT sqlite_version() AS version').get()?.version,
    feeds: ids.length, translations: ids.length * 30, bodyBytes: Buffer.byteLength(body), measuredRuns: 5,
    before, indexedPerFeed, indexedBatch,
  }, null, 2));
} finally { db.close(); }
