---
layout: home
title: 把网页与新文献，变成订阅
hero:
  name: FeedLantern · 订阅灯
  text: 把网页与新文献，变成订阅。
  tagline: 网站更新、已有 RSS、PubMed 新文献，在自己的服务器上收集、整理与翻译，交给你喜欢的阅读器。
  image:
    src: /favicon.svg
    alt: FeedLantern 订阅灯
  actions:
    - theme: brand
      text: 快速部署
      link: /guide/deployment
    - theme: alt
      text: 阅读使用指南
      link: /guide/user-guide
    - theme: alt
      text: GitHub
      link: https://github.com/Jaaayden/feedlantern
features:
  - title: 网页也能订阅
    details: 输入网址，自动识别标题、链接、摘要、图片和日期。支持动态页面、多页采集与 Cookie 登录态。
    link: /guide/user-guide
    linkText: 从第一个订阅开始
  - title: 可视化调整
    details: 识别不准时，在页面上点选内容或调整 CSS 选择器。先预览，再让后台按同一套规则抓取。
    link: /guide/user-guide
    linkText: 了解识别与编辑
  - title: 追踪 PubMed 新文献
    details: 按作者、机构、期刊和关键词组合检索条件，预览结果、订阅后续文献，也可核对并转换已有 PubMed RSS。
    link: /guide/user-guide#pubmed-订阅
    linkText: 配置文献订阅
  - title: 用熟悉的语言阅读
    details: RSS 和文献支持原文、译文或双语输出。可用 DeepL、OpenAI 兼容接口或实验性的 Google 免费通道。
    link: /guide/user-guide
    linkText: 了解翻译选项
  - title: 交给任意阅读器
    details: 输出 RSS、Atom 和 JSON Feed；用关键词过滤内容，把多个来源合并为一个聚合订阅。
    link: /guide/user-guide
    linkText: 整理你的阅读入口
  - title: 数据由你掌握
    details: 开源、自托管、多用户隔离，提供加密备份、抓取日志、失败通知，以及 CLI / MCP 自动化接口。
    link: /guide/agent
    linkText: 接入脚本与 AI Agent
---

## 从网址到阅读器，只需三步

<div class="home-steps">
  <div><span class="number">01 / 添加来源</span><h3>选择你关心的内容</h3><p>粘贴网页或 RSS 地址，或者填写一组 PubMed 检索条件。</p></div>
  <div><span class="number">02 / 核对预览</span><h3>确认抓到的就是你想读的</h3><p>检查标题、链接和条目，按需要调整规则、翻译和刷新间隔。</p></div>
  <div><span class="number">03 / 开始订阅</span><h3>让更新出现在阅读器里</h3><p>复制生成的订阅地址。后台定时更新，你按自己的节奏阅读。</p></div>
</div>

## 在自己的服务器上开始

准备 Linux、Docker Engine 和 Compose 插件，建议至少 2 GB 内存。在空目录中运行：

```sh
mkdir feedlantern && cd feedlantern
curl -fLO https://raw.githubusercontent.com/Jaaayden/feedlantern/main/docker-compose.yml -fLO https://raw.githubusercontent.com/Jaaayden/feedlantern/main/seccomp_profile.json
docker compose up -d --wait
docker compose logs feedlantern
```

打开 [http://127.0.0.1:4321](http://127.0.0.1:4321)，用日志中的一次性初始化码创建管理员。没有默认账号或密码；`seccomp_profile.json` 用于保持 Chromium 沙箱，请保留。

[完整部署步骤 →](/guide/deployment) · [Nginx 与 HTTPS](/guide/nginx) · [升级与备份](/guide/maintenance)

这是项目介绍与文档站。订阅服务需要独立部署并持续运行；它适用于有文章列表的普通网页，不负责绕过验证码或完成交互式登录。详见[支持范围](/guide/user-guide)。
