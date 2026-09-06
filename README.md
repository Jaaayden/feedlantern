# FeedLantern · 订阅灯

一个本地优先、可自托管的可视化网页 → RSS 服务。

输入网址，自动识别内容列表，预览后保存订阅。需要时可导入 Cookie、手动调整匹配。管理员登录保护管理操作，每条 RSS 使用独立的可撤销订阅密钥。

## 本地运行

需要 Node.js 24 LTS、pnpm 11.25.0，以及可运行 Chromium 的 macOS / Linux 环境。Windows 尚未验收。

```sh
git clone https://github.com/Jaaayden/feedlantern.git
cd feedlantern
pnpm install --frozen-lockfile
pnpm browser:install
pnpm build
pnpm start
```

打开 **http://127.0.0.1:4321**。首次启动会在 `data/setup-token` 写入一次性设置码；在本机读取，填入网页并创建管理员。没有默认密码，也没有公开注册。设置码使用后删除。

```sh
cat data/setup-token
```

不要把设置码粘贴到公开 issue 或聊天记录。`pnpm start` 进程存活期间，即使关闭管理页面，订阅仍会按计划刷新。停止进程后不再抓取；重新启动会恢复数据并处理到期订阅。

Linux 若缺少浏览器系统库，先运行 `pnpm exec playwright install --with-deps chromium`。若不能写入系统浏览器缓存，可在 `.env` 中设置 `PLAYWRIGHT_BROWSERS_PATH=0`，并用相同变量安装：`PLAYWRIGHT_BROWSERS_PATH=0 pnpm browser:install`。

## 创建与维护订阅

1. 登录，点击「新建订阅」，输入目标网页 URL。需要认证时先在「Cookie 凭据」中导入凭据，再选择它。
2. 打开网页后自动寻找重复列表，提取标题、链接、图片、摘要和日期。结果明确时直接预览；有歧义时提供最多三个候选。
3. 检查样例，点击「保存订阅」并复制 RSS 地址到阅读器。只有标题和链接必需；缺失的可选字段留空。
4. 需要纠偏时打开「调整匹配」，在网页截图中选择列表或字段，也可以编辑 CSS 选择器。`:scope` 表示条目本身。手动修改立即重新预览，并记录字段来源。

「重新识别」保留手动字段；显式替换全部规则才会覆盖。后台始终使用保存的规则，不会在页面改版时自动换成另一份内容。页面跳转后的交互状态不保存到定时任务，请使用最终网页的直接 URL 重新打开。

订阅支持编辑、暂停 / 恢复、立即刷新、删除和轮换 RSS 密钥。默认每 60 分钟刷新，可设为 5–1440 分钟；每个订阅保留最近 200 条，RSS 输出 100 条，按去除 fragment 后的绝对链接去重。来源没有完整日期时不输出条目 `pubDate`；首次发现时间只用于历史排序。抓取失败保留历史条目和错误提示，下一次按配置间隔重试。

## Cookie 凭据

支持粘贴 `name=value; name2=value2` 字符串，或粘贴 / 上传 OpenCookie 兼容 JSON（Cookie 数组或包含 `cookies` 数组的对象）。JSON 支持域名、路径、过期时间、Secure、HttpOnly、SameSite 和 hostOnly 属性。分区 Cookie 暂不支持。

字符串绑定到填写 URL 的主机；JSON 按自己的域名和路径发送，不会把一站凭据重新绑定到另一站。凭据可以命名、更新并供多个订阅引用，管理接口只返回域名、数量和更新时间等元数据。每次浏览使用独立上下文。

Cookie 值使用 AES-256-GCM 加密保存在 SQLite，解密密钥仅在本机 `data/master.key`。加密不防御已经能读取本机数据目录的用户。Cookie 到期后需要重新导入；不支持在远程网页中交互登录或绕过验证码。

## 配置、管理与备份

按需把 `.env.example` 复制为 `.env`。`pnpm start`、`pnpm dev` 和 `pnpm admin:reset` 自动读取配置。

| 变量 | 默认值 / 作用 |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `4321` |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:4321`，生成 RSS 地址和校验请求来源 |
| `DATA_DIR` | `./data`，数据库、主密钥和首次设置码 |
| `COOKIE_SECURE` | HTTPS 来源自动启用；反向代理后需正确设置 |
| `ALLOWED_TARGET_HOSTS` | 默认空，私网站点的精确 `host:port` 例外，逗号分隔 |
| `BROWSER_EXECUTABLE_PATH` | 可选，指定 Chromium 可执行文件 |
| `DNS_OVER_HTTPS` | 默认关闭；`true` 使用 Cloudflare 加密 DNS 的 IPv4 结果，适用于本机代理 Fake-IP 模式 |

使用与 `PUBLIC_ORIGIN` 完全一致的地址访问管理页面；修改监听端口时也要修改它。默认拒绝私网、回环、链路本地和云元数据目标，以及不安全 URL 协议。确需订阅内网站点时，例如 `ALLOWED_TARGET_HOSTS=intranet.example:8080`，仅放行必要主机和端口。

如果公网域名全部解析成 `198.18.x.x`，通常是本机代理的 Fake-IP DNS 模式。可在 `.env` 设置 `DNS_OVER_HTTPS=true` 后重启：目标域名会发送给 Cloudflare DNS，返回的真实地址仍经过私网检查并固定到代理连接，不需要放行保留地址段。

修改密码可在网页「设置」中完成；忘记密码时在项目目录执行 `pnpm admin:reset`，按提示从终端输入。它会撤销所有登录会话，密码不作为命令行参数传递。

备份时先停止服务，再复制整个 `DATA_DIR`；恢复时同时恢复数据库与 `master.key`，然后启动。丢失主密钥将无法读取既有 Cookie 和订阅密钥。本地数据库、凭据、密钥、`.env`、测试产物和截图均被 Git 忽略。

RSS 地址本身是只读凭据，持有者可阅读该订阅。泄露时轮换对应密钥。管理接口与截图均需要登录；密码采用 scrypt，会话采用 HttpOnly / SameSite Cookie，并校验 CSRF、Origin 和 Host。见 [安全说明](SECURITY.md)。

## 范围与限制

首版支持普通 DOM 列表、动态渲染、懒加载图片属性和 Cookie 访问；自动识别采用本地结构规则，不调用外部 AI。高可信要求至少三个有效重复条目、标题链接覆盖和链接唯一性达标，且没有接近的竞争候选。它不能保证任意网站都能自动识别。

不包含全文抓取、自动翻页、无限滚动采集、浏览器扩展同步、交互登录、验证码处理，以及 iframe、封闭 Shadow DOM、Canvas 内部选取。站点若需要长时间加载，可调整等待时长或等待选择器。图片可能受来源站点防盗链或阅读器认证方式限制。

浏览器限制为两个编辑会话和一个后台抓取任务；后台抓取排队执行。编辑会话空闲五分钟后回收，需要重新打开。Chromium sandbox 保持启用，浏览器请求通过检查目标地址并固定已验证 IP 的代理发出。

实际验证范围见 [验收记录](docs/verification.md) 和 [公开网站记录](docs/public-smoke.md)。Docker 镜像、安装包和 Release 自动分发尚未提供。

## 开发与验证

Node.js、TypeScript、React、Vite、Fastify、SQLite 与 Playwright Chromium。

```sh
pnpm dev                 # 前端 http://127.0.0.1:5173，API 4321
pnpm build               # 类型检查和前端构建
pnpm test                # 单元、后端及真实 DOM 测试
pnpm test:e2e            # 启动隔离测试服务和本地页面，验证浏览器流程
```

若浏览器安装在项目内，测试命令前也要加 `PLAYWRIGHT_BROWSERS_PATH=0`。浏览器无法启动默认导致测试失败；仅排查环境时可显式设 `SKIP_BROWSER_TESTS=1` 跳过部分 DOM 测试，跳过结果不能视作验收通过。

CI 使用 Node.js 24，执行锁文件安装、类型检查、测试和构建；不自动发布镜像或安装包。提交 SHA、[CHANGELOG](CHANGELOG.md) 和版本标签用于追踪实现。贡献约定见 [CONTRIBUTING](CONTRIBUTING.md)。

## License

[MIT](LICENSE)
