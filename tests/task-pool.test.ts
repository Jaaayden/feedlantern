import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskPool, siteKey } from '../src/server/task-pool';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; return { wait: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }

test('并发上限、同站点互斥、FIFO 屏障和失败后释放容量', async () => {
  const pool = new TaskPool(2), first = gate(), second = gate();
  const events: string[] = [];
  const a = pool.enqueue(async () => { events.push('a'); await first.wait; }, ['a']);
  const a2 = pool.enqueue(() => { events.push('a2'); }, ['a']);
  const b = pool.enqueue(async () => { events.push('b'); await second.wait; }, ['b']);
  const barrier = pool.enqueue(() => { events.push('barrier'); });
  const c = pool.enqueue(() => { events.push('c'); throw Error('expected'); }, ['c']);
  const failure = assert.rejects(c, /expected/);
  await tick(); assert.deepEqual(events, ['a', 'b']);
  first.release(); await a; await tick(); assert.deepEqual(events, ['a', 'b', 'a2']);
  second.release(); await Promise.all([a2, b, barrier, failure, pool.drain()]);
  assert.deepEqual(events, ['a', 'b', 'a2', 'barrier', 'c']);
  assert.equal(await pool.enqueue(() => 42, ['c']), 42);
  assert.equal(siteKey('http://EXAMPLE.com:123/a'), siteKey('https://example.com/b'));
});

test('不同 feed 的多键任务不能绕过同键等待者；drain 等待全部任务', async () => {
  const pool = new TaskPool(4), block = gate(); const order: string[] = [];
  const jobs = [pool.enqueue(() => block.wait, ['site:a']),
    pool.enqueue(() => { order.push('old'); }, ['site:a', 'feed:1']),
    pool.enqueue(() => { order.push('new'); }, ['site:b', 'feed:1']),
    pool.enqueue(() => { order.push('independent'); }, ['site:c', 'feed:2'])];
  let drained = false; const drain = pool.drain().then(() => { drained = true; });
  await tick(); assert.deepEqual(order, ['independent']); assert.equal(drained, false);
  block.release(); await Promise.all([...jobs, drain]);
  assert.deepEqual(order, ['independent', 'old', 'new']); assert.equal(drained, true);
  for (const n of [0, 5, 1.5, NaN]) assert.throws(() => new TaskPool(n));
});

test('待执行任务重新计算修改后的来源锁', async () => {
  const pool=new TaskPool(2), block=gate(); let target='old'; const order:string[]=[];
  const mutation=pool.enqueue(async()=>{await block.wait;target='new';});
  const first=pool.enqueue(async()=>{order.push('first');await tick();order.push('first-end');},['new']);
  const refreshed=pool.enqueue(()=>{order.push('second');},()=>[target]);
  block.release(); await Promise.all([mutation,first,refreshed]);
  assert.deepEqual(order,['first','first-end','second']);
});
