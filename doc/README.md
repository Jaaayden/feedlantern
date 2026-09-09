# FeedLantern 文档

## 安装与部署

1. [部署步骤](deployment.md)：环境准备、快速安装、手动部署、首次初始化和验证。
2. [Nginx 与 HTTPS](nginx.md)：域名、证书、完整反向代理示例。
3. [配置参考](configuration.md)：环境变量、存储和网络边界。

## 使用与维护

- [使用指南](user-guide.md)：识别、编辑、批量操作、Cookie 和 RSS 名称。
- [备份与迁移](backup-and-migration.md)：完整恢复和轻量配置合并。
- [升级维护](maintenance.md)：运行状态、更新、回退。
- [故障排查](troubleshooting.md)：按症状定位常见问题。

## 开发

- [开发与接口](development.md)：本地启动、架构、迁移、检查和发布。
- [性能验证](performance.md)：双路径优化、可复现基准与并发配置取舍。
- [验收记录](acceptance.md)：本版本实际验证结果和待验证项目。

配置文件直接引用仓库中的 [Compose](../docker-compose.yml)、[Nginx 示例](examples/nginx.conf)和 [Chromium seccomp 配置](../seccomp_profile.json)，避免复制多份。

历史记录：[v0.1.0 本地验收](history/v0.1.0-verification.md)、[公开网站诊断过程](history/public-smoke.md)。
