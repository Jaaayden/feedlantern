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

if (!existsSync(dbPath)) fail(`Database not found: ${dbPath}`);
const fileSize = () => statSync(dbPath).size;
const free = statfsSync(dataDir);
const freeBytes = Number(free.bavail) * Number(free.bsize);
const before = fileSize();
if (!dryRun && freeBytes < before) fail(`Free disk space (${mb(freeBytes)}) is less than the database (${mb(before)}); stopped without changing anything.`);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 10000');
const one = <T,>(sql: string) => db.prepare(sql).get() as T;
const eventCount = () => Number(one<{ c: number }>('SELECT COUNT(*) AS c FROM translation_events').c);
const excess = Number(one<{ c: number }>(`SELECT COUNT(*) AS c FROM (SELECT ROW_NUMBER() OVER (PARTITION BY feed_id ORDER BY id DESC) AS n FROM translation_events) WHERE n > ${TRANSLATION_EVENTS_PER_FEED}`).c);
const autoVacuum = Number(one<{ auto_vacuum: number }>('PRAGMA auto_vacuum').auto_vacuum);
console.log(`Database ${mb(before)}, free disk ${mb(freeBytes)}, auto_vacuum=${autoVacuum}`);
console.log(`Translation events: ${eventCount()}, of which ${excess} exceed the per-feed limit of ${TRANSLATION_EVENTS_PER_FEED}`);
if (dryRun) { console.log('--dry-run: nothing was changed.'); db.close(); process.exit(0); }

const started = Date.now();
db.prepare(`DELETE FROM translation_events WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY feed_id ORDER BY id DESC) AS n FROM translation_events) WHERE n > ?)`).run(TRANSLATION_EVENTS_PER_FEED);
console.log(`Cleaned up; ${eventCount()} remain (${((Date.now() - started) / 1000).toFixed(1)} s)`);
db.exec('PRAGMA auto_vacuum = INCREMENTAL');
db.exec('VACUUM');
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const integrity = one<{ integrity_check: string }>('PRAGMA integrity_check').integrity_check;
db.close();
console.log(`Done: ${mb(before)} -> ${mb(fileSize())}, auto_vacuum on, integrity check: ${integrity}, ${((Date.now() - started) / 1000).toFixed(1)} s in all`);
if (integrity !== 'ok') process.exit(2);
