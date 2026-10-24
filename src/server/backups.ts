import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { z } from 'zod';
import { isApplicationSettingsJson } from './settings.js';
import { storedNotificationSchema } from './notify.js';
import { BUNDLE_ITEM_LIMIT, BUNDLE_MAX_FEEDS, OUTPUT_LIMIT, RETENTION_LIMIT } from '../shared/types.js';
import { forbiddenHeaderReason, NETWORK_LIMITS } from '../shared/network-rules.js';
import { isLocale } from '../shared/i18n.js';
/** The translation cache is disposable; both pruning and backups keep only this many newest entries. */
export const TRANSLATION_CACHE_LIMIT = 20_000;
const text = z.string().max(1_000_000);
const short = z.string().min(1).max(4000);
const nullable = text.nullable();
const date = z.string().datetime();
const url = z.string().url().refine(s => { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; });
const flag = z.union([z.literal(0), z.literal(1)]);
const visible = (max: number) => z.string().max(max).regex(/^[\t\x20-\x7e]*$/);
/** The decrypted part of a network profile; validated before it is encrypted again. */
export const networkProfileSecretSchema = z.object({
  proxy: z.object({
    type: z.enum(['http', 'https', 'socks5']), host: z.string().min(1).max(255).regex(/^[a-z0-9.:_-]+$/), port: z.number().int().min(1).max(65535),
    username: z.string().max(NETWORK_LIMITS.proxyUser).optional(), password: z.string().max(NETWORK_LIMITS.proxyUser).optional(),
  }).strict().nullable(),
  userAgent: visible(NETWORK_LIMITS.userAgent).optional(),
  referer: url.optional(),
  headers: z.array(z.object({ name: z.string().min(1).max(NETWORK_LIMITS.headerName).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).refine(name => !forbiddenHeaderReason(name)), value: visible(NETWORK_LIMITS.headerValue) }).strict()).max(NETWORK_LIMITS.headers),
}).strict();
export const backupTables = {
  rss_sources: z.array(z.object({ feed_id: short, etag: nullable, modified: nullable, seen_json: text.refine(value => { try { const a=JSON.parse(value); return Array.isArray(a) && a.length<=100 && a.every(k=>typeof k==='string'); } catch { return false; } }).default('[]') }).strict()).max(10000).default([]),
  translations: z.array(z.object({ item_id: short, feed_id: short, revision: short, status: z.enum(['pending','running','success','failed']), attempts: z.number().int().min(0).max(3), next_at: z.number().int().nonnegative(), error: nullable,
    body_json: z.string().max(20_000_000).refine(value => { try { const b=JSON.parse(value); return (b.actorId == null || typeof b.actorId==='string' && b.actorId.length<=4000) && typeof b.html==='string' && ['title','translatedHtml','bilingualHtml'].every(k => b[k]===undefined || typeof b[k]==='string'); } catch { return false; } }) }).strict()).max(2_000_000).default([]),
  translation_cache: z.array(z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), text, touched_at: z.number().int().nonnegative() }).strict()).max(TRANSLATION_CACHE_LIMIT).default([]),
  // Bark settings plus optional `channels` (Webhook, ntfy, Telegram); older backups simply omit them.
  user_notifications: z.array(z.object({ user_id: short, value: text.refine(value => { try { return storedNotificationSchema.safeParse(JSON.parse(value)).success; } catch { return false; } }) }).strict()).max(10000).default([]),
  users: z.array(z.object({ id: short, role: z.enum(['admin','user']), enabled: flag, generation: z.number().int().nonnegative(), username: z.string().regex(/^\S{1,100}$/), password_hash: z.string().regex(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/), created_at: date, updated_at: date, locale: z.string().refine(isLocale).nullable().optional() }).strict()
    // Backups made before interface languages existed come from the Chinese-only interface.
    .transform(row => ({ ...row, locale: row.locale === undefined ? 'zh-CN' : row.locale }))).min(1).max(10000).refine(rows => rows.some(u => u.role === 'admin' && u.enabled === 1) && new Set(rows.map(u => u.id)).size === rows.length && new Set(rows.map(u => u.username)).size === rows.length, 'Invalid user list'),
  credentials: z.array(z.object({ owner_id: short, id: short, name: short, url, format: z.enum(['header', 'json']), encrypted_value: text, domains_json: text, cookie_count: z.number().int().nonnegative(), updated_at: date, expires_at: date.nullable() }).strict()).max(10000),
  network_profiles: z.array(z.object({ id: short, owner_id: short, name: z.string().min(1).max(NETWORK_LIMITS.name), proxy_type: z.enum(['http', 'https', 'socks5']).nullable(), proxy_host: z.string().max(255).nullable(), proxy_port: z.number().int().min(1).max(65535).nullable(), proxy_auth: flag, user_agent: nullable, referer: nullable, header_names_json: text,
    encrypted_value: text.refine(value => { try { return networkProfileSecretSchema.safeParse(JSON.parse(value)).success; } catch { return false; } }, 'Invalid network profile'), updated_at: date }).strict()).max(10000).default([]),
  feeds: z.array(z.object({ owner_id: short, network_profile_id: short.nullable().default(null), source_type: z.enum(['website', 'rss']).default('website'), translation_mode: z.enum(['original', 'translated', 'chinese', 'bilingual']).optional(), target_language: z.enum(['zh-CN', 'zh-TW', 'en', 'ja', 'ko']).default('zh-CN'), translation_provider: z.enum(['google', 'deepl', 'openai']).nullable().default(null), id: short, name: short, channel_title: z.string().min(1).max(200).nullable(), url, rules_json: text, rule_origins_json: nullable, credential_id: short.nullable(), interval_minutes: z.number().int().min(5).max(1440), wait_ms: z.number().int().min(0).max(10000), wait_for_selector: nullable, pagination_json: nullable.optional(), enabled: flag, created_at: date, last_fetched_at: date.nullable(), last_success_at: date.nullable(), next_fetch_at: date, last_error: nullable, item_count: z.number().int().nonnegative(), token_ciphertext: z.string().regex(/^[A-Za-z0-9_-]{43}$/), token_hash: z.string().regex(/^[a-f0-9]{64}$/), item_filter_json: nullable.optional(), output_limit: z.number().int().min(OUTPUT_LIMIT.min).max(OUTPUT_LIMIT.max).optional(), retention_limit: z.number().int().min(RETENTION_LIMIT.min).max(RETENTION_LIMIT.max).nullable().optional() }).strict()
    // Backups made before 0.7 call the translation-only mode `chinese`.
    .transform(row => ({ ...row, translation_mode: row.translation_mode === 'chinese' ? 'translated' as const : row.translation_mode ?? (row.source_type === 'rss' ? 'bilingual' as const : 'original' as const) }))).max(10000),
  feed_items: z.array(z.object({ id: short, feed_id: short, normalized_key: short, title: text, link: url, description: nullable, image: nullable, published_at: date.nullable(), published_at_source: z.enum(['absolute', 'relative']).nullable().default(null), first_seen_at: date }).strict()).max(2_000_000),
  // Optional so that backups made before feed bundles still restore.
  bundles: z.array(z.object({ id: short, owner_id: short, name: z.string().min(1).max(200), item_limit: z.number().int().min(BUNDLE_ITEM_LIMIT.min).max(BUNDLE_ITEM_LIMIT.max), created_at: date, updated_at: date, token_ciphertext: z.string().regex(/^[A-Za-z0-9_-]{43}$/), token_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(10000).default([]),
  bundle_feeds: z.array(z.object({ bundle_id: short, feed_id: short, position: z.number().int().min(0).max(BUNDLE_MAX_FEEDS) }).strict()).max(200_000).default([]),
  settings: z.array(z.union([
    z.object({ key: z.literal('feedView'), value: z.enum(['list', 'cards']) }).strict(),
    z.object({ key: z.literal('application'), value: text.refine(isApplicationSettingsJson, 'Invalid application settings') }).strict(),
  ])).max(2).refine(rows => new Set(rows.map(row => row.key)).size === rows.length, 'Duplicate settings key'),
};
const currentSnapshotSchema = z.object({ format: z.literal('feedlantern-backup'), version: z.literal(3), appVersion: short, createdAt: date, security: z.object({ allowedHosts: z.array(z.string()), dnsOverHttps: z.boolean() }), tables: z.object(backupTables).strict() }).strict();
/** Legacy snapshots are normalized before validation; exported snapshots are always v3. */
export const snapshotSchema = z.preprocess(value => {
  if (!value || typeof value !== 'object') return value;
  let snapshot = structuredClone(value) as Record<string, any>;
  if (snapshot.version === 1 && Array.isArray(snapshot.tables?.admin)) {
    const { admin, ...tables } = snapshot.tables;
    if (admin.length !== 1 || admin[0].id !== 1) return value;
    snapshot = { ...snapshot, version: 2, tables: { ...tables,
      users: admin.map(({ id, ...user }: Record<string, unknown>) => ({ ...user, id: 'admin', role: 'admin', enabled: 1, generation: 0 })),
      feeds: tables.feeds?.map((row: object) => ({ ...row, owner_id: 'admin' })),
      credentials: tables.credentials?.map((row: object) => ({ ...row, owner_id: 'admin' })),
    } };
  }
  if (snapshot.version === 2 && snapshot.tables) {
    const tables = snapshot.tables;
    if (!tables.user_notifications) {
      tables.user_notifications = [];
      const setting = tables.settings?.find((s: { key: string }) => s.key === 'application');
      const admin = tables.users?.find((u: { role: string }) => u.role === 'admin');
      if (setting && admin) {
        try {
          const settings = JSON.parse(setting.value);
          tables.user_notifications.push({ user_id: admin.id, value: JSON.stringify(settings.bark) });
          settings.bark = { ...settings.bark, enabled: false, url: '' }; setting.value = JSON.stringify(settings);
        } catch { return value; }
      }
    }
    snapshot.version = 3;
  }
  return snapshot;
}, currentSnapshotSchema).superRefine((snapshot, context) => {
  const { users, feeds, credentials, user_notifications, bundles, bundle_feeds, network_profiles } = snapshot.tables;
  const owners = new Set(users.map(u => u.id)), creds = new Map(credentials.map(c => [c.id, c.owner_id]));
  const profiles = new Map(network_profiles.map(p => [p.id, p.owner_id]));
  if (profiles.size !== network_profiles.length || network_profiles.some(p => !owners.has(p.owner_id)) || feeds.some(f => f.network_profile_id && profiles.get(f.network_profile_id) !== f.owner_id)) {
    context.addIssue({ code: 'custom', message: 'Network profiles in the backup belong to unknown users' });
  }
  if (new Set(user_notifications.map(n => n.user_id)).size !== user_notifications.length || user_notifications.some(n => !owners.has(n.user_id)) || feeds.some(f => !owners.has(f.owner_id) || f.credential_id && creds.get(f.credential_id) !== f.owner_id) || credentials.some(c => !owners.has(c.owner_id))) {
    context.addIssue({ code: 'custom', message: 'Data in the backup belongs to unknown users' });
  }
  // A bundle only holds its owner's feeds, each at most once.
  const feedOwners = new Map(feeds.map(f => [f.id, f.owner_id])), bundleOwners = new Map(bundles.map(b => [b.id, b.owner_id]));
  if (bundleOwners.size !== bundles.length || bundles.some(b => !owners.has(b.owner_id)) || new Set(bundle_feeds.map(m => `${m.bundle_id}\n${m.feed_id}`)).size !== bundle_feeds.length
    || bundle_feeds.some(m => !bundleOwners.has(m.bundle_id) || feedOwners.get(m.feed_id) !== bundleOwners.get(m.bundle_id))) {
    context.addIssue({ code: 'custom', message: 'Invalid bundles in the backup' });
  }
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Tables = Snapshot['tables'];
export function sealBackup(snapshot: Snapshot, password: string) {
  if (password.length < 12 || password.length > 1024) throw Error('Backup passwords must be 12 to 1024 characters');
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
  key.fill(0);
  return { format: 'feedlantern-encrypted', version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
export function openBackup(value: unknown, password: string): Snapshot {
  const envelope = z.object({ format: z.literal('feedlantern-encrypted'), version: z.literal(1), salt: z.string().max(32), iv: z.string().max(24), tag: z.string().max(32), data: z.string().max(90_000_000) }).strict().parse(value);
  if (password.length < 12 || password.length > 1024) throw Error('Invalid backup password');
  const salt = Buffer.from(envelope.salt, 'base64'), iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw Error('Invalid backup format');
  const key = scryptSync(password, salt, 32);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    return snapshotSchema.parse(JSON.parse(plain.toString('utf8')));
  } finally { key.fill(0); }
}
