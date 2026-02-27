#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-faustforge:latest}"
NAME="${NAME:-faustforge}"
PORT="${PORT:-3000}"
HOST_SESSIONS_DIR="${HOST_SESSIONS_DIR:-$HOME/.faustforge/sessions}"
FAUST_HTTP_URL="${FAUST_HTTP_URL:-http://localhost:${PORT}}"
LIVE_AUTO_DISCOVER="${LIVE_AUTO_DISCOVER:-1}"
HOST_WORKSPACE_DIR="${HOST_WORKSPACE_DIR:-$HOME/faust-workspace}"
LIVE_WORKSPACE_ROOT="${LIVE_WORKSPACE_ROOT:-/workspace}"
HOST_LIVE_WORKSPACE_ROOT="${HOST_LIVE_WORKSPACE_ROOT:-${HOST_WORKSPACE_DIR}}"
LIVE_SCAN_INTERVAL_MS="${LIVE_SCAN_INTERVAL_MS:-1500}"
LIVE_IGNORE_DIRS="${LIVE_IGNORE_DIRS:-}"
MAX_SESSIONS="${MAX_SESSIONS:-0}"

mkdir -p "${HOST_SESSIONS_DIR}"
mkdir -p "${HOST_WORKSPACE_DIR}"

docker rm -f "${NAME}" >/dev/null 2>&1 || true

RUN_ARGS=(
  -d
  --name "${NAME}"
  -p "${PORT}:3000"
  -v "${HOST_SESSIONS_DIR}:/app/sessions"
  -v "${HOST_WORKSPACE_DIR}:${LIVE_WORKSPACE_ROOT}"
  -v /var/run/docker.sock:/var/run/docker.sock
  -e SESSIONS_DIR=/app/sessions
  -e HOST_SESSIONS_DIR="${HOST_SESSIONS_DIR}"
  -e FAUST_HTTP_URL="${FAUST_HTTP_URL}"
  -e LIVE_WORKSPACE_ROOT="${LIVE_WORKSPACE_ROOT}"
  -e HOST_LIVE_WORKSPACE_ROOT="${HOST_LIVE_WORKSPACE_ROOT}"
  -e MAX_SESSIONS="${MAX_SESSIONS}"
)

if [[ "${LIVE_AUTO_DISCOVER}" == "1" ]]; then
  RUN_ARGS+=(
    -e LIVE_AUTO_DISCOVER=1
    -e LIVE_SCAN_INTERVAL_MS="${LIVE_SCAN_INTERVAL_MS}"
  )
  if [[ -n "${LIVE_IGNORE_DIRS}" ]]; then
    RUN_ARGS+=(-e LIVE_IGNORE_DIRS="${LIVE_IGNORE_DIRS}")
  fi
fi

docker run "${RUN_ARGS[@]}" \
  "${IMAGE}"

echo "Container '${NAME}' started on http://localhost:${PORT}"
