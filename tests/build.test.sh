#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS"
STUB
chmod +x "$TMP/docker"
export PATH="$TMP:$PATH" DOCKER_CALLS="$TMP/calls"

bash "$ROOT/build.sh"
[[ $(wc -l < "$DOCKER_CALLS") -eq 2 ]]
grep -F -- '--target service' "$DOCKER_CALLS"
grep -F -- '--target state-ttl' "$DOCKER_CALLS"
grep -F -- '--tag ezenki/cloudflare-manager:latest' "$DOCKER_CALLS"
grep -F -- '--tag ezenki/cloudflare-manager-state-ttl:latest' "$DOCKER_CALLS"
grep -F -- '--platform linux/amd64,linux/arm64,linux/arm/v7,linux/ppc64le,linux/s390x' "$DOCKER_CALLS"

: > "$DOCKER_CALLS"
IMAGE=custom/manager STATE_TTL_IMAGE=custom/ttl TAG=v2 PLATFORMS=linux/amd64 bash "$ROOT/build.sh"
[[ $(wc -l < "$DOCKER_CALLS") -eq 2 ]]
grep -F -- '--tag custom/manager:v2' "$DOCKER_CALLS"
grep -F -- '--tag custom/ttl:v2' "$DOCKER_CALLS"
grep -F -- '--platform linux/amd64' "$DOCKER_CALLS"
