# Startup Diagnostics in Runner Logs

## Purpose

When the Cloudflare Manager service exits before its health check succeeds, the install run must show enough information to locate the failing startup step. The runner now supports opt-in health probe output and container output on a failed health wait. These diagnostics gather evidence for the remaining installation failure; they do not change whether startup succeeds.

## Approaches

- Enable the runner's new health diagnostic options alone. This exposes the current fatal error, but gives little context before it.
- Enable both options and add short, safe startup milestones. This is the chosen approach because it shows the last completed step and the failing operation in one run.
- Add a separate log collector or stream all service output continuously. The runner contract does not require either for diagnosing a failed install and neither is part of this change.

## Behavior

The install metadata for the `cloudflare-manager` service sets `health_check.log_health_output` and `health_check.log_container_output` to `true`. On a failed health wait, the runner includes Docker's retained probe records and the service's last 100 stdout and stderr lines in the run log. The options do not change the health test, retry timing, or success criteria. The `generate-jwt-secret` runner step continues to suppress its captured output.

The Go service emits a small set of startup milestones to stderr: configuration accepted, Commander identity verified, S3 provisioner lookup started, existing resource reused or new resource created, and HTTP listener starting. Existing fatal errors still carry the operation and status code where available. Provisioner validation errors identify the failed field or metadata marker by name so a response shape problem is visible without printing returned values.

Logs must not print the manager password, JWT secret, Commander URL, request or response bodies, resource metadata values, access tokens, or resource IDs. The runner redacts secrets it knows, but the service must make its own messages safe to display. Health probe output may show a local port or HTTP status. Logging is limited to startup and install failure diagnostics; this design does not add ongoing application log streaming.

## Verification

- An installer test checks that both diagnostic options are present on the service health check and that the JWT capture step still suppresses output.
- Go tests exercise successful creation and reuse as well as a failing Commander response, checking the milestone sequence and that a sentinel password does not appear.
- Build the installer and backend and run a local failed-start smoke check to confirm the manager emits an actionable error without secret values. A later real install run will supply the actual Commander failure reason.
