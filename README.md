# FeedLantern · 订阅灯

可自托管的网页版「网页 → RSS」服务。输入网址，自动识别内容；需要时可视化调整，然后交给后台持续更新。

- 完整用户管理与多管理员；每人独立管理订阅、个人 Bark 通知与 Cookie，管理员可进入目标用户工作台，RSS 使用独立密钥，Cookie 加密保存。
- 自动匹配标题、链接、图片、摘要与日期，支持动态页面。
- 列表/卡片视图、批量创建与管理、统一的订阅名称。
- 加密备份与跨服务器恢复，轻量配置导入导出。
- 输入 RSS/Atom，后台翻译成简体中文或双语订阅；Google 免费通道为实验性，支持缓存与失败重试。
- 每个订阅默认保留 30 天抓取日志，支持 Bark 故障告警与连续失败去重，按订阅所有者独立配置，随备份迁移。

## Docker Compose 部署

先安装 [Docker Engine](https://docs.docker.com/engine/install/) 和 [Compose](https://docs.docker.com/compose/install/linux/)，然后新建目录、下载配置并启动：

```sh
mkdir feedlantern
cd feedlantern
curl -fLO https://raw.githubusercontent.com/Jaaayden/feedlantern/main/docker-compose.yml -fLO https://raw.githubusercontent.com/Jaaayden/feedlantern/main/seccomp_profile.json
docker compose up -d --wait
docker compose logs feedlantern
```

在浏览器中打开 [FeedLantern 本机页面](http://127.0.0.1:4321)，使用日志中的一次性设置码创建管理员。系统没有默认账号和密码。

上述命令下载了 `docker-compose.yml`（Compose 配置）和 `seccomp_profile.json`（Chromium 沙箱规则）。应用数据自动保存在 Docker 卷中。

远程服务器及 HTTPS 域名访问，见[部署步骤](doc/deployment.md)和 [Nginx 配置指南](doc/nginx.md)。

## Docker 更新

默认使用 `latest`，由 `main` 分支通过全部 CI 和双架构容器验证后发布。在原部署目录执行：

```sh
docker compose pull feedlantern
docker compose up -d --wait feedlantern
```

首次从旧版切换时，将 Compose 的 `image` 改为 `ghcr.io/jaaayden/feedlantern:latest`；保留现有端口、环境配置和数据卷。如果继续使用 `FEEDLANTERN_VERSION` 变量，将其设为 `latest`。无需每次下载配置，运行中的容器也不会自行升级。完整步骤见[升级维护](doc/maintenance.md)。

## 文档

[文档目录](doc/README.md) · [使用指南](doc/user-guide.md) · [配置参考](doc/configuration.md) · [备份迁移](doc/backup-and-migration.md) · [升级维护](doc/maintenance.md) · [故障排查](doc/troubleshooting.md)

本地开发使用 Node.js 24 和 pnpm，见[开发文档](doc/development.md)。变更记录见 [CHANGELOG](CHANGELOG.md)。

MIT 开源；不包含收费或多用户体系。服务主机需要持续运行。普通 DOM 列表以外的兼容范围见使用指南。
