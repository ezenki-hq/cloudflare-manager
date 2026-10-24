#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
IMAGE=${IMAGE:-ezenki/cloudflare-manager}
STATE_TTL_IMAGE=${STATE_TTL_IMAGE:-ezenki/cloudflare-manager-state-ttl}
TAG=${TAG:-latest}
PLATFORMS=${PLATFORMS:-linux/amd64,linux/arm64,linux/arm/v7,linux/ppc64le,linux/s390x}
BUILD_REVISION=${BUILD_REVISION:-$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || true)}
if [[ -z "$BUILD_REVISION" ]]; then
  BUILD_REVISION=unknown
fi

command=(docker buildx build)
if [[ -n "${BUILDER:-}" ]]; then
  command+=(--builder "$BUILDER")
fi
command+=(
  --target service
  --build-arg "BUILD_REVISION=$BUILD_REVISION"
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
  --build-arg "BUILD_REVISION=$BUILD_REVISION"
  --platform "$PLATFORMS"
  --file "$ROOT/Dockerfile"
  --tag "$STATE_TTL_IMAGE:$TAG"
  --push
  "$ROOT"
)

"${ttl_command[@]}"
