# FeedLantern · 订阅灯

可自托管的网页版「网页 → RSS」服务。输入网址，自动识别内容；需要时可视化调整，然后交给后台持续更新。

- 单管理员登录，独立 RSS 订阅密钥，Cookie 加密保存。
- 自动匹配标题、链接、图片、摘要与日期，支持动态页面。
- 列表/卡片视图、批量创建与管理、统一的订阅名称。
- 加密备份与跨服务器恢复，轻量配置导入导出。

## Docker Compose 部署

先安装 [Docker Engine](https://docs.docker.com/engine/install/) 和 [Compose](https://docs.docker.com/compose/install/linux/)，然后新建目录、下载配置并启动：

```sh
mkdir feedlantern
cd feedlantern
curl -fLO https://raw.githubusercontent.com/Jaaayden/feedlantern/v0.2.1/docker-compose.yml -fLO https://raw.githubusercontent.com/Jaaayden/feedlantern/v0.2.1/seccomp_profile.json
docker compose up -d --wait
docker compose logs feedlantern
```

打开 **http://127.0.0.1:4321**，用日志中的一次性设置码创建管理员。没有默认账号密码。下载的两个文件分别是 Compose 配置和 Chromium 沙箱规则；数据自动保存在 Docker 卷中。

远程服务器、固定版本部署及 HTTPS 域名访问，见[部署步骤](doc/deployment.md)和 [Nginx 配置指南](doc/nginx.md)。

## 文档

[文档目录](doc/README.md) · [使用指南](doc/user-guide.md) · [配置参考](doc/configuration.md) · [备份迁移](doc/backup-and-migration.md) · [升级维护](doc/maintenance.md) · [故障排查](doc/troubleshooting.md)

本地开发使用 Node.js 24 和 pnpm，见[开发文档](doc/development.md)。变更记录见 [CHANGELOG](CHANGELOG.md)。

MIT 开源；不包含收费或多用户体系。服务主机需要持续运行。普通 DOM 列表以外的兼容范围见使用指南。
