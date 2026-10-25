# Agent CLI 与 MCP

`feedlantern` 命令行让脚本和 AI Agent（例如 Claude Code）直接管理 FeedLantern 实例：识别网页、调规则、创建和刷新订阅、查看日志和条目。同一个程序用 `feedlantern mcp` 启动 MCP server，把同一批操作提供给支持 MCP 的客户端。

它只通过个人访问令牌调用公开 API（[OpenAPI 文档](development.md#用令牌调用-api)），能做的事与令牌权限完全一致，不会绕过任何限制。

## 安装

CLI 是仓库中的 workspace 包 `packages/cli`（npm 包名 `feedlantern-cli`），需要 Node.js 20 或更高版本。它目前没有发布到 npm 注册表，从仓库打包安装：

```bash
pnpm install --frozen-lockfile && pnpm build
```

```bash
(cd packages/cli && npm pack)
```

```bash
npm install --global ./packages/cli/feedlantern-cli-0.8.1.tgz
```

`npm pack` 生成的 `.tgz` 可以复制到其他机器上用同样的命令安装，安装时会从 npm 下载依赖（MCP SDK 和 zod）。不想全局安装时，在仓库里直接运行打包好的文件：

```bash
node packages/cli/dist/feedlantern.js whoami
```

服务镜像中也带有打包好的 CLI 和它的运行依赖（不含开发依赖），可以在容器里直接运行，例如在服务主机上检查实例：

```bash
docker compose exec -e FEEDLANTERN_URL=http://127.0.0.1:4321 -e FEEDLANTERN_TOKEN=fl_xxxxxxxx feedlantern node packages/cli/dist/feedlantern.js health
```

将来发布到 npm 后，也可以用 `npm i -g feedlantern-cli` 或 `npx -y feedlantern-cli <命令>`。

### 版本对应

CLI 的版本号与服务端保持一致，随服务端一起发布：CLI 0.7.x 对应服务端 0.7.x。0.x 阶段接口可能在小版本之间变化，所以 CLI 要求主版本号和次版本号与服务端相同（1.0 以后只要求主版本号相同），补丁版本互相兼容。`feedlantern health` 和 `whoami` 的 `compatible` 字段给出判断结果；不匹配时请安装与服务端同版本的 CLI。

`whoami` 中的令牌详情和 `tokens logs` 依赖 `GET /api/tokens/current`，在更早的服务端上这两项不可用（`whoami` 只返回令牌权限，`tokens logs` 返回 `not_found`）。

## 连接与令牌

在网页“设置 → 访问令牌”创建令牌。只查询用 read 令牌；要创建、修改订阅，或运行 `detect`、`preview`、`rss preview`、`pubmed preview`（它们要由服务器访问外部网站），需要 write 令牌。

地址和令牌按以下顺序取值，前面的优先：

1. 命令行选项 `--server`（只有地址，没有令牌选项，避免令牌留在 shell 历史里）；
2. 环境变量 `FEEDLANTERN_URL`、`FEEDLANTERN_TOKEN`；
3. 配置文件（默认 `~/.config/feedlantern/config.json`，可用 `XDG_CONFIG_HOME` 或 `FEEDLANTERN_CONFIG` 改位置；Windows 为 `%APPDATA%\feedlantern\config.json`）。

`login` 验证令牌后写入配置文件，文件权限 0600、目录 0700；读取时发现其他用户可读会给出警告：

```bash
feedlantern login --server https://feeds.example.com
```

在终端里运行时会提示粘贴令牌（不回显）。在脚本里用标准输入传入：

```bash
printf '%s' "$TOKEN" | feedlantern login --server https://feeds.example.com --token-stdin
```

配置文件可以保存多个实例（档案），用 `--profile` 或 `FEEDLANTERN_PROFILE` 选择，第一个保存的档案成为默认档案：

```bash
printf '%s' "$STAGING_TOKEN" | feedlantern login --server https://staging.example.com --profile staging --token-stdin
```

```bash
feedlantern feeds list --profile staging
```

`feedlantern config` 显示当前使用的地址、档案和令牌来源（令牌打码），`feedlantern logout` 删除当前档案保存的令牌。管理员可以用 `--workspace <用户ID>`（或 `FEEDLANTERN_WORKSPACE`）在其他用户的工作台中操作，与网页上的 `X-FeedLantern-User` 相同。

CLI 用令牌调用时不检查 Host，所以用内网地址（例如 Docker 网络里的 `http://feedlantern:4321`）也可以访问；不带令牌的请求仍要求地址与 `PUBLIC_ORIGIN` 一致。

## 输出与退出码

- 默认在标准输出打印一行 JSON，便于程序解析；`--pretty` 输出缩进 JSON；`--table` 输出表格给人看。
- 出错时标准输出为空，标准错误打印 `{"error": {...}}`：

```json
{"error":{"code":"token_read_only","status":403,"message":"只读令牌不能执行写操作","hint":"当前是只读（read）令牌，只能执行查询；写操作需要在“设置 → 访问令牌”中创建 write 令牌","method":"POST","path":"/api/feeds"}}
```

`code` 是稳定的机器可读代码，`message` 和 `hint` 面向人，可能随语言变化。`code` 包括服务端返回的 `token_read_only`、`token_not_allowed`、`unauthorized`、`forbidden`、`validation`、`not_found`、`conflict`、`too_large`、`rate_limited`、`source_not_feed`、`server_error`、`upstream_error`、`unavailable`，以及 CLI 自己的 `usage`、`not_configured`、`network`、`timeout`、`bad_response`、`internal`。

| 退出码 | 含义 | 对应 code |
| --- | --- | --- |
| 0 | 成功 | |
| 1 | CLI 内部错误 | `internal` |
| 2 | 用法或配置错误：参数不对、缺少 `--yes`、没有配置地址或令牌 | `usage`、`not_configured` |
| 3 | 鉴权失败：令牌无效或过期、只读令牌执行写操作、令牌无权调用的接口、账号权限不足 | `unauthorized`、`token_read_only`、`token_not_allowed`、`forbidden` |
| 4 | 服务端拒绝了请求：参数校验失败、不存在、冲突、内容过大、限流，RSS 来源返回的是网页（常见于反爬验证页）而不是订阅源，或 PubMed 查询式无法发送 | `validation`、`not_found`、`conflict`、`too_large`、`rate_limited`、`source_not_feed`、`pubmed_query_invalid` |
| 5 | 服务端错误，或响应不是 FeedLantern 的 JSON | `server_error`、`upstream_error`、`unavailable`、`bad_response` |
| 6 | 网络错误或超时 | `network`、`timeout` |
| 7 | 批量操作部分失败（结果仍打印在标准输出） | |

`feeds refresh` 在抓取失败时仍返回 0，结果中的 `ok: false` 和 `error` 说明原因（请求本身成功了）；抓取失败的原因只以文字保存在 `feed.lastError` 和抓取日志中，没有错误代码。创建 RSS 翻译订阅前先运行 `rss preview <url>`：来源返回网页而不是 RSS/Atom 时得到 `code: "source_not_feed"`（退出码 4；PubMed 期刊 RSS 被 NCBI 的验证页拦截时也是它，改用下文的 PubMed 检索订阅）。`pubmed preview` 的查询式无法发送（引号或括号不配对、AND/OR/NOT 缺少一侧）时为 `pubmed_query_invalid`，NCBI 请求失败时为 `upstream_error`，NCBI 限流或实例的 NCBI 队列过长时为 `rate_limited`。默认超时 180 秒，可用 `--timeout <秒>` 或 `FEEDLANTERN_TIMEOUT` 调整。

## 写操作的保护

- 所有写操作都支持 `--dry-run`：读请求照常发送（例如修改前先读取订阅），写请求只打印不发送，输出 `{"dryRun": true, "requests": [...]}`，其中 `Authorization` 已打码。不需要 write 令牌也能 dry-run。
- 不可撤销的操作（`feeds delete`、`bundles delete`、`bulk delete`、`api DELETE …`）必须加 `--yes`（或 `-y`），否则以退出码 2 结束，不发出任何请求。

## 命令

运行 `feedlantern help` 查看全部命令，`feedlantern help <命令>` 查看某个命令的选项。

| 命令 | 说明 |
| --- | --- |
| `login` / `logout` / `config` | 保存、删除、查看连接配置 |
| `whoami` | 令牌所属账号、权限、有效期、版本是否匹配 |
| `health` | 实例是否可访问、延迟、版本、令牌是否有效 |
| `feeds list [--status active\|paused\|failing\|warning]` | 列出订阅 |
| `feeds get <id>` | 订阅详情、RSS/Atom/JSON 地址、条目输出统计 |
| `feeds create --url <网页> --rules <JSON> [--name …]` | 创建订阅（网页订阅立即抓取一次）；`--rss` 创建 RSS 翻译订阅 |
| `feeds update <id> [字段选项]` | 修改订阅，见下文 |
| `feeds delete <id> --yes` | 删除订阅 |
| `feeds pause\|resume <id>` | 暂停 / 恢复（恢复时立即抓取）；状态已相同时返回 `changed: false` |
| `feeds refresh <id>` | 立即抓取一次 |
| `feeds items <id> [--limit N] [--status published\|excluded\|…]` | 已保存的条目及输出状态 |
| `feeds logs <id> [--status …] [--limit N] [--cursor …]` | 抓取日志，分页 |
| `detect <url>` | 自动识别列表，返回候选规则、字段覆盖、样例和可直接创建的 `suggestion` |
| `preview --url <网页> --rules <JSON>` | 用规则预览抽取结果，不保存 |
| `preview --feed <id> --title h3` | 在已保存订阅的网页上预览修改后的规则 |
| `rss preview <url>` | 预览 RSS 源前 3 条 |
| `pubmed preview [--query <查询式> \| 检索条件选项]` | 预览 PubMed 检索：实际发送的 `query`、匹配总数 `count`、NCBI 提示 `warnings` 和最新 5 篇 |
| `pubmed create [--query … \| 检索条件选项] [--name …] [--limit 10\|20\|50\|100]` | 创建 PubMed 检索订阅（首次抓取在后台进行） |
| `pubmed convert <id> \| --all-verified [--query …] [--recheck] [--yes]` | 验证并把 PubMed RSS 订阅转换为检索订阅；默认只出报告 |
| `pubmed checks [--job id] [--wait] [--cancel] [--retry] [--start]` | 查看或管理后台验证任务：进度、预计剩余时间和每个订阅的结果 |
| `bundles list\|get\|create\|update\|delete` | 聚合订阅；`update` 用 `--feeds` 整体替换成员，`--add-feeds` 追加 |
| `bulk <action> <id>...` | 批量 `copy`、`pause`、`resume`、`refresh`、`delete`、`settings --settings <JSON>` |
| `imports list\|create <url>...\|cancel <id>\|retry <id>` | 批量添加任务（后台自动识别并创建） |
| `tokens logs [--status success\|denied\|error]` | 当前令牌自己的调用记录 |
| `api <METHOD> <path> [--data <JSON>] [--query k=v]` | 直接调用任意开放给令牌的接口 |
| `mcp [--read-only]` | 以 stdio 运行 MCP server |

规则和其他 JSON 参数可以直接写 JSON，也可以写 `@文件路径`，或写 `-` 从标准输入读取。规则也可以用单独的选项给出：`--item`、`--title`、`--link`、`--description`、`--image`、`--date`，它们覆盖 `--rules` 中的同名字段。`feeds create` 和 `feeds update` 另支持 `--data <JSON>` 一次给出多个字段（单独的选项优先），字段名与 API 的 `FeedInput` 相同。

`feeds update` 只修改给出的字段：

- 改网址、规则、等待（`--wait-ms`、`--wait-for`）、翻页（`--pagination`）、凭据或来源类型时，与已保存的设置合并后整体替换，并立即重新抓取。规则只写要改的字段；把某个可选规则写成空字符串（例如 `--date ''`）表示删除它。
- 只改名称、刷新间隔、输出条数（`--output-limit`）、保留条数（`--retention-limit`，`auto` 为自动）、条目过滤（`--filter <JSON>`，`none` 为删除）或翻译设置时，只修改设置，不重新抓取。

## 给 Agent 的推荐工作流

```bash
# 0. 确认令牌和权限（token.scope 应为 write）
feedlantern whoami

# 1. 识别：拿到候选规则和 suggestion
feedlantern detect https://example.com/news > detect.json

# 2. 调规则：看 count、coverage（各字段命中数）和 duplicateLinks，逐步修改选择器
feedlantern preview --url https://example.com/news --rules "$(jq -c .suggestion.rules detect.json)"
feedlantern preview --url https://example.com/news --rules "$(jq -c .suggestion.rules detect.json)" --date 'time[datetime]'

# 3. 创建：可以直接把 suggestion 交给 feeds create，再用选项覆盖调整过的规则
jq .suggestion detect.json | feedlantern feeds create --data - --date 'time[datetime]'

# 4. 刷新并检查
feedlantern feeds refresh FEED_ID
feedlantern feeds logs FEED_ID --limit 5
feedlantern feeds items FEED_ID --limit 5
```

### PubMed 检索

`pubmed preview` 和 `pubmed create` 接受完整的查询式 `--query`，或者用选项组合检索条件（与网页构建器生成的查询式相同，条件之间为 AND，二者只能选一种）：`--all-fields`、`--title-abstract`、`--title`、`--author`、`--first-author`、`--last-author`、`--journal`、`--affiliation`、`--mesh`、`--publication-type`、`--language`、`--nlm-id`（都可重复），以及筛选 `--days N`、`--from` / `--to`（`YYYY[/MM[/DD]]`）、`--has-abstract`、`--type Review`（可重复）。需要 OR、NOT 或括号时把整个查询式写进 `--query`。检索词与 PubMed 构建器一样写成 `(检索词[字段])`，默认不加引号（PubMed 会做自动词映射）；需要精确短语时在值里自己加引号，例如 `--title '"stem cell"'`。

```bash
feedlantern pubmed preview --title-abstract cryo-EM --affiliation ShanghaiTech --has-abstract
feedlantern pubmed create --journal "PLoS Pathog" --days 30 --limit 50 --translation bilingual
feedlantern pubmed preview --query '(Sun Jin-peng[Author]) AND (ShanghaiTech University[Affiliation])' --table
```

`pubmed convert <订阅 ID>` 验证一个 PubMed RSS 订阅（期刊 RSS 或检索式 RSS）能否转换为检索订阅：从 RSS 标题还原查询式，用 E-utilities 执行并对比最新条目，输出 `status`（`verified` 可直接转换 / `review` 需要核对）、`reason`、还原的 `query` 和覆盖率；默认只输出报告，不改动任何订阅，加 `--yes` 才转换。需要核对的订阅要用 `--query <核对后的查询式> --yes` 指定。`pubmed convert --all-verified` 在服务器上开始（或沿用正在运行的）后台验证任务并等待完成，加 `--yes` 时只转换 `verified` 的。验证大多只用订阅名和已存条目，每个订阅一次 E-utilities 请求；同时验证 5 个，仍受全局 NCBI 限流约束；地址和名称都没变的订阅沿用上次结果，`--recheck` 全部重新验证。`pubmed checks` 查看最近的任务（`--job <id>`、`--wait` 等待、`--cancel` 停止、`--retry` 重试失败项、`--start [--feeds id,…]` 开始新任务）；任务在后台继续运行，与命令行是否退出无关。转换保留订阅 ID、RSS 地址、条目、译文和全部设置。验证请求不改变任何东西，`--dry-run` 下也会照常发出，只有转换请求被列出。

```bash
feedlantern pubmed convert --all-verified --table
feedlantern pubmed convert --all-verified --yes
feedlantern pubmed convert feed_123 --query '(Hu wanlong[Author]) AND (The University of Hong Kong[Affiliation])' --yes
```

`pubmed create` 默认输出原文、每次抓取最新 20 篇、刷新间隔 60 分钟，名称省略时为“查询式 - PubMed”（与网页一致，过长时从中间截断）。`pubmed convert` 默认保留订阅现有的名称，加 `--rename` 才改为“查询式 - PubMed”；MCP 的 `pubmed_convert`、`pubmed_convert_verified` 对应参数 `rename`。修改已有检索订阅用 `feeds update <id> --data '{"pubmed":{"query":"…"}}'`（不写 `limit` 时保留原篇数，已存条目保留）。所有 NCBI 请求共用实例的限流队列（不带 NCBI API Key 每秒 3 个，带 Key 10 个），请不要在循环里高频预览。

判断规则是否可靠：`coverage.title` 和 `coverage.link` 应等于 `count`，`duplicateLinks` 应为 0；日期、图片和摘要缺失不影响订阅可用。页面需要等待脚本渲染时加 `--wait-for <选择器>` 或 `--wait-ms`。之后如果订阅出现规则失效预警（`feeds list --status warning`），用 `preview --feed <id>` 在订阅的网页上试新规则，再用 `feeds update <id>` 保存。

## MCP server

`feedlantern mcp` 通过 stdio 提供以下工具，参数和返回值与 CLI 相同：

| 工具 | 说明 | 令牌 |
| --- | --- | --- |
| `whoami`、`health` | 当前令牌、实例状态 | read |
| `feeds_list`、`feed_get`、`feed_items`、`feed_logs` | 查询订阅、条目和日志 | read |
| `detect_feed`、`preview_rules`、`rss_preview`、`pubmed_preview` | 识别网页、按规则预览、预览 RSS、预览 PubMed 检索（不保存） | write |
| `pubmed_convert_check` | 在后台开始验证 PubMed RSS 订阅能否转换（不传 `feedIds` 时验证全部，`waitSeconds` 可等待），返回 jobId、进度和每个订阅的还原查询式、覆盖率和 status，不改动订阅 | write |
| `pubmed_check_status` | 查看验证任务的进度和结果 | read |
| `pubmed_convert_verified` | 转换任务中 verified 的订阅（可在任务运行中先转换），需要 `confirm: true` | write |
| `pubmed_convert` | 用验证通过或用户核对过的查询式转换一个订阅，需要 `confirm: true` | write |
| `pubmed_create` | 创建 PubMed 检索订阅：`query`，或 `conditions`（`[{field, term, op?}]`）加 `filters`（`days`、`from`、`to`、`hasAbstract`、`types`） | write |
| `feed_create`、`feed_update`、`feed_pause`、`feed_resume`、`feed_refresh` | 创建和修改订阅 | write |
| `feed_delete` | 删除订阅，需要 `confirm: true` | write |
| `feeds_bulk` | 批量操作，`action: "delete"` 时需要 `confirm: true` | write |
| `bundles_list`、`bundle_get` | 查询聚合订阅 | read |
| `bundle_create`、`bundle_update` | 创建和修改聚合订阅 | write |
| `bundle_delete` | 删除聚合订阅，需要 `confirm: true` | write |
| `imports_list` / `import_create` | 批量添加任务 | read / write |
| `token_logs` | 当前令牌的调用记录 | read |

- 每个写工具都接受 `dryRun: true`，只返回将要发出的请求。
- 出错时工具返回 `isError: true`，内容是与 CLI 相同的 `{"error": {"code", "status", "message", "hint"}}`。只读令牌调用写工具得到 `code: "token_read_only"`。
- `feedlantern mcp --read-only` 只注册查询类工具，适合配合 read 令牌给 Agent 只读权限。
- 工具带 MCP 注解（`readOnlyHint`、`destructiveHint`、`idempotentHint`），客户端可据此决定是否需要用户确认。

### 接入 Claude Code

```bash
claude mcp add feedlantern --env FEEDLANTERN_URL=https://feeds.example.com --env FEEDLANTERN_TOKEN=fl_xxxxxxxx -- feedlantern mcp
```

已经运行过 `feedlantern login` 时可以省略两个 `--env`，MCP server 会读取配置文件。没有全局安装时把最后的命令换成 `node /path/to/feedlantern/packages/cli/dist/feedlantern.js mcp`。只给只读权限时用 read 令牌并加 `--read-only`：

```bash
claude mcp add feedlantern-readonly --env FEEDLANTERN_URL=https://feeds.example.com --env FEEDLANTERN_TOKEN=fl_xxxxxxxx -- feedlantern mcp --read-only
```

在 Claude Code 中运行 `/mcp` 可以确认连接状态。Claude Code 也可以不通过 MCP，直接在终端调用 `feedlantern` 命令，JSON 输出和退出码就是为此设计的。

### 接入 Claude Desktop

编辑 `claude_desktop_config.json`（macOS 位于 `~/Library/Application Support/Claude/`，Windows 位于 `%APPDATA%\Claude\`）：

```json
{
  "mcpServers": {
    "feedlantern": {
      "command": "feedlantern",
      "args": ["mcp"],
      "env": {
        "FEEDLANTERN_URL": "https://feeds.example.com",
        "FEEDLANTERN_TOKEN": "fl_xxxxxxxx"
      }
    }
  }
}
```

Claude Desktop 找不到全局命令时，把 `command` 改成 `node` 的完整路径，`args` 改成 `["/path/to/feedlantern-cli/dist/feedlantern.js", "mcp"]`。保存后重启 Claude Desktop。

令牌写在这些配置文件里等同于保存了密码：只在自己的电脑上使用，不要提交到仓库；不再使用时在网页上吊销。

## 验收测试

在测试实例上用 CLI 做验收时，建议：

- 单独创建一个带有效期的 write 令牌，结束后吊销；用 `feedlantern tokens logs` 检查调用是否符合预期，被拒绝的调用用 `--status denied` 筛选。
- 修改前先用 `--dry-run` 确认请求；脚本根据退出码判断结果，失败时解析标准错误中的 `error.code`。
- 仓库中的 `tests/agent-cli.test.ts`（单元测试，假浏览器）和 `tests/e2e/10-agent-cli.spec.ts`（真实 Chromium 与本地 fixture 网站）可作为编写验收脚本的参考。
