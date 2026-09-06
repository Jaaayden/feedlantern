import { getConfig } from './config.js';
import { Store, verifyPassword } from './store.js';
import { StringDecoder } from 'node:string_decoder';

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
        if (code === 3) { output.write('\n'); cleanup(); reject(new Error('已取消')); return; }
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
  process.stderr.write('为避免密码出现在 shell 历史中，此命令不接受命令行参数；请仅通过 stdin 输入。\n');
  process.exitCode = 2;
} else {
  const store = new Store(getConfig());
  try {
    const admin = store.getAdmin();
    if (!admin) throw new Error('尚未完成初始化，请先运行服务并使用 setup-token 初始化。');
    const current = await promptLine('当前密码（可留空以强制重置）：');
    if (current && !verifyPassword(current, admin.passwordHash)) throw new Error('当前密码错误。');
    const next = await promptLine('新密码：');
    if (next.length < 8 || next.length > 1024) throw new Error('新密码长度必须为 8 到 1024 个字符。');
    const confirm = await promptLine('再次输入新密码：');
    if (next !== confirm) throw new Error('两次输入的密码不一致。');
    store.changePassword(next);
    process.stdout.write('密码已重置，现有登录会话已全部撤销。\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : '密码重置失败'}\n`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
