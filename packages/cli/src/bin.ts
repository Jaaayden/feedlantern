#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { run, type Io } from './cli.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Reads one line from the terminal without echoing it. */
function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  let muted = false;
  (rl as unknown as { _writeToOutput(text: string): void })._writeToOutput = text => { if (!muted) process.stderr.write(text); };
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); process.stderr.write('\n'); resolve(answer); });
    muted = true;
  });
}

const io: Io = {
  stdout: text => { process.stdout.write(`${text}\n`); },
  stderr: text => { process.stderr.write(`${text}\n`); },
  env: process.env,
  readStdin,
  ...(process.stdin.isTTY ? { promptSecret } : {}),
  serveMcp: async options => (await import('./mcp.js')).serveStdio(options),
};

process.exitCode = await run(process.argv.slice(2), io);
