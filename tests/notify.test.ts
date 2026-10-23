import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { NetworkPolicy } from '../src/server/network.js';
import { openBackup, sealBackup, snapshotSchema } from '../src/server/backups.js';
import { NotificationWorker, notificationChannelsSchema, sendNtfy, sendWebhook, telegramSender, type NotificationMessage, type NotificationSenders } from '../src/server/notify.js';
import { defaultNotificationChannels, type NotificationChannelSettings } from '../src/shared/types.js';

const browser: BrowserServiceLike = { open() { throw Error(); }, snapshot() { throw Error(); }, scroll() { throw Error(); }, click() { throw Error(); }, pick() { throw Error(); }, extract: () => [], scrape: () => [], close() {}, dispose() {} };
const rules = { item: 'article', title: 'h2', link: 'a' };
const botToken = '123456:test-private-bot-token-value';
const message: NotificationMessage = { event: 'fetch.failed', title: '订阅灯：订阅抓取失败', body: '示例订阅\n原因：HTTP 503', feedId: 'feed-1', feedName: '示例订阅', error: 'HTTP 503', time: '2026-10-22T00:00:00.000Z', panelUrl: 'https://feeds.example.test/#/feed/feed-1/logs' };

interface Received { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }
async function receiver(respond: (request: Received) => { status: number; body?: string } = () => ({ status: 200, body: '{}' })) {
  const received: Received[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    received.push(request);
    const reply = respond(request);
    res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.status === 302 ? { location: '/elsewhere' } : {}) }); res.end(reply.body ?? '');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  return { received, host, base: `http://${host}`, policy: new NetworkPolicy({ allowedHosts: [host] }),
    close: () => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); } };
}
const signal = () => AbortSignal.timeout(2000);
const channels = (patch: Partial<{ [K in keyof NotificationChannelSettings]: Partial<NotificationChannelSettings[K]> }>): NotificationChannelSettings => notificationChannelsSchema.parse({
  webhook: { ...defaultNotificationChannels.webhook, ...patch.webhook }, ntfy: { ...defaultNotificationChannels.ntfy, ...patch.ntfy }, telegram: { ...defaultNotificationChannels.telegram, ...patch.telegram },
});
async function until(fn: () => boolean) { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('timeout'); }

test('Webhook 发送事件 JSON、自定义请求头和可验证的 HMAC 签名，不跟随重定向', async () => {
  let status = 200;
  const server = await receiver(() => ({ status }));
  try {
    const config = { enabled: true, url: `${server.base}/hook?team=ops`, secret: 'signing-secret', headers: [{ name: 'X-Api-Key', value: 'header-secret' }] };
    await sendWebhook(config, message, { signal: signal(), policy: server.policy });
    const [request] = server.received;
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/hook?team=ops');
    assert.equal(request.headers['x-api-key'], 'header-secret');
    assert.equal(request.headers['x-feedlantern-event'], 'fetch.failed');
    assert.match(String(request.headers['content-type']), /application\/json/);
    assert.equal(request.headers['x-feedlantern-signature-256'], `sha256=${createHmac('sha256', 'signing-secret').update(request.body).digest('hex')}`);
    assert.deepEqual(JSON.parse(request.body), { event: 'fetch.failed', title: message.title, message: message.body, feedId: 'feed-1', feedName: '示例订阅', error: 'HTTP 503', time: message.time, panelUrl: message.panelUrl });
    await sendWebhook({ ...config, secret: '', headers: [] }, message, { signal: signal(), policy: server.policy });
    assert.equal(server.received[1].headers['x-feedlantern-signature-256'], undefined);
    for (status of [500, 302]) await assert.rejects(sendWebhook(config, message, { signal: signal(), policy: server.policy }));
    assert.ok(!server.received.some(r => r.url === '/elsewhere'));
  } finally { await server.close(); }
});

test('出站通知走网络安全策略：回环、内网和云元数据地址默认被拦截', async () => {
  const server = await receiver();
  try {
    const policy = new NetworkPolicy();
    for (const url of [`${server.base}/hook`, 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/hook', 'http://localhost:9/hook']) {
      await assert.rejects(sendWebhook({ enabled: true, url, secret: '', headers: [] }, message, { signal: signal(), policy }), { name: 'NetworkPolicyError' });
    }
    await assert.rejects(sendNtfy({ enabled: true, server: server.base, topic: 'alerts', token: '' }, message, { signal: signal(), policy }), { name: 'NetworkPolicyError' });
    await assert.rejects(telegramSender(server.base)({ enabled: true, botToken, chatId: '42' }, message, { signal: signal(), policy }), { name: 'NetworkPolicyError' });
    assert.equal(server.received.length, 0);
  } finally { await server.close(); }
});

test('ntfy 以 JSON 发布到服务器根地址并带令牌；Telegram 调用 sendMessage 并校验 ok', async () => {
  let telegramOk = true;
  const server = await receiver(request => request.url?.startsWith('/bot') ? { status: 200, body: JSON.stringify({ ok: telegramOk }) } : { status: 200 });
  try {
    await sendNtfy({ enabled: true, server: `${server.base}/ntfy`, topic: 'feed-alerts', token: 'tk_private' }, message, { signal: signal(), policy: server.policy });
    const ntfy = server.received[0];
    assert.equal(ntfy.url, '/ntfy/'); assert.equal(ntfy.headers.authorization, 'Bearer tk_private');
    assert.deepEqual(JSON.parse(ntfy.body), { topic: 'feed-alerts', title: message.title, message: message.body, tags: ['warning'], click: message.panelUrl });
    const send = telegramSender(server.base);
    await send({ enabled: true, botToken, chatId: '-1001234' }, message, { signal: signal(), policy: server.policy });
    const telegram = server.received[1];
    assert.equal(telegram.url, `/bot${botToken}/sendMessage`);
    const body = JSON.parse(telegram.body);
    assert.equal(body.chat_id, '-1001234'); assert.match(body.text, /订阅灯：订阅抓取失败[\s\S]*HTTP 503[\s\S]*feed-1\/logs/);
    telegramOk = false;
    await assert.rejects(send({ enabled: true, botToken, chatId: '-1001234' }, message, { signal: signal(), policy: server.policy }));
  } finally { await server.close(); }
});

test('渠道配置校验：保留请求头、重复请求头、无效令牌和启用时缺少必填项', () => {
  const invalid: unknown[] = [
    { webhook: { ...defaultNotificationChannels.webhook, url: 'ftp://example.test/' } },
    { webhook: { ...defaultNotificationChannels.webhook, url: 'https://user:pass@example.test/' } },
    { webhook: { ...defaultNotificationChannels.webhook, enabled: true } },
    { webhook: { ...defaultNotificationChannels.webhook, headers: [{ name: 'Host', value: 'x' }] } },
    { webhook: { ...defaultNotificationChannels.webhook, headers: [{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }] } },
    { webhook: { ...defaultNotificationChannels.webhook, headers: [{ name: 'X-A', value: 'a\r\nInjected: 1' }] } },
    { ntfy: { ...defaultNotificationChannels.ntfy, topic: 'bad topic' } },
    { ntfy: { ...defaultNotificationChannels.ntfy, server: 'https://ntfy.example.test/?q=1' } },
    { ntfy: { ...defaultNotificationChannels.ntfy, enabled: true } },
    { telegram: { ...defaultNotificationChannels.telegram, botToken: 'not-a-token' } },
    { telegram: { ...defaultNotificationChannels.telegram, chatId: 'abc' } },
    { telegram: { ...defaultNotificationChannels.telegram, enabled: true, botToken } },
  ];
  for (const value of invalid) assert.equal(notificationChannelsSchema.safeParse(value).success, false, JSON.stringify(value));
  assert.deepEqual(notificationChannelsSchema.parse({}), defaultNotificationChannels);
  assert.equal(notificationChannelsSchema.parse({ telegram: { enabled: true, botToken, chatId: '@feed_alerts' } }).telegram.chatId, '@feed_alerts');
});

test('抓取和翻译失败发到所有已启用渠道，各渠道分别重试并记录结果，停用渠道取消待发送', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-notify-')), store = new Store(dir);
  const sent: string[] = [];
  let webhookFails = true;
  const senders: Partial<NotificationSenders> = {
    bark: async (_config, message) => { sent.push(`bark:${message.event}`); },
    webhook: async (_config, message) => { sent.push(`webhook:${message.event}:${message.feedName}:${message.error}:${message.panelUrl}`); if (webhookFails) throw Error('https://hooks.example.test/private'); },
    telegram: async (_config, message) => { sent.push(`telegram:${message.event}`); },
  };
  const worker = new NotificationWorker(store.history, { target: id => store.notificationTarget(id), senders, panelUrl: (id, event) => `panel:${id}:${event}` });
  try {
    store.setBark('admin', { enabled: true, url: 'https://api.day.app/test-key/', failureThreshold: 1, maxAttempts: 2 });
    store.setNotificationChannels('admin', channels({ webhook: { enabled: true, url: 'https://hooks.example.test/private' }, telegram: { enabled: false, botToken, chatId: '42' } }));
    const feed = store.createFeed({ name: '多渠道', url: 'https://example.test', rules, credentialId: null, intervalMinutes: 60, waitMs: 0 }).feed;
    const run = store.history.start(feed.id, 'scheduled'); store.history.fail(run, feed, 'scheduled', 1, 'HTTP 503', true);
    worker.start();
    await until(() => store.history.list(feed.id).logs[0].notification?.channels?.find(c => c.channel === 'webhook')?.error !== null);
    let notification = store.history.list(feed.id).logs[0].notification!;
    assert.deepEqual(notification.channels!.map(c => [c.channel, c.status]), [['bark', 'sent'], ['webhook', 'pending']]);
    assert.equal(notification.status, 'pending');
    assert.match(notification.channels![1].error!, /^Webhook 推送失败/); assert.ok(!JSON.stringify(notification).includes('hooks.example.test'));
    assert.ok(sent.includes(`webhook:fetch.failed:多渠道:HTTP 503:panel:${feed.id}:fetch.failed`));
    // The second (last) attempt is due after the retry delay.
    const db = new DatabaseSync(store.dbPath); db.exec("UPDATE fetch_alert_deliveries SET next_attempt_at=0 WHERE status='pending'"); db.close();
    worker.wake(); await until(() => store.history.list(feed.id).logs[0].notification?.channels?.[1].status === 'failed');
    notification = store.history.list(feed.id).logs[0].notification!;
    assert.equal(notification.status, 'sent', 'one delivered channel counts as notified');
    assert.equal(sent.filter(s => s.startsWith('bark')).length, 1);
    await worker.stop();

    // Translation failures go to every enabled channel too; a channel turned off before sending is canceled.
    webhookFails = false;
    store.setNotificationChannels('admin', channels({ webhook: { enabled: true, url: 'https://hooks.example.test/private' }, telegram: { enabled: true, botToken, chatId: '42' } }));
    assert.equal(store.history.translationFailed(feed, '翻译服务超时'), true);
    const pending = store.history.nextAlert()!; assert.equal(pending.kind, 'translation');
    const raw = new DatabaseSync(store.dbPath);
    assert.deepEqual(raw.prepare("SELECT channel FROM fetch_alert_deliveries WHERE alert_id=? ORDER BY channel").all(pending.alertId).map(r => r.channel), ['bark', 'telegram', 'webhook']);
    raw.close();
    const target = store.notificationTarget(feed.id);
    assert.deepEqual(Object.keys(target.configs).sort(), ['bark', 'telegram', 'webhook']);
    // Simulate the channel being disabled without resetting (e.g. settings written by another process).
    const value = store.getNotifications('admin'); value.channels.telegram.enabled = false;
    (store as unknown as { writeNotifications(id: string, b: unknown, c: unknown): void }).writeNotifications('admin', value.bark, value.channels);
    sent.length = 0; worker.start();
    await until(() => sent.length >= 2 && !store.history.nextAlert());
    assert.deepEqual(sent.sort(), ['bark:translation.failed', `webhook:translation.failed:多渠道:翻译服务超时:panel:${feed.id}:translation.failed`]);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('渠道配置加密保存、Bark 设置互不覆盖、修改目标取消待发送告警，备份往返保留渠道', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-notify-store-')), a = new Store(join(dir, 'a')), b = new Store(join(dir, 'b'));
  try {
    a.createAdmin('admin', 'source-password');
    const value = channels({ webhook: { enabled: true, url: 'https://hooks.example.test/private-path', secret: 'private-signing', headers: [{ name: 'Authorization', value: 'Bearer private-header' }] }, ntfy: { enabled: true, topic: 'alerts', token: 'tk_private_ntfy' }, telegram: { enabled: true, botToken, chatId: '42' } });
    a.setNotificationChannels('admin', value);
    a.setBark('admin', { enabled: true, url: 'https://api.day.app/test-key/', failureThreshold: 1 });
    assert.deepEqual(a.getNotifications('admin').channels, value, 'saving Bark keeps the other channels');
    a.setSettings({ ...a.getSettings(), logRetentionDays: 9 });
    assert.deepEqual(a.getNotifications('admin').channels, value, 'saving app settings keeps the channels');
    for (const path of [a.dbPath, `${a.dbPath}-wal`]) for (const secret of ['private-signing', 'private-header', 'tk_private_ntfy', botToken]) assert.ok(!readFileSync(path).includes(Buffer.from(secret)), secret);

    const feed = a.createFeed({ name: 'x', url: 'https://example.test', rules, credentialId: null, intervalMinutes: 60, waitMs: 0 }).feed;
    const fail = () => a.history.fail(a.history.start(feed.id, 'manual'), feed, 'manual', 1, 'error', true);
    fail(); assert.ok(a.history.nextAlert());
    a.setNotificationChannels('admin', { ...value, ntfy: { ...value.ntfy, topic: 'other' } });
    assert.equal(a.history.nextAlert(), null, 're-targeting a channel cancels pending deliveries');
    assert.equal(a.history.list(feed.id).logs[0].notification?.status, 'canceled');
    fail(); assert.ok(a.history.nextAlert());
    a.setNotificationChannels('admin', { ...value, ntfy: { ...value.ntfy, topic: 'other' } });
    assert.ok(a.history.nextAlert(), 'saving unchanged destinations keeps pending deliveries');

    const snapshot = snapshotSchema.parse({ format: 'feedlantern-backup', version: 3, appVersion: 'test', createdAt: new Date().toISOString(), security: { allowedHosts: [], dnsOverHttps: false }, tables: a.exportTables() });
    const sealed = sealBackup(snapshot, 'long-backup-password');
    assert.ok(!JSON.stringify(sealed).includes('private-signing'));
    b.restoreTables(openBackup(sealed, 'long-backup-password').tables);
    assert.deepEqual(b.getNotifications('admin'), a.getNotifications('admin'));
    const corrupt = structuredClone(snapshot);
    corrupt.tables.user_notifications[0].value = JSON.stringify({ ...JSON.parse(corrupt.tables.user_notifications[0].value), channels: { telegram: { enabled: true, botToken: 'bad', chatId: '1' } } });
    assert.equal(snapshotSchema.safeParse(corrupt).success, false);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('迁移 10 把升级前的 Bark 告警转为 Bark 渠道记录，重复启动不重复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-notify-migrate-'));
  let store = new Store(dir);
  try {
    store.setBark('admin', { enabled: true, url: 'https://api.day.app/test-key/', failureThreshold: 1 });
    const feed = store.createFeed({ name: 'x', url: 'https://example.test', rules, credentialId: null, intervalMinutes: 60, waitMs: 0 }).feed;
    store.history.fail(store.history.start(feed.id, 'manual'), feed, 'manual', 1, 'error', true);
    const job = store.history.nextAlert()!; store.history.beginAttempt(job.id); store.history.finishAttempt(job.id, true);
    const path = store.dbPath; store.close();
    // Recreate a version 8 database: one Bark-era alert, no channel deliveries.
    const db = new DatabaseSync(path);
    db.exec("DELETE FROM fetch_alert_deliveries; UPDATE fetch_alerts SET payload=NULL; PRAGMA user_version=8;"); db.close();
    store = new Store(dir); store.close(); store = new Store(dir);
    assert.equal(Number(new DatabaseSync(path).prepare('PRAGMA user_version').get()!.user_version) >= 10, true);
    const notification = store.history.list(feed.id).logs[0].notification!;
    assert.equal(notification.status, 'sent');
    assert.deepEqual(notification.channels, [{ channel: 'bark', status: 'sent', error: null }]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('通知接口：机密不回显、空值保留、测试走网络策略、配置导出导入包含渠道', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-notify-api-')), store = new Store(dir);
  const server = await receiver();
  const tested: string[] = [];
  const app = await createApp({ dataDir: dir, store, browserService: browser, startScheduler: false, publicOrigin: 'http://127.0.0.1:4321', allowedHosts: [server.host],
    notificationSenders: { telegram: async (config, message) => { tested.push(`${config.chatId}:${message.event}`); } } });
  const host = '127.0.0.1:4321';
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken: store.getSetupToken(), username: 'admin', password: 'test-password' } });
    const headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken };
    const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/notifications', headers, payload });
    const initial = (await app.inject({ url: '/api/notifications', headers })).json();
    assert.equal(initial.failureThreshold, 10); assert.equal(initial.channels.webhook.enabled, false); assert.equal(initial.channels.ntfy.server, 'https://ntfy.sh/');
    const saved = await put({ failureThreshold: 2, channels: { webhook: { enabled: true, url: `${server.base}/hook`, secret: 'api-signing', headers: [{ name: 'X-Token', value: 'api-header' }] }, telegram: { enabled: true, botToken, chatId: '42' } } });
    assert.equal(saved.statusCode, 200, saved.body);
    for (const secret of ['api-signing', 'api-header', botToken, '/hook']) assert.ok(!saved.body.includes(secret), secret);
    assert.deepEqual(saved.json().channels.webhook, { enabled: true, configured: true, maskedUrl: `${server.base}/••••••`, signed: true, headerNames: ['X-Token'] });
    assert.equal(saved.json().channels.telegram.tokenConfigured, true); assert.equal(saved.json().failureThreshold, 2);
    // Omitted secrets are kept; an empty value clears.
    assert.equal((await put({ channels: { webhook: { enabled: true } } })).json().channels.webhook.signed, true);
    assert.equal((await put({ channels: { webhook: { secret: '' } } })).json().channels.webhook.signed, false);
    await put({ channels: { webhook: { secret: 'api-signing' } } });
    for (const payload of [{ channels: { slack: {} } }, { channels: { webhook: { headers: [{ name: 'Content-Type', value: 'x' }] } } }, { channels: { telegram: { botToken: 'x' } } }, { maxAttempts: 9 }, { channels: [] }, { unknown: 1 }]) assert.equal((await put(payload)).statusCode, 400, JSON.stringify(payload));

    const test = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/notifications/test', headers, payload });
    // Saved webhook through the real sender and the allowlisted local receiver.
    assert.equal((await test({ channel: 'webhook' })).statusCode, 200);
    const hook = server.received.at(-1)!;
    assert.equal(JSON.parse(hook.body).event, 'test'); assert.equal(JSON.parse(hook.body).panelUrl, 'http://127.0.0.1:4321/#/settings');
    assert.equal(hook.headers['x-token'], 'api-header');
    assert.equal(hook.headers['x-feedlantern-signature-256'], `sha256=${createHmac('sha256', 'api-signing').update(hook.body).digest('hex')}`);
    // Unsaved values are tested without saving; blocked addresses get a clear error.
    const blocked = await test({ channel: 'webhook', url: 'http://169.254.169.254/latest/meta-data/' });
    assert.equal(blocked.statusCode, 400); assert.match(blocked.json().error, /网络安全策略/);
    assert.equal(store.getNotifications('admin').channels.webhook.url, `${server.base}/hook`);
    assert.equal((await test({ channel: 'telegram', chatId: '@other_chat' })).statusCode, 200);
    assert.deepEqual(tested, ['@other_chat:test']);
    assert.equal((await test({ channel: 'ntfy' })).statusCode, 400);
    assert.equal((await test({ channel: 'bark' })).statusCode, 400);

    const archive = (await app.inject({ url: '/api/backups/config', headers })).json();
    assert.equal(archive.notificationChannels.webhook.secret, 'api-signing');
    await put({ channels: { webhook: { url: '' }, telegram: { botToken: '' } } });
    assert.equal(store.getNotifications('admin').channels.webhook.enabled, false);
    const preview = await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive } });
    assert.equal(preview.statusCode, 200);
    for (const secret of ['api-signing', 'api-header', botToken]) assert.ok(!preview.body.includes(secret), secret);
    assert.equal(preview.json().settings.notificationChannels.webhook.signed, true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive, confirm: true } })).statusCode, 200);
    assert.deepEqual(store.getNotifications('admin').channels, archive.notificationChannels);
    const { notificationChannels: _omit, ...older } = archive;
    await put({ channels: { ntfy: { enabled: true, topic: 'kept' } } });
    assert.equal((await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: older, confirm: true } })).statusCode, 200);
    assert.equal(store.getNotifications('admin').channels.ntfy.topic, 'kept', 'archives without channels keep the current ones');
    assert.equal((await app.inject({ method: 'POST', url: '/api/backups/config', headers, payload: { archive: { ...archive, notificationChannels: { webhook: { enabled: true } } } } })).statusCode, 400);
  } finally { await app.close(); store.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
