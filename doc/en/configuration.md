# Configuration

**English** · [简体中文](../configuration.md)

A standard deployment needs no `.env`: start Compose and forward to it with the [Nginx template](../nginx.md) (Chinese). Application and advanced server settings are managed in Settings on the web; the environment variables below are only for the first setup and for bootstrapping the deployment.

| Variable | Default and purpose |
|---|---|
| `FEEDLANTERN_VERSION` | Compose image tag, `latest` by default; follows `main` builds that passed the full CI, and can be overridden |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:4321`; requests through a local reverse proxy use the forwarded domain automatically, no setting needed |
| `HOST` / `PORT` | From source `127.0.0.1` / `4321`; inside the container it listens on `0.0.0.0:4321` |
| `DATA_DIR` | From source `data/`; in the container `/app/data` |
| `COOKIE_SECURE` | Turned on automatically for requests through an HTTPS reverse proxy; can be forced on |
| `TRUSTED_PROXIES` | Empty by default, so forwarded IPs aren't trusted; set explicit IPs/CIDRs, comma-separated. It's only imported at first setup and Compose doesn't pass it into the container; for Docker deployments fill it in under Settings → Server & network, see [Nginx](../nginx.md) (Chinese) |
| `ALLOWED_TARGET_HOSTS` | Empty by default; when really needed, allow exact private `host:port` pairs, comma-separated. Also applies to proxy addresses in network profiles, such as a LAN proxy at `192.168.1.10:1080` |
| `DNS_OVER_HTTPS` | false by default; set true in Fake-IP DNS environments — lookups still pass the address checks; feeds with a network profile proxy look up through that proxy |
| `BACKGROUND_CONCURRENCY` | 1 by default, whole numbers 1–4; refreshes and batch detection share it. Each source hostname (across schemes and ports) is fetched one at a time; editing sessions are separate |
| `BROWSER_EXECUTABLE_PATH` | Uses the Chromium installed with Playwright by default |
| `PLAYWRIGHT_BROWSERS_PATH` | Fixed at `/ms-playwright` in Docker; when testing from source, install and run with the same value |
| `DEFAULT_LOCALE` | `en` by default; `zh-CN` also possible. The fallback language, see [Language](#language) |

Page loads wait 1000 ms by default (0–10000); the refresh interval is 5–1440 minutes, 60 by default. Saved rules are used for previews and background refreshes. Each feed publishes 100 items by default, adjustable to 10–500 in its settings; web page feeds keep max(200, items published) items of history and RSS translation feeds max(100, items published). Item filter regexes are at most 200 characters each and 30 per list, and a feed's filters are stopped after 100 ms. Logs, translation events and caches are capped too, so the database stays a stable size; see Maintenance (Chinese).

Cookies are only in plain text while you enter them and while the server actually fetches; the API only returns metadata. Keep this machine's `master.key` together with the database: without the key, cookies and RSS keys in the old database can't be read. To move to another server, prefer restoring an encrypted backup from the web interface.

Private, loopback, link-local and cloud metadata addresses are blocked by default, and DNS, redirects and browser requests are all checked. When a feed's network profile uses a proxy, the proxy address is checked by the same rules, the target URL is still resolved and checked locally, and the proxy only receives the checked IP. Allowing a LAN proxy means traffic through it is no longer bound by this machine's private-network block, so only allow proxies you trust. Don't open up a whole network for one site. The runtime directory, cookies, backups and `.env` never go into Git.

The domain of a reverse proxy is only taken from `X-Forwarded-Host` and `X-Forwarded-Proto` sent by a direct proxy on the loopback address or a private network (including the Docker bridge). Nginx must overwrite both headers, and the container port stays bound to `127.0.0.1`. Trusting client IPs is controlled separately by `TRUSTED_PROXIES`, and by default login rate limiting is shared per proxy connection: when forwarded requests arrive without it, the log warns once — 8 failures then lock everyone out for 15 minutes — so fill in the proxy address as described in the Nginx guide.

Keep the default of 1 on modest hardware or when most feeds are on the same site; with several independent sites and spare memory, set `BACKGROUND_CONCURRENCY=2` in `.env` and restart. Use 4 only with plenty of resources and measurements; concurrency reduces queueing but doesn't make a single fetch faster. See Performance (Chinese) for the method and results.

## Language

The interface, server error messages, stored log text and alerts are available in English (`en`) and Simplified Chinese (`zh-CN`).

- **Interface**: each account's own choice (Settings → Account & password, or the top bar) is saved on the server, so all devices agree. Without a choice, the browser's preferred languages decide; the sign-in and setup pages always follow the browser and offer a language menu.
- **Server responses**: API errors return a stable `code` and a `message` in the account's language, or else the request's `Accept-Language`. The web interface sends its current language, renders known codes itself, and shows `message` otherwise.
- **Work done while you're away** — fetch logs, batch results, translation progress and alerts (Bark, webhook, ntfy, Telegram) — is written in the feed owner's language: their choice, else the language their browser last asked for when they signed in.
- **`DEFAULT_LOCALE`** sets the fallback for all of the above when nothing else applies: requests without a supported `Accept-Language` (scripts, other languages), accounts that have neither chosen a language nor signed in since upgrading, and the feed preview page for visitors in other languages. It's `en` unless set. Operators of a Chinese instance can set `DEFAULT_LOCALE=zh-CN` in `.env` (or the Compose environment) and restart.
- **Upgrading**: accounts that existed before languages could be chosen are set to Simplified Chinese, the interface they had, so nothing changes for them until they switch. Full backups made by earlier versions restore with Simplified Chinese too.
- **Feed content isn't translated by this**: RSS, Atom and JSON Feed output keep their own language — translated feeds are published in their target language (with the matching `<language>`), other feeds as the source provides. Only the channel description FeedLantern writes for an untranslated feed follows the owner's language.
- **Server logs** are always in English, so they read the same on every instance.
- **`pnpm admin:reset`** uses the shell's language (`LANG`, `LC_ALL`).

## Application and server settings on the web

Administrators open Settings → Logs & display to set the feed view and the log retention days (1–365, 30 by default). Translation services and server & network settings are under Settings → Translation services and Settings → Server & network, each saved separately. Every user sets up their own notification channels (Bark, webhook, ntfy, Telegram) and alert policy (failure threshold, push timeout, maximum attempts, retry delays, cooldown and whether to push rule warnings) under Notifications.

Translation services selects the default service (free Google Translate, DeepL, an OpenAI-compatible API) and configures the DeepL API key and plan, the OpenAI-compatible endpoint, model, API key and optional system prompt, and each service's concurrency (1–16) and request interval (0–5000 ms). The default service must be configured before saving. API keys are stored encrypted and never shown; local or LAN models need their exact `host:port` in the network allowlist. See the [user guide](user-guide.md#translation-services).

Server & network offers background concurrency (1–4), the exact network allowlist, DNS over HTTPS, trusted proxy IPs/CIDRs, the public URL, secure cookies, the session lifetime, and the listen address and port. After saving, notification and fetch settings apply at once; network or concurrency changes close old page editing sessions. The listen address and port apply after a restart; the container's port mapping must still match the deployment.

Existing environment variables are only imported when the web settings are first created; afterwards the values saved on the web win. Removing an old `BARK_URL` doesn't lose the migrated Bark settings. The data volume, browser install path and container port mapping belong to the deployment; application settings can't move the database or install the browser.

## Alerts and notification channels

Every user manages their own alerts in Settings → Notifications: the channels (Bark, webhook, ntfy, Telegram) at the top, and the alert policy for all channels below. Several channels can be on at once; each has its own switch, save button and “Send test notification”. The test sends once with the values currently entered, without saving and without needing the channel on; saving and importing never send anything themselves.

Fetch failure and RSS translation failure alerts go to every channel enabled when the alert is raised. Each channel retries and records its result separately, and the fetch log shows something like “Alerts: Bark sent · Webhook failed (…)”. Once any channel delivers, the failure counts as notified and isn't pushed again; if every channel fails, a new failure after the cooldown alerts again. Alert titles and text are written in the feed owner's language.

### Alert policy

The threshold is 10 by default; set “Alert after this many failed fetches in a row” to a whole number from 1 to 1000 (1 alerts on the first failure). Actual fetch failures from scheduled, manual and edit-triggered fetches all count toward the same feed's run, and one success resets it; interruptions from a restart don't count, and restarts and log cleanup keep the count. A changed threshold is applied at the next failure; saving never sends a catch-up alert. This threshold is for fetch failures; RSS translation failures have their own deduplicated alerts.

By default each push times out after 10 seconds, each channel tries at most 3 times, waiting 60 seconds after the first failure and 300 seconds afterwards; once attempts run out, later fetch failures can try again after a cooldown of at least 30 minutes. A failure that was alerted successfully isn't pushed again; a successful fetch resets it, and no recovery message is sent. These settings keep the field names of the old Bark settings (`bark.failureThreshold`, `bark.timeoutSeconds` and so on), so nothing needs reconfiguring after upgrading, and they travel with configuration export/import and backups; older configurations without a threshold use 10.

“Notify when rules may have stopped working” (`ruleHealthAlerts`, on by default) controls rule warnings: they go to every enabled channel, once per warning, without using the failure threshold, and are deduplicated separately from fetch failures. Failed pushes follow the attempts, retry delays and cooldown above, and warnings repeating within the cooldown aren't pushed. Older configurations and backups without the field count as on. See the [user guide](user-guide.md#rule-health-warnings) for how warnings are decided.

Turning channels on or off, or changing where they send, cancels this account's unsent alerts and resets the failure count; new failures follow the new settings. Other users aren't affected. Pushes already received can't be recalled; a lost response or a restart at the wrong moment can repeat a push.

### Bark

Enter the device URL from the Bark app in “Bark push URL”, turn on “Send alerts through Bark” and save — no environment variables or restart needed. The address is an HTTPS URL that includes the device key; self-hosted servers with a path prefix work too. Pushes use the JSON `POST /push` of [Bark API V2](https://github.com/Finb/bark-server/blob/master/docs/API_V2.md).

### Webhook

Sends a `POST` with a JSON body to the HTTP(S) address you enter:

```json
{
  "event": "fetch.failed",
  "title": "FeedLantern: feed fetch failed",
  "message": "Example feed\nTarget: example.com\n…\nReason: HTTP 503",
  "feedId": "…",
  "feedName": "Example feed",
  "error": "HTTP 503",
  "time": "2026-10-22T08:00:00.000Z",
  "panelUrl": "https://feeds.example.com/#/feed/…/logs"
}
```

`event` is `fetch.failed`, `translation.failed`, `rules.warning` or `test` (a test has `null` for `feedId`, `feedName` and `error`) and is also sent in the `X-FeedLantern-Event` header. Integrations should branch on `event`, not on `title` or `message`, which are written in the feed owner's language. `panelUrl` links to the feed panel and is built from the public URL. A 2xx response counts as success; redirects aren't followed.

Optional “Custom headers” take one `Name: value` per line, up to 10, such as `Authorization: Bearer …`; headers FeedLantern sets itself, such as `Host`, `Content-Type` and `Content-Length`, can't be customized. With a “Signing secret”, requests carry `X-FeedLantern-Signature-256: sha256=<hex>`, the HMAC-SHA256 of the raw body with the secret. Verifying it on the receiving side (Node.js):

```js
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
const valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(request.headers['x-feedlantern-signature-256'] ?? ''));
```

### ntfy

Enter the server (`https://ntfy.sh/` by default; self-hosted servers and path prefixes work) and the topic; for a protected topic also enter an access token (sent as `Authorization: Bearer`). Notifications are [published as JSON](https://docs.ntfy.sh/publish/#publish-as-json) to the server root, and tapping one opens the feed panel. On a public server a topic name works like a password, so pick one that's hard to guess.

### Telegram

Create a bot with @BotFather to get the bot token. The chat ID is a numeric ID (groups are usually negative) or a public channel's `@channelname`; the bot must be able to message the chat first (send /start to the bot in a private chat; add the bot to groups and channels). Notifications use `sendMessage` at `https://api.telegram.org`, with a link to the feed panel.

### Network security and stored secrets

Outgoing requests of every channel (Bark included) pass the same network security policy as page fetches: the target is resolved, private, loopback, link-local and cloud metadata addresses are refused, the connection is pinned to the checked IP, and redirects aren't followed. To push to a service on your private network (such as a self-hosted ntfy or webhook receiver), an administrator adds its exact `host:port` to Server & network → Network allowlist (or `ALLOWED_TARGET_HOSTS`). When blocked, the test says so directly and the fetch log shows that the network security policy blocked the address.

Bark URLs, webhook URLs, signing secrets, custom headers, ntfy access tokens and Telegram bot tokens are encrypted in the database with this machine's `master.key`. Personal settings are separated per user, and administrators can manage them through the target workspace. The API only returns whether each is configured, masked addresses and header names — never the values. Leaving a field empty on the web keeps the saved value; values are only deleted with “Clear settings” or “Remove signing secret / Remove custom headers” followed by saving. The ntfy server and topic and the Telegram chat ID aren't secrets and are shown normally. Errors and logs only contain fixed text, never addresses or tokens.

Only administrators can export the configuration, which carries their own Bark settings and other notification channels (secrets in plain text) for a complete migration — keep it private. Full backups are encrypted with the backup password and re-encrypted with the target server's key when restored.

When upgrading to v0.5.1, the old global Bark settings moved to the original administrator and other accounts started with notifications off. Fetch and translation failures only notify the feed's owner; without channels there is no fallback. Test buttons name the receiving account, and saving never sends anything.
