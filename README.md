# FeedLantern · 订阅灯

一个本地优先、可自托管的可视化网页 → RSS 服务。

输入网址，自动识别内容列表，预览后保存订阅。需要时可导入 Cookie、手动调整匹配。管理员登录保护管理操作，每条 RSS 使用独立的可撤销订阅密钥。

项目正在实现首个版本，当前工程骨架尚不能作为完整应用使用。

## 技术

Node.js 24 LTS、TypeScript、React、Fastify、SQLite、Playwright Chromium。无需外部 AI API。

## 开发

```sh
pnpm install
pnpm browser:install
pnpm dev
```

本地数据、凭据、密钥及环境配置不进入 Git 仓库。

## License

[MIT](LICENSE)
