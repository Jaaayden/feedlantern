import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/server/store.js';
import { execFileSync } from 'node:child_process';

test('单管理员密码使用 scrypt，session 与 CSRF 可撤销', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-auth-'));
  const store = new Store(dataDir);
  try {
    const setupToken = readFileSync(join(dataDir, 'setup-token'), 'utf8').trim();
    assert.equal(setupToken.length, 64);
    assert.equal(store.consumeSetupToken(setupToken), true);
    store.createAdmin('admin', 'correct-password');
    assert.equal(store.authenticate('admin', 'correct-password'), true);
    assert.equal(store.authenticate('admin', 'wrong-password'), false);
    const session = store.createSession('admin', 60_000);
    assert.equal(store.checkCsrf(session.id, session.csrfToken), true);
    assert.equal(store.checkCsrf(session.id, 'wrong'), false);
    const nextCsrf = store.issueCsrf(session.id);
    assert.equal(nextCsrf, session.csrfToken);
    assert.equal(store.checkCsrf(session.id, session.csrfToken), true);
    store.destroyAllSessions();
    assert.equal(store.findSession(session.id, 60_000), null);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('本机密码重置命令支持中文密码并撤销原会话', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedlantern-reset-'));
  const store = new Store(dataDir);
  try {
    store.createAdmin('admin', 'test-password');
    const session = store.createSession('admin', 60_000);
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/server/reset-password.ts'], { env: { ...process.env, DATA_DIR: dataDir }, input: '\n新的中文密码123\n新的中文密码123\n', encoding: 'utf8' });
    assert.match(output, /密码已重置/);
    assert.ok(!output.includes('新的中文密码123'));
    assert.equal(store.authenticate('admin', '新的中文密码123'), true);
    assert.equal(store.findSession(session.id, 60_000), null);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('多管理员本机重置必须选择目标，其他管理员会话保持有效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-reset-multi-')), store = new Store(dir);
  try {
    store.createAdmin('first', 'first-password'); const second = store.createUser('second', 'second-password');
    store.updateUser('admin', second.id, { role: 'admin' });
    const firstSession = store.createSession('first', 60_000), secondSession = store.createSession('second', 60_000);
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/server/reset-password.ts'], { env: { ...process.env, DATA_DIR: dir }, input: 'second\n\nchanged-password\nchanged-password\n', encoding: 'utf8' });
    assert.match(output, /要重置的管理员用户名/); assert.ok(store.authenticate('second', 'changed-password'));
    assert.ok(store.findSession(firstSession.id, 60_000)); assert.equal(store.findSession(secondSession.id, 60_000), null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
