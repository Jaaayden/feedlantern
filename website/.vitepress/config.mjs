import { defineConfig } from 'vitepress';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(site, '..');
const sources = JSON.parse(readFileSync(resolve(site, '.sources.json'), 'utf8'));
const targets = Object.fromEntries(Object.entries(sources).map(([target, source]) => [source, target]));
targets['README.md'] = 'en/index.md';
targets['README.zh-CN.md'] = 'index.md';
const version = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')).version;
const github = 'https://github.com/Jaaayden/feedlantern';

const zhSidebar = [
  { text: '开始使用', items: [
    { text: '文档总览', link: '/guide/' },
    { text: '安装与部署', link: '/guide/deployment' },
    { text: '使用指南', link: '/guide/user-guide' },
    { text: 'Agent CLI 与 MCP', link: '/guide/agent' }
  ] },
  { text: '配置与维护', items: [
    { text: '配置参考', link: '/guide/configuration' },
    { text: 'Nginx 与 HTTPS', link: '/guide/nginx' },
    { text: '备份与迁移', link: '/guide/backup-and-migration' },
    { text: '升级与维护', link: '/guide/maintenance' },
    { text: '故障排查', link: '/guide/troubleshooting' }
  ] },
  { text: '参与开发', collapsed: true, items: [
    { text: '开发与 API', link: '/guide/development' },
    { text: '性能验证', link: '/guide/performance' },
    { text: '验收记录', link: '/guide/acceptance' },
    { text: '更新日志', link: '/changelog' }
  ] }
];
const enSidebar = [
  { text: 'Get started', items: [
    { text: 'Overview', link: '/en/' },
    { text: 'Installation', link: '/en/guide/deployment' },
    { text: 'User guide', link: '/en/guide/user-guide' },
    { text: 'Configuration', link: '/en/guide/configuration' }
  ] },
  { text: 'More documentation · 中文', items: [
    { text: 'CLI & MCP (Chinese)', link: '/guide/agent' },
    { text: 'Nginx & HTTPS (Chinese)', link: '/guide/nginx' },
    { text: 'Backup & migration (Chinese)', link: '/guide/backup-and-migration' },
    { text: 'Maintenance (Chinese)', link: '/guide/maintenance' },
    { text: 'Troubleshooting (Chinese)', link: '/guide/troubleshooting' },
    { text: 'Development & API (Chinese)', link: '/guide/development' },
    { text: 'Changelog (Chinese)', link: '/changelog' }
  ] }
];

export default defineConfig({
  title: 'FeedLantern',
  description: '把网页、RSS 与 PubMed 新文献变成你自己的订阅。开源、自托管的可视化 RSS 工具。',
  base: '/feedlantern/',
  srcDir: '.content',
  cleanUrls: false,
  transformPageData(data) { data.frontmatter.sourcePath = sources[data.relativePath]; },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/feedlantern/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#1e392f' }]
  ],
  sitemap: { hostname: 'https://jaaayden.github.io/feedlantern/' },
  locales: {
    root: {
      label: '简体中文', lang: 'zh-CN',
      themeConfig: {
        nav: [{ text: '指南', link: '/guide/' }, { text: '更新日志', link: '/changelog' }, { text: `v${version}`, link: `${github}/releases/latest` }],
        sidebar: zhSidebar,
        outline: { label: '本页内容', level: [2, 3] },
        docFooter: { prev: '上一页', next: '下一页' },
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '目录',
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换到浅色模式',
        darkModeSwitchTitle: '切换到深色模式',
        langMenuLabel: '语言',
        skipToContentLabel: '跳转到内容',
        editLink: { text: '在 GitHub 上编辑此页', pattern: data => 'https://github.com/Jaaayden/feedlantern/edit/main/' + data.frontmatter.sourcePath },
        footer: { message: '基于 MIT 许可证开源 · 在自己的服务器上部署', copyright: 'FeedLantern · 订阅灯' }
      }
    },
    en: {
      label: 'English', lang: 'en',
      description: 'Turn web pages, RSS feeds and new PubMed papers into your own reading list. Open source, visual and self-hosted.',
      themeConfig: {
        nav: [{ text: 'Guide', link: '/en/guide/deployment' }, { text: 'Changelog · 中文', link: '/changelog' }, { text: `v${version}`, link: `${github}/releases/latest` }],
        sidebar: enSidebar,
        outline: { level: [2, 3] },
        editLink: { text: 'Edit this page on GitHub', pattern: data => 'https://github.com/Jaaayden/feedlantern/edit/main/' + data.frontmatter.sourcePath },
        footer: { message: 'Released under the MIT License · Hosted on your own server', copyright: 'FeedLantern' }
      }
    }
  },
  themeConfig: {
    logo: '/favicon.svg',
    i18nRouting: false,
    siteTitle: 'FeedLantern',
    socialLinks: [{ icon: 'github', link: github }],
    search: {
      provider: 'local',
      options: {
        locales: {
          root: { translations: {
            button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
            modal: { noResultsText: '没有找到相关内容', resetButtonTitle: '清除搜索', footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' } }
          } }
        }
      }
    }
  },
  markdown: {
    config(md) {
      // Resolve links against the original file, before VitePress applies its
      // base URL and checks routes. Markdown code blocks are left untouched.
      md.core.ruler.after('inline', 'repository-links', state => {
        const source = sources[state.env.relativePath];
        if (!source) return;
        for (const token of state.tokens) {
          for (const child of token.children ?? []) {
            if (child.type !== 'link_open') continue;
            const href = child.attrGet('href');
            if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(href)) continue;
            const match = /^([^?#]+)(.*)$/.exec(href);
            if (!match) continue;
            const original = posix.normalize(posix.join(posix.dirname(source), decodeURI(match[1])));
            if (targets[original]) {
              const destination = targets[original].replace(/\.md$/, '.html').replace(/(^|\/)index\.html$/, '$1');
              child.attrSet('href', '/' + destination + match[2]);
            } else if (existsSync(resolve(repo, original))) {
              const host = original.endsWith('.md') ? github + '/blob/main/' : 'https://raw.githubusercontent.com/Jaaayden/feedlantern/main/';
              child.attrSet('href', host + original + match[2]);
            }
          }
        }
      });
    }
  }
});
