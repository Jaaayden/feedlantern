import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateContext, parseDateFields, resolveDate } from '../src/server/dates.js';
const reference = Date.parse('2026-09-09T12:00:00Z');

test('固定基准解析混合文本、中文简写及英文相对时间', () => {
  for (const text of ['猎奇 NodeSeek · 3 分钟前', '3分前', '3 minutes ago', '3 mins ago']) {
    assert.equal(parseDateFields({ text }, reference)?.publishedAt, '2026-09-09T11:57:00.000Z');
    assert.equal(parseDateFields({ text }, reference)?.publishedAtSource, 'relative');
  }
  for (const [text, seconds] of [['刚刚', 0], ['just now', 0], ['2秒前', 2], ['2 hours ago', 7200], ['2天前', 172800], ['2周前', 1209600]] as const) {
    assert.equal(parseDateFields({ text }, reference)?.publishedAt, new Date(reference - seconds * 1000).toISOString());
  }
});

test('有效 datetime、直属文本优先，拒绝歧义与含糊时间', () => {
  assert.equal(parseDateFields({ datetime: '2026-09-01T12:00:00+08:00', direct: '3分前' }, reference)?.publishedAt, '2026-09-01T04:00:00.000Z');
  assert.equal(parseDateFields({ datetime: 'invalid', direct: '3分前', text: '广告 2天前 3分前' }, reference)?.dateText, '3分前');
  assert.equal(parseDateFields({ direct: '来源', text: 'NodeSeek · 3分前' }, reference)?.dateText, '3分前');
  for (const text of ['昨天', '2个月前', '3年前', '3 months ago', '3分前 更新于2分前', '2026-09-01 2026-09-02', '2026-09-01 3分前', '没有时间', '2026-99-99', '2026-02-30', 'NodeSeek 2026-99-99', '999999999999999999周前']) {
    assert.equal(parseDateFields({ text }, reference), undefined, text);
  }
});

test('本站 BOOT 安全解析、链接匹配与缓存基准；不影响其他站点', () => {
  const url = 'https://n.mumingfang.com/intel';
  const script = `var BOOT = ${JSON.stringify({ now: reference / 1000 - 600, first: { items: [{ t: 'title } " {', u: 'https://www.nodeseek.com/post-1', a: reference / 1000 - 900 }] } })}; throw new Error('never execute');`;
  const context = dateContext(url, reference, [script]);
  assert.equal(resolveDate({ text: '3分前' }, 'https://www.nodeseek.com/post-1#x', url, context)?.publishedAt, '2026-09-09T11:45:00.000Z');
  assert.equal(resolveDate({ text: '3分前' }, 'https://www.nodeseek.com/post-2', url, context)?.publishedAt, '2026-09-09T11:47:00.000Z');
  for (const other of ['https://example.test/intel', 'https://n.mumingfang.com/other', 'https://n.mumingfang.com.evil.test/intel']) {
    assert.equal(dateContext(other, reference, [script]).timestamps.size, 0);
    assert.equal(dateContext(other, reference, [script]).referenceTime, reference);
  }
  assert.equal(dateContext(url, reference, ['var BOOT = { now: alert(1) };']).referenceTime, reference);
  assert.equal(dateContext(url, reference, ['var BOOT = {"first":{"items":[null,{"u":"javascript:alert(1)","a":1},{"u":"https://a.test","a":"123"}]}};']).timestamps.size, 0);
});
