# Cloudflare Manager Design

Date: 2026-10-15

## Purpose and outcome

Build a Deploy Commander manager for people who administer Cloudflare R2 buckets and grant applications access to one bucket at a time. A user signs in to their own Cloudflare account, selects an account, manages buckets and custom CDN domains, and creates or revokes application S3 credentials. Deploy Commander owns the durable resource and connection records. Cloudflare owns the buckets, domains, and S3 tokens.

The manager has a small Go backend and a React, TypeScript, and Tailwind interface. An initial installer run deploys the backend. A teardown run removes it. No routine Cloudflare or connection operation starts a run.

## Deployment and lifecycle

The interface bundle is published to Deploy Commander with `@ezenki/deploy-commander-installer-interface` and is available before the backend exists. It contains an Install view and the normal management view. The same built assets are served by the Go backend after installation.

The Install view uses the trusted manager RPC caller to start one Docker runner setup run. Its metadata declares a stable `cloudflare-manager` service using a pinned backend image, a health check, the supported network connection, nonsecret OAuth configuration, and a manager redirect to the healthy service. The runner creates the service and sets the redirect only after health succeeds. The installer shows durable run status, events, and logs through manager RPC. It does not create Docker objects itself. Image build and publication are separate from interface publication.

The public manager route, OAuth callback, and Go API must be reachable under the same schemeful site as Deploy Commander. The installer must receive a configured HTTPS public origin and matching Cloudflare OAuth redirect URI. A Deploy Commander redirect or deployment ingress provides this route; the manager does not invent DNS or TLS provisioning. The installer uses a Cloudflare OAuth client configured as a public Authorization Code client with `S256` PKCE and no refresh grant.

Teardown is initiated while the Go service is still available. The user signs in to Cloudflare if needed. The interface revokes every managed application token, removes its connection secrets and connection, and removes this manager's bucket resource records. It leaves the actual Cloudflare buckets and domains in place. Failed external revocation blocks the teardown run and leaves a retriable record. After cleanup, the interface starts one runner `teardown` run. The selected runner image must be verified to clear the manager redirect before deleting the service and its Docker-owned objects; a `DONE` run alone does not prove these effects. Teardown does not use metadata to request redirect removal.

There is no update run in this version. Reinstalling or upgrading the service is outside this flow.

## OAuth and browser security

The embedded interface opens the Go `/auth/start` route in a user-initiated popup because Cloudflare authorization cannot be assumed to work inside an iframe. Go generates a random state and PKCE verifier, stores them in a short-lived `Secure`, `HttpOnly`, `SameSite=Lax`, host-only cookie, and redirects to Cloudflare with an `S256` code challenge. The callback compares state, exchanges the code and verifier at Cloudflare's token endpoint, clears the transient cookie, and sets the access token in a `Secure`, `HttpOnly`, host-only cookie. Its `Expires` and `Max-Age` match the received access-token lifetime. The callback tells the opener only that authorization finished, using a fixed allowed origin; it never sends the token to JavaScript.

Go makes every Cloudflare API request with the current user's cookie token. It has no token database, server session store, refresh-token flow, or background refresh. Missing, expired, or rejected authorization returns `401` and prompts a new OAuth sign-in. The interface does not store Cloudflare tokens in browser storage or Deploy Commander.

The Go API allows credentialed browser requests only from the configured manager/Commander origin when the frontend and API have different origins. State-changing routes require that exact `Origin` and JSON content type, and reject cross-site requests. No wildcard CORS or arbitrary Cloudflare URL proxy is exposed. Cookies are sent only to the Go host. Same-site hosting is a deployment requirement; the UI reports a cookie/session failure if a browser or deployment blocks them in the iframe.

The OAuth client requests `Workers R2 Storage Write`, `Zone Zone Read`, and `Account API Tokens Write`. It does not request `offline_access`. The exact scope identifiers come from Cloudflare's OAuth scope catalog during client registration and are documented in the environment example. The UI distinguishes a missing grant from an expired session.

## Go API and Cloudflare behavior

The Go service uses the standard `net/http` client with bounded timeouts and small request/response types. It offers only the manager operations: session status, account list, account zones, bucket list/detail/create/delete, custom-domain list/attach/detach, and application credential create/revoke. Account IDs, bucket names, jurisdiction, zone IDs, domains, and token IDs are validated before constructing fixed Cloudflare API paths. Account and bucket access is checked through Cloudflare with the current user's token; client-selected IDs are not treated as authority.

The UI displays Cloudflare accounts the user can access, then paginates R2 buckets in the selected account and jurisdiction. It can create a bucket and register an existing bucket. A managed bucket can attach or detach a custom domain in an accessible zone. The UI shows Cloudflare's ownership and TLS status rather than assuming attachment is immediate. Bucket deletion requires an explicit confirmation, revocation of attached application credentials, successful Cloudflare deletion, and then removal of its Deploy Commander resource. The manager never empties a bucket automatically.

Go reports structured, sanitized errors with useful status and operation context. It never logs OAuth tokens, S3 secret values, cookie contents, or upstream response bodies that may contain them. Cloudflare remains the source of truth when a local record is stale; the interface offers reconciliation rather than silently deleting external state.

## Deploy Commander resources and connections

The interface creates one `cloudflare-r2-bucket` resource per account, jurisdiction, and bucket through manager-scoped RPC. Its configuration holds nonsecret account ID, bucket name, jurisdiction, S3 endpoint, and an optional user-selected primary public domain. The resource ID is the Deploy Commander identity; the Cloudflare tuple is the external identity. The interface checks existing owned resources before registering to avoid duplicates. It lists and updates resources through the current manager's RPC context, never by a caller-supplied manager identity. Domain lists and status are read from Cloudflare instead of copied into a second authoritative store.

An application connection belongs to the consuming manager and attaches to the bucket resource. The resource-owning Cloudflare manager creates it with `createConnection`, subject to Deploy Commander's unique manager/resource pair. Its metadata holds only nonsecret account, bucket, jurisdiction, endpoint, permission (`read-only` or `read-write`), and Cloudflare token ID. The application values are stored under the connection's Deploy Commander secrets as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; `AWS_REGION=auto` and the endpoint are nonsecret configuration. A consuming deployment can use the documented runner `[[secret:connection:CONNECTION_UUID:KEY]]` references when its installed runner supports value interpolation. The manager does not place credentials in resource metadata, connection labels, child-interface results, run metadata, or logs.

Provisioning starts by creating a pending connection, then uses the user's OAuth token to create an account-owned Cloudflare API token with a policy restricted to that one R2 bucket and the selected object read or write permission group. Go uses the token ID as the S3 access key ID and the lowercase SHA-256 hex digest of the returned token value as the S3 secret access key, as Cloudflare documents. It returns these credential values once over HTTPS. The interface writes them to Deploy Commander connection secrets, stores the token ID in connection metadata, and marks the connection ready. It clears its temporary JavaScript values after the handoff. A failed handoff triggers best-effort Cloudflare token revocation and connection cleanup; token names contain the connection ID so an interrupted handoff can be located and reconciled. Go permits revocation only for tokens bearing this manager's naming prefix and matching the requested connection ID. Revocation deletes the Cloudflare token first, then the two connection secrets and connection. If Cloudflare deletion fails, the connection remains for retry. The user's OAuth authorization and application S3 credentials are always separate.

The interface supports the resource-connection child actions in the existing guide: `create-connection`, `link-connection`, `unlink-connection`, and `delete-connection`. It validates each resource and connection via authorized RPC. Group labels use the guide's exact keys and preserve unrelated labels. Linking and unlinking only change group membership; deleting a created connection revokes its Cloudflare token. A successful child close returns the connection identity and labels only.

## Components and interfaces

| Unit | Responsibility |
| --- | --- |
| Go OAuth handler | Start and finish PKCE, set and clear cookies, expose session state. |
| Go Cloudflare client | Typed account, R2, domain, zone, and account-token calls with error translation. |
| Go HTTP handlers | Validate browser requests and parameters; call only the typed Cloudflare operations. |
| Frontend RPC adapter | Own one interface wire and typed caller; use trusted manager context and clean up on unmount. |
| Frontend installer view | Start install or teardown runs and show durable run progress. |
| Frontend management views | Account, bucket, domain, and application connection workflows. |
| Frontend connection workflow | Coordinate one-time S3 secret handoff, labels, revocation, and child-interface close. |

The frontend calls Go with credentialed `fetch` and uses the Deploy Commander interface library for all Commander resources, connections, secrets, and runs. Go never calls Deploy Commander directly in this version. The frontend does not call Cloudflare directly.

## Verification and limits

Automated tests cover PKCE state/verifier handling and cookie expiration; origin/CSRF checks; Cloudflare pagination, error and permission responses; bucket/domain requests; exact bucket-scoped token policy and S3 key derivation; revocation order and partial failures; and manager RPC resource/connection/child workflows. Build checks cover Go, frontend, and the install image. An integration check must verify the selected runner image's health-gated redirect and redirect-first teardown behavior. A live staging check with a real Cloudflare OAuth client and Deploy Commander host is required before calling the deployed integration production-ready, especially for the iframe cookie route and child-interface behavior noted in the Commander guide.

The manager does not manage R2 objects, empty buckets, issue temporary S3 sessions, refresh OAuth authorization, or rotate application tokens automatically. Removing the manager does not delete Cloudflare buckets or domains. If Cloudflare access has been lost, external tokens require administrator cleanup before teardown can complete.

## Sources and contracts

- [Manager Interface Guide](../../integrations/MANAGER_INTERFACE_GUIDE.md): RPC, resource and connection ownership, secrets, publication, and child interfaces.
- [Resource Connection Manager Guide](../../integrations/RESOURCE_CONNECTION_MANAGER_GUIDE.md): group connection actions, labels, and child results.
- [Commander Manager Integration Guide](../../integrations/COMMANDER_MANAGER_INTEGRATION_GUIDE.md): installer approval and backend deployment, redirect and teardown expectations.
- [Deployment Runner Implementation Guide](../../integrations/DEPLOYMENT_RUNNER_IMPLEMENTATION_GUIDE.md): Docker service metadata, health checks, secret references, and full teardown.
- [Cloudflare OAuth client setup](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) and [endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/).
- [Cloudflare R2 API](https://developers.cloudflare.com/api/resources/r2/), [R2 S3 credential derivation](https://developers.cloudflare.com/r2/api/tokens/), and [account token API](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/).
