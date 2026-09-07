# 配置参考

源码运行读取 `.env`；Compose 读取部署目录的 `.env` 并将 [docker-compose.yml](../docker-compose.yml) 中声明的字段传入容器。环境变量改变后需要重建容器配置：`docker compose up -d`，仅 `restart` 不会加载新环境变量。

| 变量 | 默认与用途 |
|---|---|
| `FEEDLANTERN_VERSION` | Compose 镜像版本，正式部署固定具体版本 |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:4321`，RSS 地址前缀和管理接口来源校验 |
| `HOST` / `PORT` | 源码 `127.0.0.1` / `4321`；容器内监听 `0.0.0.0:4321` |
| `DATA_DIR` | 源码 `data/`；容器 `/app/data` |
| `COOKIE_SECURE` | 根据 PUBLIC_ORIGIN 是否 HTTPS 自动启用 |
| `TRUSTED_PROXIES` | 默认空，不信任转发 IP；允许明确 IP/CIDR，逗号分隔 |
| `ALLOWED_TARGET_HOSTS` | 默认空；确有需求时精确放行内网 `host:port`，逗号分隔 |
| `DNS_OVER_HTTPS` | 默认 false，Fake-IP DNS 环境可显式 true，查询仍执行地址安全校验 |
| `BROWSER_EXECUTABLE_PATH` | 默认使用随 Playwright 安装的 Chromium |
| `PLAYWRIGHT_BROWSERS_PATH` | Docker 固定 `/ms-playwright`；源码测试与安装必须使用同一值 |

网页加载默认等待 1000 毫秒，允许 0–10000；刷新间隔 5–1440 分钟，默认 60。保存的规则用于预览与后台刷新，每个订阅保留 200 条历史，RSS 输出 100 条。

Cookie 明文仅在输入和服务端实际抓取时使用，查询接口仅返回元数据。本机 `master.key` 与数据库必须一起保管；丢失密钥无法读取原数据库中的 Cookie 和 RSS 密钥。跨服务器优先使用网页加密备份恢复。

默认阻止私网、回环、链路本地及云元数据抓取地址，并校验 DNS、重定向与浏览器请求。不要为了一个网站而放开整个网络。运行目录、Cookie、备份和 `.env` 均不提交到 Git。
