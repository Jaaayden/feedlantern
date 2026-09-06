#!/bin/sh
set -eu
proxy_tmp=$(mktemp -d)
trap 'docker rm -f feedlantern-proxy-test >/dev/null 2>&1 || true; sudo nginx -c "$proxy_tmp/nginx.conf" -s stop >/dev/null 2>&1 || true; rm -rf "$proxy_tmp"' EXIT HUP INT TERM
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$proxy_tmp/key.pem" -out "$proxy_tmp/cert.pem" -days 1 -subj '/CN=localhost' >/dev/null 2>&1
python3 - "$proxy_tmp" <<'PY'
import sys
from pathlib import Path
root=Path(sys.argv[1])
s=Path('doc/examples/nginx.conf').read_text().replace('listen 80;', 'listen 8088;').replace('listen 443 ssl;', 'listen 8443 ssl;').replace('feeds.example.com', 'localhost')
s=s.replace('/etc/letsencrypt/live/localhost/fullchain.pem', str(root/'cert.pem')).replace('/etc/letsencrypt/live/localhost/privkey.pem', str(root/'key.pem'))
(root/'nginx.conf').write_text(f'pid {root}/nginx.pid;\nerror_log /dev/null;\nevents {{}}\nhttp {{\n{s}\n}}')
PY
sudo nginx -t -c "$proxy_tmp/nginx.conf"
sudo nginx -c "$proxy_tmp/nginx.conf"
docker run -d --name feedlantern-proxy-test --network host --init --shm-size=1g --security-opt seccomp=deploy/seccomp_profile.json -e PUBLIC_ORIGIN=https://localhost:8443 -e ALLOWED_TARGET_HOSTS=127.0.0.1:8877 -e TRUSTED_PROXIES=127.0.0.1,::1 feedlantern:test >/dev/null
node scripts/proxy-smoke.mjs
