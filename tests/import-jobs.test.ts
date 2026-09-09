import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { ImportJobs } from '../src/server/import-jobs.js';
import type { DetectionResult } from '../src/shared/types.js';
const result: DetectionResult = { recommendedId: 'a', warnings: [], candidates: [{ id: 'a', label: '文章', confidence: 'high', score: 100, count: 3, rects: [], warnings: [], rules: { item: 'article', title: 'h2', link: 'a' }, items: [1, 2, 3].map(i => ({ title: `文章${i}`, link: `https://example.test/${i}` })) }] };
async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('任务超时'); }
test('批量任务自动创建、歧义确认、失败重试和重启恢复不会重复创建', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-jobs-')), store = new Store(dir);
  let fail = true;
  const jobs = new ImportJobs(store, async fn => fn(), async entry => {
    if (entry.url.includes('failed') && fail) throw Error('network');
    return { title: '自动订阅', detection: entry.url.includes('review') ? { ...result, recommendedId: null } : result };
  }, async () => result.candidates[0].items);
  try {
    const job = jobs.create(['normal', 'review', 'failed'].map(s => ({ url: `https://example.test/${s}`, credentialId: null, intervalMinutes: 60 })));
    await until(() => !jobs.get(job.id).entries.some(e => ['queued', 'running'].includes(e.state)));
    assert.deepEqual(jobs.get(job.id).entries.map(e => e.state), ['created', 'review', 'failed']);
    const review = jobs.get(job.id).entries[1];
    const input = { name: '确认', url: review.url, rules: result.candidates[0].rules, credentialId: null, intervalMinutes: 60, waitMs: 0 };
    await jobs.confirm(job.id, review.id, input); await jobs.confirm(job.id, review.id, input);
    assert.equal(store.listFeeds().length, 2);
    fail = false; jobs.update(job.id, 'retry');
    await until(() => jobs.get(job.id).entries.every(e => e.state === 'created'));
    jobs.recover();
    assert.equal(store.listFeeds().length, 3);
    const duplicate = jobs.create([{ url: 'https://example.test/normal#fragment', credentialId: null, intervalMinutes: 60 }]);
    assert.equal(duplicate.entries[0].state, 'existing');
  } finally { jobs.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('实际重启恢复 running 任务，取消和恢复后保持幂等', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-jobs-restart-'));
  let store = new Store(dir);
  const stopped = new ImportJobs(store, async fn => fn(), async () => ({ title: '恢复', detection: result }), async () => result.candidates[0].items);
  stopped.stop();
  const job = stopped.create(['one', 'two'].map(s => ({ url: `https://example.test/${s}`, credentialId: null, intervalMinutes: 60 })));
  job.entries[0].state = 'running'; store.saveImportJob(job);
  stopped.update(job.id, 'cancel', job.entries[1].id);
  store.close(); store = new Store(dir);
  const resumed = new ImportJobs(store, async fn => fn(), async () => ({ title: '恢复', detection: result }), async () => result.candidates[0].items);
  try {
    resumed.recover();
    await until(() => resumed.get(job.id).entries[0].state === 'created');
    assert.equal(resumed.get(job.id).entries[1].state, 'canceled');
    assert.equal(store.listFeeds().length, 1);
    resumed.update(job.id, 'retry', job.entries[1].id);
    await until(() => resumed.get(job.id).entries.every(e => e.state === 'created'));
    assert.equal(store.listFeeds().length, 2);
  } finally { resumed.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('批量识别与刷新共享容量，跨站并行且同站不重入', async () => {
  const { TaskPool, siteKey } = await import('../src/server/task-pool');
  const dir=mkdtempSync(join(tmpdir(),'fl-jobs-pool-')), store=new Store(dir), pool=new TaskPool(2);
  let active=0,peak=0;const hosts=new Set<string>();
  const work=async(url:string)=>{
    const key=siteKey(url); assert.equal(hosts.has(key),false);hosts.add(key);active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,30));active--;hosts.delete(key);
    return {title:'parallel',detection:result};
  };
  const jobs=new ImportJobs(store,(fn,keys)=>pool.enqueue(fn,keys),entry=>work(entry.url),async()=>result.candidates[0].items,undefined,2);
  try {
    const refresh=pool.enqueue(()=>work('https://a.test/refresh'),[siteKey('https://a.test')]);
    const job=jobs.create(['https://a.test/one','https://b.test/two','https://b.test/three'].map(url=>({url,credentialId:null,intervalMinutes:60})));
    await refresh;await until(()=>jobs.get(job.id).entries.every(e=>e.state==='created'));await pool.drain();
    assert.equal(peak,2); assert.equal(store.listFeeds().length,3);
  } finally {jobs.stop();await pool.drain();store.close();rmSync(dir,{recursive:true,force:true});}
});
