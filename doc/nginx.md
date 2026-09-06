# Nginx 反向代理与 HTTPS

本示例为 Linux 宿主机 Nginx → 本机 Docker 发布端口 `127.0.0.1:4321`，应用使用独立域名根路径。若 Nginx 在另一个容器中，回环地址不指向应用，需要单独配置共享网络。

## 1. 域名与环境

将 `feeds.example.com` 的 A 记录指向服务器 IPv4；只有服务器确实支持 IPv6 时才设置 AAAA。开放 TCP 80、443，4321 保持只绑定回环。以下每处域名都应替换为自己的域名。

以 Debian/Ubuntu 为例安装工具：

```sh
sudo apt update
sudo apt install nginx certbot
sudo mkdir -p /var/www/certbot
```

在 `/etc/nginx/sites-available/feedlantern` 写入临时 HTTP 配置，先用于申请证书：

```nginx
server {
    listen 80;
    server_name feeds.example.com;
    access_log off;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 404; }
}
```

启用并检查；如果已经存在同名链接，无需重复创建：

```sh
sudo ln -s /etc/nginx/sites-available/feedlantern /etc/nginx/sites-enabled/feedlantern
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/certbot -d feeds.example.com
```

按 Certbot 提示填写邮箱并同意协议。其他系统安装方式见 [Certbot 官方指南](https://certbot.eff.org/instructions?ws=nginx&os=snap)。

## 2. 完整代理配置

将 [examples/nginx.conf](examples/nginx.conf) 的完整内容放到上述站点文件，替换域名及证书路径。示例包含 HTTP 跳转、TLS、请求头、300 秒代理等待及 96 MB 请求大小限制。

该文件禁用本虚拟主机访问日志与代理错误日志，因为 RSS 路径包含订阅密钥。需要诊断时优先检查应用错误；临时开启请求日志会产生敏感数据，应限制权限并及时清理。

关键转发段如下，完整可用配置以示例文件为准：

```nginx
location / {
    proxy_pass http://127.0.0.1:4321;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_cache off;
}
```

Nginx 重新写入转发 IP，不继承客户端提交的伪造值。相关指令见 [Nginx 官方文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。

## 3. 配置应用

在部署目录 `.env` 中设置：

```dotenv
PUBLIC_ORIGIN=https://feeds.example.com
```

HTTPS 来源自动启用 Secure Cookie；源码运行也可显式设置 `COOKIE_SECURE=true`。域名必须与实际管理页面访问地址完全一致，修改后原 HTTP 地址不能用于管理员操作。

为了让登录限速区分真实客户端，需要仅信任 Nginx 的连接来源。源码服务与 Nginx 同机时设置 `TRUSTED_PROXIES=127.0.0.1,::1`。Docker 默认桥接下，宿主机请求通常来自该网络的网关，先查看：

```sh
docker network inspect feedlantern_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

把查到的**单个网关 IP**填入 `.env` 的 `TRUSTED_PROXIES`。不要填整个公网、任意来源或 `true`。如果运行环境转发来源不同，先确认实际网络拓扑，默认不信任代理也是安全的，只会让限速共用一个来源。

```sh
docker compose up -d --wait
sudo nginx -t
sudo systemctl reload nginx
```

## 4. 续期与验收

确保系统启用 Certbot 定时续期；Debian/Ubuntu 软件包通常提供 `certbot.timer`：

```sh
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

在 `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx` 创建可执行脚本，续期成功后加载新证书：

```sh
#!/bin/sh
nginx -t && systemctl reload nginx
```

执行 `sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx`。

访问 HTTPS 域名，验证登录、识别、复制的 RSS 域名和备份导入。HTTP 应跳转 HTTPS。浏览器中实际域名、`PUBLIC_ORIGIN` 和 Nginx `server_name` 应一致。
