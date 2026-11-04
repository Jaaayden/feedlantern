#!/usr/bin/env bash
# Installs Chromium and its system packages on a CI runner, reusing the
# packages the workflow cached so a slow mirror cannot stall the job.
#
# Why: the only system packages `playwright install --with-deps` has to fetch
# on the ubuntu-22.04 runner are nine font packages (the layout assertions in
# the browser tests rely on them). They come from the runner's Ubuntu mirror,
# which now and then slows to a crawl: runs have spent 7-8 minutes on 18 MB
# while a normal install takes about 25 s. Every job that needs a browser waits
# for the slowest runner, so one slow download slowed the whole pipeline.
#
# Retrying a stalled download does not help (the mirror stays slow, and the
# killed apt-get keeps holding the dpkg lock), so the downloaded .deb files are
# kept in a directory the workflow caches and put back into apt's own download
# directory next time. Installing them by path (`apt-get install ./x.deb`) does
# not work: apt prefers the mirror when it offers the same version.
set -euo pipefail

debs="${CI_APT_DEB_CACHE:-$HOME/.cache/ci-apt-debs}"
archives=/var/cache/apt/archives
mkdir -p "$debs"

# 1. Put the cached packages where apt looks for finished downloads. When their
#    version and checksum still match the mirror's index, apt skips downloading
#    them; otherwise it simply downloads as usual.
if compgen -G "$debs/*.deb" > /dev/null; then
  echo "Reusing $(ls "$debs"/*.deb | wc -l) cached system packages"
  sudo cp -n "$debs"/*.deb "$archives"/ || true
fi

# 2. The browser itself (skipped when the cached copy is current) and whatever
#    system packages are still missing.
pnpm exec playwright install --with-deps chromium

# 3. Keep what is in apt's download directory for the next run. On a cache hit
#    nothing new was downloaded, so this adds nothing and the cache is not
#    saved again.
cp -n "$archives"/*.deb "$debs"/ 2> /dev/null || true
