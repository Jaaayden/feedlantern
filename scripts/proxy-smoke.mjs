import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
const origin = 'https://localhost:8443';
let cookie = '', csrf = '';
function request(path, body, method = body ? 'POST' : 'GET') {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = https.request(origin + path, { method, rejectUnauthorized: false, headers: { 'X-FeedLantern': '1', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    }); req.on('error', reject); req.end(payload);
  });
}
const fixture = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<main>' + [1,2,3].map(i => `<article><h2><a href="/item/${i}">Proxy article ${i}</a></h2><p>Summary ${i}</p></article>`).join('') + '</main>'); });
await new Promise(r => fixture.listen(8877, '127.0.0.1', r));
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await request('/api/auth/status')).status === 200) break; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  const setupToken = execFileSync('docker', ['exec', 'feedlantern-proxy-test', 'cat', '/app/data/setup-token'], { encoding: 'utf8' }).trim();
  const setup = await request('/api/auth/setup', { setupToken, username: 'proxy', password: 'proxy-test-password' });
  assert.equal(setup.status, 200);
  assert.match(setup.headers['set-cookie'][0], /Secure/);
  cookie = setup.headers['set-cookie'][0].split(';')[0]; csrf = setup.json().csrfToken;
  const created = await request('/api/feeds', { name: 'proxy', url: 'http://127.0.0.1:8877', rules: { item: 'article', title: 'h2', link: 'a' } });
  assert.equal(created.status, 200); assert.equal(created.json().feed.itemCount, 3);
  const path = new URL(created.json().feedUrl).pathname;
  assert.equal(new URL(created.json().feedUrl).origin, origin);
  assert.match((await request(path)).text, /Proxy article 1/);
  const archive = await request('/api/backups/export', { currentPassword: 'proxy-test-password', password: 'proxy-backup-password' });
  assert.equal(archive.status, 200);
  const body = { archive: archive.json(), currentPassword: 'proxy-test-password', password: 'proxy-backup-password', confirm: true };
  assert.equal((await request('/api/backups/preview', body)).status, 200);
  assert.equal((await request('/api/backups/restore', body)).status, 200);
  assert.equal((await request('/api/feeds')).status, 401);
  assert.equal((await request(path)).status, 200);
  execFileSync('docker', ['restart', 'feedlantern-proxy-test'], { stdio: 'ignore' });
  for (let i = 0; i < 30; i++) { try { if ((await request(path)).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 1000)); }
  assert.equal((await request(path)).status, 200);
  console.log('Nginx HTTPS: Secure login, actual browser refresh, RSS, encrypted restore and container restart passed');
} finally { await new Promise(r => fixture.close(r)); }
