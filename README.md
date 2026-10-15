# Cloudflare Manager for Deploy Commander

A Deploy Commander manager for Cloudflare R2. The Go service owns Cloudflare OAuth and proxies Cloudflare API requests. The published React/Tailwind interface uses Deploy Commander manager-scoped RPC for durable bucket resources, application connections, secrets, and install-run history.

Cloudflare user authorization lives in a short-lived `Secure`, `HttpOnly` cookie. It is not stored in Deploy Commander, refreshed, or persisted by this service. Application S3 credentials are separate account-owned Cloudflare tokens scoped to one bucket; their access key and secret are stored in the requesting application's Deploy Commander connection secrets.

## Requirements

- Go 1.25 or Docker for the backend image
- Node.js 22.12+ and npm for the interface
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

## Build and publish the manager interface

The published interface must be able to reach the Go service over HTTPS. Set the Vite variables in the build environment or a local ignored `frontend/.env` file. `VITE_BACKEND_ORIGIN` is the manager's public API origin; `VITE_COMMANDER_ORIGIN` is the exact origin serving Deploy Commander. These must be subdomains on the same registrable site. The Go API allows only the configured Commander origin.

```sh
cd frontend
npm ci
npm test -- --run
npm run build
npm run publish:manager
```

For publishing, put `COMMANDER_URL`, `COMMANDER_USERNAME`, and `COMMANDER_PASSWORD` in a local ignored `.env` beside `frontend/deploy-commander.json`, or export those variables. Publishing uploads only the built `frontend/dist` directory. It does not publish source files or local environment files.

### Build the service image

The final stage uses `gcr.io/distroless/static-debian12:nonroot`; the statically built Go service and frontend assets run on the minimal distroless base as UID 65532. Build and push the service image to a registry reachable by the Deploy Commander runner. Set image and origin defaults at build time so the installation form is prefilled:

```sh
docker build \
  --build-arg VITE_BACKEND_ORIGIN=https://cloudflare-manager.example.com \
  --build-arg VITE_BACKEND_IMAGE=ghcr.io/your-org/cloudflare-manager:1.0.0 \
  --build-arg VITE_RUNNER_IMAGE=ezenki/deploy-commander-runner:REPLACE_WITH_SUPPORTED_VERSION \
  --build-arg VITE_CF_CLIENT_ID=replace-with-cloudflare-oauth-client-id \
  --build-arg VITE_PUBLIC_ORIGIN=https://cloudflare-manager.example.com \
  --build-arg VITE_COMMANDER_ORIGIN=https://commander.example.com \
  -t ghcr.io/your-org/cloudflare-manager:1.0.0 .
docker push ghcr.io/your-org/cloudflare-manager:1.0.0
```

Use an immutable version tag or SHA-256 digest for both the manager and runner images. Check the current supported runner image and digest in the Deploy Commander staging environment before production use. The browser install form validates tagged or digested images.

## Install and operate

Open the published Cloudflare Manager inside Deploy Commander. The first screen starts the one-time installation run. Confirm the manager image, supported runner image, OAuth client ID, manager public origin, and exact Commander origin, then start installation. The runner configures the service on the manager network, waits for the `/healthz` health check, and sets the redirect to the healthy service.

Use an HTTPS custom hostname for the service's public origin. It and the Commander UI must be same-site so the host-only, `SameSite=Lax` OAuth cookie is available in the embedded UI. The manager must be routed only through that TLS origin. A raw internal HTTP alias works for runner-to-service traffic and is not the OAuth public origin. If a browser blocks embedded cookies anyway, the interface explains the restriction and supports completing sign-in from a top-level tab.

After installation, sign in with Cloudflare, select an account and R2 jurisdiction, then manage buckets and custom CDN domains. Track a bucket to create its Deploy Commander resource. Create an application connection to provision one bucket-scoped S3 credential pair. Secrets are stored only through Deploy Commander secret RPC and are never returned in manager metadata. Revoking a connection revokes its Cloudflare token and deletes its stored secrets. Teardown revokes manager-owned application tokens and removes the manager's bucket resource records before starting one `teardown` run; it preserves Cloudflare buckets and domains.

Installation and teardown are the only run actions. Bucket, domain, and credential operations call the Go service directly and use Deploy Commander RPC for resource/connection records and secrets.

## Configuration

The service receives these environment variables from the install run:

| Variable | Purpose |
| --- | --- |
| `CF_CLIENT_ID` | Cloudflare OAuth client ID |
| `PUBLIC_ORIGIN` | HTTPS origin for the manager and OAuth callback |
| `COMMANDER_ORIGIN` | Exact HTTPS Deploy Commander browser origin allowed by CORS |
| `PORT` | HTTP listen port; default `8080` |
| `STATIC_DIR` | Published interface assets inside the image; default `/app/frontend/dist` |

OAuth URLs use Cloudflare's production authorization and token endpoints. The API uses Cloudflare's API endpoint. No OAuth token database, secret key, refresh job, or token refresh endpoint is required.

## Local development

```sh
cd backend && go test ./... && go vet ./...
cd ../frontend && npm ci && npm test -- --run && npm run build
```

For the UI, Vite proxies no APIs; set `VITE_BACKEND_ORIGIN` to a running HTTPS Go service with the matching `COMMANDER_ORIGIN`. For the backend, set `CF_CLIENT_ID`, `PUBLIC_ORIGIN`, and `COMMANDER_ORIGIN` before running `go run ./cmd/cloudflare-manager`.

## Verification gates

Before live use, verify in Deploy Commander staging with disposable Cloudflare resources:

1. Install with pinned manager and supported runner images; confirm the run waits for health before redirecting.
2. Complete OAuth in the popup and verify the embedded same-site session. Confirm cookies are host-only, Secure, HttpOnly, and expire with the access token.
3. List accounts and buckets; create and delete an empty test bucket; attach and detach a test custom domain.
4. Provision a read-only and read/write application connection; verify the token policy names exactly one bucket; then revoke and confirm the token and both connection secrets are removed.
5. Teardown and verify the Commander redirect clears before service resources are removed, while Cloudflare buckets and domains remain.

These checks need real Cloudflare and Deploy Commander staging credentials and cannot be established by local unit tests or a container health check alone.
