# Cloudflare Manager for Deploy Commander

A Deploy Commander manager for Cloudflare R2. This repository contains two independent React projects: `installer/` approves the Commander connection, starts installation, and shows the current action state; detailed runs live in Deploy Commander's runs section. `frontend/` is the management UI bundled into the Go service image. The Go service owns Cloudflare OAuth, Cloudflare API calls, and R2 resource and connection workflows.

Cloudflare user authorization lives in a short-lived `Secure`, `HttpOnly` cookie. It is not stored in Deploy Commander, refreshed, or persisted by this service. Application S3 credentials are separate account-owned Cloudflare tokens scoped to one bucket; their access key and secret are stored in the requesting application's Deploy Commander connection secrets.

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
- Required scopes: `Account Read`, `Zone Read`, `Workers R2 Storage Read`, `Workers R2 Storage Write`, `Account API Tokens Read`, and `Account API Tokens Write`

Cloudflare OAuth scope names match API token permission names. Select the corresponding permissions in the OAuth client; current scope IDs can be fetched from Cloudflare's [`/oauth/scopes` API](https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/methods/list/). See Cloudflare's [OAuth client setup](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) and [R2 token permissions](https://developers.cloudflare.com/r2/api/tokens/) for current scope details. The consent screen shows selected required scopes; the app does not request `offline_access` and never uses a refresh token. For use by Cloudflare users outside the OAuth client's owning account, make the client public after completing Cloudflare's client URL ownership verification. Keep the client ID public; do not create a client secret for this PKCE client.

## Build and publish the installer

The installer is its own Deploy Commander project. Its only configurable build defaults are the service and runner images:

| Variable | Purpose |
| --- | --- |
| `VITE_BACKEND_IMAGE` | Manager service image to install; defaults to `ezenki/cloudflare-manager:latest` |
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

The Go service image contains only `frontend/dist` at `/app/frontend/dist`; it does not contain or publish the installer. The Go service and frontend assets run as UID 65532 on `gcr.io/distroless/static-debian12:nonroot`. Build a local image with `docker build -t cloudflare-manager:local .`. `build.sh` builds and pushes `ezenki/cloudflare-manager:latest` for the default platforms. Set `IMAGE`, `TAG`, or `PLATFORMS` to change the image name, tag, or target platforms.

The installer defaults to `latest` tags for both images. It accepts tagged image references, including `latest`, and SHA-256 digests.

## Install and operate

Open the published installer inside Deploy Commander, create and approve the Commander connection if needed, then click Install. The installer shows setup guidance and the current action state; detailed runs are available in Deploy Commander's separate runs section. The runner configures the service with its approved Commander connection, waits for the `/healthz` health check, and sets the redirect to the healthy service. After a successful install, the installer interface reloads into the manager automatically.

Use an HTTPS custom hostname for the manager. The OAuth callback is derived from the request host, and the protected state cookie carries that redirect through callback. The host-only, `SameSite=Lax` access cookie must be available to the manager frontend. A raw internal HTTP alias works for runner-to-service traffic and is not the public OAuth origin.

After installation, the manager redirects to its bundled frontend. Sign in with Cloudflare, select an account and R2 jurisdiction, then manage buckets and custom CDN domains. Track a bucket to create its Deploy Commander resource. Create an application connection to provision one bucket-scoped S3 credential pair. Secrets are stored only through Deploy Commander secret RPC and are never returned in manager metadata. Revoking a connection revokes its Cloudflare token and deletes its stored secrets.

The **Tear down** control stays available even when Cloudflare sign-in or the manager API is unavailable. It opens a separate `/teardown` page, where the user types `cloudflare` and starts the standard Commander `teardown` run using the saved runner image. The page shows progress in a styled status message. When the runner clears the manager redirect, the teardown route is removed from the URL and the manager interface reloads into the installer. The installer enables another install after teardown succeeds. Teardown preserves Cloudflare buckets and domains. Application access keys may remain active, and manager-created R2 resource records may remain in Deploy Commander. If the manager frontend cannot load or teardown cannot be started, delete the manager through Deploy Commander and publish the installer again to return to the installation flow.

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

OAuth URLs use Cloudflare's production authorization and token endpoints. The Cloudflare client ID and JWT secret are stored in `manager_settings:current`. Browser-to-Go operations use short-lived HS256 JWTs in POST bodies; the JWT secret is read through authorized manager RPC and held in browser memory. Cloudflare access tokens remain in a secure HttpOnly cookie.

## Local development

```sh
cd installer && npm ci && npm test -- --run && npm run build
cd ../frontend && npm ci && npm test -- --run && npm run build
cd ../backend && go test ./... && go vet ./...
```

Override the installer image defaults with `VITE_BACKEND_IMAGE` or `VITE_RUNNER_IMAGE` when building. The backend requires the four manager and secret environment variables shown above.

## Verification gates

Before live use, verify in Deploy Commander staging with disposable Cloudflare resources:

1. Install with the latest manager and supported runner image tags; confirm the run waits for health before redirecting.
2. Complete OAuth in the popup and verify the manager session. Confirm cookies are host-only, Secure, HttpOnly, and expire with the access token.
3. List accounts and buckets; create and delete an empty test bucket; attach and detach a test custom domain.
4. Provision a read-only and read/write application connection; verify the token policy names exactly one bucket; then revoke and confirm the token and both connection secrets are removed.
5. Load the manager frontend, make the Go API unavailable, directly load `/teardown`, and use **Tear down**. Verify the styled status appears, Commander starts the standard teardown run, the runner clears the redirect, and the manager page reloads into the installer.
6. Exercise a teardown failure before redirect clearance and verify the manager stays available with the failure status. Record any application access keys and manager-created R2 resource records that remain after teardown; Cloudflare buckets and domains should remain.
7. If the manager frontend cannot load, delete the manager in Commander and republish the installer, then verify that the installer is available again.

These checks need real Cloudflare and Deploy Commander staging credentials and cannot be established by local unit tests or a container health check alone.
