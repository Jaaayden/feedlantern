# 部署步骤

## 1. 准备环境

支持 Linux amd64、arm64。建议预留 2 GB 内存及数 GB 磁盘，实际用量取决于目标网页。服务器需要访问目标网站；镜像下载需要访问 GitHub Container Registry。

按 [Docker 官方安装文档](https://docs.docker.com/engine/install/)安装 Engine，再安装 [Compose 插件](https://docs.docker.com/compose/install/linux/)。确认当前用户可以运行：

```sh
docker version
docker compose version
docker info
```

Docker Desktop 也可以用于本机试用。仅有 Docker CLI 不足以启动容器，必须有可连接的引擎。容器主机必须允许 Chromium 用户命名空间沙箱，具体见故障排查。

## 2. 选择安装方式

### Docker Compose 部署（推荐）

新建目录，下载 [docker-compose.yml](../docker-compose.yml) 和配套沙箱规则，然后直接启动。无需安装脚本或下载源码：

```sh
mkdir feedlantern
cd feedlantern
curl -fLO https://raw.githubusercontent.com/Jaaayden/feedlantern/v0.2.2/docker-compose.yml -fLO https://raw.githubusercontent.com/Jaaayden/feedlantern/v0.2.2/seccomp_profile.json
docker compose up -d --wait
docker compose logs feedlantern
```

两个配置文件放在同一目录。Compose 默认使用文件中指定的版本化镜像，自动配置持久化卷、健康检查、重启策略和日志轮转。`seccomp_profile.json` 用于保留 Chromium 沙箱，不能删除或用特权模式替代。

需要固定部署版本时，把下载地址中的 `v0.2.2` 替换为已发布的版本标签。旧版本文件布局以对应标签的文档为准。域名直接填写在 [Nginx 模板](nginx.md)，无需 `.env`。

### 源码构建

开发中的版本尚未发布镜像时：

```sh
git clone https://github.com/Jaaayden/feedlantern.git
cd feedlantern
docker build -t ghcr.io/jaaayden/feedlantern:local .
FEEDLANTERN_VERSION=local docker compose up -d --wait
```

后续命令需继续设置 `FEEDLANTERN_VERSION=local`，或写入该部署目录的 `.env`。不要把 `.env` 提交到 Git。

## 3. 首次初始化

```sh
docker compose ps
docker compose logs --tail=50 feedlantern
```

打开 `http://127.0.0.1:4321`，填写日志中的一次性设置码和管理员账号密码。没有默认密码；初始化后设置码被删除。已有完整备份时可选择“从备份恢复”，无需先创建管理员。

默认端口仅绑定宿主机回环地址。远程服务器可以先建立 SSH 隧道：

```sh
ssh -L 4321:127.0.0.1:4321 user@your-server
```

然后在本机浏览器访问相同地址。长期域名访问按 [Nginx 指南](nginx.md)部署。

## 4. 验证

1. 创建管理员后退出再登录，确认登录有效。
2. 添加一个公开文章列表，预览并保存，复制 RSS 地址到阅读器。
3. 立即刷新一次，检查最近成功时间；关闭页面后等待调度再次更新。
4. `docker compose restart` 后确认订阅和历史还在。
5. 正式使用前导出一次加密备份，妥善保管密码。

数据在 Compose 命名卷 `feedlantern_data` 中，包括数据库及本机加密密钥。`docker compose down` 保留卷，`down -v` 会删除数据，不用于日常维护。
