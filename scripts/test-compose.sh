#!/bin/sh
set -eu
export FEEDLANTERN_VERSION=ci
export PUBLIC_ORIGIN=http://127.0.0.1:4321
deploy_dir=$(mktemp -d)
cp docker-compose.yml seccomp_profile.json "$deploy_dir/"
cd "$deploy_dir"
trap 'docker compose -p feedlantern-ci down -v >/dev/null 2>&1 || true; rm -rf "$deploy_dir"' EXIT HUP INT TERM
docker tag feedlantern:test ghcr.io/jaaayden/feedlantern:ci
docker compose -p feedlantern-ci up -d --wait
docker compose -p feedlantern-ci logs feedlantern | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>require('node:assert/strict').match(s,/首次管理员设置码：[0-9a-f]{64}/))"
docker compose -p feedlantern-ci exec -T feedlantern node -e "require('node:fs').writeFileSync('/app/data/ci-persistence-check','persisted')"
docker compose -p feedlantern-ci up -d --force-recreate --wait
docker compose -p feedlantern-ci exec -T feedlantern node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('/app/data/ci-persistence-check','utf8'),'persisted')"
echo 'Compose startup, healthcheck and volume persistence through recreation passed'
