# User guide

**English** · [简体中文](../user-guide.md)

## Language

The interface is available in English and Simplified Chinese.

- **Choose a language**: use the language menu in the top bar, or Settings → Account & password → Language. The choice is saved to your account, so every device you sign in on uses it.
- **Follow the browser**: in Settings → Account & password, choose “Browser language” to clear the saved choice. The interface then follows the browser's preferred languages, and falls back to the server's default language (English unless the administrator set `DEFAULT_LOCALE`, see [Configuration](configuration.md#language)).
- **Before signing in**: the sign-in and setup pages follow the browser's language and offer a language menu; a choice made there is remembered on that device.
- **Upgrading from an earlier version**: accounts that existed before languages could be chosen keep Simplified Chinese, the interface they had. They can switch at any time.
- **What follows the language**: the interface, dates and numbers, error messages from the server, and text written while you're away — fetch logs, batch results, translation progress and alerts (Bark, webhooks, ntfy and Telegram) are written in the language of the feed's owner. Entries already written stay in the language they were written in.
- **What doesn't change**: the content of your feeds. A translated feed is still published in its target language; other feeds keep publishing exactly what the source provides. The browser preview page of a feed address follows the visitor's browser language.

## Users and sign-in

The Users page lists each account's feeds (including failing and paused ones), credentials, last activity and creation date; the totals at the top show accounts, disabled accounts, feeds and failing feeds. Edit, disable/enable and delete are in each row's “⋯” menu. Administrators click “Create user” (top right of the Users page), set a username and an initial password of at least 8 characters, and hand the details over privately. Everyone uses the same sign-in page; there is no self-registration. Usernames, passwords and roles can be changed later; all administrators have the same rights and can manage other administrators. You can't disable or delete yourself, and you can only demote yourself while another active administrator remains. Renaming, changing the password or changing the role signs out all of that account's sessions; renaming doesn't change any RSS address.

Each account sees only its own feeds, cookie credentials, batches and editing sessions — the administrator's everyday workspace follows this rule too. Regular users can create and manage their own web page feeds and RSS translations, using the fetch and translation services the administrator configured. The list/cards view preference is stored per account in the browser.

Everyone can change their own password in Settings; afterwards all sessions and access tokens of that account stop working. A regular user who forgot their password asks an administrator to reset it on the Users page; an administrator who forgot theirs can run `pnpm admin:reset` on the server (it uses the shell's language, `LANG`).

“Disable” signs the user out immediately, closes their page editing sessions, cancels what can be canceled among their fetches and translations, and stops new background tasks and RSS access. Results returned later by old tasks are discarded; existing data is kept. After re-enabling, the user signs in again, their RSS addresses work again, enabled feeds and pending tasks continue, and feeds paused by hand stay paused.

Every user manages their own notification channels in Settings → Notifications (Bark, webhook, ntfy, Telegram — several can be on at once), failure threshold and retry settings, and can send a test through each. Alerts go only to the feed's owner; with no channel enabled nothing is sent, and there is no fallback to the administrator's channels. System settings and full backup/restore are for administrators only. A full backup includes every user's data, so keep it safe.

Administrators can switch to any account with the workspace switcher at the top of the sidebar (“My workspace” or “Managing”), or click “Open workspace” on the Users page, to work with that account's feeds, cookies, batches and personal notifications. While managing someone else, the sidebar and top bar turn amber and a banner shows “Managing: username”; click “Back to my workspace” or choose “My workspace” in the switcher to leave. The address bar includes the account (`#/u/USER_ID/…`), so reloading or going back and forward stays in the same workspace. Actions run as the real administrator, not as the target account. For a disabled user you can view and change saved settings; creating, fetching, translating, browser actions and notification tests need the account enabled first. Cookie values are never shown; you can use or replace existing credentials, and a feed can only use credentials of the same owner.

“Delete user” first shows how many feeds, credentials and batches will go, then asks you to type the username. After confirming, the account, its feeds, history, credentials, batches, personal settings and notification records are permanently deleted, and its RSS addresses stop working. This can't be undone.

## Access tokens

To manage feeds from a script or an AI agent, create a personal access token in Settings → Access tokens: give it a name (so you recognize it later) and choose the scope and expiry.

- **Read only (read)**: can view feeds, items, logs and so on, but change nothing.
- **Read and write (write)**: can also create, change, refresh and delete feeds, credentials and so on.
- Expiry: 30 days, 90 days, 1 year or never.

The full token starts with `fl_` and is **shown only once, right after creation** — copy it immediately. Afterwards the list only shows its first characters, scope, expiry and last use. Click “Revoke” when you no longer need it or suspect it leaked; scripts using it lose access at once.

A token acts as you: it can only reach your own workspace, with the same permissions you have on the web. It can't export or restore backups, manage accounts, or create or revoke tokens — those are web-only. Changing your password, or disabling or deleting the account, revokes all tokens at once. See [Development & API](../development.md#用令牌调用-api) (Chinese) for examples. API errors carry a stable `code`, plus a `message` in the account's language (or the request's `Accept-Language`).

### Call log

Each token shows its calls and failures in the last 24 hours. Click “Call log” to see each call: time, method, endpoint (such as `/api/feeds/:id`), status code, duration and client IP. Filter by succeeded / denied / errors; failed requests are highlighted; 20 per page, with “Load more” for older ones.

- **What's logged**: every `/api/*` request with an `Authorization: Bearer` token, including writes and denied requests (401 expired token, 403 missing permission or browser-only endpoint, 429 rate limited). A 401 for an expired token is logged under that token; unrecognized tokens (mistyped or revoked) aren't logged.
- **What isn't logged**: the token itself and query parameters; endpoints are logged as route templates (`/api/feeds/:id`), never raw paths. **Actions in the web interface (cookie sessions) aren't logged** — the log only shows requests that scripts and agents made with the token.
- **Client IP** follows `TRUSTED_PROXIES`: only requests from trusted proxies use the address in `X-Forwarded-For`.
- **Retention**: shares the log retention days with fetch logs (30 by default), with at most 2,000 records per token and 20,000 per instance; the oldest go first. Revoking a token also deletes its call log.

An administrator managing another user's workspace can view that user's tokens and call logs in Settings → Access tokens (read-only), but can't create or revoke tokens for them.

## Creating a feed

After signing in, click “New feed”, enter the URL and an optional cookie credential, and click “Open and detect”. The arrow next to the button also offers “RSS translation” and “Add in bulk”. FeedLantern looks for repeated lists and matches titles, links and optional fields. A clear result is previewed straight away; when there are several plausible lists, pick a candidate. Missing optional fields don't block saving.

In “Adjust rules” you can click content on the page, switch the item container, clear wrong fields or edit the CSS selectors. Changes are previewed again, and only working rules can be saved. Fields you set by hand are kept when detecting again unless you explicitly choose to replace them.

After loading, the page is scrolled screen by screen to trigger scroll animations and lazy loading in the viewport, then scrolled back. The editor preview, batch detection and background refreshes all use this same process; scrolling takes at most 20 steps or 8 seconds and stops early once the bottom is stable. By default only the source page is processed; to collect more pages, see “Multiple pages” below. Complete collection of infinite scroll or virtual lists isn't guaranteed.

### Multiple pages

While editing the rules, the “Multiple pages” panel below the page view defaults to “Don't paginate; fetch only the source page”. You can choose one method:

- **Click a “Next page” link or button**: click “Pick on the page”, then click the next-page control in the page view, or type a CSS selector. A link with `rel="next"` is preferred when the page has one. Links are opened by address; buttons without an address are clicked, and FeedLantern waits for the list to change before extracting.
- **URL template**: enter a template such as `https://example.com/list?page={n}`, a start page and a step. Page 1 is always the source URL; from page 2, `{n}` becomes the start page, then start + step, and so on. Sites that paginate by offset can use `offset={n}`, start 20, step 20.
- **Click a “Load more” button**: the button is clicked on the same page, and newly appearing items count as the next “page”. It only clicks the button; it doesn't keep scrolling.

“Maximum pages” includes page 1 (default 3, at most 10). “Delay between pages” defaults to 3 seconds and can be 2–30 seconds, plus up to 20% random jitter to reduce the chance of tripping a site's bot protection. Collection stops early when everything on a page was already in the feed (everyday refreshes usually stop after page 1), when the next-page control is missing or disabled, when a new page has no items or repeats earlier pages, or when a URL template page returns 404 or 410. Each link is kept once, page 1 items come first, and one fetch collects at most 1,000 items. Everything collected is saved; older items that disappeared from the site are later cleaned up according to the feed's “Items kept” (200 by default).

“Test pages” opens the pages one by one exactly like a background refresh (in another tab of the editing session, so the current page view doesn't change), shows how many items each page gave and where and why it stopped, and replaces the preview with the merged result. Pagination settings are saved with the feed and can also be set from “Open and adjust rules” in a batch.

Every page uses the feed's cookie credential and the same browser session and passes the same network security checks as page 1: a next-page link or template pointing at a private, local or otherwise internal address is blocked. If page 2 or later fails, the items collected so far are kept, the feed still counts as updated, and the fetch log says which page failed; only a failure on page 1 fails the whole fetch. One multi-page fetch takes at most about 3 minutes and stops at the pages collected by then; background concurrency and one-at-a-time-per-site limits still apply.

### Picking dates

When the date shares a line with the source or category, choose “Date” and click the area with the time. The highlight still covers the whole container, while the hint and preview show the time that was extracted — there's no need to find a separate tag for “3 minutes ago”. You can also enter the date container's CSS selector in the advanced rules.

A valid `datetime` attribute is preferred; then the element's own text, then its full text. Relative times such as “just now” and “3 minutes / hours / days / weeks ago” are understood in English and Chinese. They're estimated from the time the page was loaded, marked “(estimated)” in the preview, and once saved the estimate for a link doesn't drift on later refreshes; an exact time found later replaces the estimate. Several indistinguishable dates, “yesterday”, or vague expressions such as months or years ago aren't guessed, and a failed parse never erases a stored date.

On Mingdao Navigation's `/intel` pages, exact timestamps are read from the embedded data by article link; otherwise the page's own reference time is used for estimates. Clearing the date rule stops extracting new dates; dates already saved are kept.

## Feed settings

Click “Feed settings” in the list or a card, or click a feed's name and switch to the “Feed settings” tab. The feed address, refresh status and “Refresh now” stay at the top of the panel (translated feeds also show finished, waiting and failed counts there, with “Retry unfinished translations”); below are the “Items”, “Activity” and “Feed settings” tabs. With unsaved changes, closing the panel or switching tabs asks first. Name and refresh interval are shown directly and take effect with “Save settings”, without opening or previewing the site. Changing the name also changes the name in the feed list and the RSS channel title; changing only the name keeps the address, history and schedule. The name in the rule editor is the same setting. If an older version had two different names, the reader-facing name is kept and copied to the list. Readers that saved the name, or names you customized in your reader, may not update automatically.

The refresh interval is a whole number of minutes from 5 to 1440. The timer restarts when the change is saved; nothing is fetched right away, paused feeds stay paused, and resuming refreshes at once. Before closing the settings or opening “Edit rules”, unsaved changes ask for confirmation. Pausing or rotating the key doesn't clear settings you're filling in.

### Output: item filter, items published and items kept

“Feed settings → Output” controls which items the feed addresses publish; the RSS, Atom and JSON Feed addresses share it. Filters only affect the output — stored items are never deleted — and apply as soon as you save; reverting or clearing a rule brings items back.

- **Include keywords**: one per line. When set, only items whose title or summary contains one of them are published.
- **Exclude keywords**: one per line. Items whose title or summary contains any of them aren't published; this wins over include keywords.
- Matching is case-insensitive and looks at the published title and summary (for RSS sources and translated feeds, the text without HTML tags). Translated feeds match the translated text, and bilingual output includes the original too; untranslated items aren't published anyway.
- **Match as regular expressions**: each entry is a regex, matched against the title and the summary separately, so `^\[Ad\]` means the title starts with “[Ad]”. To keep output fast, each entry is at most 200 characters, each list at most 30 entries, and nested repetition (such as `(a+)+` or `(a|b)+`) and backreferences aren't allowed. If a feed's regexes run longer than 100 ms they're stopped, that output isn't filtered, and the settings show a warning. Rules are tried on existing items when you save.

While editing, a live line shows “N stored, X published, Y filtered”. After saving, filtered items in “Items” are dimmed and marked “matches an exclude keyword” or “matches no include keyword”; items beyond the limit are marked “Beyond the output limit”.

**Items published** is 10–500 (default 100), counted after filtering. Lowering it doesn't delete anything right away; the next fetch cleans up by the retention rule. Raising it fills up gradually with newly fetched items.

**Items kept** is the most items stored in the database for the feed. Empty means automatic: max(200, items published) for web page feeds and max(100, items published) for RSS feeds, the same as before. You can also enter a whole number from 10 to 1000, but not fewer than items published (saving warns you). Like items published, lowering it doesn't delete right away: the next fetch removes the oldest items. Raising it lets history build up.

A few rules keep items that were already delivered from being delivered again as new:

- Web page feeds recognize new items by the links stored in the database. So on each fetch, items still visible on the site (including every page collected) are kept even beyond the limit; only items that have disappeared from the site are cleaned up. With pagination, everyday refreshes stop once a whole page was already seen, so keeping too few items can make deeper pages look new again — keep at least two pages' worth.
- RSS feeds also remember which items the source contained last time, so cleaned-up items still in the source aren't stored again.
- Translated feeds only publish finished translations; cleaned-up items are deleted together with their pending translation tasks, so they don't use translation quota. Items kept is never below items published, so the output still fills up once translated.
- Rule health warnings only look at each fetch's raw result, not the stored history, so they don't depend on items kept.

## Everyday management

The list view is the default; you can switch to cards and the choice is remembered. Both let you copy the RSS address, open the feed settings and select feeds. Click a name to see its items, source and refresh status; “Edit rules” opens from the feed settings and returns there when you're done. The stats above the list show total feeds, auto-updating feeds, collected items and feeds that need attention. The select-all checkbox is in the list header and, after a search, only affects the results. “Status → Needs attention” shows feeds whose fetch failed or whose rules may have stopped working; you can also show only “Fetch failing” or only “Rules may have stopped working”, combined with search and the source and output filters. Changing the search, source, output or status filter clears the selection.

With feeds selected, a bulk action bar appears above the list. “Change settings” sets translation output (bilingual, translation only, original), target language, translation service, refresh interval (5–1440 minutes), items published (10–500) and items kept (keep current, automatic, or 10–1000) for all of them. Output defaults to “Keep current”, and empty intervals or counts aren't changed, so you can change just one thing. When items kept is below a feed's items published, that feed fails with the reason listed and the others are saved. Item filters are set per feed (the API accepts `itemFilter` in bulk). Web page and RSS feeds are both supported. Saving uses the same logic as a single feed, doesn't refetch the source, and keeps paused feeds paused.

Bulk copy gives one RSS address per line. “Export OPML” (in the list header it exports the current results plus all bundles, which go in a “Bundles” folder; in the bulk action bar it exports only the selected feeds) creates a standard OPML file for NetNewsWire, Reeder, Inoreader, Feedly and other readers. Pause, resume, refresh and delete are available too. Failures are listed one by one, successful items aren't rolled back, and failed items stay selected. With many feeds selected, the interface splits the requests; “Refresh now” uses a few parallel single-feed requests rather than one long request. Actual fetch concurrency is set on the server, and each source hostname is still fetched one at a time. Deleting also deletes the feed's history; rotating the key immediately revokes the old RSS, Atom and JSON Feed addresses.

## Bundles

A bundle combines several of your feeds (web page feeds and RSS translations alike) into one address — handy for putting sources on one topic together so you add them to your reader once.

- **Create**: click the arrow next to “New feed”, choose “Bundles”, enter a name and check the members. Or select feeds in the list and click “Add to bundle” in the bulk action bar to add them to an existing bundle or create a new one. Feeds already in a bundle aren't added twice.
- **Manage**: once created, a “Bundles” section appears above the feed list. Each bundle can copy its address, open in a new tab, and edit its name and members; the “⋯” menu rotates the key or deletes the bundle (member feeds aren't affected).
- **Content**: all items the members collected are merged into one timeline by time — the publication time, or the time first seen when there's none. Each item names the feed it came from with `<category>`. Each link appears once (the first collected copy is kept, so readers never show it twice). A bundle holds up to 100 items by default, adjustable to 10–500. Each member contributes exactly what its own address publishes: translated feeds only finished translations, and each member's item filter and items published still apply (items are selected by member first, then merged, deduplicated and cut to the bundle's limit).
- **Read-only**: a bundle only reads items the members already stored; opening or refreshing its address never triggers a fetch. Deleted members leave the bundle automatically; paused members still contribute their existing items. When the owner's account is disabled, the bundle address stops working like single feed addresses.

Bundle addresses look like `/bundles/BUNDLE_ID/KEY.xml` and have their own key; replace `.xml` with `.atom` or `.json` for the same content as Atom 1.0 or JSON Feed 1.1 (the source is written as Atom `category` and JSON Feed `tags`). Rotating the key revokes all three. When every member is translated into the same language, the bundle declares it (RSS `<language>` and so on); with mixed languages or original-language members it declares none. Opened directly in a browser, it shows a readable preview with the source feed under each item.

Why `<category>` rather than `<source>`: RSS 2.0's `<source>` must carry the source feed's RSS address, and a member's address contains its key, which would leak through the bundle; using the web page address instead breaks the spec. `<category>` needs no address, and most readers show it as a tag you can filter by.

## Feed addresses, formats and browser preview

Each feed has three formats with exactly the same items, filters and limits; pick what your reader supports:

| Format | Address | Content-Type |
| --- | --- | --- |
| RSS 2.0 | `/feeds/FEED_ID/KEY.xml` | `application/rss+xml` |
| Atom 1.0 | `/feeds/FEED_ID/KEY.atom` | `application/atom+xml` |
| JSON Feed 1.1 | `/feeds/FEED_ID/KEY.json` | `application/feed+json` |

Above “Feed address” in the feed panel you can switch between RSS 2.0, Atom 1.0 and JSON Feed 1.1; the copy button follows (“Copy Atom address” and so on), and the choice is remembered in the browser. “Copy RSS” in the list, bulk copy and OPML export still use the RSS address. All three addresses share one key and stop working together when it's rotated.

RSS addresses look like `/feeds/FEED_ID/KEY.xml`. Readers, command-line tools and scripts always get standard RSS 2.0 (with the `ttl` refresh interval, `generator`, and a `media:thumbnail` for items with images). Opening the same address in a browser's address bar shows a readable page instead: the feed's name, source, a copy button and the latest 30 items, with “View the raw XML” at the bottom (the address plus `?format=xml`). The page is shown in the visitor's browser language.

Atom and JSON Feed addresses have no preview page; opened in a browser they come back as `application/xml` and `application/json` so you can view rather than download them.

The preview only appears when a browser opens the RSS address as a top-level page: FeedLantern checks the `Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate` and `Accept: text/html` headers that browsers send automatically. Readers, background requests from browser extensions and page scripts never send this combination, so they're never mistaken for a browser. The preview needs the key too — don't share it publicly any more than the feed — and carries `X-Robots-Tag: noindex` so search engines skip it.

## Interface and theme

The button at the top right switches between “System”, “Light” and “Dark”; the choice is remembered in the browser. Next to it, the language menu changes the interface language for your account (see [Language](#language)). The address bar remembers the current page, settings group and open feed panel (for example `#/settings/translation` or `#/feed/FEED_ID/logs`), so reloading keeps your place and the browser's back and forward buttons work. On the feeds page, press `/` to search and Esc to clear it. The list can be sorted by order added, name, recently updated or “Needs attention first”; clicking “Needs attention” in the stats or the error under a feed shows only failing feeds or opens that feed's activity log. On phones the main navigation moves to the bottom of the screen and the feed panel slides up from the bottom. Settings show one group per page: pick Logs & display, Translation services, Server & network (these three are for administrators only), Notifications, Cookie credentials, Network profiles, Account & password, Access tokens, Backup & migration or About on the left (a horizontal row at the top on phones). Each group's save button saves only that group; with unsaved changes an “Unsaved” badge appears, and switching groups, leaving Settings or closing the page asks first.

## Adding in bulk

Click the arrow next to “New feed” and choose “Add in bulk”. Enter one URL per line, up to 100; fix invalid lines first; duplicates are skipped. You can set one refresh interval and network profile for all, and pick a cookie credential per line.

Clear results are created automatically; ambiguous ones show sample candidates — click “Open and adjust rules” to load the page again, check and save. Failures can be retried, and URLs that already have a feed reuse it. Batches run in the background, keep running after you close the page and resume after a restart. Canceling only affects entries that haven't started. The result page can copy the whole batch's feed addresses.

## Cookies

In Settings → Cookie credentials, paste a cookie header or OpenCookie-compatible JSON, or upload a JSON file. Credentials can be named, replaced and used by several feeds; cookies are only sent when the domain matches. When they expire or stop working, import them again from a browser where you're signed in. FeedLantern doesn't handle interactive sign-ins or CAPTCHAs.

## Network profiles (proxies and headers)

Some sites only work from a particular exit IP, User-Agent or Referer. Add a profile in Settings → Network profiles; it can contain:

- A proxy: `http://`, `https://` or `socks5://` plus host and port, such as `socks5://proxy.example.com:1080`, with a username and password if it needs authentication.
- A User-Agent: for web page feeds this also changes `navigator.userAgent` inside the page.
- A Referer: the referring address sent when opening the feed's page.
- Extra headers: up to 20, names up to 64 characters, values up to 2,048 characters. They're sent only to the feed's site and its subdomains (ignoring a leading `www.`), never to third-party images, scripts and other resources, and an HTTPS feed never sends them to an HTTP address. Host, Cookie, Cookie2, Proxy-*, Connection, Keep-Alive, Transfer-Encoding, TE, Trailer, Upgrade, Content-Length, Content-Encoding, Expect, Accept-Encoding and Sec-* can't be set; User-Agent and Referer use their own fields; use a cookie credential for cookies.

Web page feeds choose a profile under “New feed → Loading & network settings”, RSS translations on their edit page, and batches for the whole batch; existing feeds can switch profile, or back to the default network, in Feed settings. The editor preview, batch detection, re-detection after a rule warning and background refreshes all use the same profile, and with pagination every page goes through the same proxy with the same headers. Changes apply from the next fetch.

Proxy passwords and header values are stored encrypted and never shown again; leave them empty when editing to keep them. Changing the proxy address requires entering the username and password again. “Test connection” on a card requests a URL once with the profile, to check that the proxy is reachable and the credentials work. The test URL is filled in for you and can be changed: the source address of the first (oldest) feed using the profile; otherwise the URL you last tested with this profile in this browser; otherwise `https://cp.cloudflare.com/generate_204`. That address exists for connectivity checks: Cloudflare's global anycast network is usually reachable directly even in mainland China (Google's `gstatic` address isn't), it returns an empty HTTP 204 without redirecting and responds quickly, and proxy apps such as Clash, Surge and sing-box have used it as their default test for years. Any 2xx status (including 204) passes; any other status is shown, meaning the connection worked but the site didn't respond normally. The test doesn't follow redirects; for a 3xx, use the address it redirects to.

Proxies are subject to the private-network block too: they can't point to this machine, the LAN or a cloud metadata address. For a proxy on this machine or the LAN, an administrator adds its `host:port` (for example `192.168.1.10:1080`) to the allowed hosts in Settings → Server & network. Target sites are still resolved and checked by FeedLantern, and the proxy receives the checked IP address, so setups that rely on the proxy's DNS (such as names only the proxy can resolve) aren't supported; if this machine's DNS is tampered with, turn on encrypted DNS. With encrypted DNS (DNS over HTTPS) on, feeds with a proxy send even the encrypted DNS query through that proxy — so when this machine can't reach `cloudflare-dns.com` directly and only the proxy gets out (for example with Surge's or Clash's enhanced mode off), proxied feeds still resolve. The addresses found are still checked locally for private and reserved ranges before being handed to the proxy — on every page of a web page feed, for RSS feeds and for “Test connection”. Results looked up through a proxy are cached separately from direct lookups. A failure says “The encrypted DNS lookup through proxy … failed”.

A network profile that feeds still use can't be deleted; switch those feeds to another profile first.

## Scope

Works with ordinary DOM lists, dynamically rendered pages and pages behind cookies. Up to 10 pages can be collected through a “Next page” link or button, a URL page template or a “Load more” button (see [Multiple pages](#multiple-pages)). Not supported yet: full-article fetching, complete collection of infinite scroll, picking inside iframes, closed Shadow DOM and canvas content. When rules stop working, history is kept, and rules are never silently replaced before you fix them.

“Adjust rules” captures the page as one tall image that you scroll locally with the mouse wheel or trackpad, without waiting for the server. The capture comes in 8,000-pixel segments: the next one loads automatically as you approach the bottom, and when the detected list is further down, it loads up to there and scrolls to it. At most 48,000 pixels are shown; longer pages say so at the bottom. Hovering immediately outlines the element that would be picked and shows its tag; press ↑ / ↓ to widen or narrow, and click to pick — the feed preview refreshes in the same request. After picking you can also use the Widen / Narrow buttons.

To get to another list page first, hold ⌘ (Ctrl on Windows and Linux) and click a link on the page. After the view moves, “Use this page as the source” puts that page into the source URL and detects again; “Back to the source URL” returns. While the view is on another page you can't pick or save, so rules never disagree with the source URL. Up and down buttons only appear when the page has its own inner scroll area, for scrolling that area remotely. Leaving the editor or the page releases the remote editing session.

Automatic date detection prefers a metadata area with its own time text, so it doesn't select the whole item container. When picking by hand only parsable time text is highlighted; the saved rule is still the container selector, which handles mixed content such as “Category · Source · 27 minutes ago”.

## Items

The “Items” tab lists stored items the way a reader does: source domain and publication time, title, a summary folded to three lines, and a thumbnail on the right when there's an image. “Show more” expands the full content in place and “Show less” folds it again. The title opens the original in a new tab; the content is shown in an isolated frame that can't run scripts, and its links only open in new tabs, never inside the management page.

Translated feeds mark status with small tags: “Translating” while queued or in progress, and “Translation failed” with the reason below. In bilingual mode the title shows the translation with the original title in a lighter line below, and when expanded each translated paragraph is followed by the original in lighter text. Filtered items and items beyond the limit are dimmed with the reason.

## Activity

Click a feed's name to open the feed panel and switch to the “Activity” tab. Translated feeds have two parts here, “Fetches” and “Translations”, switched with the buttons at the top; other feeds only have fetches.

### Fetches

Each entry shows when it ran, its source, status, duration, valid items, new items and the reason for any failure. Feeds with pagination also show a line such as “3 pages (12 + 10 + 0 items); page 3 failed: …”, saying how many pages were fetched, how many new items each gave and why it stopped. You can filter by status; 20 per page, with “Load more” for history. The newest page refreshes every 5 seconds, pausing while you browse history or leave the tab.

Logs are kept for 30 days by default (adjustable in Settings). Scheduled, manual (including bulk refresh), new feed, rules edited, resumed and batch fetches are all logged as they actually happen. Concurrent requests merged into one fetch are logged once, with the source of whichever started it. No new articles still counts as success; extracting no valid items counts as failure, and failures keep existing articles. Runs cut short by an unexpected restart show as “Interrupted” with an unknown duration.

Connection timeouts name the site and how long FeedLantern waited, for example “Connecting to rss.example.com timed out (no response in 20 seconds)” (20 seconds for RSS sources, 30 for web pages). Only the host name appears; paths and query parameters never reach logs, the feed list or alerts. Without a proxy configured, the message adds the most common cause: a proxy app on this machine running in enhanced or Fake-IP mode while FeedLantern doesn't use the system proxy — turn on TUN/enhanced mode and DNS-over-HTTPS, or give the feed a network profile with a proxy. With a proxy configured, it suggests checking that proxy. Fetches stopped by a cancel, a disabled account or the server stopping are logged as “Interrupted” and never alert as timeouts or failures.

With at least one channel enabled in Settings → Notifications (Bark, webhook, ntfy or Telegram), reaching your failure threshold sends an alert to every enabled channel, and the log shows each channel's state — pending, retrying, sent, failed or canceled — for example “Alerts: Bark sent · Webhook failed (…)”; with no channel enabled it shows “off”. One run of consecutive failures alerts once, and its failure logs share that alert's state. After a successful fetch it resets, so the next failure can alert again; recoveries aren't pushed by default. See [Configuration](configuration.md#alerts-and-notification-channels) for setup.

## Rule health warnings

After a redesign, old rules often still extract a few items and fetches don't fail — but items drop from 20 to 3, every title becomes “Read more”, or every link points to the same address. To catch this, each successful fetch of a web page feed records the item count and how often each field is present, and compares them with the feed's recent healthy fetches:

| Check | When the rules may have stopped working |
|---|---|
| Item count | The baseline median is at least 5 and this fetch has less than 30% of it (for example from 20 items to 5 or fewer) |
| Title | At least 80% of baseline items had distinct titles and this fetch has 30% or fewer (for example all the same text) |
| Date, image, summary | At least 80% of baseline items had the field and this fetch has 30% or fewer; fields without a rule aren't checked |
| Link | At least 80% of baseline links were distinct and this fetch's links are all the same, or less than 50% distinct |

The baseline is the median of the last 10 healthy fetches (same URL, same rules) and needs at least 5 before judging, so new feeds and feeds with freshly changed rules never warn in their first 5 fetches. Title, link, date and similar rates are only checked when the fetch has at least 3 items. Items without a title or link are never stored, so losing them shows up as a lower item count. RSS feeds aren't checked.

When a warning appears, the fetch still counts as successful, items are saved as usual and the RSS output is unaffected. The feed shows “Rules may have stopped working” in the list and counts toward “Needs attention”; the feed panel lists the reasons at the top, and the fetch log entry is marked. Suspicious results don't join the baseline, and the warning clears after the next healthy fetch. Feeds with pagination use only page 1 for statistics and for the re-detect comparison: how many pages a run fetches changes with the early stop and the page limit, so changing the maximum pages isn't mistaken for a jump or drop in items.

In the feed panel you can:

- **Detect again**: open the page with the feed's saved cookies and wait settings, extract with the current rules and run automatic detection, and show both side by side with item counts and the first few items. Below, the changed selectors are listed by field: fields from automatic detection are checked by default; fields you picked by hand aren't, and are only replaced when you check them. When the checked combination differs from the new detection, first “Preview the selected combination”; “Replace selected fields” needs a preview with at least 1 item. Replacing fetches once with the new rules right away and a new baseline builds up. Until you confirm, the saved rules don't change.
- **Ignore this warning**: when the page really has less now (for example the site kept only some sections), ignoring makes this fetch the new baseline, and judging starts again after 5 more fetches.

With any channel enabled, each warning is sent to every enabled channel once (title “FeedLantern: rules may have stopped working”, webhook event `rules.warning`), not repeated while it lasts, and counted separately from fetch failure alerts. To turn just these off, uncheck “Notify when rules may have stopped working” in Settings → Notifications → Alert policy. Health statistics keep at most 20 samples per feed and are cleaned up by the log retention days like fetch logs.

## RSS translation (translation only / bilingual)

Click “New feed → RSS translation”, enter an existing RSS 2.0 or Atom 1.0 address and click “Preview source”. After checking the original, fill in the name, refresh interval, output, target language and translation service, and save to copy the new RSS address.

- By default it refreshes every 30 minutes and outputs bilingual Simplified Chinese. The translated title comes first; in the body, the translation comes first and the original follows in the same block. Code isn't translated.
- Target languages: Simplified Chinese, Traditional Chinese, English, Japanese and Korean. The feed's RSS `<language>` follows the target language (such as `zh-cn` or `ja`).
- The translation service defaults to “Use default”, the service the administrator chose; you can also pick Google, DeepL or an OpenAI-compatible API per feed. Services the administrator hasn't configured show “(not configured)” and can't be chosen.
- The first import processes only the latest 20 items in the source; later fetches process new items and changes to imported ones. By default the latest 100 collected items are published (adjustable under Output, see above). Older items skipped on the first import aren't translated later.
- Only what the source provides is translated: full text when the source has it, otherwise the summary; article pages aren't visited. RSS input sends no cookies; you can use an address with an access token if the source provides one.
- Images, links, lists, tables and code are kept; unsafe HTML is removed. In the management page the body is shown in an isolated preview frame whose links never navigate the page; open the original from the item title.
- Translation happens in the background. Readers fetching the feed only read the cache and never wait for the service. Only articles whose title and body both translated successfully are published; waiting, failed and partly finished items aren't. Before anything is finished, a valid empty RSS is returned. The management page still shows the original and the status.
- The top of the feed panel shows finished, waiting and failed counts; with unfinished articles, click “Retry unfinished translations” next to them. Items carry “Translating” / “Translation failed” tags, with the reason below a failure. Pausing the feed pauses new translations too; they continue after resuming.
- Switching between translation only and bilingual in the feed settings keeps the address and item IDs and needs no new translation. Changing the target language or service translates existing articles again: they stay out of the feed until finished, keep their item IDs so readers won't show them twice, and cached segments for services and languages used before are kept, so switching back is quick. Changing the RSS source address clears the feed's items and starts again from the new source — check the address before saving.

### Translation services

Administrators configure the services in Settings → Translation services. Each service is a card marked “Default”, “Configured” or “Not configured” (API keys only show whether they're set, never the value); the default service's card opens automatically, others open on click. “Make default” changes the default service; services that aren't configured can't be made default (DeepL needs an API key; the OpenAI-compatible API needs an endpoint and a model name). Services that aren't the default can still be chosen per feed. Saving sends only what actually changed, and an empty API key keeps the saved one. Concurrency, request interval and rate-limit backoff are tracked per service, so one rate-limited service doesn't slow feeds using another. Changing the default only affects later translations; finished translations aren't redone.

- **Google Translate (free)**: the default service, no key needed, experimental — see the next section.
- **DeepL**: enter a DeepL API key. With the plan on “Automatic”, keys ending in `:fx` use the free API `api-free.deepl.com` and others the Pro API `api.deepl.com`; you can also choose explicitly. When the quota runs out (HTTP 456) or requests are rate limited (HTTP 429), DeepL scheduling pauses and retries automatically.
- **OpenAI-compatible API**: enter the endpoint (Base URL, such as `https://api.openai.com/v1`; requests go to `endpoint/chat/completions`), the model name and an API key (optional for local models), plus an optional custom system prompt. FeedLantern sends only text segments from the body (code blocks, inline code, images and tag structure stay local and are reassembled in their original structure) and asks the model to return each numbered segment as is. If the returned segment count, numbers or tags don't match, the output is cut short, or there's extra text, the whole batch counts as failed and is retried — never cached or published. The custom prompt comes before the fixed format rules, so it only affects style and can't change the reply format.
- Local or LAN models (such as Ollama at `http://127.0.0.1:11434/v1`) are blocked by the network security policy by default; an administrator must add exactly `127.0.0.1:11434` to Server & network → Network allowlist first. DeepL and public endpoints pass the same address checks.
- Each service has a “Test” button that translates one sample sentence with the settings as currently entered (not yet saved), to check the key and endpoint.
- API keys are stored encrypted in the database. Once saved, the page only shows “Saved; leave empty to keep”, and the API never returns keys; check “Delete the saved key when saving” to remove one. Encrypted full backups include keys; configuration exports don't (importing keeps this server's saved keys).

Translations are cached per service and target language and never mixed; caches from before the upgrade count as “Google + Simplified Chinese”.

### Google Translate (free, experimental)

This uses Google's browser translation channel (`translate-pa.googleapis.com/v1/translateHtml`) with the same request format as the browser mode of Immersive Translate 1.33.1's published script, so no cloud account or paid API is needed. It isn't the official paid Google Cloud Translation API and has no availability guarantee; it may fail because of the server's exit IP, request rate or changes to the endpoint. Check connectivity on the actual server the first time.

By default at most 6 translation requests run at once, started 100 ms apart; an article's title, body segments and long-text parts can run in parallel and are assembled in the original order. Adjust Google's concurrency (1–16) and interval (0–5000 ms, 0 meaning no extra delay) in Settings → Translation services; changes apply after saving. Successful segments are cached permanently, and identical segments are reused across items. Temporary failures are tried up to 3 times, waiting at least 60 and then 300 seconds and honoring the server's `Retry-After` (up to 24 hours). Only clear rate-limit responses (such as 429, 403, an automated-traffic page or `Retry-After`) pause the whole translation queue; ordinary single errors don't hold up other feeds. A manual retry doesn't skip a rate-limit wait that's still running. After the attempts run out, retry by hand.

While Google rate limits requests, web page fetching, RSS output and existing translations keep working; FeedLantern doesn't switch to another service by itself. When an original article changes, the old translation never passes for the new content; the unfinished new version stays out of the RSS output, the management page shows the original, and segments already translated are reused.

RSS fetch failures go through the usual fetch log and failure alerts (depending on your notification settings); translation failures show as their own translation status and send their own alert to every channel the owner enabled. Encrypted full backups include translations, the cache and unfinished tasks; configuration exports contain no content and fetch again after importing. The segment cache keeps at most the 20,000 most recently used segments and is cleaned up regularly; finished translations of kept items aren't lost.

### RSS translation progress and log

See “Activity → Translations” in the feed panel, refreshed every 2 seconds: the translation service's current state at the top, then unfinished articles (translating, queued or failed, with the reason and next retry time), and finally the translation log (segments finished, cache hits, failure reasons), with failures highlighted. Each feed keeps the newest 200 log entries (and no more than 7 days); the interface shows the latest 100, and server output logs translation events too. The instance-wide request count includes other RSS translation feeds.

Translation requests send plain text arrays, combining up to 50 segments (at most 1,800 characters of original text), submitted with the configured concurrency. If the number or type of results is wrong or a translation is empty, the whole batch is rejected — nothing is cached or published. Complete existing translations are kept; the new channel has its own segment cache, so results from the old endpoint aren't mixed in. When the free Google API actually rate limits, requests pause and retry automatically; the management page shows when scheduling resumes. Articles reach the public feed only when completely translated.

Every notification channel has “Send test notification”, which sends one test with the values currently entered, without saving and without needing automatic alerts on. With any channel enabled, the first translation failure (including rate limits) is pushed to every enabled channel; repeated failures of one feed are deduplicated, separately from fetch failures, and alerts are allowed again once every article translates successfully. Failed pushes follow the attempts, retry delays and cooldown in the alert policy, per channel. A translation itself is tried at most 3 times: at least 1 minute after the first failure and 5 minutes after the second; a Google rate limit also triggers a global backoff of at least 1 minute and honors a longer `Retry-After`. After the third failure, retry by hand in the feed details.

### Adding RSS translations in bulk

Choose “Add in bulk” from the “New feed” menu and switch “Batch type” to “Translate RSS”. Enter one RSS/Atom address per line, choose the output (bilingual or translation only), target language, translation service and refresh interval for all of them, and click “Start translating in bulk”. Each batch takes up to 100 addresses; “Import from OPML” reads an OPML file exported from a reader. Duplicates are skipped, and a web page feed and a translated feed for the same address are told apart. In the background the sources are read, feeds are created and translation starts; source failures can be retried in the batch. An entry showing “Created” means the feed exists — check the feed for translation progress. The batch keeps running after you close the page.

### Translating web page feeds, and list filters

The list and cards show each feed's source (Web page / RSS source / PubMed search) and output (Original / Chinese translation / Bilingual; other target languages show as “Japanese translation”, “Bilingual (Japanese)” and so on). You can filter by source or by whether it's translated, and select-all only affects the filtered results.

Turn on translation for a web page feed by choosing “Translation only” or “Bilingual” under Feed settings → Output, together with a target language and translation service. FeedLantern translates the titles and extracted summaries it already has, keeps images and item IDs, and translates again when fetched content changes; it doesn't visit full articles. Only finished items reach the public RSS; you can watch progress, logs and retries in the details, and failures use the same alerts. Switching back to Original restores the original output at once, with the same address. Existing web page feeds keep original output after upgrading.

## PubMed feeds

**Recommended: a PubMed search feed.** Choose “PubMed search” in the “New feed” menu (or switch to it at the top of the new feed page) and combine conditions as in PubMed's Advanced Search Builder; the feed is created directly, without generating an RSS link on PubMed. FeedLantern reads the newest matches through NCBI's official [E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25497/): esearch takes the newest N articles in PubMed's “Most recent” order (newest added to PubMed first, the order of PubMed's RSS), and efetch reads their titles, authors, journal, publication date and abstract.

### The search builder

- **Conditions**: each line has an operator (AND / OR / NOT; none on the first line), a field and a search term. Lines combine from top to bottom as in PubMed's builder (three lines become `((A) AND (B)) OR (C)`). Fields: All Fields, Title/Abstract, Title, Author, First Author (Author - First), Last Author (Author - Last), Journal, Affiliation, MeSH Terms, Publication Type, Language, and Journal NLM ID (`[jid]`).
- **Written like PubMed's builder, unquoted**: each condition becomes `(term[Field])` (All Fields has no tag), joined with AND / OR / NOT, and terms are sent as typed. PubMed then applies automatic term mapping: `cryo electron microscopy` is mapped to MeSH terms, and `Sun Jin-peng[Author]` also matches `Sun, Jin Peng`. Quotes would match the exact phrase only and give far fewer results (24,903 versus 10,997 in a test). PubMed ignores case.
- **Exact phrase**: each line has an “Exact phrase” switch, off by default; it quotes that line's term, matching the exact words and turning automatic term mapping off. Quotes you type yourself are kept.
- **Only what breaks the syntax is changed**: `[` and `]` would start a field tag and become spaces; unpaired parentheses or quotes are dropped; upper-case AND / OR / NOT inside a term are read as operators by PubMed, and the builder points them out (write them in lower case or use “Exact phrase” to search for the words).
- **Filters**: publication date (any time / last N days / a range written `YYYY`, `YYYY/MM` or `YYYY/MM/DD`, either end may be empty), only articles with an abstract (`hasabstract`), and article-type shortcuts (Review, Systematic Review, Meta-Analysis, Clinical Trial, Randomized Controlled Trial, Case Reports; several are OR-ed).
- **Query**: the PubMed query is shown under the builder as you edit, for example `(cryo-EM[Title/Abstract]) AND (ShanghaiTech University[Affiliation])`. You can edit it directly: when it can be shown as conditions, the builder follows; when it can't (a group on the right such as `a AND (b OR c)`, or a field the builder doesn't offer), it says “Switched to manual editing” and the query is saved exactly as written — “Discard manual edits” returns to the builder. Unbalanced quotes or parentheses and an operator without a term on one side are pointed out and never sent to NCBI.
- **Preview**: the panel beside it shows how many articles match and the newest 5 (title, journal, date, authors), NCBI's notes (such as a quoted phrase that wasn't found), and what PubMed actually ran (esearch's querytranslation), so you can see what automatic term mapping added. It asks once you pause typing (about 0.8 s), reuses the answer for the same query for a minute, and shares the instance's NCBI rate limit with refreshes; when the queue is long, the preview asks you to try again shortly. “Open in PubMed” shows the same search on the PubMed site.
- **Feed settings**: the default name is the query exactly as sent, then “ - PubMed”, as PubMed titles its own pages, for example `(Mengmeng Lin[Author]) AND (ShanghaiTech[Affiliation]) - PubMed`. It follows the query until you change it; “ - PubMed” is a fixed suffix in every interface language. Names are at most 200 characters: a longer query loses its middle (with an ellipsis) and keeps the “ - PubMed” ending, while the feed still stores and runs the full query. RSS, Atom and JSON readers show this name as the channel title. “Newest articles per fetch” is 10, 20, 50 or 100 (20 by default); stored articles are never added twice. Output can be original, translation only or bilingual, with the same translation pipeline, target languages and services as RSS translations. Refresh interval, network profiles (proxy and DNS over HTTPS), item filters, output and retention limits, bundles and alerts all work as for other feeds. Rule health warnings only apply to web page feeds; a PubMed search that fails is recorded as a failed fetch with a readable reason.
- **Editing**: Feed settings → “Edit search conditions” opens the same builder. Stored articles are kept when the search changes (items are keyed by PMID); new matches are added on the next refresh. A name that is still the default “old query - PubMed” follows the new query; a name you set yourself stays, and the page says it didn't follow the query.

Example queries:

| To follow | Query |
| --- | --- |
| An author at an institution | `(Sun Jin-peng[Author]) AND (ShanghaiTech University[Affiliation])` |
| A topic in one journal | `(PLoS Pathog[Journal]) AND (Wolbachia[Title/Abstract])` |
| An institution's cryo-EM papers with abstracts | `((cryo-EM[Title/Abstract]) AND (ShanghaiTech University[Affiliation])) AND (hasabstract)` |
| Reviews in a field from the last 30 days | `(CRISPR-Cas Systems[MeSH Terms]) AND ("last 30 days"[Date - Publication]) AND ("Review"[pt])` |

Item links are `https://pubmed.ncbi.nlm.nih.gov/<PMID>/`, and the content is laid out like PubMed's RSS: the citation (journal abbreviation, date, volume, pages and DOI), the authors (ending in “et al.” after 10), the abstract (one paragraph per labelled section, or NO ABSTRACT) and PMID / PMC / DOI links. Item dates are 06:00 New York time on the day the article was added to PubMed, as in PubMed's RSS. Translated feeds translate the title and abstract. The CLI and the MCP server can preview and create PubMed searches too; see [Agent CLI](../agent.md).

### If you still want a PubMed RSS link

PubMed RSS addresses still work as ordinary RSS translation feeds; FeedLantern never rewrites them in the background:

- **Journal RSS** (`https://pubmed.ncbi.nlm.nih.gov/rss/journals/<NLM ID>/…`, from a journal's RSS button): NCBI now answers every program that reads journal RSS with a proof-of-work verification page (it needs a browser to run scripts and set a cookie) instead of RSS, so these feeds fail with “NCBI answered this PubMed journal RSS address with a verification page”. FeedLantern doesn't try to get past such checks. For a journal, use a **search RSS link** instead: search PubMed for `"PLoS Pathog"[jour]` (with your journal's abbreviation), click Create RSS and subscribe to the `/rss/search/…` link — or use a PubMed search feed as above.
- **Search RSS** (`/rss/search/<ID>/…`): still fetched directly and currently working.

**Official RSS versus E-utilities**: both read the same PubMed backend and give the same results, and both see NCBI's occasional server errors (5xx) — converting doesn't remove those. E-utilities is NCBI's official interface for programs, so it isn't blocked by web verification pages (journal RSS already is); the query is visible and editable in FeedLantern; and you choose the number of articles per fetch (10/20/50/100) and dates. Recommendation: convert journal RSS feeds; search RSS feeds can stay as they are — convert them when you want to manage the conditions in FeedLantern or worry they may be blocked later.

### Converting PubMed RSS feeds into searches

The feed panel points out both kinds of PubMed RSS link and offers “Convert to PubMed search”. FeedLantern checks first and never converts anything on its own:

1. **Recover the query**: the RSS address is read once (through the same rate-limited queue as other NCBI requests). A search RSS feed's channel title is the original query; suffixes such as “: Latest results from PubMed” are removed, unbalanced parentheses are closed (marked as repaired), and a title ending in an ellipsis, AND/OR/NOT or an open quote is treated as possibly cut off rather than guessed at. A journal RSS link prefills `"PLoS Pathog"[Journal]` from the abbreviation in the address (or `101238921[jid]`, which PubMed maps to the same journal).
2. **Compare**: esearch runs the recovered query and lists the newest 200 matches; the coverage is how many of the RSS feed's newest 20 items are among them. At least 80% means “can be converted directly”. A journal RSS that NCBI blocks is compared with the items the feed already holds.
3. **Result**: when it can be converted directly, the panel shows the query and coverage and “Confirm conversion” does it. When the title looks cut off, coverage is low, the RSS couldn't be read or there is nothing to compare with, the search builder opens prefilled with the candidate query and says “Couldn't confirm this matches the original RSS, please check it” with the reason; check it, then confirm.

With many feeds, use “Check and convert” on the strip above the feed list, or select feeds and use the bulk action “Convert to PubMed search”:

- **The check runs on the server**: it continues when you close the window or the page, even across a restart; reopening shows its progress and results. A progress bar shows “Checked N of M” and the estimated time left, and each row shows waiting, checking, can be converted directly, needs review (with the reason), failed or converted.
- **Little need for the PubMed website**: most search RSS feeds are named after their RSS title, which is the query. FeedLantern recovers the query from the name and compares it with the items the feed already holds (the PMIDs in their links) — one E-utilities request per feed. Only when that can't confirm it is the RSS address read for its title and newest items.
- **Concurrent within the limit**: 5 feeds are checked at a time, but all NCBI requests share the global rate limit (3 per second without a key, 10 with one). Without a key the window says so and links to the settings; 60 feeds take about 20 seconds without a key, less with one.
- **Results are kept**: feeds whose address and name haven't changed aren't checked again (marked “earlier check”); “Check again” redoes them. A check can be stopped, and failed feeds retried.
- **Convert while checking**: verified feeds can be converted at any time without waiting for the rest; after you confirm, only those are converted, and the others stay in the table with a “Review” button to handle them one by one in the builder. Conversion can safely be repeated; failures can be retried.

Previously each feed's RSS page was read before querying E-utilities, one feed after another, so 60 feeds took minutes; now most need a single E-utilities request and the waiting for answers overlaps. On the command line, `feedlantern pubmed convert --all-verified` reports first, `--yes` converts, and `feedlantern pubmed checks` shows the background job; see [Agent CLI](../agent.md).

Conversion keeps the feed's current name (you may have chosen it yourself); both the single and the batch confirmation offer “Also rename the feed to ‘query - PubMed’”, off by default, and with it ticked the batch table shows the old and new names. A converted feed keeps its ID, RSS address, stored items and translations, translation settings (output, target language, service), item filter, output and retention limits, bundle memberships, refresh interval and network profile. Items have the same identity as in PubMed's RSS (`pubmed:<PMID>`), so stored articles aren't sent again as new. On the first fetch after converting, small layout differences in the content may queue recent articles for translation once more; identical paragraphs come from the translation cache.

### NCBI usage rules and settings

NCBI asks programs that use E-utilities to stay within its rate limits and to name their tool and a contact email:

- All PubMed search refreshes and builder previews share one request queue: at most 3 requests per second without an API key, 10 with one. Each refresh and each preview sends 2 requests (esearch, efetch), and batch refreshes wait their turn. If NCBI still answers 429 (too many requests), FeedLantern pauses the whole queue for `Retry-After` and tries once more; if that fails too, the fetch fails with “Too many requests to NCBI E-utilities (HTTP 429)…”.
- Administrators can set an **NCBI API key** (optional; free under Account Settings → API Key Management in an NCBI account) and a **contact email** (optional) in Settings → PubMed (NCBI). The key is stored encrypted like translation keys, never shown again and left out of configuration exports; “Delete the saved key when saving” removes it. If NCBI rejects the key, the fetch log says to check or remove it.
- “Test” checks the key and email as typed, before saving: FeedLantern sends the smallest esearch request (`retmax=0`) and reports clearly — valid (with the rate limit NCBI reports: 10 per second with a key), not accepted by NCBI (for example a deleted key; NCBI answers `type: invalid`), wrong format (NCBI answers `API key not wellformed`), rate-limited, or unreachable; anything else shows a summary of NCBI's own message rather than a guess. The email gets a basic format check. Once saved, the page shows that a key is set with its last test result and time, and asks for a new test when the key changes.
- Every request carries `tool=feedlantern`, and `email` when a contact email is set. NCBI recommends the email: if something goes wrong they contact you before blocking the source IP. It's especially useful when several services share one outgoing IP.
- E-utilities requests go through the same network policy, DNS over HTTPS setting and the feed's network profile proxy and User-Agent as RSS sources; a profile's custom headers are only sent to the feed's own site, never to `eutils.ncbi.nlm.nih.gov`.
