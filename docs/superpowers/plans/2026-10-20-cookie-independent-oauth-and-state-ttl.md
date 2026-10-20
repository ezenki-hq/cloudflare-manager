# Cookie-independent OAuth and state TTL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Cloudflare OAuth from the embedded manager without a state cookie, maintain a usable session when embedded cookies are unavailable, and delete expired manager-database state with a one-minute scheduled image.

**Architecture:** The Go backend stores encrypted, ten-minute, single-use OAuth state in its own Commander manager database and exchanges the callback code after an atomic consume. The callback also issues an in-memory opaque session handle alongside its existing access cookie. A separate Go image executes one database cleanup and exits; the installer declares it as a Deploy Commander chronjob.

**Tech Stack:** Go 1.25, Commander manager HTTP API and SurrealQL, React/TypeScript/Vite, Vitest, Docker Buildx, Deploy Commander runner `chronjobs` metadata.

**Spec:** `docs/superpowers/specs/2026-10-20-cookie-independent-oauth-design.md`

## Global Constraints

- Pending state expires ten minutes after creation; callback enforces expiry even when cleanup is late.
- Store only SHA-256-derived state keys and authenticated encrypted PKCE/context payloads in the manager database. Derive encryption from `MANAGER_PASSWORD` with domain separation, never from browser-visible `JWT_SECRET`.
- Cloudflare access tokens stay in backend memory or the existing `HttpOnly` cookie; never store them in the manager database or expose them to JavaScript.
- Publish `ezenki/cloudflare-manager:latest` and `ezenki/cloudflare-manager-state-ttl:latest` by default, with matching configurable tags and platforms.
- Install a `* * * * *` UTC chronjob using the TTL image and the approved Commander resource connection. Its container runs once and exits.
- Use the runner's documented `chronjobs` contract; do not invent runner metadata or modify runner source from this repository. Full top-level teardown stops the scheduler.
- Never log state, code, verifier, token, handle, cookie, JWT body, or callback URL. Require live Commander/SurrealDB and runner checks before claiming deployment works.

## Review Focus

1. `/auth/start` with `opener_origin` different from the signed request's `Origin` must reject before writing state (Task 3).
2. An HTTP 200 Commander query with a missing result or non-`OK` statement must fail closed, with no authorization URL or token exchange (Tasks 1–3).
3. Two callbacks racing for one state must yield at most one token exchange; a delayed TTL run must never permit an expired callback (Tasks 2–3, live gate).
4. A handle from another manager or frontend origin must fail even with an otherwise valid signed request; a rejected handle must be cleared from browser storage (Tasks 4–5).
5. A cleanup run with wrong credentials, a query error, or overlapping firings must exit nonzero on error and never remove live or unrelated records (Task 6, live gate).

---

### Task 1: Return validated Commander database results

**Files:** Modify `backend/internal/commander/client.go`; test `backend/internal/commander/client_test.go`.

**Interfaces:** `type QueryResult struct { Statement int; Status string; Result json.RawMessage }`; `(*Client).DatabaseQuery(ctx context.Context, query string, bindings map[string]any) ([]QueryResult, error)`. Later tasks consume one validated result per statement.

- [ ] Write tests for a bound query returning one `OK` result, HTTP 200 with `ERR` or missing status/result envelope, multiple statements with one failure, and malformed JSON. Update existing mock responses to include `status: "OK"`.
- [ ] Run `cd backend && go test ./internal/commander -run DatabaseQuery -count=1`; confirm the new cases fail.
- [ ] Decode the bounded Commander response, require a nonempty results array with ordered statement indexes and `status == "OK"` for every item, and return typed results without echoing query values in errors.
- [ ] Run the same targeted test; require pass. Commit `feat: validate Commander database query results`.

### Task 2: Encrypt, save, consume, and prune pending OAuth state

**Files:** Create `backend/internal/auth/state_store.go`, `backend/internal/auth/state_store_test.go`; modify `backend/internal/commander/client_test.go` only if its query fixtures need the new result contract.

**Interfaces:** Export `PendingState{Verifier, OpenerOrigin, ClientID, RedirectURI, ManagerID string; ExpiresAt int64}` and `StateStore` with `Put(ctx, rawState, PendingState) error`, `Take(ctx, rawState string, now time.Time) (PendingState, error)`, `Prune(ctx, now time.Time) (int, error)`. `NewPendingStore(db DatabaseQuerier, managerID, managerPassword string) (*PendingStore, error)` uses a `DatabaseQuerier` with Task 1's signature. The table is `oauth_pending_state`; fields are `expires_at` as Unix seconds and `payload` as base64url nonce plus AES-GCM ciphertext.

- [ ] Write tests for SHA-256-derived record IDs, encrypted payloads with no raw verifier/state, ten-minute expiry data, restart decryption with the same manager password, tampering/wrong password/wrong manager rejection, one successful consume followed by miss, expiry rejection, and prune deleting only expired table records. Exercise `Put`, `Take`, and `Prune` through a fake Commander query API that records bound arguments and simulates atomic delete-return.
- [ ] Run `cd backend && go test ./internal/auth -run PendingStore -count=1`; confirm failure.
- [ ] Derive a 32-byte key with HMAC-SHA256 using domain `cloudflare-manager/oauth-pending-state/v1`; encrypt with AES-GCM and fresh nonce, binding manager ID and state hash as additional authenticated data. Use fixed queries with bound values. `Take` uses one conditional `DELETE ... WHERE expires_at > $now RETURN BEFORE` targeting the hashed record; `Prune` uses `DELETE oauth_pending_state WHERE expires_at <= $now RETURN BEFORE`. Validate result shapes and count, and treat no returned row as invalid/expired/replayed state. Verify the record-ID constructor against the installed SurrealDB version before relying on it.
- [ ] Run the targeted test and `go test ./internal/auth ./internal/commander`; require pass. Commit `feat: store single-use encrypted OAuth state in manager database`.

### Task 3: Use database state for OAuth and log safe outcomes

**Files:** Modify `backend/internal/auth/oauth.go`, `backend/internal/auth/oauth_test.go`, `backend/cmd/cloudflare-manager/main.go`, `backend/internal/server/routes.go`; test `backend/internal/server/server_test.go`.

**Interfaces:** `auth.Config` accepts `StateStore` and `ManagerID`; `Handler.Start` and callback use Task 2's store. Keep `POST /auth/start` signed and `GET /auth/callback` public. Task 4 extends the successful callback.

- [ ] Write handler and signed-route tests: start writes state before returning an authorization URL; a write/query failure returns no URL; opener origin mismatch rejects; callback without any state cookie consumes the saved record, exchanges once and sets the existing host-only `HttpOnly` access cookie; expired, malformed, replayed, wrong-host, and database-unavailable callbacks do not exchange. Assert Cloudflare provider errors are safe, and captured logs contain only flow ID, event, reason, and safe host/origin fields.
- [ ] Run `cd backend && go test ./internal/auth ./internal/server -run 'OAuth|SignedSession' -count=1`; confirm the new cases fail.
- [ ] Replace state-cookie encoding/reading with `Put`/`Take`; reconstruct and validate the exact callback origin, check saved manager identity and expiry, and use the saved verifier/client ID/redirect URI for exchange. Keep access-cookie issuance. Log sanitized start, write failure, callback rejection, exchange failure, and success. Use a short digest of the state as flow ID; never log request URL or secrets. Return a safe retry message for state errors and retain the existing useful invalid-scope message.
- [ ] Run targeted tests and `cd backend && go test ./...`; require pass. Commit `fix: complete OAuth callback from database state`.

### Task 4: Resolve in-memory session handles on signed API routes

**Files:** Create `backend/internal/auth/sessions.go`, `backend/internal/auth/sessions_test.go`; modify `backend/internal/auth/oauth.go`, `backend/internal/server/server.go`, `backend/internal/server/routes.go`, `backend/internal/server/server_test.go`.

**Interfaces:** `Handler.Token(r *http.Request) (string, bool)` checks `X-Cloudflare-Session` before the existing access cookie; the header path is used only after manager JWT verification. `Handler.ClearHandle(r *http.Request)` removes an invalidated handle. Callback posts `{type:"cloudflare-oauth-complete", session_handle:string}` to the saved opener origin.

- [ ] Write tests for random handle issuance after exchange, no raw access token in popup HTML/handle/database, successful cookie-free `/api/session` and Cloudflare API call, wrong origin/manager/expired handle rejection, bounded storage and cleanup, restart invalidation, cookie fallback, and `OPTIONS` allowing the exact header. Test that a present invalid handle fails rather than silently using a cookie.
- [ ] Run `cd backend && go test ./internal/auth ./internal/server -run 'Session|OAuth' -count=1`; confirm failure.
- [ ] Store only handle hash, Cloudflare token, manager ID, exact frontend origin, and expiry in a mutex-protected table; cap lifetime at 30 minutes or the access-token lifetime, whichever is shorter, and cap the table at 1,024 entries with oldest-expiry eviction. Resolve the header using the signed request origin, clear it on upstream Cloudflare 401, keep the cookie fallback for requests without a handle, and allow `X-Cloudflare-Session` in CORS preflight. Escape the popup payload as JSON before placing it in HTML.
- [ ] Run targeted tests and `cd backend && go test ./...`; require pass. Commit `feat: support embedded manager sessions without cookies`.

### Task 5: Preserve the opaque handle in the frontend tab

**Files:** Modify `frontend/src/api.ts`, `frontend/src/api.test.ts`, `frontend/src/App.tsx`, `frontend/src/App.test.tsx`.

**Interfaces:** Add `BackendAPI.setSessionHandle(handle: string): void` and `clearSessionHandle(): void`. The API reads a tab-scoped storage key based on the backend origin and frontend origin; `send` adds `X-Cloudflare-Session` only when a handle exists.

- [ ] Write tests for accepting a completion message only from the expected popup and backend origin, setting the handle before session refresh, rehydrating after reload, sending it on signed API requests, rejecting forged/empty handles, clearing it after a 401, and continuing without persistent storage when `sessionStorage` is unavailable. Replace the old cookie-only blocked-state assertion with a useful retry state.
- [ ] Run `cd frontend && npm test -- --run src/api.test.ts src/App.test.tsx`; confirm failure.
- [ ] Implement handle storage and message handling, including an in-memory fallback; keep the current `credentials: "include"` cookie path. Clear the handle before surfacing an unauthorized session or Cloudflare request. Update UI copy that says embedded cookies are required.
- [ ] Run the targeted tests and `cd frontend && npm run build`; require pass. Commit `feat: retain embedded OAuth session handle per tab`.

### Task 6: Build a one-shot state TTL image

**Files:** Create `backend/cmd/state-ttl/main.go`, `backend/cmd/state-ttl/main_test.go`, `tests/build.test.sh`; modify `Dockerfile`, `build.sh`.

**Interfaces:** `run(ctx context.Context, getenv func(string) string, stdout io.Writer) error` verifies `MANAGER_ID`, `MANAGER_API`, and `MANAGER_PASSWORD`, verifies manager identity, calls Task 2's `Prune(ctx, time.Now())` once, writes a safe count, and exits. Dockerfile targets `service` and `state-ttl`; `build.sh` publishes both images with the same `TAG` and `PLATFORMS`, with `IMAGE` and `STATE_TTL_IMAGE` overrides.

- [ ] Write Go tests for one successful cleanup, empty/malformed credentials, wrong manager identity, query failure, and no secret leakage. Write a shell test that stubs `docker` and asserts two `buildx build --push` invocations with the correct targets, default names, shared tag/platforms, and overrides; it must perform no real push.
- [ ] Run `cd backend && go test ./cmd/state-ttl -count=1` and `bash tests/build.test.sh`; confirm failure.
- [ ] Implement the one-shot command using the Commander client and pending store. Compile it as a separate distroless image without frontend assets; make the existing image an explicit `service` target. Update `build.sh` to push both targets and fail if either build fails.
- [ ] Run both targeted tests and `cd backend && go test ./...`; require pass. If Docker is available, locally build both targets without pushing. Commit `feat: publish one-shot OAuth state TTL image`.

### Task 7: Install the one-minute chronjob

**Files:** Modify `installer/src/installer.ts`, `installer/src/installer.test.ts`, `installer/src/main.tsx`, `installer/src/vite-env.d.ts`, `installer/src/InstallApp.test.tsx`.

**Interfaces:** Extend `InstallInput` with `stateTTLImage: string`, default `VITE_STATE_TTL_IMAGE` to `ezenki/cloudflare-manager-state-ttl:latest`. `buildInstallRun` emits `metadata.chronjobs["oauth-state-ttl"]` with `timer: "* * * * *"` and one `prune` service.

- [ ] Write tests asserting the TTL image is required and tagged/digested, the chronjob uses `MANAGER_ID`, `MANAGER_API`, the approved `COMMANDER_PASSWORD` reference, and the same Commander resource/connection reference as the main service. Assert it has no unsupported scheduled-service fields and that top-level teardown remains unchanged. Update installer test input fixtures.
- [ ] Run `cd installer && npm test -- --run src/installer.test.ts src/InstallApp.test.tsx`; confirm failure.
- [ ] Extend image defaults and install metadata. Keep cleanup out of the normal `services` map; rely on the runner's documented `chronjobs` scheduler deployment. Preserve `:latest` defaults for all three images.
- [ ] Run targeted tests and `cd installer && npm run build`; require pass. Commit `feat: install one-minute OAuth state cleanup chronjob`.

### Task 8: Document and verify the complete flow

**Files:** Modify `README.md`; inspect `docs/superpowers/specs/2026-10-20-cookie-independent-oauth-design.md` for any implementation-driven corrections.

**Interfaces:** No new runtime interface. README describes the pending-state table, two images, `VITE_STATE_TTL_IMAGE`, scheduler prerequisites, embedded handle lifetime/restart behavior, callback/log troubleshooting, and live release checks.

- [ ] Update README and its verification checklist to include a real HTTP Corvo OAuth callback, cookie-free `/api/session`, account list, reload, expired-state pruning, scheduler teardown, and confirmation that raw Cloudflare tokens are absent from JavaScript and manager database.
- [ ] Run `cd backend && go test ./... && go vet ./...`, `cd frontend && npm test -- --run && npm run build`, `cd installer && npm test -- --run && npm run build`, `bash tests/build.test.sh`, and `git diff --check`; record actual results. Stop on a failure and fix its cause before claiming completion.
- [ ] In staging, verify the installed Commander/SurrealDB version accepts the bound one-time delete and concurrent consume behavior, the runner/scheduler pair exists and uses a local Unix Docker socket, both images are published, the TTL job fires and only removes expired records, and teardown stops it. If staging is unavailable, report these as unverified release gates.
- [ ] Commit `docs: explain database-backed OAuth and scheduled state cleanup`; report worktree/merge status and offer merge if implementation used a worktree.
