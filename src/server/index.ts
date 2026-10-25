import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { getConfig } from './config.js';

const config = getConfig();
const app = await createApp({ config });

try {
  await app.listen({ host: config.host, port: config.port });
  process.stdout.write(`FeedLantern is running at http://${config.host}:${config.port}\n`);
  const setupPath = join(config.dataDir, 'setup-token');
  if (existsSync(setupPath)) process.stdout.write(`First-run setup code: ${readFileSync(setupPath, 'utf8').trim()}\nEnter it on the setup page; it expires once the administrator account is created.\n`);
} catch (error) {
  process.stderr.write(`FeedLantern failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  await app.close().catch(() => undefined);
  process.exitCode = 1;
}

const shutdown = async (): Promise<void> => {
  await app.close().catch(() => undefined);
};
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
