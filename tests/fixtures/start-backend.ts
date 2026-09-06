import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';

const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error('DATA_DIR is required for the e2e backend');

await rm(dataDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

const child = spawn('pnpm', ['start'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

const forward = (signal: NodeJS.Signals): void => {
  if (!child.killed) child.kill(signal);
};
process.once('SIGTERM', () => forward('SIGTERM'));
process.once('SIGINT', () => forward('SIGINT'));

child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
