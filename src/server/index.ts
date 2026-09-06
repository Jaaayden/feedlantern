import { createApp } from './app.js';
import { getConfig } from './config.js';

const config = getConfig();
const app = await createApp({ config });

try {
  await app.listen({ host: config.host, port: config.port });
  process.stdout.write(`FeedLantern 已启动：http://${config.host}:${config.port}\n`);
} catch (error) {
  process.stderr.write(`FeedLantern 启动失败：${error instanceof Error ? error.message : '未知错误'}\n`);
  await app.close().catch(() => undefined);
  process.exitCode = 1;
}

const shutdown = async (): Promise<void> => {
  await app.close().catch(() => undefined);
};
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
