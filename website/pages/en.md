---
layout: home
title: Turn your sources into a reading list
hero:
  name: FeedLantern
  text: Your sources. One reading list.
  tagline: Follow web pages, RSS feeds and new PubMed papers. Collect, translate and organize updates on your own server, then read them in the app you love.
  image:
    src: /favicon.svg
    alt: FeedLantern
  actions:
    - theme: brand
      text: Get started
      link: /en/guide/deployment
    - theme: alt
      text: Read the guide
      link: /en/guide/user-guide
    - theme: alt
      text: GitHub
      link: https://github.com/Jaaayden/feedlantern
features:
  - title: Give web pages a feed
    details: Detect article titles, links, summaries, images and dates. Collect dynamic pages, paginated lists and pages that need a saved cookie.
    link: /en/guide/user-guide
    linkText: Create your first feed
  - title: Adjust it visually
    details: Click the content you want or edit its CSS selectors. Preview and scheduled fetching use the same extraction rules.
    link: /en/guide/user-guide
    linkText: Explore the editor
  - title: Follow new PubMed papers
    details: Combine authors, affiliations, journals and keywords. Preview searches, subscribe to new papers, or verify and convert existing PubMed RSS feeds.
    link: /en/guide/user-guide
    linkText: Build a literature feed
  - title: Read in your language
    details: Keep the original, translate it, or show both. Use DeepL, an OpenAI-compatible API, or the experimental free Google channel.
    link: /en/guide/user-guide
    linkText: Choose a translation service
  - title: Use your favorite reader
    details: Export RSS, Atom or JSON Feed. Filter by keywords and combine several sources into one bundle.
    link: /en/guide/user-guide
    linkText: Organize your feeds
  - title: Keep your data yours
    details: Open source and self-hosted, with separate user workspaces, encrypted backups, logs, alerts and CLI / MCP automation.
    link: /guide/agent
    linkText: CLI & MCP guide · 中文
---

## From a source to your reader

<div class="home-steps">
  <div><span class="number">01 / ADD A SOURCE</span><h3>Choose what you care about</h3><p>Paste a web page or RSS address, or build a PubMed search.</p></div>
  <div><span class="number">02 / CHECK THE PREVIEW</span><h3>Make sure the right content is there</h3><p>Review titles and links, then choose your rules, translation and refresh interval.</p></div>
  <div><span class="number">03 / SUBSCRIBE</span><h3>Let updates come to your reader</h3><p>Copy your feed address. The server keeps it fresh while you read at your own pace.</p></div>
</div>

## Start on your own server

Use Linux, Docker Engine and the Compose plugin, with about 2 GB of memory. In an empty directory:

```sh
mkdir feedlantern && cd feedlantern
curl -fLO https://raw.githubusercontent.com/Jaaayden/feedlantern/main/docker-compose.yml -fLO https://raw.githubusercontent.com/Jaaayden/feedlantern/main/seccomp_profile.json
docker compose up -d --wait
docker compose logs feedlantern
```

Open [http://127.0.0.1:4321](http://127.0.0.1:4321) and use the one-time setup code from the log to create an administrator. There is no default account or password. Keep `seccomp_profile.json`: it allows Chromium to run with its sandbox enabled.

[Full installation guide →](/en/guide/deployment) · [Configuration reference](/en/guide/configuration) · [All documentation · 中文](/guide/)

This is the project's introduction and documentation site. The feed service runs on your own server and must stay online for scheduled updates. It works with ordinary article lists; interactive logins and CAPTCHA solving are outside its scope. See the [user guide](/en/guide/user-guide).
