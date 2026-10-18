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

The project uses semantic versions. Update `CHANGELOG.md` (under "未发布" until a version is cut) for user-visible changes. Pull requests run the full CI (type check, build, unit and browser tests, amd64 and arm64 container checks) but publish nothing. Once a change lands on `main` and passes CI, the verified multi-architecture image is published as `latest`, so keep `main` releasable. Dependency updates arrive as Dependabot pull requests.
