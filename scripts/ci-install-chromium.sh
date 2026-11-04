#!/usr/bin/env bash
# Installs Chromium and its system packages on a CI runner, reusing the
# packages the workflow cached so a slow mirror cannot stall the job.
#
# Why: the only system packages `playwright install --with-deps` has to fetch
# on the ubuntu-22.04 runner are nine font packages (the layout assertions in
# the browser tests rely on them). They come from the runner's Ubuntu mirror,
# which now and then slows to a crawl: one run spent 462 s on a 747 kB package
# while a normal install takes about 26 s. Every job that needs a browser waits
# for the slowest runner, so one slow download slowed the whole pipeline.
#
# Retrying a stalled download does not help (the mirror stays slow, and the
# killed apt-get keeps holding the dpkg lock), so the downloaded .deb files are
# kept in a directory the workflow caches and installed from there next time.
set -euo pipefail

debs="${CI_APT_DEB_CACHE:-$HOME/.cache/ci-apt-debs}"
mkdir -p "$debs"

# 1. Install the cached packages first so the step below finds nothing to
#    download. If that fails for any reason, the normal install still runs.
if compgen -G "$debs/*.deb" > /dev/null; then
  sudo apt-get install -y --no-install-recommends "$debs"/*.deb \
    || echo "::warning::Cached packages could not be installed; falling back to the mirror"
fi

# 2. The browser itself (skipped when the cached copy is current) and whatever
#    system packages are still missing.
pnpm exec playwright install --with-deps chromium

# 3. Keep what was downloaded for the next run. On a cache hit nothing new was
#    downloaded, so this adds nothing and the cache is not saved again.
cp -n /var/cache/apt/archives/*.deb "$debs"/ 2> /dev/null || true
echo "apt archives: $(ls /var/cache/apt/archives/*.deb 2> /dev/null | wc -l) packages; package cache: $(ls "$debs"/*.deb 2> /dev/null | wc -l) packages"
apt-config dump | grep -i -E 'Keep-Downloaded|Dir::Cache::archives|Clean-Installed|Post-Invoke' || true
ls -la /etc/apt/apt.conf.d/ || true
