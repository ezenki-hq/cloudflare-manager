# Commander Resource Create Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a failed S3 provisioner create show whether the outgoing request has the documented shape, which safe Huma validation fields failed, and which manager binary ran.

**Architecture:** Inspect the serialized resource-create body for required-field presence and JSON types without recording values. On 422, parse a small bounded Huma problem response and retain only allowlisted field paths and coarse categories, then log them at S3 create failure. Embed the source revision in the service binary and include it in the startup record.

**Tech Stack:** Go 1.25 `log/slog`, `encoding/json`, Docker build args, Bash.

**Global Constraints:**

- Never log request or response values, credentials, Commander URL, resource IDs, or raw validation messages.
- Bound error response parsing and preserve the existing status-only API error behavior for other requests.
- Keep the outgoing resource create JSON compatible with `CreateResourceInputBody` in `docs/integrations/commander-openapi.json`.
- Embed a short git revision when built via `build.sh`; direct Docker builds without the build arg report `unknown`.

### Task 1: Capture safe resource create request and validation diagnostics

**Files:** Modify `backend/internal/commander/client.go`, `backend/internal/commander/client_test.go`, `backend/internal/manager/service_resource.go`, `backend/cmd/cloudflare-manager/main_test.go`.

- [x] Add a failing client test that asserts the exact request structure, including required `config.metadata`, and a 422 Huma response containing a secret sentinel.
- [x] Run the focused tests and confirm they fail on absent request-shape and validation diagnostics.
- [x] Add shape logging for the encoded `POST /resources` body: required field presence plus `config.metadata` JSON kind only.
- [x] Parse at most 32 KiB of a 422 response; retain allowlisted locations and safe categories only. Ignore `value`, `detail`, and raw messages.
- [x] On S3 provisioner create failure, log a fixed rejection stage, status, parser state, locations, and categories. Keep the returned API error status-only.
- [ ] Verify the focused Go tests and commit as `feat: report safe Commander resource validation details`.

### Task 2: Identify the running manager build

**Files:** Modify `backend/cmd/cloudflare-manager/main.go`, `Dockerfile`, and `build.sh`.

- [ ] Add a startup log field for the embedded build revision.
- [ ] Pass the short git revision from `build.sh` through a Docker build argument and linker flag; preserve `unknown` as the fallback for direct builds.
- [ ] Build with a known test revision and run a failed Commander startup smoke test to confirm the revision and stage appear without credentials.
- [ ] Run all Go tests, `go vet`, manager build, build-script shell check, and `git diff --check`; commit as `feat: log manager build revision`.

## Final verification

Run `cd backend && go test ./... && go vet ./... && go build -o /tmp/cloudflare-manager-startup-check ./cmd/cloudflare-manager`, validate the revision using a linker-flag build and local unreachable Commander, then review the diff for secret exposure. No live install or remote publication is part of this work.
