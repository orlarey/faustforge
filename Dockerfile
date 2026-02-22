# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm config set fetch-retries 10 \
    && npm config set fetch-retry-factor 2 \
    && npm config set fetch-retry-mintimeout 10000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm config set fetch-timeout 300000 \
    && npm ci --prefer-offline --no-audit --fund=false

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY mcp.mjs ./mcp.mjs
COPY faust-doc-index.mjs ./faust-doc-index.mjs
COPY scripts/build-faust-doc-index.mjs ./scripts/build-faust-doc-index.mjs

RUN npm run build
RUN node ./scripts/build-faust-doc-index.mjs ./dist/faust-doc-index.json
RUN npm prune --omit=dev

FROM docker:27-cli AS dockercli

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

# Docker CLI is required to run the Faust compiler container through /var/run/docker.sock.
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

ENV NODE_ENV=production
ENV PORT=3000
ENV SESSIONS_DIR=/app/sessions

COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/mcp.mjs ./mcp.mjs
COPY --from=build /app/faust-doc-index.mjs ./faust-doc-index.mjs

RUN mkdir -p /app/sessions

EXPOSE 3000

CMD ["node", "dist/index.js"]
