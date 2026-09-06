# 故障排查

| 症状 | 检查与处理 |
|---|---|
| Docker 无法连接 | 执行 `docker info`；CLI 存在不代表引擎已启动 |
| 镜像 manifest unknown | 检查该版本 Release 是否成功发布，开发版本使用源码构建 |
| Nginx 502 | `docker compose ps` 检查健康状态；确认代理在宿主机运行且指向 127.0.0.1:4321 |
| 请求来源/主机不允许 | 浏览器地址、PUBLIC_ORIGIN、Host 转发必须一致；改环境后执行 compose up -d |
| HTTPS 后无法登录 | 确认 PUBLIC_ORIGIN 使用 https，浏览器 Cookie 为 Secure；不要用旧 HTTP 地址访问管理页 |
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
