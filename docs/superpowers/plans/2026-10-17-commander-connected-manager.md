# Commander-Connected Cloudflare Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the React installer one-click and small, connect the Go manager to Commander, move documented Commander record operations into Go, and implement the Resource Connection Manager Guide through signed frontend requests.

**Architecture:** The installer obtains or reuses a Commander-owned connection, then passes its IDs and connection-secret reference to a values-capable runner. Go authenticates to Commander with Basic credentials, verifies route-bound browser JWTs, and owns Cloudflare and documented Commander API operations. The frontend retains RPC for settings, child hosting, S3 secret writes, resource metadata update/deletion, and run events.

**Tech Stack:** React 19, TypeScript 7, Vite 8, Vitest, Go 1.25 standard library, Deploy Commander interface 0.7.0 and runner `values_version: 1`.

**Spec:** [One-Click Installer, Commander Connection, and JWT Backend Contract](../specs/2026-10-17-one-click-installer-jwt-design.md)

## Global Constraints

- Keep `installer/` and `frontend/` as separate React projects.
- Installer starts with one Install click; OAuth client ID is optional.
- Go receives `MANAGER_ID`, `MANAGER_API`, `MANAGER_PASSWORD`, and `JWT_SECRET` from the runner; no fixed Cloudflare client ID or public/browser origin environment values.
- `MANAGER_PASSWORD` is `[[secret:connection:<approved-connection-id>:COMMANDER_PASSWORD]]`; never put the literal password in run metadata.
- Runner metadata uses `values_version: 1`, a pinned values-capable runner, an authorized `Connection` reference, a non-streamed random-secret capture, and an idempotent database hook.
- Browser-to-Go application calls use separate POST routes with the compact HS256 JWT as the whole body; `GET /auth/callback`, static files, health, and safe OPTIONS preflight are exceptions.
- JWTs have `aud`, `path`, `origin`, `iat`, `exp`, and `data`; maximum validity is 60 seconds. Signing value stays in browser memory.
- Use unpadded base64url for the 32-byte generated signing value and compact JWT segments. `aud` is exactly `MANAGER_ID`; `iat`/`exp` are Unix seconds with `exp = iat + 60` and 5 seconds of clock skew.
- Group label names are exactly `custom_deployer_group_id` and `custom_deployer_connection_origin`. Origins are `created` and `imported`.
- Ready S3 connections declare only key names in live `metadata.secret_keys`: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
- The deterministic SurrealDB record is `manager_settings:current` with fields `cloudflare_client_id` and `jwt_secret`; writing one field preserves the other. Check every returned statement status.
- Preserve the install and teardown latest-event recovery and live listener.
- Remove `tldts` and unused installer Tailwind tooling; target installer output below 300 kB minified with no 500 kB warning.
- Do not stage or overwrite the user's uncommitted edits in `docs/integrations/`. Review them again before implementing the contracts.

## File structure and route contract

| Unit | Files and responsibility |
| --- | --- |
| JWT core | New `backend/internal/jwt/jwt.go` and tests: generate and verify the exact signed request contract. |
| Commander transport | New `backend/internal/commander/client.go` and tests: authenticated `/api/v1` requests, typed resources/connections, labels, database query. |
| Go workflows | New `backend/internal/manager/manager.go` and tests: resource ownership, R2 credential lifecycle, group labels, teardown preparation. |
| Go HTTP and OAuth | Modify `backend/internal/server/server.go`, `backend/internal/auth/oauth.go`, `backend/cmd/cloudflare-manager/main.go` and tests. |
| Installer | New `installer/src/commanderConnection.ts`, `installer/src/settings.ts`; modify `installer/src/installer.ts`, `InstallApp.tsx`, `main.tsx`, CSS, package files and tests. |
| Frontend | New `frontend/src/jwt.ts`, `frontend/src/settings.ts`; modify `api.ts`, `App.tsx`, `childWorkflow.ts`, `connections.ts`, `resources.ts`, `teardown.ts` and tests. |

All Go application routes below accept `POST` with raw compact JWT body. The JWT `path` equals the route path; its `data` uses the listed keys. Do not put operation fields in query strings or unsigned JSON.

| Route | `data` and result |
| --- | --- |
| `/auth/start` | `client_id, opener_origin, api_origin` → `{authorization_url}` |
| `/api/session` | `{}` → `{authenticated}` |
| `/api/accounts/list` | `{}` → existing account array |
| `/api/zones/list` | `account_id` → existing zone array |
| `/api/buckets/list` | `account_id, jurisdiction, cursor?` → existing bucket page |
| `/api/buckets/get` | `account_id, jurisdiction, bucket` → bucket |
| `/api/buckets/create` | `account_id, jurisdiction, bucket` → bucket |
| `/api/buckets/delete` | `account_id, jurisdiction, bucket` → empty success; Go revokes managed connections before bucket deletion |
| `/api/domains/list` | `account_id, jurisdiction, bucket` → domains |
| `/api/domains/attach` | `account_id, jurisdiction, bucket, domain, zone_id` → empty success |
| `/api/domains/detach` | `account_id, jurisdiction, bucket, domain` → empty success |
| `/api/resources/find` | `account_id, jurisdiction, bucket` → owned resource or null |
| `/api/resources/register` | `account_id, jurisdiction, bucket, s3_endpoint, primary_domain?` → resource ID |
| `/api/connections/list` | `resource_id` → connection summaries and safe metadata |
| `/api/connections/provision` | `resource_id, manager_id, permission, labels?` → connection ID, token ID, one-time S3 values |
| `/api/connections/confirm` | `connection_id` → ready connection summary |
| `/api/connections/abort` | `connection_id` → empty success after revocation/reconciliation |
| `/api/connections/revoke` | `connection_id` → empty success after revocation and deletion |
| `/api/connections/link` | `resource_id, connection_id, labels` → authoritative identity and labels |
| `/api/connections/unlink` | `resource_id, connection_id, group` → authoritative identity and remaining labels |
| `/api/connections/delete-group` | `connections` array → deleted IDs |
| `/api/teardown/prepare` | `{}` → IDs of R2 resources now safe for frontend RPC deletion |

All paths and names above are one contract. If implementation reveals a documented API mismatch, fix the contract and its tests in the same task rather than silently changing one side.

## Review Focus

1. **Lost provision response after Cloudflare token creation:** Task 4 test leaves a pending record with token ID; retry or teardown revokes it before creating a replacement.
2. **Imported connection labeled for another group:** Task 4 test rejects link/unlink that would steal membership and preserves unrelated labels.
3. **Child request supplies a resource owned by another manager:** Task 4 and Task 8 tests fail before Cloudflare or Commander mutation.
4. **Two S3 secret writes only partly succeed:** Task 8 test calls abort, and Task 4 test leaves `secret_keys` absent and revokes the token.
5. **Stale event arrives after a newer run starts:** Task 6 and Task 9 tests keep the current run ID/last event and ignore the stale update.

---

### Task 1: JWT generation and verification

**Files:**
- Create: `backend/internal/jwt/jwt.go`, `backend/internal/jwt/jwt_test.go`
- Modify: `backend/cmd/cloudflare-manager/main.go`

**Interfaces:**
- Produces: `func GenerateSecret() (string, error)`; `type Claims struct { Audience, Path, Origin string; IssuedAt, ExpiresAt int64; Data json.RawMessage }`; `func Verify(raw string, key []byte, audience, path, origin string, now time.Time) (Claims, error)`.
- `main.go` handles `generate-jwt-secret` by writing only the generated value and a newline to stdout.

- [ ] **Step 1: Write failing tests** for 32 random bytes encoded as unpadded base64url, fixed `HS256` header, valid claims, bad signature, `alg:none`, wrong `aud/path/origin`, future `iat`, expired/over-60-second `exp`, malformed base64/JSON, and body size over 32 KiB. Assert invalid claims return errors and no data.
- [ ] **Step 2: Run `cd backend && go test ./internal/jwt ./cmd/cloudflare-manager`.** Expect failure because the JWT unit does not exist.
- [ ] **Step 3: Implement the exact interfaces** with Go `crypto/rand`, `crypto/hmac`, `crypto/sha256`, `encoding/base64`, and `encoding/json`. Fix accepted header fields and compare signatures with `hmac.Equal`. Keep errors content-free and never log raw tokens.
- [ ] **Step 4: Run the same Go tests.** Expect all pass.
- [ ] **Step 5: Commit** `backend/internal/jwt` and `backend/cmd/cloudflare-manager/main.go` as `feat: add manager JWT verifier and secret generator`.

### Task 2: Authenticated Commander manager API client

**Files:**
- Create: `backend/internal/commander/client.go`, `backend/internal/commander/client_test.go`

**Interfaces:**
- Produces `NewClient(baseURL, managerID, password string, httpClient *http.Client) (*Client, error)`.
- Produces methods `VerifyManager(ctx) error`, `ListMyResources(ctx, resourceType string) ([]Resource, error)`, `GetResource(ctx, id string) (ResourceDetail, error)`, `CreateResource(ctx, input ResourceCreate) (ResourceDetail, error)`, `ListConnections(ctx, resourceID string) ([]Connection, error)`, `GetConnection(ctx, id string) (ConnectionDetail, error)`, `CreateConnection(ctx, input ConnectionCreate) (ConnectionDetail, error)`, `UpdateConnection(ctx, id string, metadata any) error`, `DeleteConnection(ctx, id string) error`, `PutConnectionLabel(ctx, id, key, value string) error`, `DeleteConnectionLabel(ctx, id, key string) error`, and `DatabaseQuery(ctx, query string, bindings map[string]any) error`.
- Resource and connection result types retain `id, manager, resource, type, metadata, labels, created_at` as applicable.

- [ ] **Step 1: Write failing `httptest` tests** for Basic auth on every request, `GET /manager` identity mismatch, pagination, resource owner checks, `POST /connections` beneficiary field `connect_manager_id`, `PATCH /connections/{id}` metadata replacement, label PUT/DELETE paths, and safe 401/403/404/409/5xx mapping. Assert no password appears in an error.
- [ ] **Step 2: Run `cd backend && go test ./internal/commander`.** Expect failure because the client does not exist.
- [ ] **Step 3: Implement the client** against `COMMANDER_MANAGER_INTEGRATION_GUIDE.md` using `/api/v1`, bounded response reads, timeouts, URL path encoding, and caller-selected manager identity only from Basic credentials. Check each list page's `total` and stop on exhaustion; do not assume one page covers all records. Use `PUT/DELETE /connections/{id}/labels/{key}` for label mutation, and verify that path against the actual host contract before relying on it.
- [ ] **Step 4: Run the same tests.** Expect all pass.
- [ ] **Step 5: Commit** `backend/internal/commander` as `feat: add authenticated Commander client`.

### Task 3: Signed Go HTTP routes and dynamic OAuth

**Files:**
- Modify: `backend/internal/server/server.go`, `backend/internal/server/server_test.go`, `backend/internal/auth/oauth.go`, `backend/internal/auth/oauth_test.go`, `backend/cmd/cloudflare-manager/main.go`
- Create: `backend/internal/server/routes.go`

**Interfaces:**
- Consumes Task 1 `jwt.Verify` and Task 2 `commander.Client`.
- `server.Config` becomes `{ManagerID string; JWTSecret []byte; StaticDir string}`. `NewHandler(cfg Config, oauth *auth.Handler, cf *cloudflare.Client, commander *commander.Client) http.Handler`.
- `auth.StartInput` is `{ClientID, OpenerOrigin, APIOrigin string}`. `(*auth.Handler).Start(w, r, input) (authorizationURL string, err error)` sets state cookie; `Register` keeps only the GET callback. The transient state records client ID, redirect URI, opener origin, verifier, state, and expiry.

- [ ] **Step 1: Write failing tests** proving each route accepts only compact JWT POST, correct `Origin`/`path`/`aud`/`iat`/`exp`, and valid typed `data`; legacy unsigned GET/DELETE routes cannot mutate. Test missing OAuth cookie, safe OPTIONS, no-store, static/health exceptions, popup URL response, callback using saved client ID after settings change, forged or expired state cookie rejection, and callback's HttpOnly cookies.
- [ ] **Step 2: Run `cd backend && go test ./internal/server ./internal/auth`.** Expect the new route and OAuth tests to fail.
- [ ] **Step 3: Implement signed dispatch and OAuth** with one authentication wrapper that reads at most 32 KiB, verifies before decoding route data, and sets no-store. Keep Cloudflare cookie checks on Cloudflare operations. Require `/auth/start` `api_origin` to be HTTPS with a host equal to the proxy-preserved `r.Host`; do not trust arbitrary `X-Forwarded-Host`. Authenticate the state cookie with HMAC using a key derived from `JWT_SECRET`, include an expiry, and let callback use that saved state rather than a fixed environment origin. Decode the unpadded base64url `JWT_SECRET` at Go startup, require 32 bytes, and remove `CF_CLIENT_ID`, `PUBLIC_ORIGIN`, `COMMANDER_ORIGIN`.
- [ ] **Step 4: Run `cd backend && go test ./internal/server ./internal/auth ./cmd/cloudflare-manager`.** Expect all pass.
- [ ] **Step 5: Commit** changed Go HTTP/OAuth files as `feat: require signed manager requests and dynamic OAuth`.

### Task 4: Go-owned R2 resource and connection lifecycle

**Files:**
- Create: `backend/internal/manager/manager.go`, `backend/internal/manager/manager_test.go`
- Modify: `backend/internal/server/routes.go`, `backend/internal/server/server_test.go`

**Interfaces:**
- Consumes Task 2 Commander client and existing `cloudflare.Client` methods.
- Produces `manager.Service` with methods `FindResource(ctx, accountID, jurisdiction, bucket string) (*commander.ResourceDetail, error)`, `RegisterResource(ctx, input ResourceInput) (string, error)`, `ListConnections(ctx, resourceID string) ([]commander.ConnectionDetail, error)`, `Provision(ctx, cfToken string, input ProvisionInput) (ProvisionResult, error)`, `Confirm(ctx, connectionID string) (commander.ConnectionDetail, error)`, `Abort(ctx, cfToken, connectionID string) error`, `Revoke(ctx, cfToken, connectionID string) error`, `Link(ctx, resourceID, connectionID string, labels map[string]string) (commander.ConnectionDetail, error)`, `Unlink(ctx, resourceID, connectionID, group string) (commander.ConnectionDetail, error)`, `DeleteGroup(ctx, cfToken string, ids []string) ([]string, error)`, `DeleteBucket(ctx, cfToken, accountID, jurisdiction, bucket string) error`, `PrepareTeardown(ctx, cfToken string) ([]string, error)`.
- `ProvisionResult` includes only one-time S3 values plus IDs; `ConnectionMetadata` includes `status, token_id, permission, accountId, bucket, jurisdiction, endpoint, secret_keys`. Ready keys are exactly the two spec names.

- [ ] **Step 1: Write failing tests** for resource manager/type and connection attachment checks before mutation; pending→token ID→secret handoff→ready; `secret_keys` and group membership absent until `Confirm`; Cloudflare failure rollback; abandoned pending cleanup; revoke failure retaining retryable metadata; link/unlink preserving unrelated labels and rejecting wrong group; delete array partial failure; bucket deletion revoking managed connections first and refusing unmanaged ones; teardown revoking only owned managed connections and leaving foreign/unmanaged records untouched.
- [ ] **Step 2: Run `cd backend && go test ./internal/manager ./internal/server`.** Expect new workflow tests to fail.
- [ ] **Step 3: Implement `manager.Service` and route bindings**. Use owner checks from fresh Commander detail, exact allowed group labels, group label last on link/first on unlink, and reread authoritative labels before returning. Create pending connections without group labels; after `Confirm` marks the record ready, add origin and then group label. Store token ID before returning S3 values. Reconcile pending records when retried. `Confirm` accepts only a pending record, and the frontend must check actual stored secret keys before calling it; provisioning alone never marks ready. Keep a failed revocation record for retry and omit its `secret_keys`.
- [ ] **Step 4: Run the same tests.** Expect all pass.
- [ ] **Step 5: Commit** manager workflow and route files as `feat: move R2 resources and connections into Go`.

### Task 5: Installer approval and runner metadata

**Files:**
- Create: `installer/src/commanderConnection.ts`, `installer/src/commanderConnection.test.ts`
- Modify: `installer/src/installer.ts`, `installer/src/installer.test.ts`, `installer/src/commander.ts`, `installer/src/main.tsx`, `installer/src/vite-env.d.ts`

**Interfaces:**
- `resolveCommanderConnection(caller: RPCCaller, wire: Wire, managerId: string): Promise<{resourceId:string; connectionId:string; managerAPI:string}>` discovers/reuses or requests approval.
- `buildInstallRun(input: {managerId:string; backendImage:string; runnerImage:string; commander:{resourceId:string;connectionId:string;managerAPI:string}}): StartRunOptions`.
- `startInstall(caller: RPCCaller, wire: Wire, images: {backendImage:string;runnerImage:string}): Promise<StartResponse>` keeps the chronology guard.

- [ ] **Step 1: Write failing tests** for unique reserved Commander manager/resource discovery, first child approval with Web Crypto password, denial without `caller.start`, response identity mismatch, missing `COMMANDER_PASSWORD` key, reuse without another child, and malformed API metadata. Assert install metadata has authorized `Connection` reference, secret reference, runner-role generator with `command:["generate-jwt-secret"]`, capture group `JWT_SECRET`, `stream_output:false`, service dependency, `values_version:1`, and idempotent `object_hooks` database write to `manager_settings:current`. Assert no literal password/client ID/origins appear.
- [ ] **Step 2: Run `cd installer && npm test -- --run src/commanderConnection.test.ts src/installer.test.ts`.** Expect new tests to fail.
- [ ] **Step 3: Implement the interfaces** using `getManagers({name:"commander",kind:"commander"})`, `getResources({type:"commander",manager:commanderManagerID})`, typed connection RPC, and `wire.startInterface({manager: commanderManagerID, metadata:{action:"create-connection", metadata:{createUser:{password}}}})`. Confirm installed package 0.7.0 has compatible child close and secret-key calls; report/document any host contract mismatch. Use generator command `["generate-jwt-secret"]` with the image's existing entrypoint and capture pattern `(?P<JWT_SECRET>[A-Za-z0-9_-]{43})` with `stream_output:false`. Use `object_hooks` on container `cloudflare-manager` after-create with bound `jwt_secret` value and deterministic SurrealQL `UPSERT manager_settings:current SET jwt_secret = $jwt_secret`. Set backend/runner image defaults at publication/build configuration; fail on missing/unpinned runner.
- [ ] **Step 4: Run the same installer tests.** Expect all pass.
- [ ] **Step 5: Commit** installer connection/runner files as `feat: approve and reuse Commander connection at install`.

### Task 6: Small React installer and optional OAuth setting

**Files:**
- Create: `installer/src/settings.ts`, `installer/src/settings.test.ts`
- Modify: `installer/src/InstallApp.tsx`, `installer/src/InstallApp.test.tsx`, `installer/src/styles.css`, `installer/package.json`, `installer/package-lock.json`, `installer/vite.config.ts`, `installer/src/main.tsx`

**Interfaces:**
- `loadClientID(caller: RPCCaller): Promise<string>` and `saveClientID(caller: RPCCaller, clientID: string): Promise<void>` use `manager_settings:current`.
- `InstallApp` receives only the bridge and baked image references; it calls Task 5 `startInstall`.

- [ ] **Step 1: Write failing tests** for Install with blank/missing client ID and no text fields; optional setting save and SurrealDB statement `ERR`; styled new-tab Cloudflare link with `noopener noreferrer`; existing last-event recovery and live ordering, including a stale event after a newer run starts.
- [ ] **Step 2: Run `cd installer && npm test -- --run src/settings.test.ts src/InstallApp.test.tsx`.** Expect failure.
- [ ] **Step 3: Implement the React UI** and settings calls. Remove `tldts` and unused Tailwind plugin/packages from manifest, lockfile, and Vite config, plus obsolete build env variables. Keep React and the interface dependency. Do not add a JWT or OAuth package.
- [ ] **Step 4: Run `cd installer && npm test -- --run && npm run build`.** Expect all pass and inspect `dist/assets/*.js` size; require below 300 kB minified and no 500 kB warning.
- [ ] **Step 5: Commit** installer UI/settings/dependency files as `feat: make installer one-click and small`.

### Task 7: Frontend settings, signer, API, and OAuth UI

**Files:**
- Create: `frontend/src/settings.ts`, `frontend/src/settings.test.ts`, `frontend/src/jwt.ts`, `frontend/src/jwt.test.ts`
- Modify: `frontend/src/api.ts`, `frontend/src/api.test.ts`, `frontend/src/App.tsx`, `frontend/src/App.test.tsx`, `frontend/src/main.tsx`

**Interfaces:**
- `loadSettings(caller: RPCCaller): Promise<{clientID:string;jwtSecret:string}>`; `saveClientID(caller: RPCCaller, clientID: string): Promise<void>` use `manager_settings:current`.
- `createSigner(secret: string, managerID: string, origin: string, now?: () => number): Promise<{sign(path:string,data:unknown):Promise<string>}>` keeps the imported Web Crypto key in memory.
- `export interface Signer { sign(path: string, data: unknown): Promise<string> }`; `createBackendAPI(baseURL: string, signer: Signer, fetcher?: typeof fetch): BackendAPI` signs each route from the route table and sends raw JWT with `Content-Type: application/jwt` and credentials.
- `BackendAPI.startOAuth(input: {clientID:string;openerOrigin:string;apiOrigin:string}): Promise<{authorization_url:string}>`.
- Add `BackendAPI` methods `findResource(accountID,jurisdiction,bucket)`, `registerResource(input)`, `listConnections(resourceID)`, `provisionConnection(input)`, `confirmConnection(connectionID)`, `abortConnection(connectionID)`, `revokeConnection(connectionID)`, `linkConnection(resourceID,connectionID,labels)`, `unlinkConnection(resourceID,connectionID,group)`, `deleteGroupConnections(ids)`, and `prepareTeardown()` mapped one-to-one to the route table. Keep existing Cloudflare method names mapped to the table's Cloudflare routes.

- [ ] **Step 1: Write failing tests** for settings absent/present/edited and statement `ERR`; fresh `iat/exp` and route-bound JWTs; every existing API operation using the table's POST path and no query/body JSON outside the JWT; no storage writes; missing client ID setup screen; Cloudflare link/new tab; blank popup opened synchronously then navigated after signed `/auth/start`; popup failure and callback message origin/source check.
- [ ] **Step 2: Run `cd frontend && npm test -- --run src/settings.test.ts src/jwt.test.ts src/api.test.ts src/App.test.tsx`.** Expect failures.
- [ ] **Step 3: Implement the interfaces** and wire settings before API use. Decode the unpadded base64url signing value into a 32-byte Web Crypto HMAC key. Get the manager ID through RPC, derive the actual frontend origin from `window.location.origin`, and retain `VITE_BACKEND_ORIGIN` only as an optional separate-host API location. Keep the callback popup's completion message free of tokens.
- [ ] **Step 4: Run the same frontend tests and `npm run build`.** Expect all pass.
- [ ] **Step 5: Commit** frontend settings/JWT/API/OAuth files as `feat: sign frontend manager requests and configure OAuth`.

### Task 8: Resource Connection Manager Guide in the frontend

**Files:**
- Modify: `frontend/src/connections.ts`, `frontend/src/connections.test.ts`, `frontend/src/resources.ts`, `frontend/src/resources.test.ts`, `frontend/src/childWorkflow.ts`, `frontend/src/childWorkflow.test.ts`, `frontend/src/App.tsx`, `frontend/src/App.test.tsx`, `frontend/src/main.tsx`

**Interfaces:**
- `provisionConnection(caller: RPCCaller, api: BackendAPI, input: ConnectionInput): Promise<string>` uses Task 4 provision/confirm/abort and Task 7 signed API; only the two `setSecret` calls remain in the browser.
- `revokeConnection(api: BackendAPI, connectionID: string): Promise<void>` delegates token and Commander record deletion to Go.
- `handleChildAction(caller: RPCCaller, api: BackendAPI, metadata: unknown, callingManager: string|null): Promise<InterfaceResponse>` retains the four action names and returns guide-compatible identity/labels only.

- [ ] **Step 1: Write failing tests** for two `setSecret` calls followed by `getSecretKeys` and confirm; partial handoff calling abort without a ready declaration; Go-owned resource creation/list and connection record mutations; wrong-owner resource rejected; exact create/link/unlink/delete child payloads; labels preserved; imported unlink never deletes; created delete takes an array; no secrets or configuration in child results.
- [ ] **Step 2: Run `cd frontend && npm test -- --run src/connections.test.ts src/resources.test.ts src/childWorkflow.test.ts src/App.test.tsx`.** Expect failures.
- [ ] **Step 3: Refactor frontend flows** so Go handles all documented manager API mutations and Cloudflare setup/cleanup. Keep `updateResource` for primary CDN metadata and `deleteResource` only after Go cleanup, since no manager API route is documented. Do not write group labels through frontend RPC. Host child actions through the existing bridge and return a standard failed `InterfaceResponse` on denial or backend failure.
- [ ] **Step 4: Run the same tests.** Expect all pass.
- [ ] **Step 5: Commit** frontend resource/connection/child files as `feat: implement resource connection guide through Go`.

### Task 9: Teardown, event recovery, and release verification

**Files:**
- Modify: `frontend/src/teardown.ts`, `frontend/src/teardown.test.ts`, `frontend/src/App.tsx`, `frontend/src/App.test.tsx`, `frontend/src/runHistory.test.ts`, `installer/src/runHistory.test.ts`
- Update: root deployment documentation or README only where old required installer fields, fixed origins, or old API paths remain.

**Interfaces:**
- `startTeardown(caller: RPCCaller, api: BackendAPI): Promise<Awaited<ReturnType<RPCCaller["start"]>>>` calls `api.prepareTeardown()` while Go is healthy, deletes only the returned now-empty owned resource IDs by RPC, then starts the pinned runner teardown.
- Task 4 `PrepareTeardown` is retryable and never deletes Cloudflare buckets/domains.

- [ ] **Step 1: Write failing tests** for cleanup→resource RPC deletion→runner teardown order; active install/teardown guard; failed token revocation preventing runner start; foreign/unmanaged connection preventing resource deletion; latest teardown event after reload, live ordering, and stale event ignored after another run starts.
- [ ] **Step 2: Run `cd frontend && npm test -- --run src/teardown.test.ts src/runHistory.test.ts src/App.test.tsx`.** Expect failures.
- [ ] **Step 3: Implement teardown and event changes**; keep service running for retry when cleanup fails. Update deployment instructions with optional client ID, required pinned runner support, Commander approval, Cloudflare OAuth callback, and internal Commander API reachability. Do not change the user's integration guides unless necessary and authorized by their content.
- [ ] **Step 4: Run `cd installer && npm test -- --run && npm run build`, `cd frontend && npm test -- --run && npm run build`, and `cd backend && go test ./... && go vet ./...`. Run `docker build .` if Docker is available; otherwise record that it was unavailable. Inspect installer bundle size and run `git diff --check`. Expect clean results. Stage the first-install approval/runner/Cloudflare flow only if the required external environment is available; record host/runner limitations if it is not.
- [ ] **Step 5: Commit** teardown/docs changes as `feat: finish manager teardown and event recovery`. Run superpowers:verification-before-completion, then report exact test/build results, bundle size, staging status, and any remaining integration limits.

## Execution handoff

Use **native execution in Luna**: one implementing agent follows the tasks in order, applies TDD for each task, and requests a final independent review only if the user authorizes delegation. Keep work in the current checkout unless an implementation worktree is needed; if one is used, report whether it was merged and offer the merge choice. The user's uncommitted integration-guide edits must remain untouched.
