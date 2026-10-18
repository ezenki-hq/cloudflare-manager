# Manager Reload and Teardown Page Design

Date: 2026-10-18

## Purpose and scope

Installation and teardown should move the open Cloudflare Manager interface to the right view without a manual refresh. The current code calls `window.parent.location.reload()` from the embedded interface, and its retry buttons repeat that call. The target is the interface's own window: `window.location.reload()`. No change to Deploy Commander is required for this navigation.

The installer should contain setup and installation controls, not a second display of Deploy Commander runs. Teardown should have a dedicated page inside the manager with an explicit typed confirmation and a styled status message. This design supersedes the navigation target, installer run display, and teardown confirmation UI in [Manager Lifecycle Navigation and Teardown Design](2026-10-18-manager-lifecycle-navigation-design.md). Its Commander-only teardown behavior and runner-image rules remain in force.

## Current-window reload

After the installer observes a saved successful install run, it calls `window.location.reload()` once for that manager, action, and run ID. A failed run does not reload. After the manager observes that Commander has explicitly cleared its redirect during teardown, it reloads its own window. A saved successful teardown remains a fallback signal for redirect clearance, as established by the runner contract. Neither interface reloads merely because an event message contains reassuring text.

The existing per-run session marker prevents automatic reload loops. A manual **Reload manager** button calls `window.location.reload()` directly, bypassing that marker, so it is a real retry. The button appears if the automatic reload throws. The same local reload target is used on install and teardown. Tests inject a reload callback and assert that automatic and manual controls invoke the current-window path; the real behavior must also be checked in Corvo staging.

The manager's teardown view uses a local `/teardown` route. Before the teardown-triggered reload, the manager replaces that path with its base path, preserving any query parameters needed by the embedding context, and then calls `window.location.reload()`. This ensures the new interface opens at its default view after redirect clearance. The frontend and backend must serve `/teardown` on a direct load and browser refresh.

## Installer presentation

The installer keeps its Commander connection approval, OAuth client ID setup, installation status needed to enable or disable Install, and the install action. It still reads saved install and teardown run status and listens for relevant updates so it can prevent duplicate installs, resume after missed events, and reload after a completed installation. It does not display run IDs, run events, run logs, or separate install and teardown run panels. The status pill and Install button may use simple labels such as **Installing**, **Installed**, and **Teardown in progress** to explain why the action is unavailable. Detailed run inspection remains in Deploy Commander's runs section.

## Teardown page and messages

The manager header's **Tear down** control opens the dedicated `/teardown` view. That control remains accessible regardless of Cloudflare sign-in or Go API health; navigation to the view and its Commander RPC state must not wait for either. The view explains that the runner removes the manager service and clears its redirect, while Cloudflare buckets and domains remain and application access keys may remain active. It has a back control and a text field instructing the user to type the literal lowercase word `cloudflare`. The final **Tear down** action is disabled until the trimmed field value equals `cloudflare`. Active install or teardown runs and an already completed teardown with no later installation also prevent a new teardown.

Clicking the final action starts the existing Commander-only teardown workflow. It does not call `window.confirm`, `window.alert`, the Go API, or Cloudflare APIs. A styled, accessible message box appears in the manager view immediately, with a starting state followed by the current outcome. It shows a clear Commander start error and permits retry when start fails. While the run is active, it shows progress from saved run state and the latest relevant event. A failed run stays on the teardown page with its failure message. Successful redirect clearance triggers the current-window reload; the status box remains useful until that navigation occurs. No message claims that Cloudflare keys or bucket records were removed.

The route and status remain meaningful after a direct page reload: the manager reconstructs the latest teardown state from Commander run history. Events from an older run cannot replace the current message. Native browser confirm and alert dialogs are absent from this teardown flow; unrelated bucket and connection confirmations are outside this change.

## Verification

Frontend tests cover opening and refreshing `/teardown`, back navigation, accessibility of the typed confirmation, case-sensitive input, no start before confirmation, no browser confirm or alert, start failure and retry, active-run guards, saved and live status, redirect clearance, and local reload from the base path. Installer tests cover no run panels or event text, correct button state, successful-install local reload, failed-install no reload, and a manual retry that calls the local window reload directly. Helper tests cover once-per-run markers and thrown reload callbacks.

Run frontend and installer tests and builds, backend tests and vet if the static route changes, and inspect the generated assets. These checks prove local behavior only. Before claiming the deployed transition works, use the published installer and manager in Corvo staging to verify install reload, teardown-page direct load, styled progress and failure messages, teardown redirect-clear reload, and manual reload. Record the actual run IDs and published artifact identities. If staging is unavailable, report that deployment behavior remains unverified.
