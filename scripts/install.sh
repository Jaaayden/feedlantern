#!/bin/sh
set -eu
version=${FEEDLANTERN_VERSION:-0.2.0}
case "$version" in *[!0-9.]*|'') echo '版本号格式无效' >&2; exit 1;; esac
command -v docker >/dev/null || { echo '请先安装 Docker Engine 和 Compose'; exit 1; }
docker compose version >/dev/null
docker info >/dev/null
command -v curl >/dev/null
command -v sha256sum >/dev/null || { echo '需要 sha256sum 校验工具'; exit 1; }
target=${1:-feedlantern}
if [ -e "$target" ]; then echo "目录 $target 已存在，停止以保护现有配置；升级请按维护文档操作。" >&2; exit 1; fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
base="https://github.com/Jaaayden/feedlantern/releases/download/v$version"
for file in deployment.tar.gz SHA256SUMS; do curl --fail --location --proto '=https' "$base/$file" -o "$tmp/$file"; done
(cd "$tmp" && sha256sum --check SHA256SUMS)
mkdir "$target"
tar -xzf "$tmp/deployment.tar.gz" -C "$target"
printf 'FEEDLANTERN_VERSION=%s\nPUBLIC_ORIGIN=http://127.0.0.1:4321\n' "$version" > "$target/.env"
chmod 600 "$target/.env"
(cd "$target" && docker compose up -d --wait)
printf '\n已启动。进入 %s 后执行 docker compose exec feedlantern cat /app/data/setup-token，创建管理员。\n' "$target"
printf '本机访问 http://127.0.0.1:4321；域名部署见 doc/nginx.md。\n'
