# syntax=docker/dockerfile:1
# Build only. No provisioning, migration or deployment step.
FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN --mount=type=secret,id=proxy_ca,required=true NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --ignore-scripts --workspace=axfluxo-video-server --include-workspace-root=false
COPY server server
COPY src/domain src/domain
COPY src/config src/config
RUN npm run build:render --workspace=axfluxo-video-server && npm prune --omit=dev --workspace=axfluxo-video-server --include-workspace-root=false --ignore-scripts && mkdir /runtime && cp work/video-server/render.mjs /runtime/ && mv node_modules /runtime/
FROM node:24.19.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=512 VIDEO_RENDER_DISK=/work VIDEO_RENDER_ENABLED=false
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/render.mjs"]
COPY --from=build /runtime/ ./
RUN --mount=type=secret,id=proxy_ca,required=true apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca update && apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir /work && chown node:node /work
USER node:node
