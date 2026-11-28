# The API (which also serves the web app and the add-in panes), the runs worker and the TLS
# proxy. Build context is the repository root; compose.yaml picks the target.

FROM node:22.23.5-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && npm install -g pnpm@12.18.0
WORKDIR /app
ENV CI=true

FROM base AS build
# The add-in manifests name the address Office loads the panes from.
ARG ADDIN_ORIGIN=https://localhost
COPY . .
RUN pnpm install --frozen-lockfile
RUN ADDIN_ORIGIN="$ADDIN_ORIGIN" pnpm --filter "@legallabs/api..." --filter "@legallabs/web..." \
    --filter "@legallabs/word-addin..." --filter "@legallabs/outlook-addin..." build
# Only what runs is kept: the dev tools are left behind.
RUN find . -name node_modules -type d -prune -exec rm -r {} + \
    && pnpm install --frozen-lockfile --prod --filter "@legallabs/api..."

FROM base AS server
ENV NODE_ENV=production
COPY --from=build /app /app
USER node

FROM server AS api
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "apps/api/dist/server.js"]

FROM server AS worker
CMD ["node", "apps/api/dist/runs-worker.js"]

FROM caddy:2.11.9-alpine AS proxy
COPY infra/compose/Caddyfile /etc/caddy/Caddyfile

# Backup and restore: the server's own Postgres tools, plus the app's code.
FROM pgvector/pgvector:0.8.7-pg17-bookworm AS ops
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gnupg
COPY --from=base /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app /app
WORKDIR /app
ENV NODE_ENV=production
ENTRYPOINT ["node", "apps/api/dist/deploy/backup-cli.js"]
