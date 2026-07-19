# Stela — self-contained image. SQLite driver by default: one container + one volume.
# Build:  docker build -t stela .
# Run:    see compose.yaml (the app fails loud without ORIGIN / AUTH_MODE / STORAGE_DRIVER).

# ---- build ----
FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
# Manifests first so dependency install caches independently of source edits.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/app/package.json packages/app/
COPY packages/mcp/package.json packages/mcp/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm --filter @stela/app build
# Materialize the app's production node_modules (workspace deps resolved) for the runtime stage.
RUN pnpm --filter @stela/app --prod deploy /deploy

# ---- runtime ----
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DRIVER=sqlite \
    DATA_DIR=/data \
    BODY_SIZE_LIMIT=12000000
COPY --from=build /repo/packages/app/build ./build
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /deploy/package.json ./package.json
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "build"]
