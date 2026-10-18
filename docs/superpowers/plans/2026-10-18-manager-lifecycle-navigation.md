# Manager Lifecycle Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user chose Sol for planning and will switch to Luna for implementation.

**Goal:** Keep one Tear down action available in the open management frontend without Go or Cloudflare sign-in, and automatically move the Commander page between installer and manager as runs change the redirect.

**Architecture:** The frontend starts the standard runner teardown directly through Commander RPC. Each React project reconciles durable run state with live events and uses its own small host-navigation helper. The management frontend checks Commander's saved redirect before returning to the installer; the installer returns to the manager only after a saved successful install run.

**Tech Stack:** React, TypeScript, Vitest, `@ezenki/deploy-commander-installer-interface`, Go verification.

**Spec:** [Manager Lifecycle Navigation and Teardown Design](../specs/2026-10-18-manager-lifecycle-navigation-design.md)

## Global Constraints

- One button labelled **Tear down**; no separate recovery action.
- Teardown starts `action: "teardown"` through Commander RPC and makes no Go API or Cloudflare session call.
- Keep the standard `ezenki/deploy-commander-runner`; the configured backend and runner images remain `:latest` unless explicitly overridden at build time.
- Cloudflare buckets and domains stay; application access keys may remain active and may need separate revocation. Do not claim they were revoked.
- Reconcile saved status every three seconds while a relevant run is active; do not poll the live event stream.
- Reload the containing Commander page once per manager/action/run when install is saved `DONE` or teardown redirect is explicitly cleared. A saved teardown `DONE` is a fallback signal.
- A failed run before redirect clearance stays on the management frontend; a failed run after clearance is visible in the installer.
- If the Go service cannot serve the frontend at all, operator deletion and reupload are outside this change.
- Treat local tests as local evidence; the real Commander install/teardown cycle is a release gate.

## File map

- `frontend/src/teardown.ts`: Commander-only teardown start and run guards.
- `frontend/src/managerRedirect.ts`: authoritative lookup of this manager's saved redirect.
- `frontend/src/hostNavigation.ts` and `installer/src/hostNavigation.ts`: project-local, once-per-run top-level reload helpers.
- `frontend/src/App.tsx`: always-visible Tear down control, run reconciliation, and redirect-clear transition.
- `installer/src/runHistory.ts` and `installer/src/InstallApp.tsx`: durable install/teardown display, missed-update reconciliation, and install-complete transition.
- Existing adjacent test files and `README.md`: behavior proofs and operating instructions.

## Review Focus

1. More than 100 managers: paginated redirect lookup must find the current manager; Task 2 tests page two.
2. Omitted redirect field: it must not be mistaken for a cleared redirect; Task 2 tests this.
3. Reinstall after an older successful teardown: the new installation must have an enabled Tear down button; Task 2 tests chronology.
4. Missed terminal browser event: saved run status must still cause the transition; Tasks 2 and 3 test the three-second reconciliation.
5. Commander RPC failure: no false teardown success or automatic navigation; Tasks 1 and 2 test the visible error and retry path.

---

### Task 1: Start teardown through Commander only

**Files:** Modify `frontend/src/teardown.ts`; test `frontend/src/teardown.test.ts`.

**Interfaces:** Produce `startTeardown(caller: RPCCaller): Promise<Awaited<ReturnType<RPCCaller["start"]>>>`. It consumes `getLatestRun`, `getRun`, and `start` on `RPCCaller`; no `BackendAPI` parameter. Preserve the saved install runner reference, including `:latest`, and reject a missing or malformed reference.

- [ ] **Step 1: Replace the old cleanup tests with failing runner-only tests.** In `frontend/src/teardown.test.ts`, assert `startTeardown(caller)` starts exactly `{action:"teardown", runner:"ezenki/deploy-commander-runner:latest", platform:"docker"}` despite a Go API outage; never calls `getMyResources`, `deleteResource`, or connection RPC; rejects active install or teardown, missing install, malformed runner, and failed `caller.start`; permits a retry after a failed start. Keep the durable run-history test.
- [ ] **Step 2: Run `cd frontend && npm test -- --run src/teardown.test.ts`.** Expect failure because the current helper requires the API and cleanup sequence.
- [ ] **Step 3: Implement the new `startTeardown(caller)` signature.** Keep the active-run and runner-reference guards; remove the session, `prepareTeardown`, resource listing, and record deletion calls.
- [ ] **Step 4: Run `cd frontend && npm test -- --run src/teardown.test.ts`.** Expect all tests in that file to pass.
- [ ] **Step 5: Commit only Task 1 files** with `git add frontend/src/teardown.ts frontend/src/teardown.test.ts && git commit -m "fix: start manager teardown without backend"`.

### Task 2: Keep Tear down available and navigate when redirect clears

**Files:** Create `frontend/src/managerRedirect.ts`, `frontend/src/managerRedirect.test.ts`, `frontend/src/hostNavigation.ts`, `frontend/src/hostNavigation.test.ts`; modify `frontend/src/App.tsx`, `frontend/src/App.test.tsx`.

**Interfaces:** Consume Task 1 `startTeardown(caller)`. Produce `getCurrentManagerRedirect(caller: RPCCaller): Promise<"set"|"cleared"|"unknown">`, using `getManager()` identity and paginated `getManagers({limit:100,offset})`; only a present `redirect` field with null or empty value is `cleared`. Produce `reloadCommanderHost(managerId:string, action:"install"|"teardown", runId:string, reload?:()=>void): boolean` in the frontend navigation module. Add optional `reloadHost?: typeof reloadCommanderHost` to `AppProps` for UI tests; the default uses the real helper. A session-storage marker keyed by manager, action, and run prevents loops across reloads; a thrown reload removes the marker and returns false.

- [ ] **Step 1: Write failing tests.** `managerRedirect.test.ts` tests page-two manager discovery, another manager's empty redirect, omitted field, explicit null/empty, and Commander query failure. `hostNavigation.test.ts` tests one reload per key and failed reload retry. `App.test.tsx` tests Tear down visible during auth `checking`, signed-out, and unavailable; confirmation cancel; successful click with `api.session` and `api.prepareTeardown` uncalled; active-run disablement; old teardown followed by newer install; Commander start failure displayed with retry; redirect-clear reload while teardown remains active; missed event caught by a three-second saved-state check; failed teardown before clear stays; saved `DONE` fallback reload; stale/duplicate events do not reload twice; reload failure shows a Reload Commander control. Assert warning copy says application access keys may remain active.
- [ ] **Step 2: Run `cd frontend && npm test -- --run src/managerRedirect.test.ts src/hostNavigation.test.ts src/App.test.tsx`.** Expect new tests to fail before implementation.
- [ ] **Step 3: Implement `getCurrentManagerRedirect` and `reloadCommanderHost` with the signatures above.** Keep unknown and RPC failure distinct from explicit redirect clearance. Let the caller perform the actual top-level page reload, catching browser security errors.
- [ ] **Step 4: Update `App.tsx` to render its shell before auth settles, call Task 1 from one Tear down button, and reconcile current install and teardown runs.** Use saved run status and explicit redirect clearance to navigate; reconcile every three seconds only while a run is active, and on tab focus. Clear timers and event listeners on unmount. Preserve latest event ordering and show failed run status without claiming Cloudflare cleanup.
- [ ] **Step 5: Run `cd frontend && npm test -- --run src/managerRedirect.test.ts src/hostNavigation.test.ts src/App.test.tsx && npm run build`.** Expect all selected tests and the production build to pass; inspect the rendered button and warning in tests.
- [ ] **Step 6: Commit only Task 2 files** with `git add frontend/src/managerRedirect.ts frontend/src/managerRedirect.test.ts frontend/src/hostNavigation.ts frontend/src/hostNavigation.test.ts frontend/src/App.tsx frontend/src/App.test.tsx && git commit -m "feat: keep teardown available and follow redirect clearance"`.

### Task 3: Follow install completion and track teardown in installer

**Files:** Create `installer/src/hostNavigation.ts`, `installer/src/hostNavigation.test.ts`; modify `installer/src/runHistory.ts`, `installer/src/runHistory.test.ts`, `installer/src/InstallApp.tsx`, `installer/src/InstallApp.test.tsx`.

**Interfaces:** Produce `reloadCommanderHost(managerId:string, action:"install"|"teardown", runId:string, reload?:()=>void): boolean` in the installer navigation module, with the same marker behavior as Task 2. Rename the existing `InstallSnapshot` type to `RunSnapshot` and produce `loadLatestTeardown(caller: RPCCaller): Promise<RunSnapshot|null>` beside `loadLatestInstall(caller: RPCCaller): Promise<RunSnapshot|null>` so the installer can show either run's saved status and latest event. Add optional `reloadHost?: typeof reloadCommanderHost` to `InstallAppProps`.

- [ ] **Step 1: Write failing tests.** `runHistory.test.ts` asserts the latest teardown event is loaded by run ID. `hostNavigation.test.ts` asserts no reload loop and explicit retry after a blocked reload. `InstallApp.test.tsx` asserts a saved `DONE` install reloads the containing page once; an install that becomes `DONE` through a live update or three-second saved-state reconciliation reloads; `FAILED` does not reload; duplicate/older run updates do not trigger a second reload; a blocked reload shows a Reload Commander control. After a teardown redirect-clear reload, assert the installer shows the active teardown run and its last event, updates it to `DONE` or `FAILED`, and enables Install only after successful teardown.
- [ ] **Step 2: Run `cd installer && npm test -- --run src/runHistory.test.ts src/hostNavigation.test.ts src/InstallApp.test.tsx`.** Expect the new transition and teardown-display tests to fail.
- [ ] **Step 3: Implement the installer navigation helper and `loadLatestTeardown` with the signatures above.** Keep install and teardown event sequences tied to their run IDs; do not treat a message such as “Service is healthy” as a terminal state.
- [ ] **Step 4: Update `InstallApp.tsx` to reconcile both latest runs on mount, relevant live events, focus, and every three seconds while either is active.** Reload once on a saved successful install; show a current teardown run and its latest event after redirect clearance; preserve the local queued-run guard until Commander history catches up; stop timers and listeners on unmount.
- [ ] **Step 5: Run `cd installer && npm test -- --run src/runHistory.test.ts src/hostNavigation.test.ts src/InstallApp.test.tsx && npm run build`.** Expect all selected tests and the production build to pass.
- [ ] **Step 6: Commit only Task 3 files** with `git add installer/src/hostNavigation.ts installer/src/hostNavigation.test.ts installer/src/runHistory.ts installer/src/runHistory.test.ts installer/src/InstallApp.tsx installer/src/InstallApp.test.tsx && git commit -m "feat: follow manager install and teardown transitions"`.

### Task 4: Document and verify the complete local behavior

**Files:** Modify `README.md`; no new production interface.

**Interfaces:** Document one Commander-only Tear down action, automatic page transitions, possible surviving Cloudflare access keys and manager-created R2 records, and the operator delete/reupload path when the frontend cannot load.

- [ ] **Step 1: Update `README.md` installation, teardown, and verification sections** to match the spec and remove the old promise that Go revokes tokens and the frontend deletes bucket records before teardown.
- [ ] **Step 2: Run `cd frontend && npm test -- --run && npm run build`, `cd installer && npm test -- --run && npm run build`, and `cd backend && go test ./... && go vet ./...`.** Require exit 0 for every command; report counts and build output without extrapolating to deployment.
- [ ] **Step 3: Run `git diff --check` and inspect the built installer bundle** for `ezenki/cloudflare-manager:latest` and `ezenki/deploy-commander-runner:latest`; require no whitespace errors and both configured defaults.
- [ ] **Step 4: Commit `README.md`** with `git add README.md && git commit -m "docs: explain manager lifecycle and teardown"`.

## Staging release gate

Before claiming the lifecycle works in Deploy Commander, verify the published installer and service image with a real staging run. Record the install and teardown run IDs, published artifact identity, relevant runner logs, actual page transitions, remaining Commander R2 records, and any Cloudflare access keys. Exercise Tear down after loading the frontend and then making the Go API unavailable; confirm that the standard runner clears the redirect and the page returns to the installer. Also exercise a failed teardown before redirect clearance. If publishing or staging access is unavailable, stop at a local implementation report and name that unverified gate; do not describe the deployed behavior as fixed.

## Execution handoff

The user has already selected inline Luna implementation. After the user reviews this plan, switch to Luna and use `superpowers:executing-plans` task by task. Do not spawn subagents. If implementation uses a worktree, report whether it was merged and offer the user the option to merge it.
