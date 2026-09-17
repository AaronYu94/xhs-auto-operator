# syntax=docker/dockerfile:1.7
#
# AI 汽车运营官 — production image.
# TypeScript runs natively on Node 24 (type stripping); there are no runtime npm dependencies.
# The `verify` stage type-checks and runs the unit tests; the runtime stage depends on its marker so a failing
# check fails the build.

FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV TZ=Asia/Shanghai

# ---- verify: typecheck + unit tests -----------------------------------------------------------
FROM base AS verify
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY test ./test
COPY fixtures ./fixtures
RUN npm run typecheck && npm run test:unit && node src/cli.ts doctor --build-check && touch /app/.verified

# ---- runtime ----------------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    APP_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_PATH=/data/xhs-operator.db \
    SCHEDULER_ENABLED=true
COPY --from=verify /app/.verified /app/.verified
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
# Dealer Brain example bundle (fictional; import your own dealer — seed-demo is refused in production)
COPY fixtures/dealers ./fixtures/dealers
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "src/cli.ts", "serve"]
