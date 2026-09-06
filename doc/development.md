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

React/Vite 前端；Fastify API；SQLite Store；Playwright BrowserService；共享 DOM 提取器和规则发现。后台刷新与批量识别串行排队，编辑会话独立且有存活上限。

SQLite `PRAGMA user_version` 记录迁移：版本 1 增加频道名称与设置表，版本 2 增加持久化任务。已有 v0.1.0 数据在首次启动时迁移，旧名称填入频道名称。更改迁移前必须考虑已有数据库和备份格式兼容。

## API 摘要

所有管理接口要求登录；写操作需要 `X-FeedLantern: 1` 和 `X-CSRF-Token`，并校验 Host/Origin。错误返回 `{error:string}`，响应不缓存。

| 接口 | 用途 |
|---|---|
| `/api/auth/*` | 初始化、登录、退出、修改密码 |
| `/api/credentials` | 凭据元数据及导入更新 |
| `/api/browser/*` | 打开页面、截图、自动发现、点选、预览 |
| `/api/feeds` | 单个订阅创建及管理 |
| `PATCH /api/feeds/:id` | `{channelTitle}`，独立更新 RSS 频道标题 |
| `GET/PUT /api/settings` | `{feedView:'list'|'cards'}` |
| `POST /api/feeds/bulk` | `{ids,action}`；copy/pause/resume/refresh/delete，逐项结果 |
| `GET/POST /api/import-jobs` | 列出/创建批量任务，创建参数 entries 与 intervalMinutes |
| `POST /api/import-jobs/:id/:action` | cancel/retry/confirm；confirm 带 entryId 与完整 input |
| `/api/backups/export` | 加密导出，POST 管理员密码与备份密码 |
| `/api/backups/preview`、`restore` | 预览/覆盖恢复；初始化场景使用 setupToken |
| `GET/POST /api/backups/config` | 轻量配置导出/预览与确认导入 |
| `/feeds/:id/:token.xml` | 无管理员登录的密钥授权 RSS 2.0 |

完整备份格式版本为 1，独立于数据库迁移版本；敏感值只在加密包内部携带可迁移明文，目标实例使用自己的主密钥重新加密。

## 发布

普通提交运行 CI。里程碑更新 package.json、CHANGELOG，完成验收后创建语义化版本标签。版本发布流程依次运行检查、两个架构的原生容器验证，再推送多架构 GHCR 镜像及 Release 部署包。未通过验证不发布正式版。

seccomp 配置来自 Playwright v1.63.0，保留上游配置；更新 Playwright 时同步检查浏览器安装和沙箱行为。容器设计参考 [Playwright Docker 文档](https://playwright.dev/docs/docker)。
