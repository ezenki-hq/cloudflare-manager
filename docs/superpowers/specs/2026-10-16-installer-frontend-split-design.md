# Installer and Frontend Project Split

## Purpose and success criteria

Cloudflare Manager needs two standalone projects in this repository. The initial installer must publish to Deploy Commander and work before the Go service exists. The ongoing management frontend must be built into the Go service image and appear after the runner sets the manager redirect. The two projects must build and test independently, without importing each other's source.

The split preserves the existing Cloudflare resource and connection workflows. It leaves teardown in the management frontend. Both the installer and teardown view show their current run status and latest structured run event, updating through the Deploy Commander interface event listener and recovering the latest saved event when reopened.

## Project layout and responsibilities

`installer/` is a standalone Vite, React, and TypeScript project with its own `package.json`, lockfile, Vite configuration, entry point, tests, and `deploy-commander.json`. Its published `dist/` is the manager's initial interface. It contains the install form, installation validation and run construction, the Commander RPC bridge, and install run status/event display. It does not call the Go API or use Cloudflare OAuth. Its build variables provide optional defaults for the backend image, pinned runner image, OAuth client ID, public service origin, and Commander origin. Deployment secrets remain outside source and build output.

`frontend/` remains a standalone Vite, React, and TypeScript project with its own package and lockfile. It contains the management UI, Cloudflare API client, Commander resource and connection workflows, child-interface actions, and teardown. It has no install form, install-start action, or installer build variables. It may read the latest install run to identify the runner image required by teardown, but cannot start an install run. Its Go API origin remains configurable at build time, with the current page origin as the local-development fallback.

The projects have no cross-project source imports and no shared workspace package. Small bridge or presentation code may be local to each project. The root Docker build compiles only `frontend/` and copies only that build beside the Go binary. The Go service serves those assets from `STATIC_DIR`. Publishing runs only from `installer/` and uploads only its built assets. `build.sh` continues to build and push the service image. README instructions distinguish publishing the installer from building the service image and running either project locally.

## Run lifecycle and events

The installer reads the latest `install` and `teardown` runs through manager-scoped RPC. A queued or running install disables another install; a failed install leaves the form available for retry. A completed install blocks a duplicate while it is the current deployment. A successful teardown that follows that install returns the manager to an installable state. Run chronology is determined from durable run timestamps rather than treating any historical successful install or teardown as permanent state. Active teardown also blocks installation. The installer never waits for the Go API before rendering.

After the install runner starts the service, verifies health, and sets the redirect, Deploy Commander presents the management frontend served by that service. The management frontend shows Cloudflare sign-in and management regardless of whether a run-history read succeeds; run-history failure must not hide the service UI. Teardown retains the existing order: verify Cloudflare authorization, revoke managed application credentials, remove managed Commander records, then start one runner `teardown` run. The runner clears the redirect before removing the service, returning future manager openings to the published installer. A failed cleanup or runner operation remains visible for retry while the frontend is open.

Each project creates one Commander interface wire, subscribes to `run-start` and `run-update`, and unsubscribes and ends the wire on unmount. The installer tracks only install events for the latest install run; the frontend tracks only teardown events for the latest teardown run. They show the run status and the most recent structured event message, not a log line presented as an event. On opening, reload, or run change, they fetch the latest relevant run and its latest persisted event. Live updates refresh the durable status and event. Run IDs and event sequence numbers prevent an older or replayed update from replacing a newer event. An event without a message cannot erase a previously displayed message. If a run has no event yet, the view shows a waiting state. RPC failures appear as useful errors without inventing a successful state.

## Browser origins and OAuth

The management frontend can be opened at the configured Commander origin or the service's configured public origin. The Go API accepts credentialed browser requests and state-changing requests from exactly those two configured HTTPS origins. It rejects every other origin; it does not use wildcard CORS. Existing cookie and JSON content-type protections remain in force.

When the frontend opens `/auth/start`, it supplies its actual browser origin. The Go handler validates that origin against the same exact allowlist before starting PKCE, stores it with the transient OAuth state, and uses it as the callback's `postMessage` target. The frontend continues to accept completion messages only from the configured backend origin and its own popup window. Invalid or missing opener origin is rejected before authorization begins. The Cloudflare redirect URI remains the service public origin plus `/auth/callback`; OAuth and access tokens never enter JavaScript or Commander metadata.

## Failure behavior and verification

The installer shows failed install status and latest event while permitting a safe retry. The frontend shows failed teardown status and latest event while retaining the existing Cloudflare cleanup safeguards. Reloading either view restores durable run state. An unrelated run event cannot change the displayed run. Removing the service after redirect clearance may end access to its frontend, but the published installer remains available through Commander.

Installer tests cover run metadata validation, active-run and completed-run guards, reinstall after successful teardown, failed install retry, live event updates, stale/replayed events, and recovery after reload. Frontend tests cover removal of install UI/actions, existing resource and connection behavior, teardown order and failures, live latest teardown event, and reload recovery. Go tests cover both allowed origins, rejection of other origins, validated OAuth opener origin, and callback targeting. Verification also runs both TypeScript builds and test suites, Go tests and vet, and an image build when Docker is available. Live Deploy Commander and Cloudflare staging checks remain necessary to verify redirect, cookies, and runner behavior end to end.

The existing uncommitted `frontend/package-lock.json` change is preserved during this work. Existing Cloudflare resource semantics, secret handling, and manager-scoped RPC authorization are outside the split and must remain intact.
