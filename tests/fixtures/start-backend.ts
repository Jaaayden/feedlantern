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
// DeepL's endpoints are fixed in production; tests point them at the fixture server.
const fixture = process.env.FIXTURE_ORIGIN;
const deeplEndpoints = fixture ? { free: `${fixture}/deepl/free/v2/translate`, pro: `${fixture}/deepl/pro/v2/translate` } : undefined;
// So are NCBI E-utilities, for PubMed journal subscriptions.
const ncbiEndpoint = fixture ? `${fixture}/entrez/eutils` : undefined;
// The PubMed conversion check reads pubmed.ncbi.nlm.nih.gov/rss/… from the fixture server instead.
const pubmedRssBase = fixture ? `${fixture}/pubmed-rss` : undefined;
const app = await createApp({ config, ncbiEndpoint, pubmedRssBase, barkSender: async () => {}, notificationSenders: { webhook: async () => {}, ntfy: async () => {}, telegram: async () => {} }, translator: async text => `中文：${text}`, translationIntervalMs: 0, deeplEndpoints });
await app.listen({ host: config.host, port: config.port });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  void app.close().finally(() => process.exit(0));
});
