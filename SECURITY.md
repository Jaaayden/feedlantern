# Security

FeedLantern is a self-hosted, multi-user service. The default listener is loopback-only.

- Management APIs and browser previews require an authenticated session. Every resource belongs to one account; other accounts get a 404, and only administrators can manage users, global settings and full backups.
- Feed URLs contain read-only secrets. Anyone holding a URL can read that feed. Rotate its token if the URL is shared unintentionally.
- Imported cookies are login credentials. They are encrypted in the database; the local master key must be kept with the private data backup, outside source control.
- Full backups are encrypted with a separate backup password and contain every user's data. Lightweight configuration exports contain the exporting administrator's Bark address in clear text; keep both private.
- Do not include cookies, setup codes, passwords, feed URLs, database files, or browser screenshots of private pages in public issues.
- A deployment on another machine must use HTTPS behind a reverse proxy, and the proxy address must be listed under trusted proxies so that login rate limiting sees real client addresses (see `doc/configuration.md`). Do not publish an unauthenticated browser-control endpoint.

The Chromium sandbox remains enabled. Private network targets are denied by default and require a deliberate host-and-port allowlist. Local files, cloud metadata, and unsafe URL schemes are not supported as scrape sources.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Contact the maintainer privately through the contact details on their GitHub profile, and include the affected component and reproduction steps using synthetic data. Do not publish a working exploit against someone else's instance.
