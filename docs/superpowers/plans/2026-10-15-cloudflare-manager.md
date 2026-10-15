# Cloudflare Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an installable Deploy Commander manager that lets each user manage Cloudflare R2 buckets and issue or revoke bucket-scoped application S3 credentials.

**Architecture:** A published React interface uses Deploy Commander RPC for resources, connections, secrets, and the two lifecycle runs. A small Go HTTP service serves the same interface after installation, owns OAuth PKCE and Cloudflare calls, and holds only the current user's OAuth access token in an expiring HttpOnly cookie.

**Tech Stack:** Go 1.25 standard library; React 19, TypeScript 7, Vite 8, Tailwind 4, Vitest 5; `@ezenki/deploy-commander-installer-interface` 0.7.0; Docker.

**Spec:** [Cloudflare Manager Design](../specs/2026-10-15-cloudflare-manager-design.md)

## Global Constraints

- Use native execution with `superpowers:executing-plans` after the user switches to Luna. Do not delegate implementation.
- The only Deploy Commander runs are initial `install` and final `teardown`; all R2 and connection operations use HTTP/RPC.
- The Go API and OAuth callback must be on the same schemeful site as Deploy Commander, with HTTPS in deployment.
- OAuth is Authorization Code with `S256` PKCE, no refresh, no persistent OAuth token storage, and an access-token cookie with matching expiration.
- Request Cloudflare `Workers R2 Storage Write`, `Zone Zone Read`, and `Account API Tokens Write`; never request `offline_access`.
- Use the interface library's manager-scoped RPC; no direct Deploy Commander HTTP calls or caller-supplied current-manager identity.
- Store `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as connection secrets; metadata and labels contain no secret values.
- Cloudflare buckets and domains survive manager teardown. Revoke application tokens before the teardown run.
- Use a versioned or digest-pinned backend image. Verify the selected runner image's health-gated redirect and redirect-first teardown before deployment.

## File Map

| Path | Responsibility |
| --- | --- |
| `backend/internal/auth/oauth.go`, `oauth_test.go` | PKCE, callback, cookie and session behavior. |
| `backend/internal/cloudflare/client.go`, `r2.go`, `credentials.go`, corresponding tests | Typed Cloudflare API operations and exact bucket token policy. |
| `backend/internal/server/server.go`, `server_test.go` | Fixed HTTP routes, validation, origin checks, and static files. |
| `backend/cmd/cloudflare-manager/main.go` | Environment configuration, server startup, and healthcheck command. |
| `frontend/src/api.ts` | Credentialed, typed calls to Go. |
| `frontend/src/commander.ts`, `resources.ts`, corresponding tests | One RPC wire and bucket resource records. |
| `frontend/src/connections.ts`, `childWorkflow.ts`, corresponding tests | Credential handoff, revocation, group labels, child replies. |
| `frontend/src/installer.ts`, `teardown.ts`, corresponding tests | Install metadata, run status, and cleanup before teardown. |
| `frontend/src/App.tsx`, `components/*`, `styles.css` | Minimal Tailwind management UI. |
| `frontend/package.json`, `vite.config.ts`, `tsconfig.json`, `deploy-commander.json` | Build, tests, and published interface configuration. |
| `Dockerfile`, `.dockerignore`, `.gitignore`, `.env.example`, `README.md` | Image, safe packaging, and operator setup. |

## Review Focus

1. OAuth callback with mismatched or missing state must set no access cookie; Task 1 tests it.
2. A blocked iframe cookie must show sign-in/configuration help rather than repeating silent requests; Task 8 tests it.
3. Cloudflare bucket pagination and upstream `success:false` must not silently omit data; Task 2 tests them.
4. Failure after minting a Cloudflare token must attempt revocation and leave a retriable connection if revocation fails; Task 6 tests it.
5. Expired OAuth or failed token revocation must prevent starting the teardown run; Task 7 tests it.

---

### Task 1: Go OAuth and Session

**Files:** Create `backend/go.mod`, `backend/internal/auth/oauth.go`, `backend/internal/auth/oauth_test.go`.

**Interfaces:** Produce `auth.Config{ClientID, PublicOrigin, FrontendOrigin, AuthorizationURL, TokenURL string}`, `auth.NewHandler(cfg Config, client *http.Client, now func() time.Time) (*Handler, error)`, `(*Handler).Register(*http.ServeMux)`, and `(*Handler).Token(*http.Request) (string, bool)`.

- [ ] **Step 1: Write failing tests** `TestOAuthPKCEAndCookie` (challenge equals base64url SHA-256 of verifier, callback exchanges code, access cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, host-only, `Expires` and `Max-Age` match `expires_in`); `TestOAuthRejectsStateMismatch` (no token exchange/cookie); `TestSessionExpires` (missing cookie returns `401`). Use an `httptest` token server and fixed clock.
- [ ] **Step 2: Run** `cd backend && go test ./internal/auth -run 'TestOAuth|TestSession' -v`; expect failure because the package is absent.
- [ ] **Step 3: Implement** `GET /auth/start`, `GET /auth/callback`, and `GET /api/session`; use 10-minute `__Host-` transient state/verifier cookie and `__Host-` access cookie; send only an authorization-complete message to the configured frontend origin. Discard any refresh token.
- [ ] **Step 4: Run** `cd backend && go test ./internal/auth -v`; expect pass.
- [ ] **Step 5: Commit** `backend/go.mod backend/internal/auth` as `feat: add Cloudflare PKCE session`.

### Task 2: Cloudflare Accounts, Buckets, and Domains

**Files:** Create `backend/internal/cloudflare/client.go`, `r2.go`, `r2_test.go`.

**Interfaces:** Produce `cloudflare.NewClient(baseURL string, httpClient *http.Client) *Client`, `ListAccounts(ctx, bearer) ([]Account, error)`, `ListZones(ctx, bearer, accountID) ([]Zone, error)`, `ListBuckets(ctx, bearer, accountID, jurisdiction, cursor) (BucketPage, error)`, `GetBucket(ctx, bearer, accountID, jurisdiction, bucket) (Bucket, error)`, `CreateBucket(ctx, bearer, accountID, jurisdiction, bucket) (Bucket, error)`, `DeleteBucket(ctx, bearer, accountID, jurisdiction, bucket) error`, `ListDomains(ctx, bearer, accountID, jurisdiction, bucket) ([]Domain, error)`, `AttachDomain(ctx, bearer, accountID, jurisdiction, bucket, domain, zoneID) error`, `DetachDomain(ctx, bearer, accountID, jurisdiction, bucket, domain) error`, and `S3Endpoint(accountID, jurisdiction string) (string, error)`. Methods are on `*Client`; DTOs are in `r2.go`. The endpoint is `https://<account>.r2.cloudflarestorage.com` for `default` and `https://<account>.<jurisdiction>.r2.cloudflarestorage.com` for a named jurisdiction.

- [ ] **Step 1: Write failing tests** `TestListAccountsAndZonesPagination` (all pages returned), `TestListBucketsReturnsCursor` (preserves Cloudflare cursor and second page), `TestCloudflareEnvelopeFailure` (`200` with `success:false` returns an error), `TestDomainUsesZoneAndJurisdiction` (POST body has `domain`, `zoneId`, `enabled:true`; jurisdiction header is present), `TestS3EndpointJurisdiction` (default and named jurisdiction endpoints), and `TestBucketDeletePreservesContents` (one DELETE only; never enumerate/delete objects).
- [ ] **Step 2: Run** `cd backend && go test ./internal/cloudflare -run 'TestListAccounts|TestListBuckets|TestCloudflare|TestDomain|TestBucket' -v`; expect missing API methods.
- [ ] **Step 3: Implement** the fixed `/client/v4` account, R2, zone, and custom-domain endpoints. Add bounded HTTP response reads/timeouts and sanitized Cloudflare error mapping. Validate IDs/names before path construction.
- [ ] **Step 4: Run** `cd backend && go test ./internal/cloudflare -v`; expect pass.
- [ ] **Step 5: Commit** `backend/internal/cloudflare/client.go backend/internal/cloudflare/r2.go backend/internal/cloudflare/r2_test.go` as `feat: add Cloudflare R2 API client`.

### Task 3: Bucket-Scoped S3 Credentials

**Files:** Create `backend/internal/cloudflare/credentials.go`, `credentials_test.go`.

**Interfaces:** Produce `Credential{TokenID, AccessKeyID, SecretAccessKey string}`, `(*Client).CreateCredential(ctx, bearer, accountID, jurisdiction, bucket, connectionID, permission string) (Credential, error)`, `(*Client).FindCredential(ctx, bearer, accountID, connectionID string) (string, error)`, and `(*Client).RevokeCredential(ctx, bearer, accountID, tokenID, connectionID string) error`.

- [ ] **Step 1: Write failing tests** `TestCreateCredentialBucketPolicy` (exact single-bucket resource `com.cloudflare.edge.r2.bucket.<account>_<jurisdiction>_<bucket>`, selected read/write permission group, name `deploy-commander-cloudflare/<connectionID>`); `TestS3KeyDerivation` (access ID is token ID, secret is lowercase SHA-256 hex of token value); `TestRevokeRejectsUnmanagedToken` (GET token name mismatch prevents DELETE); `TestFindCredentialByConnection` (can locate an interrupted handoff).
- [ ] **Step 2: Run** `cd backend && go test ./internal/cloudflare -run 'TestCreateCredential|TestS3Key|TestRevoke|TestFind' -v`; expect failure.
- [ ] **Step 3: Implement** permission-group discovery, account-token create/get/list/delete using the current bearer; allow only `read-only` and `read-write`. Never include token value in an error or log.
- [ ] **Step 4: Run** `cd backend && go test ./internal/cloudflare -v`; expect pass.
- [ ] **Step 5: Commit** credential files as `feat: provision scoped R2 S3 credentials`.

### Task 4: Go HTTP API and Static Server

**Files:** Create `backend/internal/server/server.go`, `server_test.go`, `backend/cmd/cloudflare-manager/main.go`.

**Interfaces:** Produce `server.Config{FrontendOrigin, StaticDir string}`, `server.NewHandler(cfg Config, oauth *auth.Handler, cf *cloudflare.Client) http.Handler`. Register auth's `/auth/start`, `/auth/callback`, and `/api/session`, then expose `GET /healthz`, `GET /api/accounts`, `GET /api/accounts/{account}/zones`, `GET/POST /api/accounts/{account}/buckets`, `GET/DELETE /api/accounts/{account}/buckets/{bucket}`, `GET/POST /api/accounts/{account}/buckets/{bucket}/domains`, `DELETE /api/accounts/{account}/buckets/{bucket}/domains/{domain}`, `POST /api/accounts/{account}/buckets/{bucket}/credentials`, `POST /api/accounts/{account}/credentials/revoke`, and `GET /api/accounts/{account}/credentials/find`. Credential create JSON is `{jurisdiction,connection_id,permission}` and response is `{token_id,access_key_id,secret_access_key}`; revoke JSON is `{token_id,connection_id}`; find uses `connection_id` query.

- [ ] **Step 1: Write failing tests** `TestOriginRejectsMutation` (foreign or missing Origin cannot mutate), `TestMissingCookieDoesNotCallCloudflare` (`401`), `TestCredentialsNeverCache` (`Cache-Control: no-store`), and `TestAPIRejectsBadIdentifiers` (no upstream call). Assert allowed origin is echoed only for the configured frontend origin with credentials.
- [ ] **Step 2: Run** `cd backend && go test ./internal/server -v`; expect failure.
- [ ] **Step 3: Implement** fixed routes, `r.PathValue` validation, JSON request bounds, safe static fallback, and `healthcheck` subcommand that probes `http://127.0.0.1:8080/healthz`. Use env `CF_CLIENT_ID`, `PUBLIC_ORIGIN`, `COMMANDER_ORIGIN`, `STATIC_DIR`, `PORT` and default Cloudflare endpoints only in production.
- [ ] **Step 4: Run** `cd backend && go test ./... && go vet ./...`; expect pass.
- [ ] **Step 5: Commit** server and main files as `feat: expose authenticated Cloudflare manager API`.

### Task 5: Frontend RPC and Bucket Resources

**Files:** Create `frontend/package.json`, lockfile, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/api.ts`, `src/commander.ts`, `src/resources.ts`, `src/resources.test.ts`.

**Interfaces:** Produce `createBackendAPI(baseURL: string, fetcher?: typeof fetch): BackendAPI`, `createCommanderBridge(): {wire: Wire; caller: RPCCaller}`, `registerBucket(caller: RPCCaller, bucket: ManagedBucket): Promise<string>`, and `removeBucketRecord(caller: RPCCaller, resourceId: string): Promise<void>`. `ManagedBucket` carries account ID, jurisdiction, name, S3 endpoint, and optional primary domain. `BackendAPI` has `session()`, `listAccounts()`, `listZones(accountId)`, `listBuckets(accountId,jurisdiction,cursor?)`, `getBucket(accountId,jurisdiction,bucket)`, `createBucket(accountId,jurisdiction,bucket)`, `deleteBucket(accountId,jurisdiction,bucket)`, `listDomains(accountId,jurisdiction,bucket)`, `attachDomain(accountId,jurisdiction,bucket,domain,zoneId)`, `detachDomain(accountId,jurisdiction,bucket,domain)`, `createCredential(accountId,bucket,{jurisdiction,connection_id,permission})`, `findCredential(accountId,connectionId)`, and `revokeCredential(accountId,{token_id,connection_id})`; all return typed JSON or `Promise<void>`.

- [ ] **Step 1: Write failing tests** `registerBucket` creates a `cloudflare-r2-bucket` resource with only nonsecret metadata and does not create a duplicate; `removeBucketRecord` calls manager-scoped `deleteResource`; API requests use `credentials:'include'` and never attach an OAuth bearer header.
- [ ] **Step 2: Run** `cd frontend && npm test -- --run src/resources.test.ts`; expect failure.
- [ ] **Step 3: Add** the minimal Vite/React/Tailwind setup and typed API/RPC adapter. Pin the interface package to `0.7.0`; use its actual `getMyResources`, `getResource`, `createResource`, `updateResource`, and `deleteResource` signatures. Keep one wire for the mounted app and call `wire.end()` on cleanup.
- [ ] **Step 4: Run** `cd frontend && npm test -- --run src/resources.test.ts && npm run build`; expect pass.
- [ ] **Step 5: Commit** frontend foundation as `feat: connect manager interface and R2 resources`.

### Task 6: Application Connections and Child Actions

**Files:** Create `frontend/src/connections.ts`, `connections.test.ts`, `childWorkflow.ts`, `childWorkflow.test.ts`.

**Interfaces:** Produce `provisionConnection(caller: RPCCaller, api: BackendAPI, input: ConnectionInput): Promise<string>`, `revokeConnection(caller: RPCCaller, api: BackendAPI, connectionId: string): Promise<void>`, and `handleChildAction(caller: RPCCaller, api: BackendAPI, metadata: unknown, callingManager: string | null): Promise<InterfaceResponse>`.

- [ ] **Step 1: Write failing tests** `TestProvisionHandoff` (pending connection, Cloudflare token, both connection secrets, ready metadata, no secret in result); `TestProvisionRollback` (secret write failure revokes token); `TestRollbackFailureIsRetriable` (failed Cloudflare revoke leaves connection); `TestChildGroupActions` (exact labels, preserves unrelated labels, validates resource ownership, returns identity only, handles the guide's array of delete IDs); `TestRevokeOrder` (Cloudflare DELETE precedes secret/connection deletion).
- [ ] **Step 2: Run** `cd frontend && npm test -- --run src/connections.test.ts src/childWorkflow.test.ts`; expect failure.
- [ ] **Step 3: Implement** resource/connection validation through authorized RPC, one-time S3 value handoff, rollback, `find` reconciliation for pending connections, `create-connection`, `link-connection`, `unlink-connection`, and `delete-connection`. Use `setConnectionLabel`/`removeConnectionLabel`; do not return connection config in `wire.close`.
- [ ] **Step 4: Run** `cd frontend && npm test -- --run src/connections.test.ts src/childWorkflow.test.ts && npm run build`; expect pass.
- [ ] **Step 5: Commit** connection files as `feat: manage application R2 connections`.

### Task 7: Initial Installer and Teardown

**Files:** Create `frontend/src/installer.ts`, `installer.test.ts`, `teardown.ts`, `teardown.test.ts`.

**Interfaces:** Produce `buildInstallRun(input: InstallInput & {managerId: string}): StartRunOptions`, `startInstall(caller: RPCCaller, input: InstallInput): Promise<StartResponse>`, and `startTeardown(caller: RPCCaller, api: BackendAPI): Promise<StartResponse>`. `InstallInput` contains `backendImage`, `runnerImage`, `clientId`, `publicOrigin`, and `commanderOrigin` strings.

- [ ] **Step 1: Write failing tests** `TestInstallRunMetadata` (one `cloudflare-manager` service, immutable image, manager-specific alias, explicit Platform network, healthcheck, redirect, no credentials in metadata); `TestTeardownRevokesBeforeRun`; `TestExpiredOAuthBlocksTeardown`; `TestFailedRevokeBlocksTeardown` (no `caller.start`); and `TestRunHistoryRecovery` (reload uses `getLatestRun` and durable updates).
- [ ] **Step 2: Run** `cd frontend && npm test -- --run src/installer.test.ts src/teardown.test.ts`; expect failure.
- [ ] **Step 3: Implement** install with `caller.start({action:'install', runner, platform:'docker', metadata, ...})`; obtain current manager ID through `caller.getManager()`. Teardown lists owned resources/connections, revokes credentials and removes records through API/RPC, then starts exactly one `{action:'teardown'}` run with no redirect metadata. Surface partial cleanup for retry.
- [ ] **Step 4: Run** `cd frontend && npm test -- --run src/installer.test.ts src/teardown.test.ts && npm run build`; expect pass.
- [ ] **Step 5: Commit** installer files as `feat: install and tear down manager service`.

### Task 8: Management UI

**Files:** Create `frontend/src/main.tsx`, `App.tsx`, `App.test.tsx`, `styles.css`, and small focused components under `frontend/src/components/`.

**Interfaces:** `App` receives the bridge and backend API from `main.tsx`; it renders installer status before backend availability, Cloudflare sign-in when the session is missing, and management screens when signed in.

- [ ] **Step 1: Write failing tests** `TestSessionFailureShowsSignIn` (a `401` offers user-initiated OAuth popup), `TestCookieBlockedShowsHelp` (callback completes but session stays `401`, show same-site routing guidance), and `TestAccountBucketDomainFlow` (account selection, paginated buckets, domain status, explicit delete confirmation).
- [ ] **Step 2: Run** `cd frontend && npm test -- --run src/App.test.tsx`; expect failure.
- [ ] **Step 3: Implement** restrained Tailwind views for install, account picker, bucket list/detail/create/delete, custom domains, and application connections. Use React state for display only; refresh from Cloudflare and RPC after mutations. Clear one-time credential values after handoff.
- [ ] **Step 4: Run** `cd frontend && npm test -- --run src/App.test.tsx && npm run build`; expect pass.
- [ ] **Step 5: Commit** UI files as `feat: add Cloudflare manager interface`.

### Task 9: Image, Publication, and Operator Guide

**Files:** Create `Dockerfile`, `.dockerignore`, `.gitignore`, `.env.example`, `frontend/deploy-commander.json`; update `README.md`.

**Interfaces:** Multi-stage Docker build produces one Go service image containing `frontend/dist`. `deploy-commander.json` publishes only `frontend/dist`. The README specifies the Cloudflare OAuth client, same-site route, build/publish/install/teardown order, scope grants, and live verification gates.

- [ ] **Step 1: Run** `docker build -t cloudflare-manager:local .`; expect failure because the Dockerfile is absent.
- [ ] **Step 2: Implement** a Node build stage and Go build stage, then copy the binary and frontend assets into a small runtime image. Exclude `.env`, source credentials, and docs from the published `dist` and image context. Document the exact environment variables and OAuth callback URI.
- [ ] **Step 3: Run** `cd backend && go test ./... && go vet ./...` and `cd frontend && npm test -- --run && npm run build`; expect pass.
- [ ] **Step 4: Run** `docker build -t cloudflare-manager:local .`, then `docker run -d --name cloudflare-manager-smoke -e CF_CLIENT_ID=test-client -e PUBLIC_ORIGIN=https://cf.example.test -e COMMANDER_ORIGIN=https://commander.example.test cloudflare-manager:local`, `docker exec cloudflare-manager-smoke /app/cloudflare-manager healthcheck`, and `docker rm -f cloudflare-manager-smoke`; expect build and healthcheck success.
- [ ] **Step 5: Verify** the configured runner image digest and its redirect-first teardown behavior in a Deploy Commander staging environment. Verify OAuth popup/cookie, one bucket/domain flow, one S3 provision/revoke, installer health redirect, and teardown external effects. Record any unavailable live checks as open gates, not as passing.
- [ ] **Step 6: Commit** packaging and README as `docs: package and operate Cloudflare manager`.

## Execution Handoff

After the plan is approved, switch to Luna and use `superpowers:executing-plans`. At implementation start, use `superpowers:using-git-worktrees` for isolation if appropriate. If a worktree is used, report whether its branch was merged and offer the user the merge choice. Perform the final verification skill before claiming completion; do not treat unavailable Cloudflare/Commander staging credentials as a passing live integration test.
