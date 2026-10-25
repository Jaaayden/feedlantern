import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../.vitepress/dist');
const origin = 'https://jaaayden.github.io';
const base = '/feedlantern/';
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
}
function decode(text) {
  return text.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}
const pages = walk(dist).filter(path => path.endsWith('.html'));
const ids = new Map();
for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  ids.set(page, new Set([...html.matchAll(/\bid="([^"]*)"/g)].map(match => decode(match[1]))));
}
const problems = [];
let checked = 0;
for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  const current = new URL(base + page.slice(dist.length + 1), origin);
  assert.match(html, /<html[^>]+lang="(?:zh-CN|en)"/, page + ': missing document language');
  for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const href = decode(match[1]);
    if (/^(?:data:|javascript:|mailto:|tel:)/i.test(href)) continue;
    const url = new URL(href, current);
    if (url.origin !== origin) continue;
    if (!url.pathname.startsWith(base)) {
      problems.push(`${current.pathname}: link escapes the Pages base: ${href}`);
      continue;
    }
    let target = join(dist, decodeURIComponent(url.pathname.slice(base.length)));
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
    else if (!existsSync(target) && !target.endsWith('.html')) target += '.html';
    if (!existsSync(target)) {
      problems.push(`${current.pathname}: missing ${href}`);
      continue;
    }
    if (url.hash && target.endsWith('.html') && !ids.get(target)?.has(decodeURIComponent(url.hash.slice(1)))) {
      problems.push(`${current.pathname}: missing anchor ${href}`);
    }
    checked++;
  }
}
assert.equal(problems.length, 0, problems.slice(0, 40).join('\n'));
console.log(`Validated ${pages.length} HTML pages and ${checked} local links/assets, including anchors and the Pages base path.`);
