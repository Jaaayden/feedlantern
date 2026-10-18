<p align="center"><img src="public/favicon.svg" width="96" height="96" alt="FeedLantern 订阅灯"></p>

# FeedLantern · 订阅灯

[![CI](https://github.com/Jaaayden/feedlantern/actions/workflows/ci.yml/badge.svg)](https://github.com/Jaaayden/feedlantern/actions/workflows/ci.yml)

**把任意网页变成你的 RSS 订阅。** 自托管、可视化，数据留在自己的服务器上。

输入网址，自动识别文章列表；识别不准就在页面上点选调整。保存后由后台定时更新，生成一个标准 RSS 地址，交给任意阅读器订阅。

## 特性

- **网页转 RSS**：自动匹配标题、链接、图片、摘要与日期；用真实 Chromium 渲染，支持动态页面、滚动加载和 Cookie 登录态。
- **可视化调整**：识别不理想时直接点选页面内容或编辑 CSS 选择器，预览结果与后台抓取使用同一套规则。
- **RSS 翻译**：把已有的 RSS/Atom 订阅翻译成简体中文或双语订阅（Google 免费通道，实验性，带缓存与失败重试）。
- **批量管理**：一次添加最多 100 个网址；批量暂停、恢复、刷新、删除，统一修改刷新间隔和输出模式。
- **多用户**：管理员创建账号，每人独立管理自己的订阅、Cookie 和个人 Bark 通知；管理员可进入任意账号的工作台。
- **可观测**：每个订阅有抓取日志（默认保留 30 天），连续失败可通过 Bark 告警并自动去重。
- **安全默认值**：Cookie 加密保存；RSS 地址带独立密钥，可随时轮换；默认拦截内网、回环和云元数据地址；Chromium 沙箱始终开启。
- **备份与迁移**：加密完整备份、跨服务器恢复，以及只含订阅规则的轻量配置导入导出。
- **体积可控**：日志、事件、缓存都有上限，数据库体积保持稳定。

## 快速开始

需要 Linux（amd64 或 arm64）、[Docker Engine](https://docs.docker.com/engine/install/) 和 [Compose 插件](https://docs.docker.com/compose/install/linux/)，建议预留 2 GB 内存。新建目录，下载两个配置文件并启动：

```sh
mkdir feedlantern
cd feedlantern
curl -fLO https://raw.githubusercontent.com/Jaaayden/feedlantern/main/docker-compose.yml -fLO https://raw.githubusercontent.com/Jaaayden/feedlantern/main/seccomp_profile.json
docker compose up -d --wait
docker compose logs feedlantern
```

打开 [http://127.0.0.1:4321](http://127.0.0.1:4321)，用日志中的一次性设置码创建管理员。系统没有默认账号和密码。

`seccomp_profile.json` 用来保留 Chromium 沙箱，请勿删除或改用特权模式。数据保存在 Docker 命名卷中，`docker compose down` 不会删除它。

## 升级

在部署目录执行，数据卷和配置保持不变：

```sh
docker compose pull feedlantern
docker compose up -d --wait feedlantern
```

升级前建议在网页「设置 → 备份与迁移」导出一份加密备份。注意事项和回退方法见[升级维护](doc/maintenance.md)。

## 部署到公网

默认只监听本机回环地址。要用域名访问，在宿主机用 Nginx 反向代理并启用 HTTPS，见 [Nginx 配置指南](doc/nginx.md)。有反向代理时，务必在「设置 → 服务器与网络」里把代理地址填入「可信反向代理」，否则登录限速会把所有人当成同一个来源，见[配置参考](doc/configuration.md)。

## 工作原理

```text
网址 ──> Chromium 渲染 ──> 识别重复列表 ──> 保存匹配规则
                                              │
        阅读器 <── /feeds/<id>/<密钥>.xml <── SQLite <── 定时抓取并提取条目
```

React + Vite 前端，Fastify API，SQLite 存储，Playwright 驱动 Chromium。预览、批量识别和后台刷新共用同一套提取逻辑，所以所见即所得。

## 适用范围

支持普通 DOM 列表、动态渲染页面和需要 Cookie 的页面。目前不支持：全文抓取、自动翻页、无限滚动的完整采集、iframe 内部点选、封闭 Shadow DOM、Canvas 内容，以及交互式登录和验证码。服务主机需要持续运行，定时更新才会继续。详见[使用指南](doc/user-guide.md#兼容范围)。

## 文档

| 想做什么 | 看这里 |
| --- | --- |
| 部署、HTTPS、配置 | [部署步骤](doc/deployment.md) · [Nginx](doc/nginx.md) · [配置参考](doc/configuration.md) |
| 日常使用 | [使用指南](doc/user-guide.md) |
| 备份、迁移、升级、数据库体积 | [备份与迁移](doc/backup-and-migration.md) · [升级维护](doc/maintenance.md) |
| 出问题了 | [故障排查](doc/troubleshooting.md) |
| 参与开发 | [开发与接口](doc/development.md) · [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md) |

完整目录见[文档索引](doc/README.md)，版本变化见 [CHANGELOG](CHANGELOG.md)。

## 本地开发

需要 Node.js 24 和 pnpm：

```sh
pnpm install --frozen-lockfile
pnpm browser:install
pnpm dev
```

## 许可

[MIT](LICENSE)。
