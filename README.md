# Cloudflare Manager for Deploy Commander

A Deploy Commander manager for Cloudflare R2. This repository contains two independent React projects: `installer/` approves the Commander connection, starts installation, and shows the current action state; detailed runs live in Deploy Commander's runs section. `frontend/` is the management UI bundled into the Go service image. The Go service owns Cloudflare OAuth, Cloudflare API calls, and R2 resource and connection workflows.

OAuth pending state is stored encrypted for ten minutes in the manager's Commander database and consumed once by `/auth/callback`. Successful sign-in keeps the Cloudflare token in backend memory and gives the embedded frontend a short-lived opaque session handle. The existing host-only `HttpOnly` cookie remains available where the browser accepts it; the handle supports embedded flows without cookies and is kept in tab-scoped `sessionStorage` when available. Handles expire within 30 minutes or the Cloudflare access-token lifetime, and a backend restart invalidates them. Cloudflare access tokens are never stored in Commander or exposed to JavaScript. Application S3 credentials are separate account-owned Cloudflare tokens scoped to one bucket; their access key and secret are stored in the requesting application's Deploy Commander connection secrets.

## Requirements

- Go 1.25 or Docker for the backend image
- Node.js 22.12+ and npm for `installer/` and `frontend/`
- A Cloudflare OAuth client and an HTTPS deployment
- Deploy Commander publisher access and its supported deployment runner

## Configure the Cloudflare OAuth client

Create an OAuth client in Cloudflare with these settings:

- Grant type: `authorization_code`
- Response type: `code`
- Token authentication: `none`
- Client type: public client using Authorization Code with PKCE (`S256`)
- Redirect URI: `https://cloudflare-manager.example.com/auth/callback` (replace with the manager's exact public origin)
- Required scopes:
  - Account Settings Read (`account-settings.read`)
  - Zone Read (`zone.read`)
  - Workers R2 Storage Read (`workers-r2.read`)
  - Workers R2 Storage Write (`workers-r2.write`)
  - Account API Tokens Write (`account-api-tokens.write`)

Configure the listed scopes on the OAuth client. On the consent screen, select the account before reviewing and granting the requested permissions. Cloudflare's [`/oauth/scopes` API](https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/methods/list/) lists current scope IDs. See Cloudflare's [OAuth client setup](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) and [R2 token permissions](https://developers.cloudflare.com/r2/api/tokens/) for current scope details. The app does not request `offline_access` and never uses a refresh token. For use by Cloudflare users outside the OAuth client's owning account, make the client public after completing Cloudflare's client URL ownership verification. Keep the client ID public; do not create a client secret for this PKCE client.

## Build and publish the installer

The installer is its own Deploy Commander project. Its only configurable build defaults are the service and runner images:

| Variable | Purpose |
| --- | --- |
| `VITE_BACKEND_IMAGE` | Manager service image to install; defaults to `ezenki/cloudflare-manager:latest` |
| `VITE_STATE_TTL_IMAGE` | One-shot expired OAuth-state cleanup image; defaults to `ezenki/cloudflare-manager-state-ttl:latest` |
| `VITE_RUNNER_IMAGE` | Values-capable Deploy Commander runner; defaults to `ezenki/deploy-commander-runner:latest` |

The installer first checks for a valid connection to the reserved Commander resource. If one is missing, create it from the installer and approve it in Deploy Commander. Install becomes available after approval and the `COMMANDER_PASSWORD` secret check; the Install action rechecks the approved connection before starting the run. The optional OAuth client ID can be saved from the installer or frontend settings. The OAuth callback is the manager's HTTPS origin plus `/auth/callback` and must be registered on the Cloudflare client.

```sh
cd installer
npm ci
npm test -- --run
npm run build
npm run publish:manager
```

For publishing, put `COMMANDER_URL`, `COMMANDER_USERNAME`, and `COMMANDER_PASSWORD` in a local ignored `.env` beside `installer/deploy-commander.json`, or export them in the shell. Publishing uploads only `installer/dist`; it does not publish source files or local environment files.

## Build the management frontend

The management UI is a separate Vite project, but it is served by the Go service rather than published to Deploy Commander. It discovers its host from `window.location.origin` and uses the manager RPC to load the client ID and JWT secret when it starts.

```sh
cd frontend
npm ci
npm test -- --run
npm run build
```

### Build the service image

The Go service image contains only `frontend/dist` at `/app/frontend/dist`; it does not contain or publish the installer. The service and the one-shot TTL image run as UID 65532 on `gcr.io/distroless/static-debian12:nonroot`. Build the local targets with `docker build --target service -t cloudflare-manager:local .` and `docker build --target state-ttl -t cloudflare-manager-state-ttl:local .`. `build.sh` builds and pushes both `ezenki/cloudflare-manager:latest` and `ezenki/cloudflare-manager-state-ttl:latest` for the same default platforms. Set `IMAGE`, `STATE_TTL_IMAGE`, `TAG`, or `PLATFORMS` to change image names, the shared tag, or target platforms. The installer accepts tagged references, including `latest`, and SHA-256 digests.

The installer defaults to `latest` tags for the manager service, TTL image, and Deploy Commander runner. It accepts tagged image references, including `latest`, and SHA-256 digests.

## Install and operate

Open the published installer inside Deploy Commander, create and approve the Commander connection if needed, then click Install. The installer shows setup guidance and the current action state; detailed runs are available in Deploy Commander's separate runs section. The runner configures the service with its approved Commander connection, waits for the `/healthz` health check, and sets the redirect to the healthy service. After a successful install, the installer interface reloads into the manager automatically.

Use an HTTPS custom hostname for production. The OAuth callback is derived from the current browser origin. Local HTTP origins are supported for development; keep production on HTTPS. The access cookie is host-only, `HttpOnly`, and `SameSite=Lax`, while the opaque handle lets the embedded frontend make signed requests when its browser context does not send cookies. A raw internal HTTP alias works for runner-to-service traffic and is not the public OAuth origin.

The install run also declares the `oauth-state-ttl` chronjob with timer `* * * * *` (UTC). It launches the TTL image once per minute with the same manager ID, Commander API, Commander connection, and `COMMANDER_PASSWORD` secret reference used by the manager. The command verifies that the Commander credentials resolve to the configured manager, deletes expired rows from `oauth_pending_state`, prints a safe removal count, and exits. Callback expiry checks still reject expired state if cleanup is delayed. The runner and its paired `ezenki/deploy-commander-chronjob` scheduler image must support chronjobs; the runner requires a local Unix Docker socket. Full top-level teardown stops the scheduler. See the [runner chronjob contract](docs/integrations/DEPLOYMENT_RUNNER_IMPLEMENTATION_GUIDE.md#chronjobs) for prerequisites and supported fields.

After installation, the manager redirects to its bundled frontend. Sign in with Cloudflare, select an account and R2 jurisdiction, then manage buckets and custom CDN domains. Track a bucket to create its Deploy Commander resource. Create an application connection to provision one bucket-scoped S3 credential pair. Secrets are stored only through Deploy Commander secret RPC and are never returned in manager metadata. Revoking a connection revokes its Cloudflare token and deletes its stored secrets. See the [Cloudflare Manager integration guide](CLOUDFLARE_MANAGER_INTEGRATION_GUIDE.md) for other manager authors.

The **Tear down** control stays available even when Cloudflare sign-in or the manager API is unavailable. It opens a separate `/teardown` page, where the user types `cloudflare` and starts the standard Commander `teardown` run using the saved runner image. The page shows progress in a styled status message. When the runner clears the manager redirect, the teardown route is removed from the URL and the manager interface reloads into the installer. The installer enables another install after teardown succeeds. Teardown preserves the S3 provisioner resource, registered bucket resources, Cloudflare buckets, and CDN domains. Application access keys may remain active. If the manager frontend cannot load or teardown cannot be started, delete the manager through Deploy Commander and publish the installer again to return to the installation flow.

Installation and teardown are the only run actions. Bucket, domain, and credential operations call the Go service directly and use Deploy Commander RPC for resource/connection records and secrets.

## Configuration

The service receives these environment variables from the install run:

| Variable | Purpose |
| --- | --- |
| `MANAGER_ID` | Cloudflare Manager's Deploy Commander manager ID |
| `MANAGER_API` | Approved Commander API address ending in `/api/v1` |
| `MANAGER_PASSWORD` | Runner reference to the Commander connection's `COMMANDER_PASSWORD` secret |
| `JWT_SECRET` | Random 32-byte unpadded base64url signing value generated by the runner and saved to manager settings |
| `PORT` | HTTP listen port; default `8080` |
| `STATIC_DIR` | Published interface assets inside the image; default `/app/frontend/dist` |

OAuth URLs use Cloudflare's production authorization and token endpoints. The Cloudflare client ID and JWT secret are stored in `manager_settings:current`. Browser-to-Go operations use short-lived HS256 JWTs in POST bodies; the JWT secret is read through authorized manager RPC and held in browser memory. Pending OAuth records use a SHA-256-derived key and an authenticated encrypted PKCE/context payload, with an encryption key derived from `MANAGER_PASSWORD` using domain separation. The raw state and PKCE verifier are not stored as database fields. Cloudflare access tokens remain in backend memory and the existing HttpOnly cookie; the browser stores only the opaque session handle.

## Local development

```sh
cd installer && npm ci && npm test -- --run && npm run build
cd ../frontend && npm ci && npm test -- --run && npm run build
cd ../backend && go test ./... && go vet ./...
```

Override the installer image defaults with `VITE_BACKEND_IMAGE`, `VITE_STATE_TTL_IMAGE`, or `VITE_RUNNER_IMAGE` when building. The backend service requires the manager and secret environment variables shown above; the TTL command requires `MANAGER_ID`, `MANAGER_API`, and `MANAGER_PASSWORD` and runs once per invocation. A cleanup failure exits nonzero and should appear in that scheduled container's logs without printing the password or OAuth contents.

## Verification gates

Before live use, verify in Deploy Commander staging with disposable Cloudflare resources:

1. Install with the latest manager and supported runner image tags; confirm the run waits for health before redirecting.
2. From the real HTTP Corvo `*.interface.localhost:8080` origin, complete OAuth in the popup without relying on cookies. Confirm `/auth/callback` succeeds, `/api/session` and account listing work through the opaque handle, then reload the manager and confirm the tab-scoped handle still works. Confirm HTTPS cookies are host-only, Secure, HttpOnly, and expire with the access token.
3. List accounts and buckets; create and delete an empty test bucket; attach and detach a test custom domain.
4. Provision a read-only and read/write application connection; verify the token policy names exactly one bucket; then revoke and confirm the token and both connection secrets are removed.
5. Load the manager frontend, make the Go API unavailable, directly load `/teardown`, and use **Tear down**. Verify the styled status appears, Commander starts the standard teardown run, the runner clears the redirect, and the manager page reloads into the installer.
6. Exercise a teardown failure before redirect clearance and verify the manager stays available with the failure status. Record any application access keys and manager-created R2 resource records that remain after teardown; Cloudflare buckets and domains should remain.
7. Confirm the manager database contains no raw Cloudflare access token and browser JavaScript/session storage contains only the opaque handle, not the token. Verify pending-state fields are encrypted and raw OAuth state/verifier values are absent.
8. Wait for the one-minute cleanup chronjob to fire. Confirm expired pending-state rows are removed, live rows and unrelated records remain, and a failing cleanup container exits nonzero with safe logs. Verify full teardown stops the scheduler.
9. If the manager frontend cannot load, delete the manager in Commander and republish the installer, then verify that the installer is available again.

These checks need real Cloudflare and Deploy Commander staging credentials and cannot be established by local unit tests or a container health check alone.
