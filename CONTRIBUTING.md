# Contributing

Use Node.js 24 LTS and the pnpm version pinned in `package.json`.

```sh
pnpm install
pnpm browser:install
pnpm build
pnpm test
pnpm test:e2e
```

Keep changes small and independently reviewable. Describe the user-visible behavior and how it was verified. Add tests for parsing, security boundaries, extraction behavior, and regressions; use local fixtures rather than public sites in CI.

Automatic detection, manual previews, and scheduled refreshes must use the same extraction behavior. Do not silently replace manually selected fields or existing feed rules.

Never commit real cookies, credentials, private URLs, screenshots of authenticated pages, local databases, or generated browser profiles.

The project uses semantic versions. Update `CHANGELOG.md` for user-visible changes; ordinary commits do not publish packages or releases. Container and binary distribution are deferred until local validation is complete.
