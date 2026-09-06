# 公网烟雾验收记录

这份记录只描述真实 Chromium 通过 `BrowserService` 的结果。它不把本地 fixture 的通过结果当作公网兼容性证明，也没有使用用户 Cookie 或 RSS token。

## 执行方式

执行日期：2026-09-06（Asia/Shanghai）。

```sh
PLAYWRIGHT_BROWSERS_PATH=0 pnpm exec tsx scripts/public-smoke.ts
```

脚本对每个目标创建真实浏览器会话，等待页面完成加载，调用自动识别，然后只记录最多三个候选和最多三个标题/链接样例。浏览器会话结束后立即关闭，脚本不会保存网页内容、Cookie 或认证信息。

## 结果

第一次完整运行（`2026-09-06T10:38:21.037Z`）得到以下结果：

| 页面 | 结果 | 识别信息 |
| --- | --- | --- |
| `https://news.ycombinator.com/news` | 失败 | 页面导航等待 30 秒后超时，未产生候选。 |
| `https://github.blog/changelog/` | 页面可加载，但识别结果存在误配 | 页面标题为 `GitHub Changelog`；推荐 `candidate-1`，当时被判为高可信，18 条。标题、链接、摘要和日期覆盖率均被报告为 100%，图片覆盖率为 0%。 |
| `https://developer.chrome.com/blog/` | 未纳入第一次运行 | 该页面作为后续补充目标加入脚本。 |

GitHub Changelog 当时返回的前三个“标题”和链接样例为：

1. `Sep.04 Release` → `https://github.blog/changelog/2026-09-04-github-copilot-weekly-releases-august-31`
2. `Sep.04 Release` → `https://github.blog/changelog/2026-09-04-gpt-6-astra-is-generally-available-in-github-copilot`
3. `Sep.04 Release` → `https://github.blog/changelog/2026-09-04-new-api-endpoint-provides-privacy-safe-star-history-data`

这三个值实际是每个条目的日期和类别元信息，不是文章标题。对应主标题链接文本分别是 `GitHub Copilot weekly releases — August 31`、`GPT-6 Astra is generally available in GitHub Copilot`、`New API endpoint provides privacy-safe star history data`。因此，这次结果应记录为一次真实的自动识别误配；当时的“高可信”和 100% 标题覆盖率不能作为正确性证明。页面还返回了两个低可信竞争候选（计数为 0），推荐列表提示图片字段没有稳定识别。

## 本地修复

针对这次误配，检测器已做两项通用修复：

- 条目内带有日期、时间、发布、类别或元信息信号的节点会降低标题评分；语义明确的主标题链接优先于重复的日期/类别文本，不依赖 GitHub 的具体 class 名称。
- 标题和链接覆盖率的分母改为发现阶段的条目数，而不是抽取后仍然有效的条目数；高度重复的标题会产生警告并阻止高可信判定。

新增本地 fixture 覆盖了“日期/类别元信息 + 主标题链接”和“缺失字段 + 重复标题”两种情况。2026-09-06 本地完整测试为 26 项通过。修复后尚未重新运行公网烟雾脚本，因此本记录不把公网复验标记为通过。

第二次运行（`2026-09-06T10:39:51.080Z`）中，Hacker News 仍在导航阶段超时，GitHub Changelog 和 Chrome Developers Blog 被浏览器的网络策略在主导航阶段拒绝。随后直接检查 DNS 解析发现当前验收环境把这三个公网域名解析到 `198.18.5.x` 地址（例如 `github.blog → 198.18.5.199`）。`198.18.0.0/15` 是基准测试保留地址段，FeedLantern 的 SSRF 防护会有意阻断它；这次拒绝是预期的安全行为，不能作为这些页面内容识别失败的证据。

因此，本次公网证据能确认 GitHub Changelog 曾经在真实 Chromium 中完成一次页面加载和自动发现，但也暴露了标题误配；Hacker News 在当前环境未完成识别，Chrome Developers Blog 的补充运行也受到同一 DNS 条件影响。要验证修复后的公网行为，应在另一台网络环境重新运行脚本，并记录该次原始 JSON 输出。

## 用户网址复验与 Fake-IP 兼容修复

2026-09-06 用户报告两个公开网址均显示 `Bad Request`。复现确认 Fastify 错误处理器注册时机导致错误正文采用默认格式，同时本机 DNS 把两站解析为 `198.18.5.206` / `198.18.5.207`。增加可选 `DNS_OVER_HTTPS=true`，从 Cloudflare 加密 DNS 获取真实 IPv4 后仍执行私网校验和固定 IP 连接。没有放行保留地址段。

应用该设置并修复通用检测规则后，真实 Chromium 复验结果：

| 用户网址 | 自动推荐 | 实际内容 |
| --- | --- | --- |
| https://slst.shanghaitech.edu.cn/researchprogress/list.htm | candidate-1，14 条 | 正确提取科研进展标题、文章链接和日期；不把标题重复用作摘要 |
| https://uioqps.github.io/ | candidate-1，10 条 | 正确推荐文章卡片，首条为「2024年终总结」；提取链接、图片和日期 |

这次修复还解决了选择器重放扩展到页脚、序号 class 破坏分组、同级日期段落误作摘要、关闭 HTTPS 隧道时未处理 EPIPE 导致服务退出的问题。博客另有论文链接候选，评分低于文章卡片，不作为自动推荐。该页面部分条目摘要为空。

## 其他限制

- 这是单次、少量公开页面的烟雾测试，不代表对任意网站的兼容性。
- HN 的导航超时可能来自当前网络路径、站点响应或中间层，并非自动识别器已经得到“无列表”结论。
- 这次 GitHub Changelog 的 `Sep.04 Release` 重复值已确认是此前检测器的误配样本；修复后的公网行为尚未复验。
- GitHub 页面未稳定提供条目图片，FeedLantern 不会用站点图标或页面级图片填充条目图片。
- 测试没有覆盖需要 Cookie、交互登录、验证码、iframe、封闭 Shadow DOM、Canvas 内容、翻页或无限滚动的公网页面。
