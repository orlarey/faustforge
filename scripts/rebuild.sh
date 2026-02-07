#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-faustforge:latest}"
CONTEXT="${CONTEXT:-.}"
NO_CACHE="${NO_CACHE:-1}"

BUILD_ARGS=()
if [[ "${NO_CACHE}" == "1" ]]; then
  BUILD_ARGS+=(--no-cache)
fi

docker build "${BUILD_ARGS[@]}" -t "${IMAGE}" "${CONTEXT}"
echo "Image rebuilt: ${IMAGE}"
