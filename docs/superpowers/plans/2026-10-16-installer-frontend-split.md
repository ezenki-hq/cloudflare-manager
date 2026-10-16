# Installer and Frontend Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a standalone published installer and a standalone management frontend bundled with the Go service, each showing its latest relevant run event.

**Architecture:** `installer/` owns installation and Commander publication; `frontend/` owns management and teardown. The Go image builds only `frontend/`. Both UIs use their own Commander bridge and durable run-event reads, while Go accepts only the configured Commander and service browser origins.

**Tech Stack:** React 19, TypeScript 7, Vite 8, Vitest, Deploy Commander interface 0.7.0, Go 1.25, Docker.

**Spec:** `docs/superpowers/specs/2026-10-16-installer-frontend-split-design.md`

## Global Constraints

- Keep two standalone projects in this repository: `installer/` and `frontend/`, with separate packages, lockfiles, builds, and tests; no cross-project source imports or shared workspace package.
- Publish only `installer/dist`; bundle only `frontend/dist` into the Go service image.
- Preserve Cloudflare resource, connection, secret, and manager-scoped RPC behavior.
- Show run status and the latest structured `install` event in the installer and latest structured `teardown` event in the frontend, live and after reload.
- Accept browser requests and OAuth popup delivery from exactly configured `COMMANDER_ORIGIN` and `PUBLIC_ORIGIN`; reject other origins.
- Preserve the pre-existing user edit to `frontend/package-lock.json` (removal of optional package `libc` fields). Do not stage that edit as part of the feature; if using a worktree, leave the original checkout edit intact.

## Review Focus

1. A successful old install followed by a successful teardown must permit reinstall; a newer successful install must still block duplicates. Task 1 tests both orderings.
2. Equal or invalid run timestamps must not silently permit another install. Task 1 tests the guarded error.
3. A replayed event, an unrelated run event, or a live event without a message must not replace the current latest message. Tasks 2 and 3 test these cases.
4. A run with more than 100 saved events must still display the latest event on reload. Tasks 2 and 3 assert descending, one-item durable queries.
5. An OAuth opener origin outside the two configured origins must be rejected before redirect or cookie creation; callback delivery must target the validated opener. Task 4 tests both.

---

### Task 1: Standalone installer project and install guards

**Files:** Create `installer/package.json`, `installer/package-lock.json`, `installer/tsconfig.json`, `installer/vite.config.ts`, `installer/index.html`, `installer/deploy-commander.json`, `installer/src/vite-env.d.ts`, `installer/src/main.tsx`, `installer/src/commander.ts`, `installer/src/installer.ts`, `installer/src/installer.test.ts`, and a minimal `installer/src/InstallApp.tsx` and `installer/src/styles.css`. Move installation-only code from `frontend/src/installer.ts`; do not remove old frontend files until Task 3. Add installer build ignores to `.gitignore`.

**Interfaces:** `InstallInput` has `backendImage`, `runnerImage`, `clientId`, `publicOrigin`, `commanderOrigin`; `buildInstallRun(input: InstallInput & { managerId: string }): StartRunOptions`; `installationState(install: RunItem | null, teardown: RunItem | null): "ready" | "installing" | "installed" | "tearing-down"`; `startInstall(caller: RPCCaller, input: InstallInput): Promise<Awaited<ReturnType<RPCCaller["start"]>>>`. The independent project exports no module to `frontend/`.

- [ ] **Step 1: Scaffold the test runner** in `installer/` with standalone package and Vite/TypeScript config, then install dependencies and generate its lockfile there. Add installer build ignores to `.gitignore`.
- [ ] **Step 2: Write failing tests** in `installer/src/installer.test.ts`: retain current metadata/origin/image assertions; assert `installationState(doneInstall, laterDoneTeardown) === "ready"`, `installationState(laterDoneInstall, oldDoneTeardown) === "installed"`, failed install is ready, active install/teardown blocks, and equal/invalid `queued_at` timestamps reject. Assert `startInstall` calls `getManager` and `start` only when ready.
- [ ] **Step 3: Run red check:** `cd installer && npm test -- --run src/installer.test.ts`; expect new behavior assertions to fail.
- [ ] **Step 4: Implement** the installer domain and minimal entry. Use `queued_at` from the two latest action runs for chronology; reject ambiguous timestamps. Keep the existing image and same-site origin validation. The entry can render the install form without event display until Task 2.
- [ ] **Step 5: Run green check:** `cd installer && npm test -- --run src/installer.test.ts && npm run build`; expect pass.
- [ ] **Step 6: Commit** only installer project, tests, and `.gitignore` changes: `git commit -m "feat: create standalone installer project"`.

### Task 2: Installer's latest event and live run status

**Files:** Create `installer/src/runHistory.ts`, `installer/src/runHistory.test.ts`, `installer/src/InstallApp.test.tsx`; modify `installer/src/InstallApp.tsx`, `installer/src/styles.css`, and `installer/src/main.tsx`.

**Interfaces:** `InstallSnapshot = { run: RunItem; lastEvent: { seq: number; message: string } | null }`; `loadLatestInstall(caller: RPCCaller): Promise<InstallSnapshot | null>` calls `getLatestRun({action:"install"})` and `getRunEvents({run_id,limit:1,order:"desc"})`. `InstallApp({bridge,defaults}: {bridge: CommanderBridge; defaults: InstallInput})` owns install status, event subscription, form, and wire cleanup.

- [ ] **Step 1: Write failing tests:** add `// @vitest-environment jsdom` to `InstallApp.test.tsx`; durable load returns the last event after a simulated long history and no event yields a waiting message; rendering shows the last install event after reload; `run-start` and matching `run-update` refresh status/event; stale/replayed, unrelated, log-only, and message-less events do not replace the latest message; failed install leaves retry enabled; unmount removes the listener and ends the wire.
- [ ] **Step 2: Run red check:** `cd installer && npm test -- --run src/runHistory.test.ts src/InstallApp.test.tsx`; expect failures for absent history/live behavior.
- [ ] **Step 3: Implement** the snapshot fetch and event-driven refresh. Track current run ID and event sequence, and ignore stale async refreshes. Show status and one latest structured event, never a log as an event. Surface RPC errors; do not wait for the Go API. Default values come from installer Vite variables, with Commander origin falling back to the current page origin.
- [ ] **Step 4: Run green check:** `cd installer && npm test -- --run && npm run build`; expect pass.
- [ ] **Step 5: Commit** installer event UI and tests: `git commit -m "feat: show live installer run event"`.

### Task 3: Management frontend without installer, with teardown event

**Files:** Modify `frontend/src/App.tsx`, `frontend/src/App.test.tsx`, `frontend/src/main.tsx`, `frontend/src/teardown.ts`, `frontend/src/teardown.test.ts`, `frontend/src/styles.css`, `frontend/src/vite-env.d.ts`, `frontend/package.json`, `frontend/package-lock.json`; create `frontend/src/runHistory.ts`, `frontend/src/runHistory.test.ts`; delete `frontend/src/installer.ts`, `frontend/src/installer.test.ts`, `frontend/src/components/InstallPanel.tsx`, and `frontend/deploy-commander.json`.

**Interfaces:** `App({bridge,api,backendOrigin}: AppProps)` has no install defaults. `loadLatestTeardown(caller: RPCCaller): Promise<{run: RunItem; lastEvent: {seq:number; message:string} | null} | null>` uses `getRunEvents({run_id,limit:1,order:"desc"})`. `startTeardown(caller: RPCCaller, api: BackendAPI): Promise<Awaited<ReturnType<RPCCaller["start"]>>>` retains the existing cleanup sequence and reads the latest install run solely for its runner image.

- [ ] **Step 1: Write failing tests:** the management UI renders sign-in or buckets even if run-history RPC fails, has no install form/button, shows latest teardown event on reload, refreshes on matching live events, ignores stale/unrelated/log-only/message-less updates, and ends its bridge on unmount. Keep teardown order, OAuth-expiry, and failed-revocation assertions. Assert `window.open` includes the encoded current browser origin as `opener_origin`.
- [ ] **Step 2: Run red check:** `cd frontend && npm test -- --run src/App.test.tsx src/teardown.test.ts src/runHistory.test.ts`; expect new assertions to fail.
- [ ] **Step 3: Implement** UI separation, teardown snapshot/live listener, and popup origin parameter. Remove only installer-specific styles, Vite variables, publish script/config, and `tldts` dependency. Update the lockfile without discarding the pre-existing `libc` diff; stage only feature-owned lockfile hunks if working in the original checkout.
- [ ] **Step 4: Run green check:** `cd frontend && npm test -- --run && npm run build`; expect pass and no `installer` source import in frontend.
- [ ] **Step 5: Commit** only feature-owned frontend changes: `git commit -m "refactor: keep management and teardown in frontend"`.

### Task 4: Exact browser origins and OAuth callback target

**Files:** Modify `backend/internal/auth/oauth.go`, `backend/internal/auth/oauth_test.go`, `backend/internal/server/server.go`, `backend/internal/server/server_test.go`, and `backend/cmd/cloudflare-manager/main.go`.

**Interfaces:** Add `PublicOrigin string` to `server.Config`. Keep `auth.Config{PublicOrigin,FrontendOrigin}`; `/auth/start?opener_origin=<encoded origin>` validates the exact origin against those two values and saves it in `transientState`. The callback uses that saved origin as the sole `postMessage` target. CORS accepts exact `server.Config.PublicOrigin` or `FrontendOrigin` and still requires a valid `Origin` and JSON type for mutations.

- [ ] **Step 1: Write failing Go tests:** both configured origins can make credentialed API requests; an arbitrary origin and absent mutation origin return 403; unknown or missing `opener_origin` returns 400 without a state cookie or redirect; callback posts to the saved Commander or public opener origin and still rejects mismatched OAuth state. Keep existing cookie/PKCE tests.
- [ ] **Step 2: Run red check:** `cd backend && go test ./internal/auth ./internal/server`; expect new assertions to fail.
- [ ] **Step 3: Implement** exact allowlist validation, transient opener origin, callback target, and `PublicOrigin` wiring in `main.go`. Keep `PUBLIC_ORIGIN/auth/callback` as the Cloudflare redirect URI, `Secure`/`HttpOnly` host-only cookies, and no wildcard CORS.
- [ ] **Step 4: Run green check:** `cd backend && go test ./... && go vet ./...`; expect pass.
- [ ] **Step 5: Commit** backend origin support and tests: `git commit -m "fix: allow configured management browser origins"`.

### Task 5: Deployment documentation and integration verification

**Files:** Modify `README.md`; modify `Dockerfile` only if inspection finds an installer copy or publish dependency (the current file already builds only `frontend/`). Check `.dockerignore` and `build.sh` for the same boundary; leave them unchanged when already correct.

**Interfaces:** `cd installer && npm run publish:manager` publishes `installer/dist`; the root Docker image copies `frontend/dist` into `/app/frontend/dist`; `STATIC_DIR` points there. Document independent local commands and the exact `VITE_*`, `PUBLIC_ORIGIN`, and `COMMANDER_ORIGIN` roles.

- [ ] **Step 1: Update README** with separate installer publish, management frontend build, service image build, local development, redirect/teardown lifecycle, latest-event display, and exact browser origin setup. Verify publishing credentials are read from ignored local `.env` or environment variables, never committed.
- [ ] **Step 2: Check project boundaries:** `rg -n 'frontend/src/installer|InstallPanel|publish:manager' installer frontend Dockerfile README.md` should find publication only under `installer/` and no frontend installer module; inspect hits rather than treating any match as failure. Confirm both lockfiles match their packages with `npm ci` in each project.
- [ ] **Step 3: Run final verification:** `cd installer && npm test -- --run && npm run build`; `cd frontend && npm test -- --run && npm run build`; `cd backend && go test ./... && go vet ./...`; if Docker is available, `docker build -t cloudflare-manager:split-check .`. Expect all available checks to pass. Do not publish or push an image without the user's existing authorization for that external action.
- [ ] **Step 4: Commit** README and any necessary build-file edits: `git commit -m "docs: describe separate installer and frontend builds"`.
- [ ] **Step 5: Report** exact checks run and any unavailable integration checks. Live Commander/Cloudflare staging remains a separate verification gate requiring those service credentials.

## Execution handoff

Use native, task-by-task implementation after the user reviews this plan and switches the session to Luna. At execution start, apply `superpowers:using-git-worktrees` and account for the dirty original `frontend/package-lock.json`. If a worktree is used, report whether it has been merged and offer the user the merge choice. Finish with `superpowers:verification-before-completion` and branch integration guidance.
