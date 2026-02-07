#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-faustforge:latest}"
NAME="${NAME:-faustforge}"
PORT="${PORT:-3000}"
HOST_SESSIONS_DIR="${HOST_SESSIONS_DIR:-$HOME/.faustforge/sessions}"
FAUST_HTTP_URL="${FAUST_HTTP_URL:-http://localhost:${PORT}}"

mkdir -p "${HOST_SESSIONS_DIR}"

docker rm -f "${NAME}" >/dev/null 2>&1 || true

docker run -d \
  --name "${NAME}" \
  -p "${PORT}:3000" \
  -v "${HOST_SESSIONS_DIR}:/app/sessions" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e SESSIONS_DIR=/app/sessions \
  -e HOST_SESSIONS_DIR="${HOST_SESSIONS_DIR}" \
  -e FAUST_HTTP_URL="${FAUST_HTTP_URL}" \
  "${IMAGE}"

echo "Container '${NAME}' started on http://localhost:${PORT}"
