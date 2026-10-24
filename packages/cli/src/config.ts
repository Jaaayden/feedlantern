import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FeedLanternError } from './errors.js';
import { t } from './messages.js';

/** One saved instance: its address and a personal access token. */
export interface Profile { url?: string; token?: string }
export interface ConfigFile { defaultProfile?: string; profiles: Record<string, Profile> }

export type Env = Record<string, string | undefined>;

export const DEFAULT_PROFILE = 'default';

/**
 * `FEEDLANTERN_CONFIG`, else `$XDG_CONFIG_HOME/feedlantern/config.json`,
 * `%APPDATA%\feedlantern\config.json` on Windows, or `~/.config/feedlantern/config.json`.
 */
export function configPath(env: Env, platform = process.platform): string {
  if (env.FEEDLANTERN_CONFIG) return env.FEEDLANTERN_CONFIG;
  const base = env.XDG_CONFIG_HOME || (platform === 'win32' && env.APPDATA) || join(env.HOME || homedir(), '.config');
  return join(base, 'feedlantern', 'config.json');
}

export async function readConfig(path: string, warn?: (message: string) => void): Promise<ConfigFile> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: {} };
    throw new FeedLanternError({ code: 'not_configured', status: 0, message: t('config.unreadable', { path, message: (error as Error).message }) });
  }
  if (warn && process.platform !== 'win32') {
    try { if ((await stat(path)).mode & 0o077) warn(t('config.loosePermissions', { path })); } catch { /* checked best effort */ }
  }
  try {
    const parsed = JSON.parse(text) as Partial<ConfigFile>;
    const profiles = parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {};
    return { ...(typeof parsed.defaultProfile === 'string' ? { defaultProfile: parsed.defaultProfile } : {}), profiles };
  } catch {
    throw new FeedLanternError({ code: 'not_configured', status: 0, message: t('config.invalid', { path }) });
  }
}

/** Written atomically and readable by the owner only (0600, directory 0700). */
export async function writeConfig(path: string, config: ConfigFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export interface Connection {
  url: string;
  token?: string;
  profile: string;
  /** Where each value came from, for `feedlantern config`. */
  sources: { url: 'flag' | 'env' | 'config' | 'none'; token: 'env' | 'config' | 'none' };
  configPath: string;
}

/** Flags beat environment variables, which beat the config file. */
export async function resolveConnection(options: { url?: string; profile?: string }, env: Env, warn?: (message: string) => void): Promise<Connection> {
  const path = configPath(env);
  const file = await readConfig(path, warn);
  const profile = options.profile || env.FEEDLANTERN_PROFILE || file.defaultProfile || DEFAULT_PROFILE;
  const saved = file.profiles[profile] ?? {};
  const url = options.url || env.FEEDLANTERN_URL || saved.url || '';
  const token = env.FEEDLANTERN_TOKEN || saved.token || undefined;
  return {
    url: url.replace(/\/+$/, ''), token, profile, configPath: path,
    sources: {
      url: options.url ? 'flag' : env.FEEDLANTERN_URL ? 'env' : saved.url ? 'config' : 'none',
      token: env.FEEDLANTERN_TOKEN ? 'env' : saved.token ? 'config' : 'none',
    },
  };
}

/** `fl_Ab12Cd34…` — enough to tell tokens apart, never the secret. */
export function maskToken(token: string | undefined): string | null {
  return token ? `${token.slice(0, 11)}…` : null;
}
