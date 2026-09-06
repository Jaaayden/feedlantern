# FeedLantern · 订阅灯

可自托管的网页版「网页 → RSS」服务。输入网址，自动识别内容；需要时可视化调整，然后交给后台持续更新。

- 单管理员登录，独立 RSS 订阅密钥，Cookie 加密保存。
- 自动匹配标题、链接、图片、摘要与日期，支持动态页面。
- 列表/卡片视图、批量创建与管理、自定义阅读器频道名称。
- 加密备份与跨服务器恢复，轻量配置导入导出。

## 快速开始

先安装 [Docker Engine](https://docs.docker.com/engine/install/) 和 [Compose](https://docs.docker.com/compose/install/linux/)。正式镜像随版本 Release 发布；尚未发布的开发版本请使用[源码构建](doc/deployment.md#源码构建)。

```sh
curl -fsSL https://raw.githubusercontent.com/Jaaayden/feedlantern/v0.2.0/scripts/install.sh | sh
cd feedlantern
docker compose exec feedlantern cat /app/data/setup-token
```

打开 **http://127.0.0.1:4321**，输入一次性设置码并创建管理员。默认没有账号密码，也不开放注册。

远程服务器及 HTTPS 域名访问，请按[部署步骤](doc/deployment.md)和 [Nginx 配置指南](doc/nginx.md)操作。

## 文档

[文档目录](doc/README.md) · [使用指南](doc/user-guide.md) · [配置参考](doc/configuration.md) · [备份迁移](doc/backup-and-migration.md) · [升级维护](doc/maintenance.md) · [故障排查](doc/troubleshooting.md)

本地开发使用 Node.js 24 和 pnpm，见[开发文档](doc/development.md)。变更记录见 [CHANGELOG](CHANGELOG.md)。

MIT 开源；不包含收费或多用户体系。服务主机需要持续运行。普通 DOM 列表以外的兼容范围见使用指南。
