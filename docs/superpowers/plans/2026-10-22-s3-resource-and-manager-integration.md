# S3 Resource and Manager Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a durable S3 provisioner resource at full stack install and let other managers create R2 bucket resources with optional CDN domains through a documented child interface.

**Architecture:** The Go service ensures the provisioner resource before opening its health endpoint. The installer explains metadata commands when the service is absent. The management frontend validates a child request, guides the signed-in user through bucket and CDN setup, and returns nonsecret resource details; existing connection actions remain separate.

**Tech Stack:** Go `net/http`, React 19, TypeScript, Vitest, Deploy Commander manager RPC.

**Spec:** `docs/superpowers/specs/2026-10-22-s3-resource-and-manager-integration-design.md`

## Global Constraints

- Provisioner resource: type `s3`, name `Cloudflare R2 S3`, `external: true`, metadata `{ "provider": "cloudflare-r2", "role": "provisioner", "contract_version": 1 }`.
- Bucket resource type remains `cloudflare-r2-bucket`; bucket identity is account ID, jurisdiction, and bucket name.
- Installation requires no Cloudflare account or OAuth grant. A failed provisioner ensure must prevent service health and successful installation.
- Teardown preserves the provisioner resource, bucket resource records, Cloudflare buckets, and CDN domains.
- No OAuth or S3 secret value appears in resource metadata, child metadata/results, labels, or logs.
- The new consuming-manager guide is `CLOUDFLARE_MANAGER_INTEGRATION_GUIDE.md` in the project root.

## Review Focus

- A conflicting, duplicated, or unavailable Commander `s3` resource must block startup instead of making discovery ambiguous or falsely reporting health (Task 1 tests).
- A forged caller identity, foreign resource, or unsupported child action must cause a structured failure without Cloudflare mutation (Tasks 3 and 4 tests).
- A bucket created before resource registration fails must be recoverable by selecting the existing bucket on retry (Task 3 tests).
- A domain attached before primary metadata update fails must be recognized on retry, without a second attach (Task 3 tests).
- A generic manager omitting Custom Deployer labels must still be able to create a bucket scoped connection (Task 4 tests).

---

### Task 1: Ensure the install time S3 provisioner

**Files:** Create `backend/internal/manager/service_resource.go`, `backend/internal/manager/service_resource_test.go`; modify `backend/cmd/cloudflare-manager/main.go`, `backend/cmd/cloudflare-manager/main_test.go`.

**Interfaces:** Produce `(*manager.Service).EnsureServiceResource(ctx context.Context) (string, error)` and constants `ServiceResourceType = "s3"`, `ServiceResourceName = "Cloudflare R2 S3"`. Use the existing `Commander` interface methods. Produce `prepareCommander(ctx context.Context, managerID string, client *commander.Client) error` in `main.go`; it verifies identity and ensures the resource before `serve` starts the HTTP server.

- [ ] **Step 1: Write failing Go tests.** `TestEnsureServiceResourceCreatesAndReuses` checks one `CreateResource` call, exact external/type/name/metadata, and the same ID on a second call. `TestEnsureServiceResourceRejectsConflicts` checks wrong metadata, foreign ownership, and two matches. `TestEnsureServiceResourcePropagatesCommanderFailure` checks list/create errors and no successful ID. `TestPrepareCommanderStopsBeforeHealthOnResourceFailure` uses a local Commander HTTP stub to assert that a resource error is returned before the server listener starts. Assert that metadata contains no account, bucket, endpoint, domain, or secret fields.

  ```go
  if firstID != "service-1" || secondID != firstID || fake.createCalls != 1 { t.Fatal("service resource was not reused") }
  if input.Type != "s3" || input.Name != "Cloudflare R2 S3" || !input.External { t.Fatalf("wrong resource: %#v", input) }
  if err == nil || !strings.Contains(err.Error(), "ensure S3 service resource") { t.Fatalf("startup should fail: %v", err) }
  ```
- [ ] **Step 2: Run `cd backend && go test ./internal/manager -run 'TestEnsureServiceResource' -count=1`.** Expect failure because the method does not exist.
- [ ] **Step 3: Implement `EnsureServiceResource` and call it through `prepareCommander` in `serve`.** Filter owned `s3` resources, fetch and verify the full matching record, reject conflict or ambiguity, create only when none exists, and verify the created record. Wrap startup failure with `ensure S3 service resource` and return before `ListenAndServe`.
- [ ] **Step 4: Run `cd backend && go test ./internal/manager ./cmd/cloudflare-manager -count=1 && go vet ./...`.** Expect success. Review `main.go` to confirm ensure precedes the server listener.
- [ ] **Step 5: Commit** `backend/internal/manager/service_resource.go`, its tests, and `main.go` as `feat: publish S3 provisioner on manager startup`.

### Task 2: Explain metadata commands in the installer

**Files:** Modify `installer/src/InstallApp.tsx`, `installer/src/InstallApp.test.tsx`, and `installer/src/styles.css` only if the existing alert style is insufficient.

**Interfaces:** `InstallApp` calls `bridge.caller.getMetadata()` once on mount. A nonblank string `action` sets a visible command notice; it does not call `wire.close` or execute that action. The existing Install control and run recovery continue to work.

- [ ] **Step 1: Write failing installer tests.** With `{ action: "create-bucket" }`, assert the user sees the action and an instruction to install the full stack manager, while the Install button remains available. With absent or whitespace action, assert no notice. With markup in the action, assert it is rendered as text. Assert `wire.close` is not called.

  ```ts
  expect(screen.getByText(/install the full stack cloudflare manager/i)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
  expect(bridge.wire.close).not.toHaveBeenCalled();
  ```
- [ ] **Step 2: Run `cd installer && npm test -- --run src/InstallApp.test.tsx`.** Expect the command notice test to fail.
- [ ] **Step 3: Implement the metadata read and notice in `InstallApp`.** Keep metadata read errors as a visible nonblocking status; keep the existing installation flow and postinstall reload.
- [ ] **Step 4: Run `cd installer && npm test -- --run src/InstallApp.test.tsx && npm run build`.** Expect success.
- [ ] **Step 5: Commit** the installer changes as `feat: guide child commands to full stack installation`.

### Task 3: Validate and complete bucket and CDN setup

**Files:** Create `frontend/src/bucketWorkflow.ts`, `frontend/src/bucketWorkflow.test.ts`; modify `frontend/src/resources.ts` to export `bucketEndpoint(accountId: string, jurisdiction: string): string` and replace the private endpoint helper in `frontend/src/App.tsx`.

**Interfaces:** Produce `validateBucketRequest(caller: RPCCaller, metadata: unknown, callingManager: string | null): Promise<BucketRequest>`, `setupBucket(caller: RPCCaller, api: BackendAPI, request: BucketRequest, selection: BucketSelection, onProgress?: (progress: BucketProgress) => void): Promise<BucketSetupResult>`, and `BucketSetupError` with `failedStep: "validate" | "bucket" | "resource" | "domain" | "primary" | "status"` and `progress: BucketProgress`. `BucketRequest` contains `serviceResourceId`, `callingManagerId`, and optional `suggested` values using the spec's snake case keys. `BucketSelection` contains `accountId`, `jurisdiction`, `bucket`, `mode: "create" | "existing"`, optional `domain` and `zoneId`. `BucketProgress` contains `bucketExists: boolean`, optional `resourceId`, `domainAttached: boolean`, and `lastCompleted: "none" | "bucket" | "resource" | "domain" | "primary"`. `BucketSetupResult` is the spec's nonsecret `result` object.

- [ ] **Step 1: Write failing workflow tests.** Validate the current manager, trusted caller, exact provisioner type/metadata, and rejection before mutation. Test creating a bucket and returning its resource; selecting an existing bucket through `getBucket`; register failure after create with progress that permits retry in `existing` mode; a requested domain found in `listDomains` without a new attach; attach followed by primary metadata failure and retry without a second attach; pending CDN status in the result; and omission of `cdn` and secrets when no domain was requested.

  ```ts
  expect(api.createBucket).toHaveBeenCalledTimes(1); // after create fails at registration, retry in existing mode
  expect(api.attachDomain).toHaveBeenCalledTimes(1); // after metadata update fails, retry finds attached domain
  expect(result.resource).toEqual({ id: "bucket-resource", manager: "cloudflare-manager", type: "cloudflare-r2-bucket" });
  expect(JSON.stringify(result)).not.toMatch(/access_key|secret|token/i);
  ```
- [ ] **Step 2: Run `cd frontend && npm test -- --run src/bucketWorkflow.test.ts`.** Expect failure because the workflow module is missing.
- [ ] **Step 3: Implement the request parser and workflow.** Require exact owned provisioner identity through `caller.getResource`; treat suggestions as form defaults only. Validate selected account and zone against `api.listAccounts` and `api.listZones`, and verify existing buckets with `api.getBucket`. Use `registerBucket`, `setBucketPrimaryDomain`, `api.listDomains`, and `api.attachDomain`; return current Cloudflare CDN status. Report completed steps through `onProgress`; wrap failed steps without losing progress. Do not delete external state on failure.
- [ ] **Step 4: Run `cd frontend && npm test -- --run src/bucketWorkflow.test.ts && npm run build`.** Expect success.
- [ ] **Step 5: Commit** workflow, tests, and endpoint helper as `feat: coordinate R2 bucket and CDN child setup`.

### Task 4: Render and close the bucket child interface

**Files:** Create `frontend/src/BucketSetup.tsx`, `frontend/src/BucketSetup.test.tsx`, `frontend/src/main.test.tsx`; modify `frontend/src/main.tsx`, `frontend/src/childWorkflow.ts`, `frontend/src/childWorkflow.test.ts`, and `frontend/src/styles.css`.

**Interfaces:** `BucketSetup` receives validated `BucketRequest`, `BackendAPI`, `CommanderBridge`, `backendOrigin`, and `onClose(response: InterfaceResponse)`. It calls Task 3's `setupBucket` only after a form confirmation. `main.tsx` routes `create-bucket` to this component; it routes existing connection actions to `handleChildAction`; any other action closes with a structured failed `InterfaceResponse`. Existing `create-connection` accepts omitted `labels` for generic callers and omits labels from the result in that case; it preserves the exact Custom Deployer label validation when labels are supplied. `onClose` calls `wire.close` once and ends the wire afterward.

- [ ] **Step 1: Write failing UI and routing tests.** Assert signed-out state offers the existing OAuth popup/session-handle flow; successful sign-in loads accounts/zones; prefilled suggestions cause no mutation until confirmation; create/existing mode and optional CDN fields reach `setupBucket`; partial failure shows completed steps and retry without closing; cancel closes with failure; success closes with `manager`, `ok: true`, and the exact nonsecret result. In `main.test.tsx`, test unknown action and invalid request closing with failure before Cloudflare mutation and existing connection dispatch. In `childWorkflow.test.ts`, test omitted labels creating a generic connection and supplied Custom Deployer labels retaining their current validation.

  ```ts
  expect(api.createBucket).not.toHaveBeenCalled(); // after suggestions render, before confirmation
  expect(api.provisionConnection).toHaveBeenCalledWith({ resource_id: "bucket-resource", manager_id: "app-manager", permission: "read-only" });
  expect(bridge.wire.close).toHaveBeenCalledWith({ manager: "cloudflare-manager", ok: true, result: expectedResult });
  ```
- [ ] **Step 2: Run `cd frontend && npm test -- --run src/BucketSetup.test.tsx src/main.test.tsx src/childWorkflow.test.ts`.** Expect the new child tests to fail.
- [ ] **Step 3: Build the guided child view and dispatch.** Reuse the existing `BackendAPI` OAuth methods and popup message checks, including origin and source validation. Show explicit account/jurisdiction/mode/bucket/domain/zone controls; preserve progress on retry and switch a successfully created bucket to `existing` mode. Accept absent labels only for generic `create-connection`; reject malformed supplied labels. Ensure wire disposal and one close response on success or cancellation.
- [ ] **Step 4: Run `cd frontend && npm test -- --run && npm run build`.** Expect success, including existing management UI tests.
- [ ] **Step 5: Commit** the child UI and routing as `feat: expose guided bucket setup to other managers`.

### Task 5: Publish the root integration guide

**Files:** Create `CLOUDFLARE_MANAGER_INTEGRATION_GUIDE.md`; modify `README.md`.

**Interfaces:** Document discovery of the `s3` provisioner; the `startInterface` request for `create-bucket`; the successful `InterfaceResponse`; result identity verification; the `create-connection` request with optional group labels; `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` storage and `[[secret:connection:CONNECTION_UUID:KEY]]` runner references.

- [ ] **Step 1: Draft the guide with complete JSON/TypeScript examples.** Include user confirmation and OAuth, optional CDN pending status, partial failure and retry, installer guidance before installation or after teardown, and preservation of service/bucket resources and Cloudflare state.
- [ ] **Step 2: Link the root guide from `README.md`.** Use a relative root link and keep the existing integration links working.
- [ ] **Step 3: Verify guide examples against the implemented request/result types and connection workflow.** Run `rg -n 'create-bucket|create-connection|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|teardown' CLOUDFLARE_MANAGER_INTEGRATION_GUIDE.md` and `git diff --check`; expect all required topics and no whitespace errors.
- [ ] **Step 4: Run final verification:** `cd backend && go test ./... && go vet ./...`; `cd frontend && npm test -- --run && npm run build`; `cd installer && npm test -- --run && npm run build`. Expect all to pass. Record whether live Commander and Cloudflare staging was available; do not claim an unrun staging check passed.
- [ ] **Step 5: Commit** the guide and README as `docs: explain Cloudflare Manager integration`.

## Execution Handoff

Implement natively in Luna using `superpowers:executing-plans`, one task and test cycle at a time. Before implementation, use `superpowers:using-git-worktrees` if isolation is needed. After implementation, run `superpowers:verification-before-completion` and review the branch. If a worktree is used, report whether it has been merged and offer that option.
