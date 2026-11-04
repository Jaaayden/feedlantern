#!/usr/bin/env bash
# Installs Chromium and its system packages on a CI runner.
#
# The system packages (fonts) come from the runner's Ubuntu mirror, which now
# and then slows to a crawl: one run spent 462 s on a 747 kB font package while
# a normal install takes about 26 s (p90 40 s). Because every job that needs a
# browser waits for the slowest runner, each attempt is capped and retried on a
# fresh connection instead of waiting the slow download out.
#
# CI_CHROMIUM_INSTALL_TIMEOUTS overrides the per-attempt limits in seconds,
# e.g. "5 120 120" to rehearse a timed-out first attempt.
set -euo pipefail

read -r -a timeouts <<< "${CI_CHROMIUM_INSTALL_TIMEOUTS:-120 120 120}"

# Let apt give up on a stalled connection, retry a failed download and wait for
# a dpkg lock that a killed attempt may still hold for a moment.
sudo tee /etc/apt/apt.conf.d/99ci-retries > /dev/null <<'APT'
Acquire::Retries "3";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
DPkg::Lock::Timeout "60";
APT

attempt=0
for seconds in "${timeouts[@]}"; do
  attempt=$((attempt + 1))
  if timeout --kill-after=10 "$seconds" pnpm exec playwright install --with-deps chromium; then
    exit 0
  fi
  echo "::warning::Chromium install attempt ${attempt}/${#timeouts[@]} failed or took longer than ${seconds}s; retrying"
  # A killed attempt can leave a half-configured package behind.
  sudo dpkg --configure -a || true
  sleep 3
done

echo "::error::Chromium install failed after ${#timeouts[@]} attempts"
exit 1
