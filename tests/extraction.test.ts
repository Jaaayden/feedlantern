import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isoDate } from '../src/server/extraction.js';

test('日期只采用带年份的来源内容，并稳定处理未指定时区的时间', () => {
  assert.equal(isoDate('September 6'), undefined);
  assert.equal(isoDate('3 hours ago'), undefined);
  assert.equal(isoDate('昨天'), undefined);
  assert.equal(isoDate('2026年9月6日'), '2026-09-06T00:00:00.000Z');
  assert.equal(isoDate('2026-09-06T12:30:00'), '2026-09-06T12:30:00.000Z');
  assert.equal(isoDate('2026-09-06T12:30:00+08:00'), '2026-09-06T04:30:00.000Z');
  assert.equal(isoDate('2026-09-06'), '2026-09-06T00:00:00.000Z');
});
