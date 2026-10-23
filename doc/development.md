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

版本 16 为 `feeds` 增加 `pagination_json`（多页采集设置，NULL 表示只抓源网址这一页）。迁移会先检查列是否已存在。`fetch_logs` 的 `pages`、`note` 列和该表的其他列一样，由 `FetchHistory` 按列存在与否补齐。

多用户迁移版本为 7：统一 `users` 表替代 `admin`，会话引用用户 ID，订阅、凭据和批量任务记录 `owner_id`。原数据迁移到稳定 ID `admin`，旧会话清空。HTTP 层所有资源入口检查归属，批量操作逐项校验；队列执行时重新检查。用户停用递增 `generation`、撤销会话及发出取消信号，后台结果只有代次仍一致时可落库；翻译同时使用任务 revision。

Store 的无 owner 参数列表方法保留给整站后台调度和备份使用，HTTP 工作台必须传入认证的用户 ID。客户端提交的 ownerId 不决定归属。普通用户不读取全局设置，列表偏好存储在浏览器中。

## API 摘要

所有管理接口要求登录；账号管理、全局设置及备份仅管理员可用，跨用户资源与不存在资源均返回 404。写操作需要 `X-FeedLantern: 1` 和 `X-CSRF-Token`，并校验 Host/Origin。错误返回 `{error:string}`，响应不缓存。

| 接口 | 用途 |
|---|---|
| `/api/auth/*` | 初始化、登录、退出、修改自己的密码；登录状态包含 userId、role |
| `GET/POST /api/users` | 管理员列出用户／以 `{username,password}` 创建普通用户 |
| `PATCH /api/users/:id` | 管理员局部更新 `{username?, enabled?, role?}`；身份变化会撤销目标会话，必须保留至少一名启用的管理员，不能停用自己 |
| `POST /api/users/:id/password` | 管理员以 `{password}` 重置普通用户密码，撤销目标账号会话 |
| `/api/credentials` | 凭据元数据及导入更新 |
| `/api/browser/*` | 打开页面、截图、自动发现、点选、预览 |
| `/api/feeds` | 单个订阅创建及管理 |
| `PATCH /api/feeds/:id` | `{channelTitle?, intervalMinutes?}`，至少提供一个；名称同步 RSS 标题，间隔为 5–1440 的整数，变化时重新计时；不触发抓取，兼容仅改名称的旧客户端 |
| `GET/PUT /api/settings` | 仅管理员读取／修改全局配置及管理员视图偏好 |
| `POST /api/feeds/bulk` | `{ids,action}`；copy/pause/resume/refresh/delete，逐项结果 |
| `GET/POST /api/import-jobs` | 列出/创建批量任务，创建参数 entries 与 intervalMinutes |
| `POST /api/import-jobs/:id/:action` | cancel/retry/confirm；confirm 带 entryId 与完整 input |
| `/api/backups/export` | 加密导出，POST 管理员密码与备份密码 |
| `/api/backups/preview`、`restore` | 预览/覆盖恢复；初始化场景使用 setupToken |
| `GET/POST /api/backups/config` | 轻量配置导出/预览与确认导入 |
| `/feeds/:id/:token.xml` | 无管理员登录的密钥授权 RSS 2.0 |

`ScreenFrame` 是从页面顶部截取的第一段截图（JPEG 质量 75，data URL，每段最高 8000 像素）。`height` 为已截取的高度，`documentHeight` 为可截取的总高度（最高 48000 像素；网页更长时 `truncated: true`），`viewportHeight` 为远端视口高度。`POST /api/browser/:id/segment {top}` 截取下一段，`top` 必须等于已截取的高度，否则拒绝，避免重复或跳段；返回 `{top, height, image, documentHeight, map}`。`map` 是元素地图：`boxes` 每 5 个数一组（x、y、宽、高、最近的上层元素序号，根为 -1），坐标相对整页顶部，另含 `labels`、`links`（仅 http/https）和 `innerScroll`。地图是累计的：后续分段只追加新元素，已有序号不变。编辑器据此在本地完成悬停高亮、↑/↓ 调整范围和滚动。

`POST /api/browser/:id/pick` 优先接受元素序号 `{node, exact?}`，也接受整页坐标 `{x, y}`；`exact: true` 保留所选元素，不自动扩展到重复条目或字段元素。带上 `rules` 时，同一请求按新选择器预览并返回 `items`（失败时为 `previewError`）。`POST /api/browser/:id/follow {node}` 在当前会话打开该元素或其上层元素的链接（受同样的网络策略限制）并返回新的 `ScreenFrame`。高亮框、自动识别和日期选区的坐标均相对整页顶部。

多页采集由 `src/server/pagination.ts` 的 `collectPages` 完成：第 1 页由调用方打开，之后在同一标签、同一浏览器上下文中按 `PaginationRules`（`next` / `template` / `loadMore`）逐页处理。后台刷新（`BrowserService.scrape`）、批量确认和编辑器预览都调用它；导航前先做 `NetworkPolicy.assertAllowed`，请求仍经过上下文路由和受限代理。总时长预算为 180 秒，硬超时为预算加 90 秒。`POST /api/browser/:id/preview` 带上 `pagination` 且最多页数大于 1 时，在会话的另一个标签重新打开源网址并试抓，返回 `{items, pagination: PaginationReport}`；`PickRequest.target` 可为 `next`，用于点选“下一页”或“加载更多”。后台刷新传入订阅已保存链接的判断函数，一页全是已见条目时停止；结果写入抓取日志的 `pages` 和 `note`。

`POST /api/browser/:id/scroll` 接受 `{deltaY,x?,y?}`，坐标须同时提供并位于远端视口内；省略时使用视口中心。编辑器只在 `map.innerScroll` 为真时用它滚动页面内部的滚动区域。显式关闭编辑会话会取消进行中的操作并释放容量。

完整备份格式版本为 3（兼容导入 version 1、2），独立于数据库迁移版本；敏感值只在加密包内部携带可迁移明文，目标实例使用自己的主密钥重新加密。

## 发布

普通提交运行 CI；依赖更新由 Dependabot 以 PR 提交。`main` 通过检查、两个架构的原生容器验证后，将同一批已验证镜像发布为多架构 GHCR `sha-<完整提交 SHA>` 和 `latest`。PR 不发布镜像；重跑旧提交不会覆盖已前进的 `main` 对应的 `latest`。镜像记录 `org.opencontainers.image.revision` 便于核对源码。里程碑仍可更新 package.json、CHANGELOG 并创建语义化版本标签；标签流程发布版本化镜像及 Release 部署包，不覆盖跟随 `main` 的 `latest`。

seccomp 配置来自 Playwright v1.63.0，保留上游配置；更新 Playwright 时同步检查浏览器安装和沙箱行为。容器设计参考 [Playwright Docker 文档](https://playwright.dev/docs/docker)。

## RSS 翻译模块

数据库版本 5 增加订阅来源 `source_type`、输出模式 `translation_mode`；RSS 获取状态、任务、译文及片段缓存分别由 `rss_sources`、`translations`、`translation_cache` 保存。版本 6 将旧网页订阅设置为原文输出；网页订阅开启翻译后将已抓取内容同步到翻译队列，原始数据保留。

- `POST /api/rss/preview {url}`：鉴权与 CSRF 保护，获取并返回前三条安全原文预览，不触发翻译。
- `POST/PUT /api/feeds[/id]` 新增 `sourceType: 'rss'` 与 `translationMode: 'original' | 'chinese' | 'bilingual'`。RSS 输入不要求 `rules`、`waitMs` 或 Cookie。新建返回订阅链接后后台获取；来源类型缺省按原有网页订阅处理。
- `PATCH /api/feeds/:id` 支持 `translationMode`；模式切换不改变地址、GUID 或缓存。
- `POST /api/feeds/:id/translation/retry {}`：重试未完成条目，清除该订阅重试计数；保留服务端限流等待期。
- RSS 输出及 ETag 使用同一份仅翻译成功的条目列表；管理端仍返回等待／失败条目。
- 详情及列表的 RSS Feed 增加 `translation: {pending,success,failed}`；详情条目增加 `contentHtml`、`translationStatus`、`translationError`。

RSS HTTP 获取绑定已检查的 IP，限制 5 次重定向、20 秒和 5 MB 响应；单条 HTML 上限 200,000 字符、标题上限 20,000 字符，超限明确失败，不静默截断。XML 禁止 DTD/实体声明。RSS 输出和管理预览都使用安全 HTML，管理预览另加 sandbox 与 CSP。

翻译后台队列与网页抓取池分开，SQLite 任务使用 revision 防止暂停、编辑、删除后的旧结果回写。关闭、恢复备份和应用设置维护时先停止并取消翻译，再操作存储；启动恢复进行中的任务。获取失败进入抓取日志；翻译失败进入独立日志，两类故障分别去重并复用 Bark 发送队列。

完整备份继续接受版本 1，新增字段/表使用兼容默认值，因此新程序可恢复旧备份；包含 RSS 翻译的新备份不应交给旧版本程序恢复。轻量配置格式 2 增加来源与模式，不携带内容缓存。

`tests/rss-translation.test.ts` 验证解析、受限 HTTP、缓存、竞态、备份与接口。E2E 后端注入确定性翻译器与模拟 Bark 发送器，实际 RSS HTTP 和浏览器抓取仍使用本地 fixture；生产入口不包含模拟翻译。运行真实 Google 连接检查可使用 `node --import tsx scripts/check-translation.ts`。

应用设置新增 `translation: {concurrency: 6, requestIntervalMs: 100}`，旧设置和备份缺失时自动采用默认值。并发范围 1–16，间隔范围 0–5000 毫秒；PUT 支持局部更新。全局请求调度器约束真实 HTTP 并发与启动间隔，正文先并行翻译，再按 DOM 顺序组装；局部失败等待已启动操作收敛后再记录重试，禁止半成品进入 RSS。

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

完整备份 version 3 包含个人通知并兼容 version 1、2；只在加密备份内保存可恢复密钥。轻量配置仅导出操作管理员自己的订阅和个人 Bark。开发测试注入模拟 Bark 发送器，禁止向真实设备地址发送测试消息。

## 数据保留与体积

数据库中的日志、事件和缓存都有上限，避免体积随运行时间增长：

| 数据 | 清理规则 | 位置 |
| --- | --- | --- |
| 每个订阅的文章 | 最新 200 条 | `Store.upsertItems` |
| 翻译进度事件 | 每个订阅最新 200 条，且不超过 7 天；界面只读最近 100 条 | `RssTranslations.prune` |
| 翻译片段缓存 | 最近使用的 20000 条（`TRANSLATION_CACHE_LIMIT`，备份格式共用同一上限） | `RssTranslations.prune` |
| 抓取日志 | 按「日志保留天数」，默认 30 天 | `FetchHistory.prune` |
| 登录会话 | 过期后每小时清理 | `Store.purgeExpiredSessions` |

清理每小时运行一次。新建的数据库使用 `auto_vacuum=INCREMENTAL`，清理后 `Store.compact()` 把空闲页逐步还给磁盘；更早创建的数据库用 `scripts/compact-db.ts` 一次性转换并压缩，用法见[升级维护](maintenance.md#数据库体积)。完整备份导出时翻译缓存也只取最近使用的 20000 条，因此缓存在两次清理之间短暂超限不会让导出失败。

## 错误处理

未预期的服务器错误对客户端统一返回 `{error:"服务器内部错误"}`，同时把类型、消息和简短堆栈写入服务日志（不含请求内容）。完整备份导出前会按备份格式校验数据，校验失败时响应里直接给出出错的表和字段，例如 `tables.settings.0`，不会包含数据值。
