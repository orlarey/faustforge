#!/usr/bin/env bash
set -euo pipefail

NAME="${NAME:-faustforge}"

docker rm -f "${NAME}" >/dev/null 2>&1 || true
echo "Container '${NAME}' stopped and removed"
