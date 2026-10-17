// One-off maintenance: trim translation events to the per-feed cap, switch the file to incremental
// auto_vacuum and VACUUM it so the file shrinks to its real content size. Stop the service first.
//   docker compose stop feedlantern
//   docker compose run --rm --no-deps feedlantern node --import tsx scripts/compact-db.ts [--dry-run]
//   docker compose up -d --wait feedlantern
import { existsSync, statSync, statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TRANSLATION_EVENTS_PER_FEED } from '../src/server/rss-translation.js';

const dryRun = process.argv.includes('--dry-run');
const dataDir = resolve(process.env.DATA_DIR ?? 'data');
const dbPath = join(dataDir, 'app.db');
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
const fail = (message: string): never => { console.error(message); process.exit(1); };

if (!existsSync(dbPath)) fail(`找不到数据库：${dbPath}`);
const fileSize = () => statSync(dbPath).size;
const free = statfsSync(dataDir);
const freeBytes = Number(free.bavail) * Number(free.bsize);
const before = fileSize();
if (!dryRun && freeBytes < before) fail(`磁盘剩余空间 ${mb(freeBytes)} 小于数据库 ${mb(before)}，为安全起见已中止，未做任何修改。`);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 10000');
const one = <T,>(sql: string) => db.prepare(sql).get() as T;
const eventCount = () => Number(one<{ c: number }>('SELECT COUNT(*) AS c FROM translation_events').c);
const excess = Number(one<{ c: number }>(`SELECT COUNT(*) AS c FROM (SELECT ROW_NUMBER() OVER (PARTITION BY feed_id ORDER BY id DESC) AS n FROM translation_events) WHERE n > ${TRANSLATION_EVENTS_PER_FEED}`).c);
const autoVacuum = Number(one<{ auto_vacuum: number }>('PRAGMA auto_vacuum').auto_vacuum);
console.log(`数据库 ${mb(before)}，磁盘剩余 ${mb(freeBytes)}，auto_vacuum=${autoVacuum}`);
console.log(`翻译事件 ${eventCount()} 条，超出每订阅 ${TRANSLATION_EVENTS_PER_FEED} 条上限的有 ${excess} 条`);
if (dryRun) { console.log('--dry-run：未修改任何数据。'); db.close(); process.exit(0); }

const started = Date.now();
db.prepare(`DELETE FROM translation_events WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY feed_id ORDER BY id DESC) AS n FROM translation_events) WHERE n > ?)`).run(TRANSLATION_EVENTS_PER_FEED);
console.log(`已清理，剩余 ${eventCount()} 条（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
db.exec('PRAGMA auto_vacuum = INCREMENTAL');
db.exec('VACUUM');
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const integrity = one<{ integrity_check: string }>('PRAGMA integrity_check').integrity_check;
db.close();
console.log(`完成：${mb(before)} -> ${mb(fileSize())}，auto_vacuum 已启用，完整性检查：${integrity}，共 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
if (integrity !== 'ok') process.exit(2);
