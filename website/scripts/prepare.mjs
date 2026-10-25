import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(site, '..');
const content = join(site, '.content');
// .content is generated, ignored by Git, and never an authoring directory.
rmSync(content, { recursive: true, force: true });
mkdirSync(content, { recursive: true });
const sources = {};
function copy(source, target) {
  const destination = join(content, target);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(repo, source), destination);
  sources[target] = source;
}
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
}
for (const path of walk(join(repo, 'doc')).filter(path => path.endsWith('.md'))) {
  const source = relative(repo, path).replaceAll('\\', '/');
  let target = source.startsWith('doc/en/') ? source.replace('doc/en/', 'en/guide/') : source.replace('doc/', 'guide/');
  if (target === 'guide/README.md') target = 'guide/index.md';
  copy(source, target);
}
copy('CHANGELOG.md', 'changelog.md');
copy('website/pages/index.md', 'index.md');
copy('website/pages/en.md', 'en/index.md');
mkdirSync(join(content, 'public'), { recursive: true });
cpSync(join(repo, 'public/favicon.svg'), join(content, 'public/favicon.svg'));
writeFileSync(join(content, 'public/.nojekyll'), '');
writeFileSync(join(site, '.sources.json'), JSON.stringify(sources, null, 2) + '\n');
console.log(`Prepared ${Object.keys(sources).length} pages from repository Markdown.`);
