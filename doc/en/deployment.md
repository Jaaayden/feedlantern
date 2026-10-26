# Deployment

**English** · [简体中文](../deployment.md)

## 1. Prepare the host

Linux amd64 and arm64 are supported. Allow about 2 GB of memory and a few GB of disk; actual use depends on the sites you follow. The server needs to reach the target sites, and pulling the image needs access to GitHub Container Registry.

On smaller hosts, keep background concurrency at 1 and lower translation concurrency as needed. With no editing session or fetch running, Chromium exits after 60 seconds idle and starts again on demand. This reduces idle memory at the cost of a browser start on the next fetch. The image uses a multi-stage build containing only runtime dependencies and Chromium's headless shell, with installation caches removed. Frontend dependencies are used only during the build; the web interface uses the built assets. Complex pages can still need substantial memory; these changes do not alter item retention or lifetime collection and translation counters.

Install Docker Engine following [Docker's documentation](https://docs.docker.com/engine/install/), then the [Compose plugin](https://docs.docker.com/compose/install/linux/). Check that your user can run:

```sh
docker version
docker compose version
docker info
```

Docker Desktop works for trying it out locally. The Docker CLI alone isn't enough — you need a reachable engine. The container host must allow Chromium's user-namespace sandbox; see Troubleshooting (Chinese) for details.

## 2. Choose how to install

### Docker Compose (recommended)

Create a directory, download [docker-compose.yml](../../docker-compose.yml) and the matching sandbox rules, and start. No install script or source checkout is needed:

```sh
mkdir feedlantern
cd feedlantern
curl -fLO https://raw.githubusercontent.com/Jaaayden/feedlantern/main/docker-compose.yml -fLO https://raw.githubusercontent.com/Jaaayden/feedlantern/main/seccomp_profile.json
docker compose up -d --wait
docker compose logs feedlantern
```

Keep both files in the same directory. Compose uses the `latest` image by default (a build of `main` that passed the full CI, including container checks on both architectures) and sets up the persistent volume, health check, restart policy and log rotation. `seccomp_profile.json` keeps the Chromium sandbox working; don't delete it or replace it with privileged mode.

Updating only means pulling the image and recreating the container — no version numbers to edit and no configuration to download again; see Maintenance (Chinese). The domain goes straight into the [Nginx template](../nginx.md) (Chinese), so no `.env` is needed. Advanced users can still pin a tag with `FEEDLANTERN_VERSION` to reproduce or roll back.

### Building from source

To try the source before CI publishes an image:

```sh
git clone https://github.com/Jaaayden/feedlantern.git
cd feedlantern
docker build -t ghcr.io/jaaayden/feedlantern:local .
FEEDLANTERN_VERSION=local docker compose up -d --wait
```

Keep setting `FEEDLANTERN_VERSION=local` for later commands, or put it in the deployment directory's `.env`. Don't commit `.env` to Git.

## 3. First-run setup

```sh
docker compose ps
docker compose logs --tail=50 feedlantern
```

Open `http://127.0.0.1:4321` and enter the one-time setup code from the log together with the administrator's username and password. There is no default password; the setup code is deleted once setup is done. If you already have a full backup, choose “Restore from backup” instead of creating an administrator first.

The setup page follows your browser's language and has a language menu; the administrator can change the language later in Settings → Account & password. To make the server's fallback language Simplified Chinese (for browsers in other languages and for alerts of users who haven't signed in yet), set `DEFAULT_LOCALE=zh-CN`; see [Configuration](configuration.md#language).

The default port is bound to the host's loopback address only. For a remote server, open an SSH tunnel first:

```sh
ssh -L 4321:127.0.0.1:4321 user@your-server
```

Then open the same address in your local browser. For long-term access with a domain, follow the [Nginx guide](../nginx.md) (Chinese).

## 4. Verify

1. After creating the administrator, sign out and back in to check that signing in works.
2. Add a public article list, preview and save it, and copy the RSS address into a reader.
3. Refresh it once and check the last success time; close the page and wait for a scheduled update.
4. Run `docker compose restart` and check that feeds and history are still there.
5. Before relying on it, export an encrypted backup and keep the password safe.

Data lives in the Compose named volume `feedlantern_data`, including the database and this machine's encryption key. `docker compose down` keeps the volume; `down -v` deletes the data and isn't for everyday maintenance.

## Checking RSS translation connectivity

RSS translation reuses the same container and volume; no Redis, external database or extra service is needed. The free Google channel needs the container to reach `translate-pa.googleapis.com`; a browser on the host translating fine doesn't mean the container's exit works.

Run in the deployment directory:

```sh
docker compose exec feedlantern node --import tsx scripts/check-translation.ts
```

The command translates three fixed public sample texts in one request and waits at most 20 seconds. On success it shows how many translations came back and how long it took; on failure it exits with a non-zero code. If you hit an automated-traffic page or HTTP 429, retry later or check the server's network exit; FeedLantern doesn't work around the limit or switch to a paid API on its own. The free Google channel may change, and local tests with a mock service can't replace checking connectivity on the real server.

Fetching RSS sources follows the target host policy and encrypted DNS option in the settings. Private and special addresses are blocked by default and every redirect is checked again; to follow an RSS service on your own private network, add its host and port to the allowed target hosts setting.
