# Nginx 反向代理

Docker 默认监听 `127.0.0.1:4321`。宿主机 Nginx 转发到这个地址即可，无需创建 `.env` 或填写应用域名配置。

将 [完整 Nginx 模板](examples/nginx.conf) 放到你的 Nginx 站点配置中，替换 `feeds.example.com` 和已有证书的两个路径，然后检查并重载：

```sh
nginx -t && systemctl reload nginx
```

如果已有 HTTPS 站点，只需在该站点中加入：

```nginx
location / {
    proxy_pass http://127.0.0.1:4321;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 300s;
    client_max_body_size 96m;
}
```

应用根据本机反代的转发头生成正确的 RSS 地址、验证请求来源并设置 HTTPS 登录 Cookie。请保留 Compose 的本地端口绑定；模板关闭访问日志，避免 RSS 密钥进入日志。

**还需要一步**：把 Nginx 的地址填入可信代理。登录限速依赖 `X-Forwarded-For` 识别访客，默认不信任任何转发地址，因此所有人会被当成同一个来源，8 次失败就会锁定所有人 15 分钟。在「设置 → 服务器与网络 → 可信反向代理」里每行填一个地址，保存后立即生效。宿主机 Nginx 访问 Docker 容器时，应用通常看到的是网桥网关地址，可用下面的命令查到（项目名默认是 `feedlantern`）：

```sh
docker network inspect feedlantern_default --format '{{range .IPAM.Config}}{{.Gateway}}  {{.Subnet}}{{end}}'
```

只填你自己的代理地址，不要填很大的网段，否则任何人都能伪造 `X-Forwarded-For` 绕过限速。Compose 文件不会把 `TRUSTED_PROXIES` 环境变量传进容器，请在网页里设置。

Nginx 若运行在容器里，`127.0.0.1` 指向 Nginx 容器自身，需要使用共享网络的服务地址。
