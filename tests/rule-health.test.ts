import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp, Store, type BrowserServiceLike } from '../src/server/app.js';
import { RULE_HEALTH, evaluateHealth, measureItems } from '../src/server/rule-health.js';
import { ruleHealthSeverity } from '../src/shared/rule-health.js';
import { NotificationWorker, alertTitle, type NotificationMessage } from '../src/server/notify.js';
import { notificationChannelsSchema } from '../src/server/notify.js';
import type { DetectionResult, ExtractedItem } from '../src/shared/types.js';

/** A list page before a redesign: unique titles/links with dates, images and summaries. */
function before(count = 20): ExtractedItem[] {
  return Array.from({ length: count }, (_, i) => ({ title: `文章 ${i}`, link: `https://example.test/post/${i}`, publishedAt: '2026-01-01T00:00:00.000Z', image: `https://example.test/${i}.png`, description: `摘要 ${i}` }));
}
const history = (count = 6, items = before()) => Array.from({ length: count }, () => measureItems(items));

test('条数未变：日期、图片和摘要仅为轻提示，标题或链接异常仍为警告', () => {
  for (const field of ['publishedAt', 'image', 'description'] as const) {
    const items = before(6).map(item => ({ ...item, [field]: undefined }));
    const reasons = evaluateHealth(measureItems(items), history(5, before(6)))!;
    assert.equal(measureItems(items).itemCount, 6);
    assert.equal(reasons.length, 1);
    assert.equal(ruleHealthSeverity(reasons), 'notice');
  }
  for (const items of [
    before().map(item => ({ ...item, title: 'Read more', publishedAt: undefined })),
    before().map(item => ({ ...item, link: 'https://example.test/', image: undefined })),
    before(3),
  ]) assert.equal(ruleHealthSeverity(evaluateHealth(measureItems(items), history())!), 'warning');
});

test('样本不足时不判断，正常波动不告警', () => {
  assert.equal(evaluateHealth(measureItems(before(2)), history(RULE_HEALTH.minSamples - 1)), null);
  assert.deepEqual(evaluateHealth(measureItems(before(10)), history()), []);
  assert.deepEqual(evaluateHealth(measureItems(before(20)), history()), []);
  // Small lists are never judged on item count.
  assert.deepEqual(evaluateHealth(measureItems(before(1)), history(6, before(4))), []);
});

test('条目数骤降、链接全部相同或大面积重复、字段有效率骤降', () => {
  const dropped = evaluateHealth(measureItems(before(3)), history())!;
  assert.deepEqual(dropped.map(r => r.code), ['item-count']);
  assert.match(dropped[0].message, /从约 20 条降到 3 条/);
  const same = evaluateHealth(measureItems(before().map(item => ({ ...item, link: 'https://example.test/' }))), history())!;
  assert.deepEqual(same.map(r => r.code), ['same-link']);
  const duplicated = evaluateHealth(measureItems(before().map((item, i) => ({ ...item, link: `https://example.test/post/${i % 4}#c${i}` }))), history())!;
  assert.deepEqual(duplicated.map(r => r.code), ['duplicate-links']);
  const fields = evaluateHealth(measureItems(before().map(item => ({ title: 'Read more', link: item.link }))), history())!;
  assert.deepEqual(fields.map(r => r.field), ['title', 'date', 'image', 'description']);
  assert.match(fields[0].message, /标题有效率从约 100% 降到 5%/);
  // Fields that were never present are not judged.
  const plain = before().map(({ title, link }) => ({ title, link }));
  assert.deepEqual(evaluateHealth(measureItems(plain), history(6, plain)), []);
});

const input = { name: '健康度', url: 'https://example.test/list', rules: { item: 'article', title: 'h2', link: 'a' }, credentialId: null, intervalMinutes: 60, waitMs: 0 };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fl-health-')), store = new Store(dir);
  store.setSettings({ ...store.getSettings(), bark: { ...store.getSettings().bark, enabled: true, url: 'https://example.test/mock-key' } });
  const feed = store.createFeed(input).feed;
  const fetch = (items: ExtractedItem[], now = Date.now()) => {
    const run = store.history.start(feed.id, 'scheduled');
    const counts = { itemCount: 0, newItemCount: 0 };
    store.upsertItems(store.getFeed(feed.id)!, items, counts);
    store.history.succeed(run, feed.id, 1, counts);
    return { run, warning: store.ruleHealth.record(store.getFeed(feed.id)!, run, items, now) };
  };
  const alerts = () => store.history.nextAlert(Date.now() + 1000);
  return { dir, store, feed, fetch, alerts, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('6 条仍为 6 条：缺少可选字段只在订阅和日志中提示，不排队任何渠道通知，恢复后清除', () => {
  const { store, feed, fetch, alerts, close } = fixture();
  try {
    store.setNotificationChannels('admin', notificationChannelsSchema.parse({ webhook: { enabled: true, url: 'https://hooks.example.test/x', secret: '', headers: [] } }));
    for (let i = 0; i < RULE_HEALTH.minSamples; i++) fetch(before(6));
    for (const field of ['publishedAt', 'image', 'description'] as const) {
      const result = fetch(before(6).map(item => ({ ...item, [field]: undefined })));
      assert.equal(result.warning?.severity, 'notice');
      assert.equal(result.warning?.itemCount, 6);
      assert.equal(store.getFeed(feed.id)!.ruleHealth?.severity, 'notice');
      assert.equal(store.getFeed(feed.id)!.lastError, null);
      const log = store.history.list(feed.id).logs[0];
      assert.equal(log.status, 'success');
      assert.equal(log.itemCount, 6);
      assert.equal(log.newItemCount, 0);
      assert.equal(log.warningSeverity, 'notice');
      assert.equal(log.notification, null);
      assert.equal(alerts(), null);
    }
    assert.equal(fetch(before(6)).warning, null);
    assert.equal(store.getFeed(feed.id)!.ruleHealth, undefined);
  } finally { close(); }
});

test('轻提示升级为关键字段异常会通知，降级会取消尚未发送的各渠道告警', () => {
  const { store, feed, fetch, alerts, close } = fixture();
  try {
    store.setNotificationChannels('admin', notificationChannelsSchema.parse({ webhook: { enabled: true, url: 'https://hooks.example.test/x', secret: '', headers: [] } }));
    for (let i = 0; i < RULE_HEALTH.minSamples; i++) fetch(before(6));
    const missingDates = before(6).map(item => ({ ...item, publishedAt: undefined }));
    assert.equal(fetch(missingDates).warning?.severity, 'notice');
    assert.equal(alerts(), null);
    const now = Date.now() + 100;
    const warning = fetch(missingDates.map(item => ({ ...item, title: 'Read more' })), now).warning!;
    assert.equal(warning.severity, 'warning');
    assert.equal(warning.detectedAt, new Date(now).toISOString());
    const originalLog = store.history.list(feed.id).logs[0];
    assert.equal(originalLog.warningSeverity, 'warning');
    assert.equal(originalLog.notification?.channels?.length, 2);
    const alert = alerts()!;
    assert.equal(alert.kind, 'health');
    // A sustained critical problem stays one episode.
    assert.equal(fetch(missingDates.map(item => ({ ...item, title: 'Read more' })), now + 1).warning?.detectedAt, warning.detectedAt);
    assert.equal(alerts()!.alertId, alert.alertId);
    assert.equal(fetch(missingDates, now + 2).warning?.severity, 'notice');
    assert.equal(alerts(), null);
    const canceled = store.history.list(feed.id).logs.find(log => log.id === originalLog.id)!;
    assert.deepEqual(canceled.notification?.channels?.map(channel => channel.status), ['canceled', 'canceled']);
    // A later warning is still eligible; notices neither notify nor consume cooldown.
    fetch(before(1), now + 31 * 60_000);
    assert.ok(store.history.nextAlert(now + 31 * 60_000 + 1000));
  } finally { close(); }
});

test('升级旧记录：字段缺失立即降级并取消旧通知，真正的规则告警保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-health-upgrade-'));
  let store = new Store(dir);
  try {
    store.setBark('admin', { enabled: true, url: 'https://example.test/mock-key' });
    const noticeFeed = store.createFeed({ ...input, name: '日期缺失' }).feed;
    const warningFeed = store.createFeed({ ...input, name: '条目骤降', url: 'https://example.test/other' }).feed;
    const record = (feed: typeof noticeFeed, items: ExtractedItem[]) => {
      const run = store.history.start(feed.id, 'scheduled');
      store.history.succeed(run, feed.id, 1, { itemCount: items.length, newItemCount: 0 });
      return store.ruleHealth.record(feed, run, items);
    };
    for (const feed of [noticeFeed, warningFeed]) for (let i = 0; i < RULE_HEALTH.minSamples; i++) record(feed, before());
    const notice = record(noticeFeed, before().map(item => ({ ...item, publishedAt: undefined })))!;
    const legacyAlert = store.history.ruleHealthAlert(noticeFeed, notice.reasons.map(reason => reason.message), null);
    assert.ok(legacyAlert.id);
    record(warningFeed, before(3));
    store.close();
    const db = new DatabaseSync(join(dir, 'app.db'));
    db.exec("ALTER TABLE fetch_logs DROP COLUMN warning_severity; UPDATE feed_health SET warning_json=json_remove(warning_json,'$.severity');");
    db.prepare('UPDATE feed_health SET alerted_at=? WHERE feed_id=?').run(Date.now(), noticeFeed.id);
    db.close();
    store = new Store(dir);
    assert.equal(store.getFeed(noticeFeed.id)!.ruleHealth?.severity, 'notice');
    assert.equal(store.getFeed(warningFeed.id)!.ruleHealth?.severity, 'warning');
    assert.equal(store.history.nextAlert(Date.now() + 1000)?.feedId, warningFeed.id);
    const migrated = new DatabaseSync(join(dir, 'app.db'));
    assert.equal(migrated.prepare('SELECT status FROM fetch_alerts WHERE id=?').get(legacyAlert.id!)?.status, 'canceled');
    assert.equal(migrated.prepare('SELECT alerted_at FROM feed_health WHERE feed_id=?').get(noticeFeed.id)?.alerted_at, null);
    assert.equal(store.history.list(noticeFeed.id).logs[0].warningSeverity, undefined, 'old logs do not invent a historical severity');
    migrated.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('警告记录在订阅和日志上，每次出现只通知一次，恢复后取消', () => {
  const { store, feed, fetch, alerts, close } = fixture();
  try {
    for (let i = 0; i < RULE_HEALTH.minSamples; i++) assert.equal(fetch(before()).warning, null);
    const first = fetch(before(3));
    assert.equal(first.warning?.reasons[0].code, 'item-count');
    assert.equal(store.getFeed(feed.id)!.ruleHealth?.itemCount, 3);
    assert.equal(store.getFeed(feed.id)!.lastError, null);
    const log = store.history.list(feed.id).logs[0];
    assert.equal(log.status, 'success');
    assert.match(log.warning!, /条目数从约 20 条降到 3 条/);
    assert.equal(log.notification?.status, 'pending');
    const alert = alerts()!;
    assert.equal(alert.kind, 'health');
    assert.match(alert.body, /规则可能失效|重新识别/);
    // Same episode: no second notification, detection time is kept.
    const second = fetch(before(2));
    assert.equal(second.warning?.detectedAt, first.warning?.detectedAt);
    assert.equal(store.history.list(feed.id).logs[0].notification, null);
    store.history.cancelAlert(alert.alertId);
    assert.equal(alerts(), null);
    // Suspicious fetches never become the baseline; a healthy fetch clears the warning.
    assert.equal(fetch(before()).warning, null);
    assert.equal(store.getFeed(feed.id)!.ruleHealth, undefined);
    // A failure alert is deduplicated separately from rule health.
    const failed = store.history.start(feed.id, 'scheduled');
    store.history.fail(failed, store.getFeed(feed.id)!, 'scheduled', 1, '失败', true);
    const third = fetch(before(3));
    assert.ok(third.warning);
  } finally { close(); }
});

test('规则预警发到所有已启用渠道，事件为 rules.warning；关闭开关后取消已排队的投递', async () => {
  const { store, feed, fetch, close } = fixture();
  const sent: NotificationMessage[] = [];
  const senders = { bark: async (_c: unknown, m: NotificationMessage) => { sent.push(m); }, webhook: async (_c: unknown, m: NotificationMessage) => { sent.push(m); } };
  const worker = new NotificationWorker(store.history, { target: id => store.notificationTarget(id), senders });
  try {
    store.setNotificationChannels('admin', notificationChannelsSchema.parse({ webhook: { enabled: true, url: 'https://hooks.example.test/x', secret: '', headers: [] } }));
    for (let i = 0; i < RULE_HEALTH.minSamples; i++) fetch(before());
    assert.ok(fetch(before(3)).warning);
    worker.start();
    for (let i = 0; i < 400 && sent.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(sent.map(m => [m.event, m.title]).sort(), [['rules.warning', alertTitle('rules.warning')], ['rules.warning', '订阅灯：规则可能失效']]);
    assert.equal(sent[0].error, '条目数从约 20 条降到 3 条');
    assert.deepEqual(store.history.list(feed.id).logs[0].notification?.channels?.map(c => c.status), ['sent', 'sent']);
    await worker.stop();
    // Within the cooldown a new episode is not pushed again.
    fetch(before());
    assert.ok(fetch(before(2)).warning);
    assert.equal(store.history.list(feed.id).logs[0].notification, null);
    // After the cooldown a new episode is queued; the switch is turned off before delivery.
    fetch(before());
    assert.ok(fetch(before(2), Date.now() + 31 * 60_000).warning);
    store.setBark('admin', { ruleHealthAlerts: false });
    sent.length = 0; worker.start();
    for (let i = 0; i < 40; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(sent.length, 0);
    assert.equal(store.history.list(feed.id).logs[0].notification?.status, 'canceled');
  } finally { await worker.stop(); close(); }
});

test('忽略警告重置基线，修改规则清除旧统计，关闭开关不通知，RSS 订阅不统计', () => {
  const { store, feed, fetch, alerts, close } = fixture();
  try {
    for (let i = 0; i < RULE_HEALTH.minSamples; i++) fetch(before());
    assert.ok(fetch(before(3)).warning);
    store.ruleHealth.ignore(feed.id);
    assert.equal(store.getFeed(feed.id)!.ruleHealth, undefined);
    assert.equal(alerts(), null, '忽略后取消待发送通知');
    // The ignored result is the new normal: no judgement until the baseline refills.
    for (let i = 0; i < RULE_HEALTH.minSamples; i++) assert.equal(fetch(before(3)).warning, null);
    assert.equal(fetch(before(3)).warning, null);

    store.setBark('admin', { ruleHealthAlerts: false });
    for (let i = 0; i < RULE_HEALTH.minSamples; i++) fetch(before());
    assert.ok(fetch(before(1)).warning);
    assert.equal(alerts(), null);
    assert.equal(store.history.list(feed.id).logs[0].notification?.status, 'disabled');

    store.updateFeed(feed.id, { ...input, rules: { ...input.rules, title: 'h3' } });
    assert.equal(store.getFeed(feed.id)!.ruleHealth, undefined);
    assert.equal(fetch(before(1)).warning, null, '新规则没有历史样本');

    const rss = store.createFeed({ ...input, sourceType: 'rss', url: 'https://example.test/feed.xml' }).feed;
    assert.equal(store.ruleHealth.record(rss, 0, before(1)), null);
  } finally { close(); }
});

test('样本数量有上限并随日志保留期清理', () => {
  const { store, feed, fetch, dir, close } = fixture();
  try {
    for (let i = 0; i < 40; i++) fetch(before());
    for (let i = 0; i < 40; i++) fetch(before(1));
    // Long episodes keep the healthy baseline, so the warning does not silently clear.
    assert.ok(store.getFeed(feed.id)!.ruleHealth);
    const db = new DatabaseSync(join(dir, 'app.db'));
    const count = () => Number((db.prepare('SELECT COUNT(*) AS c FROM feed_health_samples').get() as { c: number }).c);
    assert.equal(count(), RULE_HEALTH.window + RULE_HEALTH.maxFlagged);
    store.ruleHealth.prune(Date.now() + 31 * 86400_000);
    assert.equal(count(), 0);
    // Without history an active warning is kept rather than treated as healthy.
    fetch(before());
    assert.ok(store.getFeed(feed.id)!.ruleHealth);
    // Later migrations (e.g. 16) may raise the version further.
    assert.ok(Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 15);
    db.close();
  } finally { close(); }
});

test('API：抓取后出现警告、并排对比重新识别、预览组合、忽略与替换规则', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-health-api-'));
  let page = before();
  const scraped: string[] = [];
  const sent: string[] = [];
  const detection: DetectionResult = { recommendedId: 'c1', warnings: [], candidates: [{ id: 'c1', label: '新列表', confidence: 'high', score: 1, count: 12, warnings: [], rects: [{ x: 0, y: 0, width: 1, height: 1 }],
    rules: { item: '.story', title: '.headline', link: '.headline a', date: 'time' }, items: before(12) }] };
  const browser: BrowserServiceLike = {
    async open() { throw new Error('unused'); }, async snapshot() { throw new Error('unused'); }, async scroll() { throw new Error('unused'); }, async click() { throw new Error('unused'); },
    async pick() { throw new Error('unused'); }, async extract() { return []; },
    async scrape(options) { scraped.push(options.rules.title); if (options.rules.item === '.story') return before(12); return page; },
    async discover() { return { title: 'x', detection }; },
    async close() {}, async dispose() {},
  };
  const app = await createApp({ dataDir: dir, publicOrigin: 'http://127.0.0.1:4321', browserService: browser, startScheduler: false, barkSender: async (_url, _body, _signal, title) => { sent.push(title ?? ''); } });
  try {
    const host = '127.0.0.1:4321';
    const setupToken = readFileSync(join(dir, 'setup-token'), 'utf8').trim();
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { host, 'x-feedlantern': '1' }, payload: { setupToken, username: 'admin', password: 'password123' } });
    const headers = { host, cookie: `${setup.cookies[0].name}=${setup.cookies[0].value}`, 'x-feedlantern': '1', 'x-csrf-token': setup.json().csrfToken as string };
    const bark = await app.inject({ method: 'PUT', url: '/api/notifications/bark', headers, payload: { enabled: true, url: 'https://example.test/mock-key' } });
    assert.equal(bark.statusCode, 200);
    assert.equal(bark.json().ruleHealthAlerts, true);
    const created = await app.inject({ method: 'POST', url: '/api/feeds', headers, payload: { ...input, rules: { ...input.rules, date: '.date' }, ruleOrigins: { item: 'auto', title: 'manual', link: 'auto', date: 'auto' } } });
    const id = created.json().feed.id as string;
    for (let i = 0; i < RULE_HEALTH.minSamples - 1; i++) assert.equal((await app.inject({ method: 'POST', url: `/api/feeds/${id}/refresh`, headers, payload: {} })).statusCode, 200);
    page = before(3);
    const refreshed = await app.inject({ method: 'POST', url: `/api/feeds/${id}/refresh`, headers, payload: {} });
    assert.equal(refreshed.json().feed.lastError, null);
    assert.equal(refreshed.json().feed.ruleHealth.reasons[0].code, 'item-count');
    const listed = await app.inject({ method: 'GET', url: '/api/feeds', headers });
    assert.ok(listed.json()[0].ruleHealth);
    for (let i = 0; i < 50 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(sent, ['订阅灯：规则可能失效']);
    // Stored items are untouched by the health check.
    assert.equal((await app.inject({ method: 'GET', url: `/api/feeds/${id}`, headers })).json().items.length, 20);

    const redetect = await app.inject({ method: 'POST', url: `/api/feeds/${id}/health/redetect`, headers, payload: {} });
    assert.equal(redetect.statusCode, 200);
    assert.equal(redetect.json().current.count, 3);
    assert.equal(redetect.json().detection.candidates[0].items.length, 5);
    assert.deepEqual(redetect.json().detection.candidates[0].rects, []);
    // Re-detection never saves rules.
    assert.equal((await app.inject({ method: 'GET', url: `/api/feeds/${id}`, headers })).json().feed.rules.item, 'article');
    const preview = await app.inject({ method: 'POST', url: `/api/feeds/${id}/health/preview`, headers, payload: { rules: { item: '.story', title: 'h2', link: '.headline a' } } });
    assert.deepEqual([preview.statusCode, preview.json().count], [200, 12]);
    const invalid = await app.inject({ method: 'POST', url: `/api/feeds/${id}/health/preview`, headers, payload: { rules: { item: '' } } });
    assert.equal(invalid.statusCode, 400);

    const ignored = await app.inject({ method: 'POST', url: `/api/feeds/${id}/health/ignore`, headers, payload: {} });
    assert.equal(ignored.json().feed.ruleHealth, undefined);

    // Apply: replace only the auto fields; the manual title stays.
    const updated = await app.inject({ method: 'PUT', url: `/api/feeds/${id}`, headers, payload: { ...input, rules: { item: '.story', title: 'h2', link: '.headline a', date: 'time' }, ruleOrigins: { item: 'auto', link: 'auto', date: 'auto' } } });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().feed.ruleOrigins.title, 'manual');
    assert.equal(updated.json().feed.ruleHealth, undefined);

    const other = await app.inject({ method: 'POST', url: '/api/feeds/missing/health/redetect', headers, payload: {} });
    assert.equal(other.statusCode, 404);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
