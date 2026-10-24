import { getConfig } from './config.js';
import { Store } from './store.js';
import { StringDecoder } from 'node:string_decoder';
import { formatList, negotiateLocale, translator } from '../shared/i18n.js';

// An interactive operator command: it speaks the shell's language (LANG=zh_CN.UTF-8 gives Simplified Chinese).
const locale = negotiateLocale((process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '').split('.')[0].replace('_', '-'));
const t = translator(locale);

let pipedInput: Promise<string[]> | undefined;

async function promptLine(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !input.setRawMode) {
    output.write(prompt);
    pipedInput ??= (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of input) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
    })();
    const lines = await pipedInput;
    return lines.shift() ?? '';
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const decoder = new StringDecoder('utf8');
    const onData = (chunk: Buffer): void => {
      for (const character of decoder.write(chunk)) {
        const code = character.codePointAt(0)!;
        if (code === 3) { output.write('\n'); cleanup(); reject(new Error(t('cli.canceled'))); return; }
        if (code === 13 || code === 10) { output.write('\n'); cleanup(); resolve(value); return; }
        if (code === 127 || code === 8) { value = Array.from(value).slice(0, -1).join(''); continue; }
        if (code >= 32 && code !== 127) value += character;
      }
    };
    const cleanup = (): void => { input.off('data', onData); input.setRawMode?.(false); input.pause(); };
    input.on('data', onData);
  });
}

if (process.argv.slice(2).length > 0) {
  process.stderr.write(`${t('cli.noArguments')}\n`);
  process.exitCode = 2;
} else {
  const store = new Store(getConfig());
  try {
    const admins = store.listUsers().filter(u => u.role === 'admin');
    let selected = admins[0];
    if (admins.length > 1) {
      process.stdout.write(`${t('cli.admins', { names: formatList(locale, admins.map(u => u.username)) })}\n`);
      const username = await promptLine(t('cli.promptUsername'));
      selected = admins.find(u => u.username === username)!;
      if (!selected) throw new Error(t('cli.noSuchAdmin'));
    }
    const admin = selected;
    if (!admin) throw new Error(t('cli.notSetUp'));
    const current = await promptLine(t('cli.promptCurrent'));
    if (current && !store.authenticate(admin.username, current)) throw new Error(t('cli.currentWrong'));
    const next = await promptLine(t('cli.promptNew'));
    if (next.length < 8 || next.length > 1024) throw new Error(t('cli.newLength'));
    const confirm = await promptLine(t('cli.promptConfirm'));
    if (next !== confirm) throw new Error(t('cli.mismatch'));
    store.changePassword(next, admin.id);
    process.stdout.write(`${t('cli.done')}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : t('cli.failed')}\n`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
