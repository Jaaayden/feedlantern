# 开发与接口

## 本地启动

Node.js 24、pnpm 11.25.0：

```sh
pnpm install --frozen-lockfile
pnpm browser:install
cp .env.example .env
pnpm dev
```

开发页面 `http://127.0.0.1:5173`；生产模式 `pnpm build && pnpm start`，默认 `http://127.0.0.1:4321`。`start` 和 `admin:reset` 直接用 `node --import tsx` 运行，容器里也是同样的命令，所以应用是容器内的主进程，停止时 SIGTERM 能直接送达。只在配置允许的来源访问管理接口。

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

测试安装和执行需使用相同 PLAYWRIGHT_BROWSERS_PATH；如采用项目内浏览器，安装与测试命令均加 `PLAYWRIGHT_BROWSERS_PATH=0`。E2E 使用隔离数据目录及 4322、8766 端口，不操作日常实例。

## 架构

React/Vite 前端；Fastify API；SQLite Store；Playwright BrowserService；共享 DOM 提取器和规则发现。后台刷新与批量识别共享有界任务池（默认 1，可配置至 4），同一来源 hostname 串行，编辑会话独立且有存活上限。无键的编辑、删除等任务形成全局屏障，等待先前抓取结束后执行；抓取的站点锁在执行前重新计算，避免修改网址后沿用旧锁。

SQLite `PRAGMA user_version` 记录迁移：版本 1 增加频道名称与设置表，版本 2 增加持久化任务，版本 3 将频道名称与管理名称统一（保留已设置的频道名称）。已有 v0.1.0 数据在首次启动时迁移，旧名称填入频道名称。更改迁移前必须考虑已有数据库和备份格式兼容。

迁移版本 11 增加 `api_tokens` 表（令牌 ID、所属用户、名称、SHA-256 哈希、显示前缀、权限、创建／过期／最近使用时间），删除用户时级联删除。

迁移版本 15 新增规则健康统计：`feed_health`（每个订阅当前的预警和最近一次推送时间）与 `feed_health_samples`（每次成功抓取的条目数、不重复链接数和各字段有效率），并为 `fetch_logs` 增加 `warning` 列。它们和抓取日志一样属于诊断数据，不进入完整备份；删除订阅时级联删除。判断逻辑在 `src/server/rule-health.ts`（`measureItems` / `evaluateHealth`，阈值集中在 `RULE_HEALTH`），在抓取事务提交之后单独执行，出错只写服务端日志，不影响抓取结果和条目存储。样本按“网址 + 规则”的签名区分，修改规则或网址后旧样本作废。

迁移版本 16 为 `feeds` 增加 `pagination_json`（多页采集设置，NULL 表示只抓源网址这一页）；和 13–15 一样按列是否存在判断，并写入 `max(16, 当前版本)`，重复运行或从任意版本升级都安全。`fetch_logs` 的 `pages`、`note` 列和该表的其他列一样，由 `FetchHistory` 按列存在与否补齐。

多用户迁移版本为 7：统一 `users` 表替代 `admin`，会话引用用户 ID，订阅、凭据和批量任务记录 `owner_id`。原数据迁移到稳定 ID `admin`，旧会话清空。HTTP 层所有资源入口检查归属，批量操作逐项校验；队列执行时重新检查。用户停用递增 `generation`、撤销会话及发出取消信号，后台结果只有代次仍一致时可落库；翻译同时使用任务 revision。

聚合订阅迁移版本为 14（按 `bundles` 表是否存在判断，与合并顺序无关）：新增 `bundles`（所有者、名称、条数上限、加密密钥与哈希）和 `bundle_feeds`（成员与顺序）。`bundle_feeds.feed_id` 外键 `ON DELETE CASCADE`，删除订阅自动移出所有聚合；删除用户同时删除其聚合。存取在 `src/server/bundle-store.ts`，合并与 RSS 输出在 `src/server/bundles.ts`：每个成员先经 `publishedItems`（与单个订阅 RSS 相同的条目选择），再合并去重；条目复用 `renderRssItem`、`renderAtomEntry`、`jsonFeedItem`，聚合只追加来源（RSS/Atom 的 category、JSON Feed 的 tags）。聚合只读已存条目，不进入抓取任务池。

Store 的无 owner 参数列表方法保留给整站后台调度和备份使用，HTTP 工作台必须传入认证的用户 ID。客户端提交的 ownerId 不决定归属。普通用户不读取全局设置，列表偏好存储在浏览器中。

### 网络配置（迁移 17）

`network_profiles` 表按 `owner_id` 归属，结构与 Cookie 凭据相同：凭据属于用户，订阅通过 `feeds.network_profile_id`（`ON DELETE RESTRICT`）引用。这样一组代理和请求头只需维护一次，改密码后所有引用的订阅同时生效；订阅本身、轻量配置和接口响应都不携带密钥。代理类型、主机、端口、是否有认证、User-Agent、Referer 和请求头名称以明文列保存，供列表展示；完整配置（含代理用户名密码和请求头的值）以主密钥 AES-256-GCM 加密保存在 `encrypted_value`，只在服务端实际抓取时解密。

迁移版本 17 和 13–16 一样按表和列是否存在判断（`network_profiles` 表、`feeds.network_profile_id` 列），所有语句可重复执行，并写入 `max(17, 当前版本)`，与合并顺序无关。

迁移版本 19 新增 `api_token_logs`（访问令牌调用记录：令牌 ID、所属用户、令牌名称与前缀、时间、方法、路由模板、状态码、耗时、来源 IP），按表是否存在判断并写入 `max(19, 当前版本)`。`token_id` 外键级联删除，吊销令牌、删除账号或恢复备份时一并清除；它属于诊断数据，不进入完整备份。

所有抓取路径都经 `app.ts` 的 `networkFor()` 取得同一份 `FetchNetworkOptions`：编辑器 `POST /api/browser`（含“试抓多页”）、批量识别（`ImportJobs` 的 discover / scrape / RSS）、规则失效后的“重新识别”和后台刷新 `refreshOnce()`。多页采集在同一个浏览器上下文里翻页，代理、User-Agent 和额外请求头对每一页都生效，每次翻页仍先经过网络策略检查；第 1 页使用配置中的 Referer，之后的页面以上一页为 Referer。访问令牌调用网络配置接口与其他接口相同：GET 需要 read，其余需要 write，按令牌所属账号的工作台隔离。

Chromium 侧：有代理的配置会为该浏览器上下文单独创建一个只监听 127.0.0.1 的受限代理（`createRestrictedForwardProxy({ upstream, requireAuth })`），它沿用全局的网络策略选项（`allowedHosts`、`dnsOverHttps`），对每个请求先校验目标、再校验代理地址，然后经上游代理以已校验的 IP 建立隧道（HTTP/HTTPS 代理用 CONNECT，SOCKS5 用 IPv4/IPv6 地址类型）。这个本机代理要求每个上下文独立的随机 Basic 登录，交给 Chromium 的只是这组随机登录，用户真实的代理密码始终留在 Node 进程中；另一个上下文或本机其他进程无法借用。上下文关闭时随之关闭。User-Agent 用上下文选项设置，Referer 只用于首次导航，额外请求头在请求路由中按站点范围加入。浏览器只启动一次，沙箱、`--disable-quic` 和 WebRTC 限制不变。RSS 侧在 `rss-source.ts` 中用同样的隧道和规则。

### 保留条数（迁移 18）

`feeds.retention_limit`（可为 NULL，NULL 表示自动）记录每个订阅在数据库中最多保存的条目数。`feed-output.ts` 的 `storedItemLimit` 计算实际保留量：自动时网页 200、RSS 100，任何情况下不少于输出条数；`retentionProblem` 校验 10–1000 且不少于输出条数，`Store.updateFeedSettings` 在写入任何字段之前用合并后的输出条数再检查一次，所以单个修改、批量设置和配置导入都不会留下低于输出条数的值。清理只在抓取写入时发生（`Store.upsertItems`、`RssTranslations.upsert`），调小不会立即删除。

网页订阅判断新条目靠 `feed_items.normalized_key`，所以 `upsertItems` 保留量取 `max(storedItemLimit, 本次抓到的去重条目数)`：网页上仍能看到的条目不会被删掉后又以新 ID 入库、被阅读器当作新条目重复推送。RSS 订阅还有 `rss_sources.seen_json`（上次来源中出现过的键），`incoming()` 会跳过已见过但已清理的条目，因此不需要这一下限。被清理条目的翻译任务随 `ON DELETE CASCADE` 一起删除。规则健康统计只用每次抓取的原始结果，与保留量无关。

迁移 18 和 13–17 一样按列是否存在判断，写入 `max(18, 当前版本)`。完整备份的 `feeds.retention_limit` 为可选字段，旧备份恢复为自动；轻量配置导出只在设置了固定值时带 `retentionLimit`。

### 抓取超时文案

使用网络配置代理的抓取会把代理交给 `NetworkPolicy`（`policy.forProxy(proxy)` 或 `policyOptionsFor(options, proxy)`）：开启 DNS over HTTPS 时，`lookupCached` 改用 `resolveDnsOverHttpsViaProxy`，经 `openResolverTunnel` 让代理按主机名连接解析服务，HTTPS 端到端校验证书。这是“代理只收已检查的 IP”规则唯一的例外，因为解析服务是固定的公共端点，不是用户填写的目标。解析结果照常检查后，才通过 `openTunnel`（只接受 IP）连接目标。代理服务器本身的地址仍直连解析（`directPolicy`）。每个策略实例有自己的 DNS 缓存，带代理的策略总是单独的实例，因此经代理和直连的结果不会混用。用到它的地方包括 `fetchSource`、`probeTarget`、`createRestrictedForwardProxy`（`upstream`）、`BrowserService.createContext` 与 `installNetworkPolicy`、翻页的 `collect` 和编辑器的 `follow`。

`fetch-errors.ts` 的 `withFetchTimeout` 给一次抓取加上自己的超时信号，只有它触发时才抛出 `FetchTimeoutError`（“连接 主机 超时（N 秒未响应）”加代理提示）；调用方的取消信号（用户取消、停用账号、服务停止）原样抛出，`refreshOnce` 记为“中断”。RSS 来源（`fetchSource`、网络配置的“测试连接”）超时 20 秒；网页由 Playwright 的导航超时（30 秒）转换，等待元素超时单独提示。错误只含主机名，`friendlyError` 直接透传；其他英文的 `AbortError`／`TimeoutError` 会被换成中文。

### 非订阅源响应与 PubMed 期刊订阅

`fetchSource` 和 `parseSource` 在解析 XML 之前调用 `fetch-errors.ts` 的 `nonFeedReason(body, status?, contentType?)`：正文以 `<!doctype html` / `<html` 开头（允许前置 BOM、XML 声明和注释）、`Content-Type` 为 HTML 且正文不像 XML，或状态码是 200 以外的 2xx 时抛出 `NotAFeedError`；页面含 `cookies-required`、`identity_pow`、captcha、challenge 等标记时在文案中注明。被标成 `text/html` 的合法 RSS 照常解析；带 DTD／实体声明的 XML 仍由原有检查拒绝。新增的用户可见文案都在 `fetch-errors.ts` 的 `sourceMessages` 中（界面文案在 `src/shared/pubmed.ts`），便于统一迁到语言文件。

`rss-source.ts` 的 `fetchRaw` 是两者共用的一次 GET（网络策略、固定 IP、代理、DoH、重定向和超时），`fetchSource` 与 `pubmed.ts` 都基于它。`app.ts` 的 RSS 抓取入口是 `sourceFetcher(policy, ncbi)`：`src/shared/pubmed.ts` 的 `pubmedJournalSource(url)` 识别出期刊地址时调用 `fetchPubmedJournal`（esearch `term=<NLM ID>[jid]&sort=pub_date&retmax=<limit>`，再 efetch XML），其他地址照旧 `fetchSource`。`createApp` 内只有一个 `NcbiRateLimiter`，按调用顺序分配起始时间，不带 Key 间隔 350 毫秒、带 Key 110 毫秒（略宽于 NCBI 的每秒 3／10 个）；429 时 `pause` 整条队列再重试一次。条目 key 为 `digest('id:pubmed:<PMID>')`，与 `parseSource` 处理原 RSS guid `pubmed:<PMID>` 的结果相同；`publishedAt` 取 Entrez 日期当天纽约时间 6:00，与原 RSS 的 `pubDate` 相同。efetch 只接受它自己的 DOCTYPE 公共标识（解析前删除，从不加载外部 DTD），其他声明一律拒绝。设置存放在应用设置的 `ncbi`（`apiKey`、`email`）中，没有数据库迁移；测试和 e2e 后端用 `createApp({ ncbiEndpoint })` 指向本地 fixture（`tests/fixtures/pubmed`），CI 不访问 NCBI。

### 完整恢复与服务器设置

`Store.restoreTables(tables, { restoreServer })` 默认把备份中应用设置的 `server` 整组替换为恢复前本机的值，只有 `POST /api/backups/restore` 传入 `restoreServerSettings: true` 时才使用备份的值。`POST /api/backups/preview` 返回 `serverChanges`（`key`、`label`、`current`、`backup`），预览中的 `settings` 不再包含 `server`。
## API 摘要

所有管理接口要求登录（网页会话 Cookie 或个人访问令牌，见下节）；账号管理、全局设置及备份仅管理员可用，跨用户资源与不存在资源均返回 404。网页会话的写操作需要 `X-FeedLantern: 1` 和 `X-CSRF-Token`，并校验 Host/Origin。错误返回 `{error:string}`，响应不缓存。完整的接口说明见 `GET /api/openapi.json`（OpenAPI 3.1）。

| 接口 | 用途 |
|---|---|
| `/api/auth/*` | 初始化、登录、退出、修改自己的密码；登录状态包含 userId、role |
| `GET/POST /api/users` | 管理员列出用户／以 `{username,password}` 创建普通用户 |
| `PATCH /api/users/:id` | 管理员局部更新 `{username?, enabled?, role?}`；身份变化会撤销目标会话，必须保留至少一名启用的管理员，不能停用自己 |
| `POST /api/users/:id/password` | 管理员以 `{password}` 重置普通用户密码，撤销目标账号会话 |
| `/api/credentials` | 凭据元数据及导入更新 |
| `/api/network-profiles` | 网络配置：GET 列表、POST 创建、PUT `/:id` 修改、DELETE `/:id`（被订阅使用时 409）、POST `/:id/test {url}` 测试连接；返回 `NetworkProfileSummary`，不含代理用户名、密码和请求头的值 |
| `/api/browser/*` | 打开页面、截图、自动发现、点选、预览 |
| `/api/feeds` | 单个订阅创建及管理 |
| `PATCH /api/feeds/:id` | `{channelTitle?, intervalMinutes?, networkProfileId?}`，至少提供一个；`networkProfileId: null` 改回默认网络；名称同步 RSS 标题，间隔为 5–1440 的整数，变化时重新计时；不触发抓取，兼容仅改名称的旧客户端 |
| `GET/PUT /api/settings` | 仅管理员读取／修改全局配置及管理员视图偏好 |
| `POST /api/feeds/bulk` | `{ids,action}`；copy/pause/resume/refresh/delete，逐项结果 |
| `GET/POST /api/import-jobs` | 列出/创建批量任务，创建参数 entries 与 intervalMinutes |
| `POST /api/import-jobs/:id/:action` | cancel/retry/confirm；confirm 带 entryId 与完整 input |
| `/api/backups/export` | 加密导出，POST 管理员密码与备份密码 |
| `/api/backups/preview`、`restore` | 预览/覆盖恢复；初始化场景使用 setupToken |
| `GET/POST /api/backups/config` | 轻量配置导出/预览与确认导入 |
| `GET/POST /api/tokens`、`DELETE /api/tokens/:id` | 列出（含最近 24 小时调用统计 `usage24h`）、创建（`{name, scope:'read'\|'write', expiresInDays?}`，返回只出现一次的 `secret`）、吊销自己的访问令牌；仅限网页会话。管理员带 `X-FeedLantern-User` 可只读列出其他用户的令牌，创建和吊销只能针对自己 |
| `GET /api/tokens/:id/logs?status=success\|denied\|error&cursor=&limit=` | 令牌调用记录，新到旧分页（`{calls, nextCursor, retentionDays, perTokenLimit}`）；`denied` 为 401/403/429，`error` 为其他 ≥ 400；仅限网页会话，管理员可带 `X-FeedLantern-User` 查看其他用户的记录 |
| `GET /api/openapi.json` | 公开的 OpenAPI 3.1 文档 |
| `/feeds/:id/:token.xml` | 无管理员登录的密钥授权 RSS 2.0 |
| `POST /api/feeds/:id/health/redetect` | 网页订阅：后台按当前规则抽取并运行自动识别，返回 `{current:{count,items,error?}, detection}`（每个候选最多 5 条预览），不保存规则 |
| `POST /api/feeds/:id/health/preview` | `{rules}`，在订阅网页上预览字段组合，返回 `{count,items,error?}` |
| `POST /api/feeds/:id/health/ignore` | 清除“规则可能失效”并以最新样本作为新基线，返回 `{feed,feedUrl}` |
| `/feeds/:id/:token.atom`、`.json` | 同一密钥授权的 Atom 1.0、JSON Feed 1.1 |
| `PATCH /api/feeds/:id` | 名称、间隔、翻译模式，以及 `itemFilter`（`null` 清除）和 `outputLimit` |
| `POST /api/feeds/:id/output-preview` | `{itemFilter?,outputLimit?}` 预览未保存设置下每个条目的输出状态 |
| `GET/POST /api/bundles` | 列出／以 `{name, feedIds, itemLimit?}` 创建聚合订阅，返回 `{bundle, bundleUrl}`；成员必须属于同一账号，最多 200 个，`itemLimit` 为 10–500（默认 100） |
| `GET/PUT/DELETE /api/bundles/:id` | 读取／局部修改 `{name?, feedIds?, itemLimit?}`（`feedIds` 整体替换成员）／删除聚合，不影响成员订阅 |
| `POST /api/bundles/:id/feeds` | `{feedIds}` 追加成员，已有成员保持原位 |
| `POST /api/bundles/:id/rotate-token` | 轮换聚合密钥，旧地址立即失效 |
| `/bundles/:id/:token.xml`、`.atom`、`.json` | 同一密钥授权的聚合 RSS 2.0、Atom 1.0、JSON Feed 1.1，`.xml` 在浏览器直接打开时显示预览页；只读已存条目，不触发抓取 |

### 输出选择

RSS、Atom、JSON Feed、浏览器预览页和管理端都通过 `src/server/feed-output.ts` 的 `classifyItems` 决定发布哪些条目：先去掉未完成翻译的条目，再应用 `itemFilter`，最后按 `outputLimit` 截断。每个条目的状态为 `published`、`untranslated`、`excluded`、`not-included` 或 `over-limit`；`GET /api/feeds/:id` 在 `outputStatus`（按条目 ID）中返回，ETag 也基于同一结果计算，修改规则后阅读器会拿到新内容。

正则过滤的安全限制：保存时用 `u` 标志编译检查，`unsafeRegexReason` 拒绝反向引用以及“重复的组内还有重复或分支”（如 `(a+)+`、`(a|ab)*`）；运行时标题截取 500 字符、摘要 2000 字符，并在 `node:vm` 中以 100 毫秒超时执行，V8 会在回溯中途中断。超时结果按规则和内容缓存，本次输出不应用过滤并记录一次警告；保存时如果在已有条目上超时则直接拒绝。

`ScreenFrame` 是从页面顶部截取的第一段截图（JPEG 质量 75，data URL，每段最高 8000 像素）。`height` 为已截取的高度，`documentHeight` 为可截取的总高度（最高 48000 像素；网页更长时 `truncated: true`），`viewportHeight` 为远端视口高度。`POST /api/browser/:id/segment {top}` 截取下一段，`top` 必须等于已截取的高度，否则拒绝，避免重复或跳段；返回 `{top, height, image, documentHeight, map}`。`map` 是元素地图：`boxes` 每 5 个数一组（x、y、宽、高、最近的上层元素序号，根为 -1），坐标相对整页顶部，另含 `labels`、`links`（仅 http/https）和 `innerScroll`。地图是累计的：后续分段只追加新元素，已有序号不变。编辑器据此在本地完成悬停高亮、↑/↓ 调整范围和滚动。

`POST /api/browser/:id/pick` 优先接受元素序号 `{node, exact?}`，也接受整页坐标 `{x, y}`；`exact: true` 保留所选元素，不自动扩展到重复条目或字段元素。带上 `rules` 时，同一请求按新选择器预览并返回 `items`（失败时为 `previewError`）。`POST /api/browser/:id/follow {node}` 在当前会话打开该元素或其上层元素的链接（受同样的网络策略限制）并返回新的 `ScreenFrame`。高亮框、自动识别和日期选区的坐标均相对整页顶部。

多页采集由 `src/server/pagination.ts` 的 `collectPages` 完成：第 1 页由调用方打开，之后在同一标签、同一浏览器上下文中按 `PaginationRules`（`next` / `template` / `loadMore`）逐页处理。后台刷新（`BrowserService.scrape`）、批量确认和编辑器预览都调用它；导航前先做 `NetworkPolicy.assertAllowed`，请求仍经过上下文路由和受限代理。总时长预算为 180 秒，硬超时为预算加 90 秒。`POST /api/browser/:id/preview` 带上 `pagination` 且最多页数大于 1 时，在会话的另一个标签重新打开源网址并试抓，返回 `{items, pagination: PaginationReport}`；`PickRequest.target` 可为 `next`，用于点选“下一页”或“加载更多”。后台刷新传入订阅已保存链接的判断函数，一页全是已见条目时停止；结果写入抓取日志的 `pages` 和 `note`，与规则健康的 `warning`、多渠道告警记录互不影响。规则健康只统计 `CollectResult.firstPage`（第 1 页抽取的条目），`/api/feeds/:id/health/*` 的对比和重新识别也只看第 1 页，因此健康签名不包含翻页设置，改动最多页数不需要重置基线。

`POST /api/browser/:id/scroll` 接受 `{deltaY,x?,y?}`，坐标须同时提供并位于远端视口内；省略时使用视口中心。编辑器只在 `map.innerScroll` 为真时用它滚动页面内部的滚动区域。显式关闭编辑会话会取消进行中的操作并释放容量。

数据库版本 9 为 `feeds` 增加 `item_filter_json`（JSON，可空）和 `output_limit`（默认 100）；完整备份中两列为可选字段，旧备份恢复后使用默认值。完整备份格式版本为 3（兼容导入 version 1、2），独立于数据库迁移版本；敏感值只在加密包内部携带可迁移明文，目标实例使用自己的主密钥重新加密。

## 用令牌调用 API

脚本和 AI Agent 使用个人访问令牌，不需要模拟网页登录。在“设置 → 访问令牌”创建，令牌形如 `fl_` 加 43 个字符，只在创建时显示一次；数据库只保存 SHA-256 哈希和用于识别的前 11 个字符。

带令牌的每个 `/api/*` 请求都会记入该令牌的调用记录（`src/server/api-token-log.ts`）：`onRequest` 钩子识别令牌（已过期的令牌也会识别，以便记下 401），`onResponse` 钩子把方法、路由模板（`request.routeOptions.url`，未匹配时为 null）、状态码、`reply.elapsedTime` 和 `request.ip`（遵循 `TRUSTED_PROXIES`）放进内存缓冲区。缓冲区每秒或攒满 200 条时在一个事务中写入，并按每个令牌和全站上限裁剪，请求本身不产生数据库写入；读取记录前会先写入缓冲区。网页 Cookie 会话的请求不记录，令牌密钥和查询参数也不记录。

```sh
export FEEDLANTERN=https://feeds.example.com
export FEEDLANTERN_TOKEN=fl_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 确认令牌和所属账号（返回 userId、role、tokenScope）
curl -s -H "Authorization: Bearer $FEEDLANTERN_TOKEN" "$FEEDLANTERN/api/auth/status"

# 列出订阅（read 或 write 令牌）
curl -s -H "Authorization: Bearer $FEEDLANTERN_TOKEN" "$FEEDLANTERN/api/feeds"

# 立即抓取一个订阅（需要 write 令牌）
curl -s -X POST -H "Authorization: Bearer $FEEDLANTERN_TOKEN" "$FEEDLANTERN/api/feeds/FEED_ID/refresh"

# 修改刷新间隔（需要 write 令牌）
curl -s -X PATCH -H "Authorization: Bearer $FEEDLANTERN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"intervalMinutes":120}' "$FEEDLANTERN/api/feeds/FEED_ID"

# 下载接口文档（公开，无需令牌）
curl -s "$FEEDLANTERN/api/openapi.json" -o feedlantern-openapi.json
```

规则：

- 令牌请求按令牌所属账号鉴权，权限与工作台隔离和该账号的网页会话完全相同：普通用户只能访问自己的数据；管理员令牌默认作用于管理员自己的工作台，和网页一样，只有带 `X-FeedLantern-User: 用户ID` 才在其他账号的工作台中操作。
- `read` 令牌只能调用 GET；任何写操作返回 403。`write` 令牌可调用所有开放给令牌的接口。
- 带 `Authorization: Bearer` 的请求只看令牌，忽略 Cookie；不需要 `X-FeedLantern`、`X-CSRF-Token`，也不校验 Host/Origin（这些检查只用来保护浏览器自动携带的 Cookie，跨站页面无法替用户附上令牌）。其他认证方案（例如反向代理的 `Authorization: Basic`）不受影响，仍按 Cookie 会话处理。网页会话的防护保持不变。
- 错误响应统一为 `{"code": "代码", "message": "说明", "error": "说明", "messageKey": "error.xxx", "params"?: {…}}`。`message`（与 `error` 相同，兼容旧客户端）面向人，按读者语言翻译；`messageKey` 和 `params` 让网页按自己的语言渲染同一条文案。脚本应判断 `code`：`token_read_only`（只读令牌执行写操作）、`token_not_allowed`（令牌调用了仅限网页会话的接口）、`unauthorized`、`forbidden`、`validation`、`not_found`、`conflict`、`too_large`、`rate_limited`、`server_error`、`upstream_error`、`unavailable`，以及 `source_not_feed`（`POST /api/rss/preview` 时来源返回网页而不是 RSS/Atom，即 `NotAFeedError`；NCBI 失败为 `upstream_error` 或 `rate_limited`）。代码表在 `src/shared/types.ts` 的 `ApiErrorCode`；`new AppError(status, 'error.xxx' | msg(...))` 默认按状态码归类，个别文案键在 `src/server/auth.ts` 的 `specificErrorCode` 中对应更具体的代码，也可以传第三个参数指定。
- 令牌无效、过期或已吊销返回 401（带 `WWW-Authenticate: Bearer`）；同一来源地址 15 分钟内失败 20 次后，该地址的令牌请求一律返回 429，直到窗口结束。与登录限速一样，部署在反向代理后要设置 `TRUSTED_PROXIES`。
- 账号停用、删除、修改密码（包括管理员重置）、改名或角色变化时，与登录会话一样立即吊销该账号的全部令牌；重新启用账号不会恢复旧令牌。完整恢复备份会吊销全部令牌。
- 每个账号最多 50 个令牌；有效期 1–3650 天或永不过期。过期令牌保留在列表中 30 天后自动清除。

令牌不能调用的接口（只能在网页登录会话中操作，返回 403）：

- 登录相关：`POST /api/auth/setup`、`/api/auth/login`、`/api/auth/logout`、`/api/auth/password`
- 备份：`POST /api/backups/export`、`/api/backups/preview`、`/api/backups/restore`，`GET/POST /api/backups/config`
- 账号管理中的危险操作：`POST /api/users`、`PATCH /api/users/:id`、`POST /api/users/:id/password`、`DELETE /api/users/:id`
- 令牌本身：`GET/POST /api/tokens`、`DELETE /api/tokens/:id`、`GET /api/tokens/:id/logs`

令牌可以用 `GET /api/tokens/current` 查看自己的名称、权限、有效期和最近 24 小时调用次数，用 `GET /api/tokens/current/logs`（参数同 `/api/tokens/:id/logs`）查看自己的调用记录；只返回发起请求的这个令牌，网页会话调用返回 400。

清单定义在 `src/server/api-tokens.ts` 的 `SESSION_ONLY_ROUTES`，OpenAPI 文档中这些接口的 `x-feedlantern-token` 为 `forbidden`。

`GET /api/openapi.json` 公开提供：文档只描述接口形状，与开源代码中的信息相同，不含任何用户数据；公开后脚本、Agent 和代码生成工具无需先拿到令牌就能读取。`servers` 使用当前请求的公开地址。每个操作带 `x-feedlantern-access`（public / session / read / write）和 `x-feedlantern-token`（read / write / forbidden）。

新增或删除 `/api/*` 路由时同步修改 `src/server/openapi.ts`；`tests/openapi.test.ts` 会比对服务器路由表和文档，缺少或多出接口都会失败。

Agent CLI 与 MCP server 位于 workspace 包 `packages/cli`（用法见 [Agent CLI 与 MCP](agent.md)）：`client.ts` 是类型化 API 客户端（类型来自 `src/shared/types.ts`），`operations.ts` 是 CLI 与 MCP 共用的操作，`messages.ts` 集中所有输出文案。`pnpm build` 会用 esbuild 把它打包到 `packages/cli/dist/feedlantern.js`；`tests/agent-cli.test.ts` 和 `tests/e2e/10-agent-cli.spec.ts` 覆盖主要命令和 MCP 工具。新增开放给令牌的接口时，考虑同步加到 CLI 命令和 MCP 工具。

## 发布

普通提交运行 CI；依赖更新由 Dependabot 以 PR 提交。`main` 通过检查、两个架构的原生容器验证后，将同一批已验证镜像发布为多架构 GHCR `sha-<完整提交 SHA>` 和 `latest`。PR 不发布镜像；重跑旧提交不会覆盖已前进的 `main` 对应的 `latest`。镜像记录 `org.opencontainers.image.revision` 便于核对源码。里程碑仍可更新 package.json、CHANGELOG 并创建语义化版本标签；标签流程发布版本化镜像及 Release 部署包，不覆盖跟随 `main` 的 `latest`。

seccomp 配置来自 Playwright v1.63.0，保留上游配置；更新 Playwright 时同步检查浏览器安装和沙箱行为。容器设计参考 [Playwright Docker 文档](https://playwright.dev/docs/docker)。

## RSS 翻译模块

数据库版本 5 增加订阅来源 `source_type`、输出模式 `translation_mode`；RSS 获取状态、任务、译文及片段缓存分别由 `rss_sources`、`translations`、`translation_cache` 保存。版本 6 将旧网页订阅设置为原文输出；网页订阅开启翻译后将已抓取内容同步到翻译队列，原始数据保留。

- `POST /api/rss/preview {url}`：鉴权与 CSRF 保护，获取并返回前三条安全原文预览，不触发翻译。
- `POST/PUT /api/feeds[/id]` 新增 `sourceType: 'rss'` 与 `translationMode: 'original' | 'translated' | 'bilingual'`（v0.7 前名为 `chinese`，仍作为别名接受），以及 `targetLanguage`（`zh-CN` / `zh-TW` / `en` / `ja` / `ko`，默认 `zh-CN`）和 `translationProvider`（`google` / `deepl` / `openai`，`null` 跟随默认）。RSS 输入不要求 `rules`、`waitMs` 或 Cookie。新建返回订阅链接后后台获取；来源类型缺省按原有网页订阅处理。
- `PATCH /api/feeds/:id` 与批量设置支持 `translationMode`、`targetLanguage`、`translationProvider`；模式切换不改变地址、GUID 或缓存，更换目标语言或实际使用的服务时该订阅全部条目重新排队翻译（`RssTranslations.retranslate`），GUID 不变。
- `GET /api/translation/providers`（任意已登录用户）返回默认服务和各服务是否已配置；`POST /api/settings/translation/test {provider, settings?, targetLanguage?}`（管理员）用未保存的设置翻译一句示例。
- `POST /api/feeds/:id/translation/retry {}`：重试未完成条目，清除该订阅重试计数；保留服务端限流等待期。
- RSS 输出及 ETag 使用同一份仅翻译成功的条目列表；管理端仍返回等待／失败条目。
- 详情及列表的 RSS Feed 增加 `translation: {pending,success,failed}`；详情条目增加 `contentHtml`、`translationStatus`、`translationError`。

RSS HTTP 获取绑定已检查的 IP，限制 5 次重定向、20 秒和 5 MB 响应；单条 HTML 上限 200,000 字符、标题上限 20,000 字符，超限明确失败，不静默截断。XML 禁止 DTD/实体声明。RSS 输出和管理预览都使用安全 HTML，管理预览另加 sandbox 与 CSP。

翻译后台队列与网页抓取池分开，SQLite 任务使用 revision 防止暂停、编辑、删除后的旧结果回写。关闭、恢复备份和应用设置维护时先停止并取消翻译，再操作存储；启动恢复进行中的任务。获取失败进入抓取日志；翻译失败进入独立日志，两类故障分别去重并复用通知发送队列。

完整备份继续接受版本 1，新增字段/表使用兼容默认值，因此新程序可恢复旧备份；包含 RSS 翻译的新备份不应交给旧版本程序恢复。轻量配置格式 2 增加来源与模式，不携带内容缓存。

`tests/rss-translation.test.ts` 验证解析、受限 HTTP、缓存、竞态、备份与接口。E2E 后端注入确定性翻译器与模拟通知发送器，实际 RSS HTTP 和浏览器抓取仍使用本地 fixture；生产入口不包含模拟翻译。运行真实 Google 连接检查可使用 `node --import tsx scripts/check-translation.ts`。

### 翻译服务

`src/server/translation-providers.ts` 定义 `TranslationEngine`：一个服务加一个目标语言，只负责把一组文本按顺序翻译成同样数量的结果，失败抛出 `TranslationError`（`rateLimited` 表示需要退避）。排队、批量、缓存、限流退避和重试仍由 `TranslationWorker` 统一处理，Google 通道的行为不变。工作器为每个服务维护独立的队列、并发、启动间隔和冷却时间；`RssTranslations.next(defaultProvider, skip)` 跳过正在冷却或已满的服务。

- 缓存键为 `sha256("<命名空间>:<片段>")`：Google 为 `google-browser:v2:<语言>`（`zh-CN` 即升级前的键），DeepL 为 `deepl:v1:<语言>`，OpenAI 兼容接口为 `openai:v1:<接口地址+模型+提示词摘要>:<语言>`。
- DeepL 与 OpenAI 兼容接口的请求经 `policyPost` 发出：先用 `NetworkPolicy` 解析并校验地址，再把连接固定到已校验的 IP，不跟随重定向；私网和回环地址只有精确加入 `allowedHosts` 才放行。
- OpenAI 兼容接口把片段编号为 `<seg id="N">…</seg>`（转义后发送），系统提示词为“自定义提示词 + 固定格式要求”；`parseSegments` 要求编号连续、数量一致、段内无标签、段外无内容，否则整批失败重试。`finish_reason: length` 视为失败。
- 设置中的 API Key 随加密的应用设置保存；`GET /api/settings`、备份预览和轻量配置导出把 Key 置空并返回 `apiKeyConfigured`。`PUT /api/settings` 中 Key 缺省或为空表示保留，`null` 表示删除。
- 数据库迁移 13 增加 `feeds.target_language`、`feeds.translation_provider`，并把 `chinese` 改为 `translated`。迁移按列是否存在执行，不依赖其他迁移的合并顺序。完整备份与轻量配置的订阅新增对应可选字段，备份格式版本不变。
- RSS 的 `<language>` 由 `feedLanguage(feed)` 给出（如 `zh-cn`、`ja`）；Atom 的 `xml:lang` 与 JSON Feed 的 `language` 使用 `feedLanguageTag(feed)`（BCP 47，如 `zh-CN`、`ja`）。

`tests/translation-providers.test.ts` 用本地 HTTP 服务模拟 DeepL 与 OpenAI 兼容接口；E2E 的 fixture 服务器提供 `/deepl/{free,pro}/v2/translate` 与 `/openai/v1/chat/completions`，后端通过 `FIXTURE_ORIGIN` 把 DeepL 的固定端点指向它。不调用任何真实翻译服务。

应用设置新增 `translation: {concurrency: 6, requestIntervalMs: 100}`，旧设置和备份缺失时自动采用默认值。并发范围 1–16，间隔范围 0–5000 毫秒；PUT 支持局部更新。v0.7 起该并发与间隔只作用于 Google 通道，`translation.deepl` / `translation.openai` 各有自己的并发与间隔，`translation.defaultProvider` 选择默认服务。每个服务的请求调度器约束真实 HTTP 并发与启动间隔，正文先并行翻译，再按 DOM 顺序组装；局部失败等待已启动操作收敛后再记录重试，禁止半成品进入 RSS。

## v0.5.1 用户与目标工作台

资源接口支持可选 `X-FeedLantern-User` 用户 ID。省略时使用当前账号；指定其他账号必须是已登录管理员。身份接口、用户管理、全局设置和备份始终以真实操作人为准。服务端从已验证目标写入所有者，不接受请求体伪造归属；跨所有者资源和凭据引用返回 404。

- `GET/POST /api/users`：列出账号、创建普通用户。
- `PATCH /api/users/:id`：局部更新 `username`、`enabled`、`role`；身份变化撤销目标会话。
- `POST /api/users/:id/password`：重置其他账号密码，`password` 至少 8 字符。
- `GET /api/users/:id/deletion-preview`：返回用户与 `feeds`、`credentials`、`jobs` 数量。
- `DELETE /api/users/:id`：请求体 `{username}` 必须准确匹配目标账号。
- `GET/PUT /api/notifications/bark`：读取／更新目标个人设置。读取返回 `configured`、`maskedUrl`，不返回 `url`；写入省略地址保持，空地址清除并关闭。
- `POST /api/notifications/bark/test`：使用目标账号已有或请求中未保存的设置，明确展示接收账号；不保存设置。

SQLite 版本 8 移除单管理员索引并增加加密 `user_notifications`。账号变更在事务内保护最后一名启用管理员；会话仍绑定稳定用户 ID。导入任务持久记录 `actorId` 和 `ownerId`，翻译手动重试记录操作人，浏览器记录操作人及目标。执行前及写入前检查权限与取消信号，删除不能恢复已清除的任务。删除账号也清理可能含来源片段的共享翻译缓存，不删除其他用户已保存的译文。

完整备份 version 3 包含个人通知并兼容 version 1、2；只在加密备份内保存可恢复密钥。轻量配置仅导出操作管理员自己的订阅和个人通知设置。开发测试注入模拟通知发送器，禁止向真实设备地址发送测试消息。

## 通知渠道

告警按“告警 + 渠道投递”两层保存：`fetch_alerts` 每次故障一行，记录正文、`kind`（`fetch`／`translation`／`health`，后者为规则失效预警，Webhook 事件 `rules.warning`）、结构化 `payload`（订阅名称、错误、时间）以及汇总状态；`fetch_alert_deliveries` 每个渠道一行，各自记录 `attempts`、`next_attempt_at`、`error` 和状态。告警产生时为所有者所有已启用且填写完整的渠道各建一条投递；`NotificationWorker`（`src/server/notify.ts`）逐条发送，阈值、超时、重试和冷却沿用所有者的告警策略。汇总状态规则：仍有待发送即“待发送”，任一渠道送达即“已发送”（不再重复推送），全部失败才“发送失败”并在冷却后允许重新告警。取消告警（恢复成功、删除订阅、修改通知目标）由触发器同时取消其待发送投递。数据库迁移 `user_version=10` 把升级前的告警转换为 Bark 投递，已有日志继续显示 Bark 的发送结果。

渠道配置与 Bark 设置一起加密存放在 `user_notifications.value`：原有 Bark 字段（含告警策略）保持不变，新增可选 `channels: {webhook, ntfy, telegram}`，因此旧数据和旧备份无需转换。所有渠道（包括 Bark）通过 `postJson`（`src/server/outbound.ts`）发送：先用 `NetworkPolicy` 解析并检查目标，再把连接固定到检查过的地址，不跟随重定向，响应体最多读取 64 KB。投递错误只保存固定文案。

- `GET /api/notifications`：返回 `NotificationSummary`，即告警策略和各渠道的 `enabled`、`configured` 及非机密字段（脱敏地址、ntfy 服务器与主题、Telegram Chat ID、Webhook 是否签名及请求头名称），不返回地址、密钥、请求头值和令牌。
- `PUT /api/notifications`：请求体为 `NotificationUpdate`，可同时包含策略字段和 `channels.{bark,webhook,ntfy,telegram}` 的局部更新。省略字段保持原值，空字符串清除；清除必填项（Bark／Webhook 地址、ntfy 主题、Telegram Token 或 Chat ID）会自动停用该渠道；`headers` 整体替换。通知目标变化时取消该账号的待发送告警。
- `POST /api/notifications/test`：`{channel, ...未保存字段}`，以已保存设置叠加请求字段发送一次 `event: "test"` 通知，不保存；目标被网络策略拦截时返回 400。
- `GET/PUT /api/notifications/bark` 与 `POST /api/notifications/bark/test` 保留给已有脚本，只读写 Bark 字段，保存 Bark 不会改动其他渠道。
- `GET /api/backups/config` 新增可选 `notificationChannels`；导入时校验，缺省时保留当前渠道。

测试与 E2E 通过 `createApp({ notificationSenders })` 注入各渠道发送器（`barkSender` 仍可单独替换 Bark）；`tests/notify.test.ts` 用本地 HTTP 接收端和精确白名单验证真实发送路径、签名与网络拦截。

## 数据保留与体积

数据库中的日志、事件和缓存都有上限，避免体积随运行时间增长：

| 数据 | 清理规则 | 位置 |
| --- | --- | --- |
| 每个订阅的文章 | 网页订阅 max(200, 输出条数)，RSS 翻译订阅 max(100, 输出条数)，下次抓取时清理 | `storedItemLimit`（`Store.upsertItems`、`RssTranslations.upsert`） |
| 翻译进度事件 | 每个订阅最新 200 条，且不超过 7 天；界面只读最近 100 条 | `RssTranslations.prune` |
| 翻译片段缓存 | 最近使用的 20000 条（`TRANSLATION_CACHE_LIMIT`，备份格式共用同一上限） | `RssTranslations.prune` |
| 抓取日志 | 按「日志保留天数」，默认 30 天 | `FetchHistory.prune` |
| 规则健康样本 | 每个订阅最近 10 条正常样本和 10 条可疑样本，并按「日志保留天数」清理 | `RuleHealth.record` / `RuleHealth.prune` |
| 登录会话 | 过期后每小时清理 | `Store.purgeExpiredSessions` |
| 访问令牌 | 过期 30 天后每小时清理；每个账号最多 50 个 | `ApiTokens.purgeExpired` |
| 访问令牌调用记录 | 按「日志保留天数」；每个令牌最多 2000 条（`API_TOKEN_LOG_PER_TOKEN`）、全站最多 20000 条（`API_TOKEN_LOG_LIMIT`），写入时即裁剪 | `ApiTokenLog.flush` / `ApiTokenLog.prune` |

清理每小时运行一次。新建的数据库使用 `auto_vacuum=INCREMENTAL`，清理后 `Store.compact()` 把空闲页逐步还给磁盘；更早创建的数据库用 `scripts/compact-db.ts` 一次性转换并压缩，用法见[升级维护](maintenance.md#数据库体积)。完整备份导出时翻译缓存也只取最近使用的 20000 条，因此缓存在两次清理之间短暂超限不会让导出失败。

## 国际化

界面、服务端错误、RSS 浏览器预览页、通知和存储的日志文案都来自 `src/shared/locales/` 下的消息文件，由 `src/shared/i18n.ts`（无第三方依赖）提供：

- `en.ts` 是基准：它的键定义 `MessageKey`。其他语言文件的类型是 `LocaleMessages`，缺键或多键都是编译错误；`tests/i18n.test.ts` 还会检查每种语言的占位符和复数形式一致。
- 占位符写作 `{name}`，参数可以是字符串、数字（按语言加千分位）或另一条消息 `msg(key, params)`，在同一语言中翻译。复数写作 `{ one, other }`，按 `count` 参数用 `Intl.PluralRules` 选择。日期、相对时间和列表使用 `Intl`（`formatDateTime`、`formatRelative`、`formatList`）。
- 服务端：`AppError(status, 'error.xxx' | msg(...))` 返回 `{ code, message, error, messageKey, params? }`：`code` 是上面的稳定错误代码（`ApiErrorCode`），`messageKey` 是文案键，`message` 按请求语言翻译。抛出深层错误时用 `LocalizedError`（`BrowserServiceError`、`NetworkPolicyError` 等都继承它），它的 `message` 是当前语言、`englishMessage` 是英文。请求在读者语言（账号偏好 → `Accept-Language` → `DEFAULT_LOCALE`）中运行，后台任务（刷新、翻译、批量、通知）在订阅所有者的语言中运行，见 `src/server/i18n.ts` 的 `withLocale`/`currentLocale`/`tl`。写入数据库的文案按写入时的语言保存。服务端日志统一英文（`describeError` 使用 `englishMessage`）。
- 前端：`src/web/i18n.ts` 的 `t()` 读取当前语言，`App` 通过 `useLocale()` 在切换语言时整体重新渲染；`api.ts` 发送 `Accept-Language`，并优先按错误的 `messageKey` 和 `params` 渲染文案，不认识的键才显示 `message`。
- 迁移 21 给 `users` 加 `locale`（用户选择，现有账号设为 `zh-CN`）和 `detected_locale`（登录时浏览器语言，用于离线通知；不进入备份）。旧备份恢复时 `locale` 默认 `zh-CN`。

新增一种语言：复制 `src/shared/locales/en.ts` 为新文件并翻译（类型改为 `LocaleMessages`），在 `src/shared/locales/index.ts` 登记一行（代码、自称名称）。`pnpm test` 会检查键和占位符；`negotiateLocale` 按语言主标签自动匹配地区变体。

单元测试默认以 `DEFAULT_LOCALE=zh-CN` 运行（沿用原有中文断言），`tests/i18n.test.ts` 自己清除该变量检查英文默认值；e2e 固定 `zh-CN`，英文流程在 `tests/e2e/10-english.spec.ts`。

## 错误处理

未预期的服务器错误对客户端统一返回 `{code:"internal", message:"…", error:"…"}`（`message` 与 `error` 为读者语言的“服务器内部错误”），同时把类型、消息和简短堆栈写入服务日志（不含请求内容）。完整备份导出前会按备份格式校验数据，校验失败时响应里直接给出出错的表和字段，例如 `tables.settings.0`，不会包含数据值。
