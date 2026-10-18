# Manager Lifecycle Navigation and Teardown Design

Date: 2026-10-18

## Purpose

Cloudflare Manager must let a person tear down its deployed service from the open management frontend even when Cloudflare sign-in or the Go API fails. Installation must open the management frontend without a manual browser refresh. Teardown must return the open page to the published installer when the runner clears the manager redirect. If the Go service cannot serve the frontend at all, the operator will delete and reupload the manager through Deploy Commander; that case is outside this change.

This design replaces the teardown behavior in [the one-click installer design](2026-10-17-one-click-installer-jwt-design.md). It keeps the standard `ezenki/deploy-commander-runner` and the existing Commander connection and install metadata. The configured backend and runner images remain the `:latest` tags unless explicitly overridden at build time.

## One teardown action

The management frontend has one button labelled **Tear down**. It is present while authentication is checking, signed out, signed in, or unavailable. It does not require a Cloudflare OAuth session or a response from the Go API. It is unavailable only while an install or teardown run is queued or running, or when the latest teardown is already done and no later installation exists.

Clicking the button shows one confirmation that states what the action does: the standard runner removes the deployed manager and clears its redirect; Cloudflare buckets and domains stay; application access keys may remain active and may need separate revocation. Confirmation starts one top-level `action: "teardown"` run through the manager-scoped Commander interface RPC. The frontend reads the runner image from the saved installation run and accepts the user's `:latest` tag or a valid digest. It rejects a missing or malformed image reference and checks Commander run history for a conflicting active run before starting. No Go API call, Cloudflare session check, `prepareTeardown`, bucket-resource enumeration, or frontend resource deletion is part of this path. A failed Commander call leaves the button available for retry and displays the actual error.

The frontend must not report that it revoked Cloudflare tokens, removed R2 bucket records, or completed teardown until the corresponding operation is established. The runner's documented teardown contract clears the redirect before removing manager-owned deployment objects and published resources. Manager-created R2 bucket records and their application connections are not deleted by frontend teardown. Any such records that survive the standard runner remain available for later inspection after reinstall. The UI and README state that Cloudflare access keys can remain valid and require separate cleanup.

## Install and teardown page transitions

The installer and management frontend use Commander run history as durable state and live `run-start`/`run-update` events for immediate updates. While a relevant run is active, they also reconcile its saved status every three seconds so a missed browser event cannot leave the page stale. They do not poll the live event stream. Initial load and tab focus reconcile saved status as well. A stale response cannot replace a newer run or trigger a second navigation.

After an install run reaches saved status `DONE`, the installer reloads the containing Deploy Commander page once. Commander then applies the installed manager redirect and opens the management frontend. A `FAILED` run stays in the installer and shows its saved status and last event. The installer never navigates solely because an event message says the service is healthy.

After a teardown run starts, the management frontend checks the current manager's redirect using Commander RPC, matching the manager returned by `getManager()` to its entry in paginated `getManagers()` results. Only an explicit empty or null redirect counts as cleared; a missing manager or omitted redirect field is not proof. When Commander reports clearance, the frontend reloads the containing Deploy Commander page once. This can happen before the teardown run finishes; the installer continues to show that active run. A saved `DONE` teardown is a fallback navigation signal because the runner contract guarantees redirect clearance before `DONE`. If the run fails before clearing the redirect, the management frontend stays open and shows the failure. If it fails after clearing the redirect, the installer shows the failed run after reload. Event message text is never used as proof that the redirect changed.

Page reload targets the containing Commander page, not just the embedded manager frame. A nonsecret, per-manager, per-run marker in browser session storage prevents a reload loop if Commander still serves the old page after navigation. The implementation must use a host-supported navigation path verified in staging. If the browser or host prevents that reload, the UI displays the saved run outcome and an explicit Reload Commander control; automatic navigation remains a release gate rather than an assumed success.

## UI state and errors

The management shell, including Tear down and its run status, renders before the first Go session request finishes. The existing auth and bucket UI can continue loading separately. A failed session request cannot hide or disable Tear down. The confirmation, pending state, failed run, and latest saved teardown event remain understandable without Cloudflare sign-in.

The installer retains its single Install action and Commander connection approval. It prevents a second install during an active run, shows a failed run without redirecting, and returns to the ready state only after a later successful teardown. Both pages unsubscribe from events and stop status reconciliation when unmounted or after navigation. Navigation is performed at most once per observed run ID.

## Verification and release gate

Automated tests cover Tear down from checking, signed-out, and unavailable auth states; absence of Go API calls; confirmation cancellation; a conflicting install or teardown; latest runner image retrieval; failed Commander start and retry; and recovery of a saved teardown run after reload. Navigation tests cover successful install, failed install, teardown redirect clearance during an active run, failure before and after redirect clearance, missed live updates, duplicate events, and one navigation per run. Tests also assert that teardown does not claim application keys were revoked.

Run installer and frontend tests and production builds, Go tests and vet, and inspect the built installer image references. These local checks do not establish the Commander host's navigation or runner behavior. Before release, publish the installer and service image and perform a real Commander staging cycle: install and observe automatic opening of the manager, exercise Tear down with the Go API unavailable, observe automatic return to the installer when the redirect clears, verify that the installer tracks the remaining run, and verify the expected remaining Cloudflare keys and Commander records. Verify a failed teardown before redirect clearance remains on the manager view. Record the published artifact version or digest and actual run IDs/logs. Do not call the lifecycle fixed or publish it as verified if the Commander endpoint or staging environment is unavailable.
