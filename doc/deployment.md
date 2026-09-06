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

### 一行安装

在希望保存部署目录的位置执行，脚本会新建 `feedlantern/`：

```sh
curl -fsSL https://raw.githubusercontent.com/Jaaayden/feedlantern/v0.2.0/scripts/install.sh | sh
cd feedlantern
```

脚本检查 Docker/Compose，下载指定版本部署包并校验 SHA-256，再启动服务。已有同名目录会停止，不覆盖配置或数据。可以先下载脚本检查内容再运行。脚本不会安装 Docker，也不会修改宿主机 Nginx。

### 手动部署正式版本

从 [Releases](https://github.com/Jaaayden/feedlantern/releases)下载同一版本的 `deployment.tar.gz` 和 `SHA256SUMS`，放入一个新目录：

```sh
sha256sum --check SHA256SUMS
tar -xzf deployment.tar.gz
printf 'FEEDLANTERN_VERSION=0.2.0\nPUBLIC_ORIGIN=http://127.0.0.1:4321\n' > .env
chmod 600 .env
docker compose up -d --wait
```

镜像只有在对应版本发布流程通过后才可下载。部署文件中的 seccomp 配置必须保留，不能用 `--privileged` 或关闭 Chromium 沙箱代替。

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
docker compose exec feedlantern cat /app/data/setup-token
```

打开 `http://127.0.0.1:4321`，填写设置码和管理员账号密码。没有默认密码；初始化后设置码被删除。已有完整备份时可选择“从备份恢复”，无需先创建管理员。

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
