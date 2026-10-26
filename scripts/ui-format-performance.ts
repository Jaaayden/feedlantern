/** Synthetic list formatting benchmark, not an HTTP or page-load benchmark.
 * Run: pnpm exec tsx scripts/ui-format-performance.ts
 * Uses generated timestamps only; never opens a database or the network.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { formatDateTime, formatRelative } from '../src/shared/i18n.js';

const now = Date.now();
const dates = Array.from({ length: 1000 }, (_, i) => new Date(now - 120_000 - i * 1000).toISOString());
const previous = () => dates.map(value => [
  new Intl.DateTimeFormat('zh-CN', { hourCycle: 'h23', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)),
  new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }).format(-Math.max(1, Math.round((now - Date.parse(value)) / 60_000)), 'minute'),
]);
const cached = () => dates.map(value => [formatDateTime('zh-CN', value), formatRelative('zh-CN', value, now)]);
const expected = previous();
assert.deepEqual(cached(), expected);
const times: Record<string, number[]> = { previous: [], cached: [] };
for (let round = 0; round < 7; round++) {
  const methods = round % 2 ? { cached, previous } : { previous, cached };
  for (const [name, format] of Object.entries(methods)) {
    const started = performance.now();
    const result = format();
    times[name].push(performance.now() - started);
    assert.deepEqual(result, expected);
  }
}
console.log(JSON.stringify({
  node: process.version, platform: `${process.platform}/${process.arch}`, rows: dates.length, samples: 7,
  milliseconds: Object.fromEntries(Object.entries(times).map(([name, samples]) => [name, {
    median: Number([...samples].sort((a, b) => a - b)[3].toFixed(3)),
    max: Number(Math.max(...samples).toFixed(3)),
  }])),
}, null, 2));
