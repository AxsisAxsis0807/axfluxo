# syntax=docker/dockerfile:1
# Build only. No provisioning, migration or deployment step.
FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN --mount=type=secret,id=proxy_ca if [ -s /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; npm ci --ignore-scripts --workspace=axfluxo-video-server --include-workspace-root=false
COPY server server
COPY src/domain src/domain
COPY src/config src/config
RUN npm run build --workspace=axfluxo-video-server && npm run build:worker --workspace=axfluxo-video-server && npm run build:probe --workspace=axfluxo-video-server && npm run build:export-worker --workspace=axfluxo-video-server && npm run build:derivatives --workspace=axfluxo-video-server && npm run build:render --workspace=axfluxo-video-server && npm run build:deletion --workspace=axfluxo-video-server && npm run build:notifications --workspace=axfluxo-video-server && npm prune --omit=dev --workspace=axfluxo-video-server --include-workspace-root=false --ignore-scripts && mkdir -p /runtime/assets && cp work/video-server/*.mjs /runtime/ && cp server/worker/templates/all-versions/assets/* /runtime/assets/ && cp server/worker/templates/fnf-showcase/assets/NotoSansJP.ttf /runtime/assets/ && cp server/worker/templates/fnf-showcase/assets/OFL.txt /runtime/assets/NotoSansJP-OFL.txt && chmod 644 /runtime/assets/* && mv node_modules /runtime/
FROM node:24.19.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production VIDEO_RENDER_DISK=/work VIDEO_RENDER_ENABLED=false VIDEO_ALEO_FONT=/app/assets/Aleo.ttf VIDEO_FNF_FONT=/app/assets/NotoSansJP.ttf
STOPSIGNAL SIGTERM
RUN --mount=type=secret,id=proxy_ca set -eu; if [ -s /run/secrets/proxy_ca ]; then export APT_CONFIG=/tmp/axfluxo-apt.conf; printf 'Acquire::https::CaInfo "/run/secrets/proxy_ca";\n' > "$APT_CONFIG"; fi; apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* /tmp/axfluxo-apt.conf && mkdir /work && chown node:node /work
COPY --from=build /runtime/ ./
USER node:node

# Separate selectable targets; CMD may be replaced with another bundled worker.
FROM runtime AS api
ENV NODE_OPTIONS=--max-old-space-size=128
ENTRYPOINT ["node"]
CMD ["/app/api.mjs"]
FROM runtime AS worker
ENV NODE_OPTIONS=--max-old-space-size=128 VIDEO_WORKER_ENABLED=false TMPDIR=/work
VOLUME ["/work"]
ENTRYPOINT ["node"]
CMD ["/app/worker.mjs"]
# Minimal cloud export worker: database bytes only, no shared disk with the API.
FROM runtime AS export-worker
ENV NODE_OPTIONS=--max-old-space-size=256 TMPDIR=/work EXPORT_WORK_DIR=/work EXPORT_MIN_FREE_BYTES=268435456
VOLUME ["/work"]
ENTRYPOINT ["node", "/app/export-worker.mjs"]
# Default target preserves the existing render image command and heap setting.
FROM runtime AS render
ENV NODE_OPTIONS=--max-old-space-size=512
ENTRYPOINT ["node", "/app/render.mjs"]
