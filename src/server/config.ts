import { existsSync, readFileSync } from 'node:fs';
import { mkdir, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface ServerConfig {
  port: number;
  host: string;
  publicOrigin: string;
  dataDir: string;
  version: string;
  cookieSecure: boolean;
  cookieName: string;
  sessionTtlMs: number;
  allowedHosts: string[];
  trustedProxies?: string[];
  browserExecutablePath?: string;
  distDir: string;
  viteOrigins: string[];
}

export interface ConfigInput extends Partial<Omit<ServerConfig, 'allowedHosts' | 'viteOrigins'>> {
  allowedHosts?: string[];
  viteOrigins?: string[];
}

const DEFAULT_ORIGIN = 'http://127.0.0.1:4321';

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? '4321');
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 4321;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseOrigin(value: string | undefined): string {
  const origin = value?.trim() || DEFAULT_ORIGIN;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return DEFAULT_ORIGIN;
    }
    return parsed.origin;
  } catch {
    return DEFAULT_ORIGIN;
  }
}

function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function detectVersion(cwd: string): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  let base = '0.1.0-dev.1';
  try {
    const packageJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof packageJson.version === 'string' && packageJson.version) base = packageJson.version;
  } catch {
    // Running from a bundled/embedded directory may not have package.json.
  }
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 500 }).toString().trim();
    return sha ? `${base}+${sha}` : base;
  } catch {
    return base;
  }
}

export function getConfig(overrides: ConfigInput = {}, cwd = process.cwd()): ServerConfig {
  const publicOrigin = parseOrigin(overrides.publicOrigin ?? process.env.PUBLIC_ORIGIN);
  const dataDir = resolve(overrides.dataDir ?? process.env.DATA_DIR ?? resolve(cwd, 'data'));
  const distDir = resolve(overrides.distDir ?? resolve(cwd, 'dist'));
  const cookieSecure = overrides.cookieSecure ?? parseBool(process.env.COOKIE_SECURE, new URL(publicOrigin).protocol === 'https:');
  const version = overrides.version ?? detectVersion(cwd);
  const viteOrigins = overrides.viteOrigins ?? (process.env.NODE_ENV === 'development' ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : []);
  const allowedHosts = overrides.allowedHosts ?? parseAllowedHosts(process.env.ALLOWED_TARGET_HOSTS);

  return {
    port: overrides.port ?? parsePort(process.env.PORT),
    host: overrides.host ?? process.env.HOST ?? '127.0.0.1',
    publicOrigin,
    dataDir,
    version,
    cookieSecure,
    cookieName: overrides.cookieName ?? 'feedlantern_session',
    sessionTtlMs: overrides.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000,
    allowedHosts,
    trustedProxies: overrides.trustedProxies ?? (process.env.TRUSTED_PROXIES ?? '').split(',').map(s => s.trim()).filter(Boolean),
    browserExecutablePath: overrides.browserExecutablePath ?? process.env.BROWSER_EXECUTABLE_PATH,
    distDir,
    viteOrigins,
  };
}

/** Ensure the private application data directory exists with owner-only permissions. */
export async function ensureDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // mkdir's mode is affected by the process umask and does not change an existing directory.
  await chmod(dataDir, 0o700);
}

export function hasDist(distDir: string): boolean {
  return existsSync(resolve(distDir, 'index.html'));
}

export function isAllowedOrigin(origin: string | undefined, config: ServerConfig): boolean {
  if (!origin) return true;
  return origin === config.publicOrigin || config.viteOrigins.includes(origin);
}
