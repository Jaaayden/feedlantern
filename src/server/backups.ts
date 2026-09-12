import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { z } from 'zod';
import { isApplicationSettingsJson } from './settings.js';
const text = z.string().max(1_000_000);
const short = z.string().min(1).max(4000);
const nullable = text.nullable();
const date = z.string().datetime();
const url = z.string().url().refine(s => { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; });
const flag = z.union([z.literal(0), z.literal(1)]);
export const backupTables = {
  admin: z.array(z.object({ id: z.literal(1), username: z.string().regex(/^\S{1,100}$/), password_hash: z.string().regex(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/), created_at: date, updated_at: date }).strict()).length(1),
  credentials: z.array(z.object({ id: short, name: short, url, format: z.enum(['header', 'json']), encrypted_value: text, domains_json: text, cookie_count: z.number().int().nonnegative(), updated_at: date, expires_at: date.nullable() }).strict()).max(10000),
  feeds: z.array(z.object({ id: short, name: short, channel_title: z.string().min(1).max(200).nullable(), url, rules_json: text, rule_origins_json: nullable, credential_id: short.nullable(), interval_minutes: z.number().int().min(5).max(1440), wait_ms: z.number().int().min(0).max(10000), wait_for_selector: nullable, enabled: flag, created_at: date, last_fetched_at: date.nullable(), last_success_at: date.nullable(), next_fetch_at: date, last_error: nullable, item_count: z.number().int().nonnegative(), token_ciphertext: z.string().regex(/^[A-Za-z0-9_-]{43}$/), token_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(10000),
  feed_items: z.array(z.object({ id: short, feed_id: short, normalized_key: short, title: text, link: url, description: nullable, image: nullable, published_at: date.nullable(), published_at_source: z.enum(['absolute', 'relative']).nullable().default(null), first_seen_at: date }).strict()).max(2_000_000),
  settings: z.array(z.union([
    z.object({ key: z.literal('feedView'), value: z.enum(['list', 'cards']) }).strict(),
    z.object({ key: z.literal('application'), value: text.refine(isApplicationSettingsJson, '应用设置无效') }).strict(),
  ])).max(2).refine(rows => new Set(rows.map(row => row.key)).size === rows.length, '设置键重复'),
};
export const snapshotSchema = z.object({ format: z.literal('feedlantern-backup'), version: z.literal(1), appVersion: short, createdAt: date, security: z.object({ allowedHosts: z.array(z.string()), dnsOverHttps: z.boolean() }), tables: z.object(backupTables).strict() }).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Tables = Snapshot['tables'];
export function sealBackup(snapshot: Snapshot, password: string) {
  if (password.length < 12 || password.length > 1024) throw Error('备份密码需为 12–1024 个字符');
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
  key.fill(0);
  return { format: 'feedlantern-encrypted', version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
export function openBackup(value: unknown, password: string): Snapshot {
  const envelope = z.object({ format: z.literal('feedlantern-encrypted'), version: z.literal(1), salt: z.string().max(32), iv: z.string().max(24), tag: z.string().max(32), data: z.string().max(90_000_000) }).strict().parse(value);
  if (password.length < 12 || password.length > 1024) throw Error('备份密码无效');
  const salt = Buffer.from(envelope.salt, 'base64'), iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw Error('备份格式无效');
  const key = scryptSync(password, salt, 32);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    return snapshotSchema.parse(JSON.parse(plain.toString('utf8')));
  } finally { key.fill(0); }
}
