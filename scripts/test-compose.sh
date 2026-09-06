#!/bin/sh
set -eu
export FEEDLANTERN_VERSION=ci
export PUBLIC_ORIGIN=http://127.0.0.1:4321
trap 'docker compose -p feedlantern-ci down -v >/dev/null 2>&1 || true' EXIT HUP INT TERM
docker tag feedlantern:test ghcr.io/jaaayden/feedlantern:ci
docker compose -p feedlantern-ci up -d --wait
docker compose -p feedlantern-ci exec -T feedlantern node -e "require('node:fs').writeFileSync('/app/data/ci-persistence-check','persisted')"
docker compose -p feedlantern-ci up -d --force-recreate --wait
docker compose -p feedlantern-ci exec -T feedlantern node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('/app/data/ci-persistence-check','utf8'),'persisted')"
echo 'Compose startup, healthcheck and volume persistence through recreation passed'
