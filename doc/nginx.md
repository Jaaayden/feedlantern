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
    proxy_read_timeout 300s;
    client_max_body_size 96m;
}
```

应用根据本机反代的转发头生成正确的 RSS 地址、验证请求来源并设置 HTTPS 登录 Cookie。请保留 Compose 的本地端口绑定；模板关闭访问日志，避免 RSS 密钥进入日志。

以上适用于 v0.2.2 及以后版本，旧版本请先升级。Nginx 若运行在容器里，`127.0.0.1` 指向 Nginx 容器自身，需要使用共享网络的服务地址。
