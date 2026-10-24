FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/Jaaayden/feedlantern"
LABEL org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile && pnpm exec playwright install --with-deps chromium
COPY . .
RUN pnpm build && pnpm prune --prod && mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321 DATA_DIR=/app/data
USER node
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4321/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Run node directly (no pnpm/tsx wrapper processes) so SIGTERM reaches the app.
CMD ["node", "--import", "tsx", "src/server/index.ts"]
