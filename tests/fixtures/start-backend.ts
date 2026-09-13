import { mkdir, rm } from 'node:fs/promises';
import { createApp } from '../../src/server/app.js';
import { getConfig } from '../../src/server/config.js';

const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error('DATA_DIR is required for the e2e backend');
await rm(dataDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

// Translation and push providers are deterministic; browser capture and RSS HTTP
// fetches exercise the real production paths against the local fixture server.
const config = getConfig();
const app = await createApp({ config, barkSender: async () => {}, translator: async text => `中文：${text}`, translationIntervalMs: 0 });
await app.listen({ host: config.host, port: config.port });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  void app.close().finally(() => process.exit(0));
});
