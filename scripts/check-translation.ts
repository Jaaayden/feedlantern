import { googleTranslateBatch } from '../src/server/rss-translation.js';
const texts = ['Hello world.', 'This feed contains new articles.', 'Use <code> as literal text & preserve symbols.'];
const started = performance.now();
try {
  const translated = await googleTranslateBatch(texts, AbortSignal.timeout(20_000));
  if (translated.length !== texts.length) throw Error('批量译文数量不匹配');
  console.log(`Google 浏览器批量翻译连接成功：${translated.length} 段，${Math.round(performance.now() - started)} 毫秒`);
  translated.forEach((text, index) => console.log(`${index + 1}. ${text}`));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Google 浏览器翻译连接失败');
  process.exitCode = 1;
}
