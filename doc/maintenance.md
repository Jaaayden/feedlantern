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

默认的 `latest` 镜像跟随通过全部 CI 及 amd64/arm64 容器验证的 `main` 分支。代码推送后需等待 GitHub Actions 的 `publish` 作业成功；仅有代码更新不代表新镜像已经可拉取。运行中的容器不会自动升级。

升级前从网页导出完整备份，并保存当前部署文件及 `.env`。查看变更说明，尤其是数据库兼容性变更。

### 旧部署首次切换

在原部署目录，编辑当前实际使用的 Compose 文件（可能是 `docker-compose.yml` 或旧版 `compose.yaml`），将服务的镜像改为：

```yaml
image: ghcr.io/jaaayden/feedlantern:latest
```

也可保留变量写法 `image: ghcr.io/jaaayden/feedlantern:${FEEDLANTERN_VERSION:-latest}`，但需将 `.env` 或 shell 中已有的 `FEEDLANTERN_VERSION` 改为 `latest`，避免旧值继续锁定版本。不要同时新建另一份 Compose 文件；保留项目名、端口、环境配置、沙箱规则和数据卷挂载。

确认最终镜像是 `ghcr.io/jaaayden/feedlantern:latest`：

```sh
docker compose config --images
```

### 每次更新

在同一部署目录执行（如果原来使用 `-f` 或 `-p`，继续使用相同参数）：

```sh
docker compose pull feedlantern
docker compose up -d --wait feedlantern
docker compose ps
docker compose logs --tail=50 feedlantern
```

`pull` 下载镜像，`up` 使用新镜像重建容器并保留挂载的数据卷。单独 `restart` 不会切换到新镜像。不需要先 `down`，不要执行 `down -v`。

确认登录、订阅历史、RSS 和立即刷新正常。后续重复上述命令即可，无需改版本号；只有部署配置或沙箱规则有变更时才需对照更新相关文件，避免覆盖自己的配置。

直接用 `docker run` 部署的用户，先运行 `docker pull ghcr.io/jaaayden/feedlantern:latest`，再停止并删除旧容器（不要加 `-v`），用原来的参数和同一数据卷重新创建容器，将镜像替换为 `latest`。不要创建新数据卷代替原卷。

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
