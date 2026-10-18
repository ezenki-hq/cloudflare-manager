# Manager Local Reload and Teardown Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user chose inline Luna implementation; do not dispatch subagents.

**Goal:** Reload the current interface after install and teardown, remove run details from the installer, and move teardown into a dedicated manager page with typed confirmation and styled progress.

**Architecture:** Keep Commander run history and events as the lifecycle source of truth. Both React projects reload their own `window`; the frontend uses a small History API route for `/teardown` and renders a focused teardown component. The existing Commander-only teardown runner call remains the action behind the final button.

**Tech Stack:** React 19, TypeScript 7, Vite 8, Vitest, Testing Library, Go 1.25 static server.

**Spec:** [Manager Reload and Teardown Page Design](../specs/2026-10-18-manager-local-reload-teardown-page-design.md)

## Global constraints

- Use `window.location.reload()` in the current installer or manager window. Never access `window.parent` for this flow.
- The `/teardown` input accepts the trimmed, exact lowercase word `cloudflare`.
- Teardown must use Commander RPC even when Cloudflare auth or the Go API is unavailable; it must not call `window.confirm` or `window.alert`.
- Keep the saved runner image rule, including `:latest` and SHA-256 digests, and the existing active-run checks.
- Do not display run IDs, events, logs, or run panels in the installer. Retain enough run status to govern Install and navigation.
- Preserve query parameters when changing between `/` and `/teardown`; clear `/teardown` from the current URL before teardown-triggered reload.
- Do not claim the deployed transitions work until verified in Corvo staging. If a worktree is used, report whether it was merged and offer the user the option to merge it.

## File map

| File | Responsibility |
| --- | --- |
| `frontend/src/hostNavigation.ts`, `installer/src/hostNavigation.ts` | Once-per-run local reload helper. |
| `frontend/src/managerPage.ts` | Parse and change the manager's local `/teardown` route. |
| `frontend/src/components/TeardownPage.tsx` | Typed confirmation, warning copy, and styled, accessible status message. |
| `frontend/src/App.tsx` | Header navigation, lifecycle state, teardown action, and page selection. |
| `installer/src/InstallApp.tsx`, `installer/src/runHistory.ts` | Installer controls and run-state reconciliation without run details. |
| `frontend/src/styles.css`, `installer/src/styles.css` | Teardown page styling and removal of unused installer run styles. |
| `README.md` | Correct operator flow and staging checks. |

## Review focus

1. A stale successful teardown followed by a newer install must not force a fresh manager back to the installer; Task 3 tests run ordering.
2. A delayed Commander history response must not erase a locally queued teardown or show the previous run's message; Task 3 tests the start/history race.
3. A direct load of `/teardown?context=...` must render teardown and preserve the query when returning to `/`; Task 3 tests both directions and the static fallback.
4. A typed value such as `Cloudflare` or `cloudflare extra` must not start teardown; Task 3 tests exact input and button disabling.
5. A thrown automatic reload must leave a working manual retry that bypasses the per-run marker; Task 1 tests both interfaces.

---

### Task 1: Reload the current interface

**Files:** Modify `frontend/src/hostNavigation.ts`, `frontend/src/hostNavigation.test.ts`, `frontend/src/App.tsx`, `frontend/src/App.test.tsx`, `installer/src/hostNavigation.ts`, `installer/src/hostNavigation.test.ts`, `installer/src/InstallApp.tsx`, `installer/src/InstallApp.test.tsx`.

**Interfaces:** Each `hostNavigation.ts` exports `reloadCurrentInterface(managerId: string, action: "install" | "teardown", runId: string, reload?: () => void): boolean`, defaulting `reload` to `() => window.location.reload()`. `App` and `InstallApp` accept optional `reloadPage?: () => void` for tests; production defaults to that same current-window call. Their automatic path uses `reloadCurrentInterface(..., reloadPage)` and their manual button calls `reloadPage()` directly.

- [ ] **Step 1: Write failing tests** for one automatic reload per run ID, marker cleanup when reload throws, storage failure, installer success versus failure, and teardown redirect clearance. Clicking **Reload interface** must call the injected `reloadPage` even when the per-run marker exists. Assert neither app renders **Reload Commander**.
- [ ] **Step 2: Run** `cd frontend && npm test -- --run src/hostNavigation.test.ts src/App.test.tsx` and `cd installer && npm test -- --run src/hostNavigation.test.ts src/InstallApp.test.tsx`; confirm the new expectations fail against the parent-window implementation.
- [ ] **Step 3: Implement** the interfaces above, replace both direct parent-window retry calls, and update reload failure copy to name the interface. Preserve the existing once-per-run marker behavior.
- [ ] **Step 4: Run** the same focused test commands and both `npm run build` commands; require exit 0.
- [ ] **Step 5: Commit** the Task 1 files as `fix: reload the current manager interface`.

### Task 2: Remove run details from the installer

**Files:** Modify `installer/src/InstallApp.tsx`, `installer/src/InstallApp.test.tsx`, `installer/src/runHistory.ts`, `installer/src/runHistory.test.ts`, `installer/src/styles.css`.

**Interfaces:** `loadLatestInstall(caller: RPCCaller): Promise<RunItem | null>` and `loadLatestTeardown(caller: RPCCaller): Promise<RunItem | null>` read saved run status only. `installationState` remains the source for Install availability.

- [ ] **Step 1: Write failing tests** asserting the installer renders no run summaries, IDs, structured event messages, or logs; it does not request `getRunEvents`; and it shows simple action state while an install or teardown is active. Preserve tests for saved successful install reload, missed event reconciliation, failed install, and Install becoming available after successful teardown.
- [ ] **Step 2: Run** `cd installer && npm test -- --run src/runHistory.test.ts src/InstallApp.test.tsx`; confirm the display and `getRunEvents` assertions fail.
- [ ] **Step 3: Implement** status-only run loading, remove event-specific state and UI, retain status polling and live-event-triggered refresh, simplify status labels, and remove unused `.run-summary` CSS.
- [ ] **Step 4: Run** the focused installer tests and `cd installer && npm run build`; require exit 0.
- [ ] **Step 5: Commit** the Task 2 files as `refactor: keep runs out of installer UI`.

### Task 3: Add the dedicated teardown page

**Files:** Create `frontend/src/managerPage.ts`, `frontend/src/managerPage.test.ts`, `frontend/src/components/TeardownPage.tsx`, `frontend/src/components/TeardownPage.test.tsx`; modify `frontend/src/App.tsx`, `frontend/src/App.test.tsx`, `frontend/src/styles.css`, `frontend/src/teardown.ts`, `frontend/src/teardown.test.ts`, `backend/internal/server/server_test.go`.

**Interfaces:** `managerPageFromPath(pathname: string): "home" | "teardown"` recognizes `/teardown` and `/teardown/`. `navigateManagerPage(page: "home" | "teardown", mode?: "push" | "replace"): void` changes only the local pathname through the History API and preserves `window.location.search`. `TeardownPage` receives `run: TeardownSnapshot | null`, `installRun: RunItem | null`, `starting: boolean`, `startError: string`, `reloadBlocked: boolean`, `onBack: () => void`, `onStart: () => Promise<void>`, and `onReload: () => void`; it owns the confirmation input and status presentation.

- [ ] **Step 1: Write failing route tests** for direct `/teardown` load, trailing slash, query preservation, Back and browser `popstate`, and replacing the teardown path with `/` before reload. Add a Go static-handler test that a direct GET `/teardown` serves `index.html`.
- [ ] **Step 2: Run** `cd frontend && npm test -- --run src/managerPage.test.ts src/App.test.tsx` and `cd backend && go test ./internal/server`; confirm the frontend route expectations fail. The existing Go static handler should already pass the new direct-load test.
- [ ] **Step 3: Implement** `managerPage.ts` and App page selection, including a `popstate` listener and a header link that opens the teardown page without a full navigation. Keep this view available before Go session settles and when it fails.
- [ ] **Step 4: Write failing teardown-page tests** for exact typed `cloudflare`, warning copy about surviving keys/buckets/domains, no native confirm or alert, immediate styled `role="status"` message, saved/live progress, start error and retry, failed run, active-run guard, and a newer install after an old completed teardown. Test a locally queued run against stale history and ignore an old run's event. Use distinct `queued_at` timestamps in run-order tests and update existing teardown fixtures whose timestamps are empty.
- [ ] **Step 5: Run** `cd frontend && npm test -- --run src/components/TeardownPage.test.tsx src/App.test.tsx src/teardown.test.ts`; confirm the new behavior fails.
- [ ] **Step 6: Implement** `TeardownPage`, its styles, and App's start/progress state using existing `startTeardown(caller)` and lifecycle reconciliation. Remove the home-page teardown run panel and its native confirmation. Make `startTeardown` reject an already completed teardown when no newer install exists, so the RPC path enforces the UI guard. On explicit redirect clearance or saved successful teardown, replace `/teardown` with `/` before local reload; do not navigate on a failed run before clearance.
- [ ] **Step 7: Run** all focused frontend tests, `cd frontend && npm run build`, and `cd backend && go test ./internal/server`; require exit 0.
- [ ] **Step 8: Commit** the Task 3 files as `feat: add typed teardown page and status`.

### Task 4: Document and verify the complete flow

**Files:** Modify `README.md`.

- [ ] **Step 1: Update README** to say the installer shows setup and action state while detailed runs live in Deploy Commander; the current interface reloads after install and teardown; teardown opens `/teardown`, requires typing `cloudflare`, and reports progress in a styled message. Keep the warning about application access keys and remaining Cloudflare resources.
- [ ] **Step 2: Run** `cd frontend && npm test -- --run && npm run build`, `cd installer && npm test -- --run && npm run build`, and `cd backend && go test ./... && go vet ./...`; require exit 0 and record actual output. Run `git diff --check` and inspect generated installer assets for the configured `:latest` image references.
- [ ] **Step 3: Commit** `README.md` as `docs: explain manager reload and teardown page`.
- [ ] **Step 4: Review** the full branch against the spec, checking the five Review focus cases and that no `window.parent.location.reload()` remains in either app. Report any unverified Corvo staging behavior without calling it fixed.

## Corvo staging gate

With published installer and manager assets, observe a successful install reload into the manager, a direct `/teardown` load, teardown while the Go API is unavailable, an immediate styled status message, redirect-clear reload into the installer, and a working manual reload. Confirm the installer exposes no run details. Exercise a failed teardown before redirect clearance. Record the published artifact identities and run IDs. If staging access is unavailable, report that the integration gate remains open.

## Execution handoff

The user requested Sol planning and Luna implementation. After plan review, ask the user to switch to Luna and implement inline with `superpowers:executing-plans` and `superpowers:test-driven-development`. Do not spawn subagents. If a worktree is used, state whether it has been merged and offer the merge option.
