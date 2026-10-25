# FeedLantern documentation site

The site is static and published to <https://jaaayden.github.io/feedlantern/> by GitHub Pages.

## Local development

Use Node.js 24 and pnpm 11.25.0:

```sh
pnpm --dir website install --frozen-lockfile
pnpm --dir website dev
```

Build and validate links, then preview the same static files that Pages serves:

```sh
pnpm --dir website build
pnpm --dir website preview
```

Open the printed address with the `/feedlantern/` path. Preview only listens on loopback.

## Authoring

- Edit detailed documentation in `doc/` and release notes in `CHANGELOG.md`.
- Edit the two introduction pages in `website/pages/`.
- Navigation and appearance live in `website/.vitepress/`.
- The preparation script copies these sources into the ignored `website/.content/` directory. Do not edit generated files.
- Relative documentation links are resolved against their original source paths. Repository files such as Compose and Nginx configuration link to their originals on GitHub.
- English currently covers the introduction, user guide, installation and configuration. Other guides are linked with a Chinese-language label.

Documentation dependencies use a separate lockfile and workspace. They are not installed for the application or included in its Docker image.

## Deployment

The Pages workflow builds and checks links for pull requests and relevant pushes. Only `main` can deploy. Configure the repository's Pages source as **GitHub Actions**; no deploy key or custom domain is needed.

The deployment path is fixed to `/feedlantern/`. A custom domain would require updating `base`, the sitemap hostname, icon URL, link checker origin and repository Pages settings together.
