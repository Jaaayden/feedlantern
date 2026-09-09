# 配置参考

标准部署无需 `.env`：启动 Compose 后按 [Nginx 模板](nginx.md)转发即可。以下仅供高级配置或源码运行参考；如需调整容器参数，直接修改 [docker-compose.yml](../docker-compose.yml) 的 `environment` 后执行 `docker compose up -d`。

| 变量 | 默认与用途 |
|---|---|
| `FEEDLANTERN_VERSION` | Compose 镜像标签，默认 `latest`；跟随通过全部 CI 的 `main`，可按需覆盖 |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:4321`；本机反代请求自动使用转发域名，无需配置 |
| `HOST` / `PORT` | 源码 `127.0.0.1` / `4321`；容器内监听 `0.0.0.0:4321` |
| `DATA_DIR` | 源码 `data/`；容器 `/app/data` |
| `COOKIE_SECURE` | HTTPS 反代请求自动启用；可显式强制开启 |
| `TRUSTED_PROXIES` | 默认空，不信任转发 IP；允许明确 IP/CIDR，逗号分隔 |
| `ALLOWED_TARGET_HOSTS` | 默认空；确有需求时精确放行内网 `host:port`，逗号分隔 |
| `DNS_OVER_HTTPS` | 默认 false，Fake-IP DNS 环境可显式 true，查询仍执行地址安全校验 |
| `BACKGROUND_CONCURRENCY` | 默认 1，允许整数 1–4；刷新与批量识别共享容量。同一来源 hostname（跨协议、端口）串行，编辑会话独立 |
| `BROWSER_EXECUTABLE_PATH` | 默认使用随 Playwright 安装的 Chromium |
| `PLAYWRIGHT_BROWSERS_PATH` | Docker 固定 `/ms-playwright`；源码测试与安装必须使用同一值 |

网页加载默认等待 1000 毫秒，允许 0–10000；刷新间隔 5–1440 分钟，默认 60。保存的规则用于预览与后台刷新，每个订阅保留 200 条历史，RSS 输出 100 条。

Cookie 明文仅在输入和服务端实际抓取时使用，查询接口仅返回元数据。本机 `master.key` 与数据库必须一起保管；丢失密钥无法读取原数据库中的 Cookie 和 RSS 密钥。跨服务器优先使用网页加密备份恢复。

默认阻止私网、回环、链路本地及云元数据抓取地址，并校验 DNS、重定向与浏览器请求。不要为了一个网站而放开整个网络。运行目录、Cookie、备份和 `.env` 均不提交到 Git。

反代域名仅接受回环地址或私有网络中的直接代理（含 Docker 网桥）发来的 `X-Forwarded-Host` 和 `X-Forwarded-Proto`。Nginx 必须覆盖这两个头，容器端口保持绑定 `127.0.0.1`；客户端 IP 的信任仍由 `TRUSTED_PROXIES` 单独控制，默认登录限速按代理连接来源共享。

资源较弱或订阅集中在同一站点时保留默认 1；有多个独立站点且内存有余量时，可在 `.env` 设置 `BACKGROUND_CONCURRENCY=2` 并重启。4 仅用于资源充足且已测量的环境；并发减少排队，不保证单个抓取更快。测试方法与测量结果见 [性能验证](performance.md)。
