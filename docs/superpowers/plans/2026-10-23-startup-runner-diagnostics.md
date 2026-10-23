# Startup Runner Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a failed Cloudflare Manager startup explain its last completed step and failure in the Deploy Commander run log.

**Architecture:** The installer opts the checked service into the runner's health probe and container tail diagnostics. The Go service writes short structured startup stages to stderr and names mismatched provisioner fields in errors without printing returned values. Health gating and resource creation behavior stay the same.

**Tech Stack:** TypeScript, Vitest, Go 1.25 `log/slog`, Deploy Commander runner health-check metadata.

**Spec:** `docs/superpowers/specs/2026-10-23-startup-runner-diagnostics-design.md`

## Global Constraints

- Set `health_check.log_health_output` and `health_check.log_container_output` to `true` for the `cloudflare-manager` service only. Keep the existing health command and timing values.
- Keep `generate-jwt-secret.stream_output` as `false`; do not expose its captured value.
- Do not log the manager password, JWT secret, Commander URL, request or response bodies, resource metadata values, access tokens, or resource IDs.
- Preserve startup's fail-before-health behavior and the current provisioner validation rules.
- The runner prints these diagnostic sources only when a service fails its checked startup. Do not add continuous log streaming or change the runner.

## Review Focus

- Secret interpolation on the service must not suppress the requested container tail: Task 1 asserts `log_container_output: true`.
- A failing or restarting health probe must be available to the runner: Task 1 asserts `log_health_output: true` with the existing `CMD` test.
- A Commander failure after identity verification must show its stage and status without credential values: Task 2 tests a `503` response with a sentinel password.
- First install and reinstall must have distinct, nonsecret S3 provisioner stages: Task 2 tests create and reuse.
- A malformed provisioner response with an unexpected value must identify the failing field without printing that value: Task 2 tests configuration type and metadata marker mismatches.

---

### Task 1: Enable runner diagnostics for failed service startup

**Files:** Modify `installer/src/installer.ts` and `installer/src/installer.test.ts`.

**Interfaces:** `buildInstallRun(input: InstallInput & { managerId: string; commander: CommanderConnection }): StartRunOptions` continues to produce the install metadata. Its `services["cloudflare-manager"].health_check` gains Boolean `log_health_output` and `log_container_output` fields; no other service or runner field changes.

- [ ] **Step 1: Write the failing installer assertion.** Extend the existing `builds a values-enabled one-click install with approved Commander connection` test to assert both diagnostic fields are `true`, the health command remains `["CMD", "/app/cloudflare-manager", "healthcheck"]`, and `generate-jwt-secret.stream_output` remains `false`.
- [ ] **Step 2: Run the focused test.** Run `cd installer && npm test -- --run src/installer.test.ts`. Expect failure only on the missing diagnostic fields.
- [ ] **Step 3: Set both fields in `buildInstallRun`.** Add `log_health_output: true` and `log_container_output: true` to the existing service `health_check` object. Do not set a generic service `stream_output` field.
- [ ] **Step 4: Verify the task.** Run `cd installer && npm test -- --run src/installer.test.ts && npm run build`. Expect all focused tests and the build to pass.
- [ ] **Step 5: Commit.** Stage the two installer files and commit as `feat: show manager startup diagnostics in runner`.

### Task 2: Emit safe startup stages and mismatch reasons

**Files:** Modify `backend/cmd/cloudflare-manager/main.go`, `backend/cmd/cloudflare-manager/main_test.go`, `backend/internal/manager/service_resource.go`, and `backend/internal/manager/service_resource_test.go`.

**Interfaces:** Keep `prepareCommander(ctx context.Context, managerID string, client *commander.Client) error`, `(*Service).EnsureServiceResource(ctx context.Context) (string, error)`, and `validateServiceResource(detail commander.ResourceDetail, managerID, resourceID string) error` unchanged. Add `slog.Info` records with message `Cloudflare Manager startup` and fixed `stage` values: `configuration_validated`, `commander_verification_started`, `commander_verified`, `s3_provisioner_lookup_started`, `s3_provisioner_create_started`, `s3_provisioner_created`, `s3_provisioner_reuse_started`, `s3_provisioner_reused`, and `http_listener_starting`. Only the stage key and fixed value may be attached to these records. Validation errors may name a fixed field path such as `config.resource_type` or `config.metadata.provider`; they must not include the received value.

- [ ] **Step 1: Write failing Go tests.** In `main_test.go`, capture the default `slog` handler around `prepareCommander` with a local Commander HTTP server that verifies the manager and returns `503` for `/resources/mine`; assert stages `commander_verified` and `s3_provisioner_lookup_started`, the returned error's `status 503`, and no sentinel password or Commander URL in captured logs. In `service_resource_test.go`, capture logs across create then reuse and assert the distinct stage values; add a validation case with a missing `config.resource_type` and one with a secret-looking `config.metadata.provider`, asserting the error names the field but never the value.
- [ ] **Step 2: Run focused tests.** Run `cd backend && go test ./cmd/cloudflare-manager ./internal/manager -run 'TestPrepareCommanderLogs|TestEnsureServiceResourceLogs|TestValidateServiceResourceNames' -count=1`. Expect failure on missing stages and mismatch field names.
- [ ] **Step 3: Add the startup records and safe errors.** Emit stages at the points named in Interfaces: after environment/JWT validation, before and after Commander verification, around S3 lookup and create/reuse, and just before `ListenAndServe`. Split the existing combined provisioner validation conditions so each failed check returns a fixed field path while preserving every existing comparison, including the exact metadata field count and contract version. Keep `log.Fatal` as the final error output and do not log any input or response values.
- [ ] **Step 4: Verify the task and failure path.** Run `cd backend && go test ./... && go vet ./... && go build -o /tmp/cloudflare-manager-startup-check ./cmd/cloudflare-manager`. Then run that binary with dummy `MANAGER_ID`, a deliberately unreachable local `MANAGER_API`, a sentinel dummy password, and a valid dummy JWT secret; expect a nonzero exit with `configuration_validated` and `commander_verification_started`, and no dummy password or JWT value in output. Run `git diff --check`.
- [ ] **Step 5: Commit.** Stage the four Go files and commit as `feat: log safe manager startup stages`.

## Final verification

Run `cd installer && npm test -- --run && npm run build` and `cd backend && go test ./... && go vet ./...` on the completed branch. Review the diff against every Global Constraint and Review Focus item. The next real failed install run is the check for the runner's new diagnostic output; do not claim the external Commander failure is fixed before that evidence is available.
