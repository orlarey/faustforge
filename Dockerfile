FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY mcp.mjs ./mcp.mjs
COPY faust-doc-index.mjs ./faust-doc-index.mjs
COPY scripts/build-faust-doc-index.mjs ./scripts/build-faust-doc-index.mjs

RUN npm run build
RUN node ./scripts/build-faust-doc-index.mjs ./dist/faust-doc-index.json

FROM docker:27-cli AS dockercli

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

# Docker CLI is required to run the Faust compiler container through /var/run/docker.sock.
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update \
  && apt-get install -y --no-install-recommends zip \
  && rm -rf /var/lib/apt/lists/*
RUN apt-get update \
  && apt-get install -y --no-install-recommends zip \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV SESSIONS_DIR=/app/sessions

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/mcp.mjs ./mcp.mjs
COPY --from=build /app/faust-doc-index.mjs ./faust-doc-index.mjs

RUN mkdir -p /app/sessions

EXPOSE 3000

CMD ["node", "dist/index.js"]
