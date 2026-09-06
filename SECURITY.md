# Security

FeedLantern is a single-administrator service. The default listener is loopback-only.

- Management APIs and browser previews require an authenticated session.
- Feed URLs contain read-only secrets. Anyone holding a URL can read that feed. Rotate its token if the URL is shared unintentionally.
- Imported cookies are login credentials. They are encrypted in the database; the local master key must be kept with the private data backup, outside source control.
- Do not include cookies, setup codes, passwords, feed URLs, database files, or browser screenshots of private pages in public issues.
- A future deployment on another machine must use HTTPS and an explicit public origin. Do not publish an unauthenticated browser-control endpoint.

The Chromium sandbox remains enabled. Private network targets are denied by default and require a deliberate host-and-port allowlist. Local files, cloud metadata, and unsafe URL schemes are not supported as scrape sources.

For a security problem, report the affected component and reproduction steps with synthetic data. Do not publish a working exploit against someone else's instance.
