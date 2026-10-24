import { googleTranslateBatch } from '../src/server/rss-translation.js';
const texts = ['Hello world.', 'This feed contains new articles.', 'Use <code> as literal text & preserve symbols.'];
const started = performance.now();
try {
  const translated = await googleTranslateBatch(texts, AbortSignal.timeout(20_000));
  if (translated.length !== texts.length) throw Error('The batch returned the wrong number of translations');
  console.log(`Google browser translation works: ${translated.length} segments in ${Math.round(performance.now() - started)} ms`);
  translated.forEach((text, index) => console.log(`${index + 1}. ${text}`));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not reach Google browser translation');
  process.exitCode = 1;
}
