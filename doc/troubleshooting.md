# 故障排查

| 症状 | 检查与处理 |
|---|---|
| Docker 无法连接 | 执行 `docker info`；CLI 存在不代表引擎已启动 |
| 镜像 manifest unknown | 检查该版本 Release 是否成功发布，开发版本使用源码构建 |
| Nginx 502 | `docker compose ps` 检查健康状态；确认代理在宿主机运行且指向 127.0.0.1:4321 |
| 请求来源/主机不允许 | 升级至 v0.2.2，按 Nginx 模板覆盖 Host、X-Forwarded-Host 和 X-Forwarded-Proto；无需配置 PUBLIC_ORIGIN |
| HTTPS 后无法登录 | 确认 Nginx 转发 X-Forwarded-Proto 为 https，浏览器 Cookie 为 Secure |
| 识别超时 | 检查目标可达性、等待设置、Cookie；Nginx 等待时间不能短于实际排队与抓取时间 |
| 没有列表或歧义 | 使用候选预览和调整匹配；页面改版需修复已保存规则 |
| Cookie 无效 | 从已登录浏览器重新导入，检查域名、路径及过期时间 |
| Fake-IP DNS 导致拒绝 | 明确需要时设置 DNS_OVER_HTTPS=true；不要关闭私网校验 |
| 备份上传 413 | 检查 Nginx client_max_body_size 与应用上限；更大数据使用停机卷备份 |
| 忘记管理员密码 | `docker compose exec -it feedlantern pnpm admin:reset`，按提示操作，旧会话会撤销 |
| 数据目录权限失败 | 数据目录需由容器用户 UID 1000 读写，数据库和 master.key 不能丢失 |
| Chromium 沙箱无法启动 | 检查 Compose seccomp 文件、宿主机用户命名空间和 AppArmor 策略；不要以 privileged 或 no-sandbox 绕过 |

RSS 地址携带访问密钥，排错时不要贴完整地址、Cookie、备份密码或 setup-token。默认 Nginx 示例不记录可能带密钥的请求日志。

Ubuntu 24.04 等主机可能对无特权用户命名空间施加额外 AppArmor 限制。应按主机安全策略配置针对容器运行时的例外，或使用已验证的兼容主机；项目不自动修改宿主机全局安全策略。

## 订阅抓取失败与 Bark 通知

先打开订阅详情的“抓取日志”，筛选“失败”，对照时间、触发来源和失败原因排查。HTTP 401/403 通常需要检查 Cookie 或访问权限；没有有效条目时，检查页面结构、匹配规则、登录状态和渲染等待。仅没有新文章不属于故障。失败不会清空已有文章。

Bark 显示“未启用”时检查网页“设置 → Bark 故障通知”是否已填写地址并启用；“待发送”可能正在重试；“发送失败”时检查服务到 Bark 的网络及设备密钥。原始响应、设备密钥和认证头不会出现在日志里。持续失败在成功告警后不会重复推送，抓取恢复成功后会重新允许下一次故障告警。

“中断”表示服务重启前抓取未完成，不代表已验证目标网站失效，因此不单独触发 Bark；下一次实际抓取失败才会告警。升级前的历史不可回溯，超过网页配置保留天数的日志自动清理。
