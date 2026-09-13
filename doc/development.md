# 开发与接口

## 本地启动

Node.js 24、pnpm 11.25.0：

```sh
pnpm install --frozen-lockfile
pnpm browser:install
cp .env.example .env
pnpm dev
```

开发页面 `http://127.0.0.1:5173`；生产模式 `pnpm build && pnpm start`，默认 `http://127.0.0.1:4321`。只在配置允许的来源访问管理接口。

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

## API 摘要

所有管理接口要求登录；写操作需要 `X-FeedLantern: 1` 和 `X-CSRF-Token`，并校验 Host/Origin。错误返回 `{error:string}`，响应不缓存。

| 接口 | 用途 |
|---|---|
| `/api/auth/*` | 初始化、登录、退出、修改密码 |
| `/api/credentials` | 凭据元数据及导入更新 |
| `/api/browser/*` | 打开页面、截图、自动发现、点选、预览 |
| `/api/feeds` | 单个订阅创建及管理 |
| `PATCH /api/feeds/:id` | `{channelTitle?, intervalMinutes?}`，至少提供一个；名称同步 RSS 标题，间隔为 5–1440 的整数，变化时重新计时；不触发抓取，兼容仅改名称的旧客户端 |
| `GET/PUT /api/settings` | `{feedView:'list'|'cards'}` |
| `POST /api/feeds/bulk` | `{ids,action}`；copy/pause/resume/refresh/delete，逐项结果 |
| `GET/POST /api/import-jobs` | 列出/创建批量任务，创建参数 entries 与 intervalMinutes |
| `POST /api/import-jobs/:id/:action` | cancel/retry/confirm；confirm 带 entryId 与完整 input |
| `/api/backups/export` | 加密导出，POST 管理员密码与备份密码 |
| `/api/backups/preview`、`restore` | 预览/覆盖恢复；初始化场景使用 setupToken |
| `GET/POST /api/backups/config` | 轻量配置导出/预览与确认导入 |
| `/feeds/:id/:token.xml` | 无管理员登录的密钥授权 RSS 2.0 |

`POST /api/browser/:id/scroll` 接受 `{deltaY,x?,y?}`，坐标须同时提供并位于远端视口内；省略时使用视口中心。截图仍为 data URL，编码改用 JPEG 质量 80。显式关闭编辑会话会取消进行中的操作并释放容量。

完整备份格式版本为 1，独立于数据库迁移版本；敏感值只在加密包内部携带可迁移明文，目标实例使用自己的主密钥重新加密。

## 发布

普通提交运行 CI；`main` 通过检查、两个架构的原生容器验证后，将同一批已验证镜像发布为多架构 GHCR `sha-<完整提交 SHA>` 和 `latest`。PR 不发布镜像；重跑旧提交不会覆盖已前进的 `main` 对应的 `latest`。镜像记录 `org.opencontainers.image.revision` 便于核对源码。里程碑仍可更新 package.json、CHANGELOG 并创建语义化版本标签；标签流程发布版本化镜像及 Release 部署包，不覆盖跟随 `main` 的 `latest`。

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
