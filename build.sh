#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
IMAGE=${IMAGE:-ezenki/cloudflare-manager}
STATE_TTL_IMAGE=${STATE_TTL_IMAGE:-ezenki/cloudflare-manager-state-ttl}
TAG=${TAG:-latest}
PLATFORMS=${PLATFORMS:-linux/amd64,linux/arm64,linux/arm/v7,linux/ppc64le,linux/s390x}

command=(docker buildx build)
if [[ -n "${BUILDER:-}" ]]; then
  command+=(--builder "$BUILDER")
fi
command+=(
  --target service
  --platform "$PLATFORMS"
  --file "$ROOT/Dockerfile"
  --tag "$IMAGE:$TAG"
  --push
  "$ROOT"
)

"${command[@]}"

ttl_command=(docker buildx build)
if [[ -n "${BUILDER:-}" ]]; then
  ttl_command+=(--builder "$BUILDER")
fi
ttl_command+=(
  --target state-ttl
  --platform "$PLATFORMS"
  --file "$ROOT/Dockerfile"
  --tag "$STATE_TTL_IMAGE:$TAG"
  --push
  "$ROOT"
)

"${ttl_command[@]}"
