import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type BrowserServiceLike } from '../src/server/app.js';

const browser: BrowserServiceLike = {
  open() { throw Error('unexpected'); }, snapshot() { throw Error('unexpected'); }, scroll() { throw Error('unexpected'); }, click() { throw Error('unexpected'); }, pick() { throw Error('unexpected'); }, extract() { throw Error('unexpected'); },
  scrape: async () => [], close() {}, dispose() {},
};

type Inject = Awaited<ReturnType<typeof createApp>>;
async function signIn(app: Inject, dir: string, headers: Record<string, string>, username: string, password: string) {
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers, payload: { setupToken: readFileSync(join(dir, 'setup-token'), 'utf8').trim(), username, password } });
  assert.equal(setup.statusCode, 200, setup.body);
  return { ...headers, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-csrf-token': setup.json().csrfToken };
}
async function login(app: Inject, headers: Record<string, string>, username: string, password: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username, password } });
  assert.equal(response.statusCode, 200, response.body);
  return { ...headers, cookie: `${response.cookies[0].name}=${response.cookies[0].value}`, 'x-csrf-token': response.json().csrfToken };
}

test('恢复正式服务器的完整备份后，本机仍可从原地址访问；勾选后才使用备份的服务器与网络设置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-restore-server-'));
  // The production server sits behind a reverse proxy on another origin and port.
  const source = await createApp({ dataDir: join(dir, 'source'), browserService: browser, startScheduler: false, publicOrigin: 'https://feeds.prod.example', port: 8080, host: '0.0.0.0', cookieSecure: true, trustedProxies: ['10.0.0.0/8'] });
  // The local test instance from the user's report.
  const local = { host: '127.0.0.1:4400', origin: 'http://127.0.0.1:4400', 'x-feedlantern': '1' };
  const target = await createApp({ dataDir: join(dir, 'target'), browserService: browser, startScheduler: false, publicOrigin: 'http://127.0.0.1:4400', port: 4400 });
  try {
    const sourceHeaders = await signIn(source, join(dir, 'source'), { host: 'feeds.prod.example', 'x-feedlantern': '1' }, 'owner', 'owner-password');
    const exported = await source.inject({ method: 'POST', url: '/api/backups/export', headers: sourceHeaders, payload: { currentPassword: 'owner-password', password: 'long-backup-password' } });
    assert.equal(exported.statusCode, 200, exported.body);
    const archive = exported.json();

    const targetHeaders = await signIn(target, join(dir, 'target'), local, 'local', 'local-password');
    const body = { archive, currentPassword: 'local-password', password: 'long-backup-password', confirm: true };
    const preview = await target.inject({ method: 'POST', url: '/api/backups/preview', headers: targetHeaders, payload: body });
    assert.equal(preview.statusCode, 200, preview.body);
    const changes = new Map((preview.json().serverChanges as Array<{ key: string; current: unknown; backup: unknown }>).map(change => [change.key, change]));
    assert.deepEqual(changes.get('publicOrigin'), { key: 'publicOrigin', label: '公开访问地址', current: 'http://127.0.0.1:4400', backup: 'https://feeds.prod.example' });
    assert.deepEqual(changes.get('port'), { key: 'port', label: '监听端口', current: 4400, backup: 8080 });
    assert.equal(changes.get('cookieSecure')?.backup, true);
    assert.deepEqual(changes.get('trustedProxies')?.backup, ['10.0.0.0/8']);
    assert.ok(!changes.has('sessionTtlDays'), '相同的设置不列出');
    assert.equal(preview.json().settings.server, undefined, '服务器设置只在差异中列出');

    // Default: keep this instance's server and network settings.
    const restored = await target.inject({ method: 'POST', url: '/api/backups/restore', headers: targetHeaders, payload: body });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().serverSettingsRestored, false);
    const owner = await login(target, local, 'owner', 'owner-password');
    const status = await target.inject({ url: '/api/auth/status', headers: owner });
    assert.equal(status.statusCode, 200, status.body);
    const settings = await target.inject({ url: '/api/settings', headers: owner });
    assert.equal(settings.statusCode, 200, settings.body);
    assert.equal(settings.json().server.publicOrigin, 'http://127.0.0.1:4400');
    assert.equal(settings.json().server.port, 4400);
    assert.equal(settings.json().server.cookieSecure, false);
    assert.deepEqual(settings.json().server.trustedProxies, []);
    // A write from the original address still passes the origin check.
    const created = await target.inject({ method: 'POST', url: '/api/feeds', headers: owner, payload: { name: 'after restore', url: 'https://example.test', rules: { item: 'article', title: 'h2', link: 'a' } } });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(new URL(created.json().feedUrl).origin, 'http://127.0.0.1:4400');

    assert.equal((await target.inject({ method: 'POST', url: '/api/backups/restore', headers: owner, payload: { ...body, currentPassword: 'owner-password', restoreServerSettings: 'yes' } })).statusCode, 400);
    // Opting in takes over the backup's settings; that is what used to lock the user out.
    const optIn = await target.inject({ method: 'POST', url: '/api/backups/restore', headers: owner, payload: { ...body, currentPassword: 'owner-password', restoreServerSettings: true } });
    assert.equal(optIn.statusCode, 200, optIn.body);
    assert.equal(optIn.json().serverSettingsRestored, true);
    const blocked = await target.inject({ url: '/api/auth/status', headers: local });
    assert.equal(blocked.statusCode, 403);
    assert.match(blocked.json().error, /请求来源不被允许/);
  } finally {
    await source.close(); await target.close(); rmSync(dir, { recursive: true, force: true });
  }
});
