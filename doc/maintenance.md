# 升级维护

以下命令在部署目录执行。

```sh
docker compose ps
docker compose logs --tail=100 feedlantern
docker compose restart
docker compose stop
docker compose start
```

## 升级

1. 从网页导出完整备份，并保存当前 `.env` 和部署文件。
2. 阅读目标版本 CHANGELOG；检查数据库兼容说明。
3. 下载新版本的 `docker-compose.yml` 和 `seccomp_profile.json`，对照更新部署配置，保留现有 `.env`。从 v0.2.0 升级时先备份并移走旧 `compose.yaml`，避免 Compose 优先读取旧文件；项目名和数据卷名不变。
4. 修改 `.env` 的 `FEEDLANTERN_VERSION`，然后运行：

```sh
docker compose pull
docker compose up -d --wait
docker compose ps
```

5. 检查登录、历史、RSS、立即刷新和备份导出。命名卷保持不变。

## 回退与停机备份

数据库迁移不保证旧代码可读。回退需要旧镜像与升级前数据，不能只替换镜像版本。

需要原始数据备份时先停止应用，再复制整个卷：

```sh
docker compose stop
mkdir -p volume-backup
docker compose cp feedlantern:/app/data/. ./volume-backup/
docker compose start
```

备份目录包含本机密钥，必须限制访问并妥善保存，不能提交到仓库。恢复原始目录前停止目标服务，保存目标现有数据，复制完整目录并恢复容器用户 UID 1000 的拥有权。网页加密备份是跨服务器迁移的首选。

`docker compose down` 保留命名卷；不要使用 `down -v` 或清理该卷。镜像版本可固定为具体版本，需更严格锁定时按 Release 镜像摘要使用 `image@sha256:…`。
