#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
IMAGE=${IMAGE:-ezenki/cloudflare-manager}
TAG=${TAG:-latest}
PLATFORMS=${PLATFORMS:-linux/amd64,linux/arm64,linux/arm/v7,linux/ppc64le,linux/s390x}

command=(docker buildx build)
if [[ -n "${BUILDER:-}" ]]; then
  command+=(--builder "$BUILDER")
fi
command+=(
  --platform "$PLATFORMS"
  --file "$ROOT/Dockerfile"
  --tag "$IMAGE:$TAG"
  --push
  "$ROOT"
)

"${command[@]}"
