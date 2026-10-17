# Commander manager integration guide

This is the complete, portable contract for integrating a manager with Single
Commander. It covers browser approval, credential handoff, the authenticated
manager API, installer runs, deployment networking, and manager redirects.
The Commander manager UUID, Commander resource UUID, requesting-manager UUID,
and run UUID are different values; keep those distinctions throughout.

## Lifecycle at a glance

1. Commander registers an agent and ensures its reserved `commander` manager
   and `commander` resource exist.
2. A requesting manager embeds the Commander manager interface with an
   action-based `startInterface` request.
3. A human approves. Commander creates a manager user and a connection to the
   Commander resource, then returns the connection snapshot to the parent.
4. The requesting manager securely delivers the resulting password to its
   backend, starts an installer run with Basic credentials, and supplies
   installer inputs in run metadata.
5. The installer uses its run token and `AGENT_ENDPOINT` to deploy a durable
   service, verifies health, and patches the requesting manager's redirect.
6. For teardown, clear the redirect before removing the service.

The guide intentionally does not define manager APIs for
`getCallingManager`, `getMetadata`, or `getManagerToken`. Those are browser
interface-context/token operations, not backend integration routes. It also
does not advertise browser-side run event or run log APIs; manager backends
should use the authenticated run-history endpoints documented below.

## Prerequisites and terminology

The agent must be registered, its schema and initial administrator must be
ready, and Commander initialization must have completed. The requesting
manager and its interface must already exist and run inside Commander's
`InterfaceHost`. Both interfaces need compatible versions of
`@ezenkico/deploy-commander-installer-interface` (the durable run contract is
version `^0.5.0`). A browser user needs an authenticated Commander
session.

There is a current launch limitation: the parent-to-child host path is not
fully operational in every deployment. The host currently rejects `iface.init`,
may fail to pass the parent manager as `callingManager`, requires host-owned
`from`/`to` fields on `iface.close`, and can remove child state before the close
response is forwarded. Test and repair those host behaviors before promising
this workflow as production-ready.

The Commander **manager UUID** is the value passed to `startInterface`. Do not
substitute the Commander **resource UUID**. The resource represents how to
reach Commander; the manager owns the interface and receives the redirect.

## Commander bootstrap

```yaml
bootstrap:
  description: "The commander's job"
  redirect: http://localhost:6080
  platform_connection:
    network: manager
  manager_api:
    host: commander
    port: 6080
    tls: false
```

`manager_api` is optional. Its exact defaults are `host: commander`, `port:
6080`, and `tls: false`; an omitted individual field receives its default.
Initialization is ensure-if-missing: it creates a reserved manager named and
typed `commander`, a resource named and typed `commander`, the ownership edge,
and the current-agent association. Raw `platform_connection` is stored in
`resource.config.platform_connection`; it is not the `{type,data}` wrapper
used by a resolved resource connection. Normalized API metadata is stored at
`resource.config.metadata.manager_api`.

For an existing resource, initialization does not reconcile name, owner,
agent, platform connection, or redirect. It backfills `manager_api` only when
that key is absent, preserves an existing value including `null`, and fails
closed if top-level metadata is not an object. Changes to bootstrap values do
not update existing records. Correcting an existing Commander resource
currently requires controlled deletion and reinitialization; deletion also
removes its connections. The manager redirect can be updated through the
authenticated manager update path.

## Browser approval

Install the interface library:

```bash
npm install @ezenkico/deploy-commander-installer-interface@^0.5.0
```

Create one stable wire per mounted application, use the library's caller, and
start the child with the `create-connection` action:

```ts
import {
  createWire,
  RPC,
} from "@ezenkico/deploy-commander-installer-interface";
import type {
  InterfaceResponse,
  RPCCall,
  RPCResponse,
} from "@ezenkico/deploy-commander-installer-interface";

async function handleIncomingCall(call: RPCCall): Promise<RPCResponse> {
  return {
    ok: false,
    error: { message: `Unsupported request: ${call.request}` },
  };
}
const wire = createWire(handleIncomingCall, () => {});
const caller = RPC.SetupRPCCaller(wire);

export async function requestCommanderConnection(
  commanderManagerId: string,
): Promise<InterfaceResponse> {
  if (!commanderManagerId.trim())
    throw new Error("Commander manager ID is required");
  const child = await wire.startInterface({
    manager: commanderManagerId,
    metadata: {
      action: "create-connection",
      labels: { environment: "production" },
    },
  });
  const response = await child.close;
  if (!response.ok) {
    const error = new Error(
      response.error?.message ?? "Connection was not approved",
    );
    Object.assign(error, {
      status: response.error?.status,
      details: response.error?.details,
    });
    throw error;
  }
  return response;
}
// Call wire.end() when the application is destroyed.
```

Use one stable wire for the application's lifetime. `child.close` completes
the child workflow; `wire.end()` only removes the local listener and does not
close an active child. The request may optionally configure the connection and
manager password:

```ts
metadata: {
  action: "create-connection",
  labels: { environment: "production" },
  metadata: {
    createUser: { password: managerOwnedSecret },
  },
}
```

If `metadata.createUser.password` is omitted, Commander creates a generated
password and the approving user may edit it before approval. If the manager
supplies a password, it is used for both the manager user and connection and
the user only approves or denies it; the password is never rendered in the
approval UI. A manager-supplied password is a credential, so send it only over
a secure interface transport. Apart from this explicit field, do not put
credentials, tokens, or other secrets in metadata. Handle structured RPC
failures (`message`, optional `status`, and optional `details`) rather than
assuming every failure is an `Error`.

The manager frontend reads approval metadata and trusted calling-manager
context, finds and validates the Commander resource, checks for an existing
connection, then uses the manager-supplied password or generates an editable
random password. On approval it creates a connection without the password in
its metadata, stores the password on that connection as the
`COMMANDER_PASSWORD` secret, creates the manager login credential, and closes
the child. If secret or login creation fails, it attempts to delete the new
connection, which also removes its connection secrets. Denial is `403`;
duplicate manager/resource connections are `409`; malformed resource data is
rejected before credential creation (typically `422`). Backend authorization
remains authoritative. This flow applies to new connections; it does not
migrate credentials from existing connection metadata.

### Approval result and secure handoff

```ts
type InterfaceResponse = {
  manager: string;
  ok: boolean;
  result?: unknown;
  error?: { message: string; status?: number; details?: unknown };
};
type ConnectionResult = {
  connection: {
    id: string;
    manager: string;
    resource: string;
    external: boolean;
    created_at: string;
    updated_at: string;
  };
  config: { id: string; manager: string; resource: string; metadata: unknown };
};
```

The username is the requesting manager UUID. The resolved password is stored
as the connection secret `COMMANDER_PASSWORD`; it is not included in the
connection metadata or the approval result. Commander stores a bcrypt hash
for Basic authentication. An authorized active runner can retrieve the
connection secret with
`GET /v1/secrets/connection/<connection-id>/value?key=COMMANDER_PASSWORD`.
The manager recorded on the connection can read its secret when the run
belongs to that manager. Use `result.connection.manager` and `.resource` for
ownership; the top-level close `manager` identifies the resource context.

The approval bridge passes this flat metadata object to connection creation.
The resolved `selectedPassword` is the manager-supplied password or the value
the approving user edited. The fifth argument is the manager-supplied labels
object; labels are stored as connection labels, not under `config.metadata`:

```ts
await caller.createConnection(
  {
    username: callingManagerId,
    password: selectedPassword,
    platform_connection: { type: "Platform", data: { network: "manager" } },
    manager_api: { host: "commander", port: 6080, tls: false },
  },
  callingManagerId,
  false,
  commanderResourceId,
  labels,
);
```

Unlike the create result above, a later single-connection read includes the
attached resource's current connection descriptors under `config`:

```ts
type GetConnectionResult = {
  connection: ConnectionResult["connection"];
  config: ConnectionResult["config"] & {
    platform_connection?: unknown;
    public_connection?: { address: string; port: number };
  };
};

const saved: GetConnectionResult = await caller.getConnection(connectionId);
```

Each descriptor is omitted independently when absent. No resource object or
resource metadata is included, and these values are not copied into connection
metadata. Create, update, list, and delete responses do not gain these fields.

## Manager API address and authentication

### Browser access and CORS

The manager server uses `DOMAIN` as the trusted base hostname for browser
requests. The base hostname and true dot-delimited subdomains are allowed;
ports are ignored when matching. For example, `example.com` allows
`https://example.com` and `https://app.example.com`, but not
`https://notexample.com` or `https://example.com.attacker.test`.

For an allowed origin, the server echoes the exact request origin in
`Access-Control-Allow-Origin`, permits credentials and the `Authorization`
header, and grants every manager API path and HTTP method. An allowed
`OPTIONS` preflight returns `204 No Content` before manager authentication or
readiness checks and includes the requested method and headers. CORS permission
does not replace manager Basic/Bearer authentication on functional routes.

Build the cross-manager URL from approved `metadata.manager_api`, not a browser
`DOMAIN` or localhost:

```text
scheme = manager_api.tls ? "https" : "http"
host = IPv6 literal ? "[" + host + "]" : host
origin = scheme + "://" + host + ":" + manager_api.port
api_base = origin + "/api/v1"
```

```sh
MANAGER_API=http://commander:6080/api/v1
MANAGER_ID=<requesting-manager-uuid>
MANAGER_PASSWORD=<resolved-password>
curl --fail-with-body --user "$MANAGER_ID:$MANAGER_PASSWORD" \
  "$MANAGER_API/manager" -H 'Accept: application/json'
```

Use Basic over trusted TLS for unattended backends. The API also accepts an
HS256 bearer containing `manager_id`; Basic does not exchange for a token.
`POST /auth/inspect` validates a supplied bearer but does not mint or refresh
one. Functional routes are readiness-gated and fail closed while the agent is
unavailable. Invalid input is `400`, inaccessible scoped records `404`,
conflicts `409`, and successful connection deletion `204`; authentication is
`401` with the existing Basic/Bearer challenge. Errors use the normal
structured Huma envelope; redact secrets before retaining bodies.

## Complete cross-manager API

All paths are under `/api/v1`. Every route except token inspection requires
manager authentication and readiness. The current manager always comes from
credentials; no path, query, or body field selects it.

| Method | Path                          | Purpose                                                                 |
| ------ | ----------------------------- | ----------------------------------------------------------------------- |
| POST   | `/auth/inspect`               | Validate bearer token in the body; no auth header required.             |
| GET    | `/manager`                    | Return authenticated manager.                                           |
| GET    | `/managers/with-users`        | Commander-manager-only list.                                            |
| POST   | `/managers/users`             | Commander-manager-only credential creation.                             |
| POST   | `/runs`                       | Start run for authenticated manager.                                    |
| GET    | `/runs`                       | List that manager’s runs.                                               |
| GET    | `/runs/{runID}`               | Get that manager’s run.                                                 |
| GET    | `/resources`                  | Global summary list (`manager`, `type`, `external`, `limit`, `offset`). |
| GET    | `/resources/mine`             | Owned summary list (`type`, `external`, `limit`, `offset`).             |
| GET    | `/resources/{resourceID}`     | Full owned resource detail.                                             |
| POST   | `/resources`                  | Create resource owned by caller.                                        |
| GET    | `/connections`                | Visible list (`manager`, `resource`, `limit`, `offset`).                |
| GET    | `/connections/{connectionID}` | Visible connection detail.                                              |
| POST   | `/connections`                | Create connection to owned resource.                                    |
| PATCH  | `/connections/{connectionID}` | Replace metadata as resource owner.                                     |
| DELETE | `/connections/{connectionID}` | Delete as resource owner.                                               |
| POST   | `/database/query`             | Query caller’s database.                                                |
| GET    | `/files`                      | List or search the caller’s API-file catalog.                           |
| POST   | `/files/{path}`               | Stream-create a caller-owned API file.                                  |
| GET    | `/files/{path}`               | Stream caller-owned API-file content.                                   |
| PUT    | `/files/{path}`               | Stream-replace caller-owned API-file content.                           |
| PATCH  | `/files/{path}`               | Update a caller-owned API file’s path, content type, or labels.         |
| DELETE | `/files/{path}`               | Delete a caller-owned API file.                                         |
| POST   | `/file-query-tokens`          | Issue a temporary download token for one caller-owned API file.         |

There are deliberately no routes for `getCallingManager`, `getMetadata`,
`getManagerToken`, run events, or run logs.

### Platform credentials

Platform credentials belong to the platform in the agent, not to a manager.
The agent stores them in each platform's database. Commander never reads a
credential back and does not include credentials in run configuration or
runner environment variables.

Operators can add or remove credential batches through the human-session API:

```http
POST /api/v1/platforms/credentials/upsert
POST /api/v1/platforms/credentials/remove
Cookie: auth=<operator-session>
Content-Type: application/json
```

The embedded manager interface uses the human session and its trusted manager
scope:

```http
POST /api/v1/managers/{managerID}/platforms/credentials/upsert
POST /api/v1/managers/{managerID}/platforms/credentials/remove
Cookie: auth=<operator-session>
Content-Type: application/json
```

The requesting manager can also call the cross-manager API with its existing
Basic or Bearer authentication. Those routes derive the manager identity only
from authentication:

```http
POST /api/v1/platforms/credentials/upsert
POST /api/v1/platforms/credentials/remove
Authorization: Basic <manager-uuid:password>
Content-Type: application/json
```

Every body contains an ordered `items` array. Upsert entries contain a platform
and credential; removal entries contain a platform and selector.

#### Docker credential setup

Use `platform: "docker"` for Docker Hub and every other Docker registry. Give
Docker Hub its own credential and identify other registries by host or by host
plus repository prefix. For basic authentication, nest the username and
password (or registry token used as a password) inside `auth`:

```json
{
  "items": [
    {
      "platform": "docker",
      "credential": {
        "kind": "docker_hub",
        "auth": { "kind": "basic", "username": "robot", "password": "<secret>" }
      }
    },
    {
      "platform": "docker",
      "credential": {
        "kind": "prefix",
        "prefix": "ghcr.io/team",
        "auth": {
          "kind": "basic",
          "username": "robot",
          "password": "<registry-token>"
        }
      }
    }
  ]
}
```

For a Docker identity token, use
`"auth":{"kind":"identity_token","token":"<docker-identity-token>"}`
instead. Upserting the same Docker Hub scope or normalized prefix replaces its
credential. Remove either scope with its selector:

```json
{
  "items": [
    { "platform": "docker", "selector": { "kind": "docker_hub" } },
    {
      "platform": "docker",
      "selector": { "kind": "prefix", "prefix": "ghcr.io/team" }
    }
  ]
}
```

Images without an explicit registry host, such as `alpine:latest` and
`library/alpine:latest`, use the Docker Hub credential. Images with a host,
including `docker.io/library/alpine:latest`, use the longest matching prefix
credential; they do not fall back to the Docker Hub credential. A host-only
prefix such as `ghcr.io` covers all repositories there. A path prefix such as
`ghcr.io/team` matches `ghcr.io/team/app` but not `ghcr.io/team2/app`.
Prefixes must omit URL schemes and trailing slashes.

A batch contains 1 to 100 items and is limited to 1 MiB. A successful HTTP
response reports each original item index in order. `status` is `ok` or
`error`; an error includes a safe code such as `invalid_entry`,
`unknown_platform`, `operation_failed`, or `forbidden`. Valid items continue
after an invalid or denied item. Managers need a separate add or remove grant
for each exact, case-sensitive platform name. The Commander operator assigns
those grants when creating a manager or replaces them with
`PUT /api/v1/managers/{id}/permissions`; an empty permissions object revokes
all grants. Manager grants are checked against the current manager record on
each request. An omitted permission on manager creation means no grants.

Credential values and selectors are never included in responses. Keep them out
of URLs, logs, and publish configuration files.

Commander connection approval stores the requesting manager's Basic password
as the `COMMANDER_PASSWORD` secret owned by the new connection. Only an
authorized active runner can retrieve the value:

```http
GET /v1/secrets/connection/<connection-uuid>/value?key=COMMANDER_PASSWORD
Authorization: Bearer <active-run-token>
```

### Manager, runs, resources, and connections

```http
GET /api/v1/manager
Authorization: Basic <base64(manager-uuid:password)>
```

Response: `{"id":"<uuid>","name":"my-manager","kind":"deployment",
"description":null,"redirect":null,"repo":null,"version":null}`.

Start a run with `POST /runs` and body:

```json
{
  "runner": "registry.example/installer:1.2.3",
  "platform": "docker",
  "platform_data": { "network": "manager" },
  "action": "deploy",
  "metadata": { "requested_by": "release-page" },
  "config": { "image": "registry.example/manager:1.2.3" },
  "secrets": { "REGISTRY_TOKEN": "<initial-secret-value>" },
  "target": { "kind": "resource", "id": "<resource-uuid>" },
  "note": "Install manager service",
  "labels": { "environment": "production" }
}
```

Run configuration fields have separate owners and purposes:

| Field            | Purpose                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `manager`, `run` | Trusted Commander-assigned manager and run UUIDs.                                                              |
| `runner`         | Runner image or executable selected for the action.                                                            |
| `platform`       | Optional execution platform, such as `docker`.                                                                 |
| `platform_data`  | Optional platform-specific action input, such as network or runtime settings.                                  |
| `action`         | Action the runner should execute.                                                                              |
| `metadata`       | Flexible input for the runner action.                                                                          |
| `config`         | Optional raw JSON input owned by the manager; Commander and the agent forward it without interpreting it.      |
| `target`         | Optional structured association to a durable object operated on by the run.                                    |
| `secrets`        | Optional string map stored as secret records for this exact run; values are not included in run configuration. |

`note` and `labels` belong to the run record, not its runner configuration.
Omit `config` (or send `null`) when the manager has no config. When supplied,
the runner still receives the complete configuration, including manager config.

Omit `user_id` for a manager-initiated run. Success is
`{"id":"<run-uuid>","status":0,"queued_at":"<RFC3339>"}`. Statuses are
0 queued, 1 running, 2 done, 3 failed; one queued/running run per manager is
allowed. `GET /runs` accepts `user_id`, `statuses`, `not_statuses`, `sort`,
`limit`, and `offset`; sort is `created_at`, `-created_at`, `updated_at`, or
`-updated_at` (default created descending), limit defaults 50 and caps at 200.
Its envelope is `{"items":[<run-item>],"limit":50,"offset":0,"total":1}`;
`GET /runs/{runID}` is `{"run":<run-item>,"config":<configuration|null>}`.

Resource list envelopes are `{"items":[<summary>],"limit":<n>,"offset":<n>,"total":<n>}`.
Summaries contain `id,name,type,external,agent,manager,created_at,updated_at`.
General `/resources` is global and summary-only; `/resources/mine` is owned.
Detail is `{"resource":<summary>,"config":<full-resource>}`. Create:

```http
GET /api/v1/resources/mine?type=commander&limit=1&offset=0
Authorization: Basic <credentials>
```

This returns only resources owned by the manager selected by those
credentials, with the standard list envelope.

```http
POST /api/v1/resources
Authorization: Basic <credentials>
Content-Type: application/json

{"name":"production","type":"platform","external":false,"config":{"platform_connection":{"network":"manager"},"metadata":{}}}
```

The caller ID is not authoritative in the body; a compatibility `config.manager`
is overwritten from credentials. Flexible resource JSON is preserved.

Connection visibility is connection-owner or connected-resource-owner.
Filters refine visibility, never caller identity. Detail is
`{"connection":<summary>,"config":<connection>}`. Create:

```http
POST /api/v1/connections
Authorization: Basic <resource-owner-credentials>
Content-Type: application/json

{"connect_manager_id":"<beneficiary-manager-uuid>","resource_id":"<owned-resource-uuid>","external":false,"config":{"purpose":"integration"},"labels":{"environment":"production"}}
```

`connect_manager_id` is the distinct beneficiary; the authenticated caller is
the resource owner. This existing action is the manager-callable connection
creation action; no additional endpoint is required. PATCH accepts
`{"metadata":<any JSON value>}` and replaces metadata. DELETE returns `204`.
The service validates ownership and unique `(manager, resource)`.

### Manager interface secrets

Embedded manager interfaces use the typed installer calls. The current manager
ID is bound by Commander and is not supplied by the interface:

```ts
const keys = await caller.getSecretKeys("connection", connectionId);
await caller.setSecret("resource", resourceId, "REGISTRY_TOKEN", "<value>");
await caller.deleteSecret("resource", resourceId, "REGISTRY_TOKEN");
```

These methods send the host RPC requests `getSecretKeys`, `setSecret`, and
`deleteSecret`. For example, the key-list request is:

```ts
{
  request: "getSecretKeys",
  payload: { kind: "connection", owner_id: connectionId },
}
```

Set uses `{ kind, owner_id, key, value }`; delete uses
`{ kind, owner_id, key }`. The library sends no manager ID.

The matching host routes are:

```text
GET    /api/v1/managers/{managerID}/secrets/{kind}/{ownerID}/keys
PUT    /api/v1/managers/{managerID}/secrets/{kind}/{ownerID}  {"key":"NAME","value":"..."}
DELETE /api/v1/managers/{managerID}/secrets/{kind}/{ownerID}?key=NAME
```

Key lists contain `key`, `created_at`, and `updated_at`; no manager RPC returns
a saved value. The manager ID recorded on a connection may list its keys. The
manager that owns the connected resource may also list keys and may set or
delete them. Backend checks are
authoritative. Initial secrets may also be supplied as `secrets` in a run
request; the runner obtains those values through its active-run API rather than
from `/run/config.json`. Never log submitted values or return them in RPC
errors.

### Manager API files

Manager API files are a separate, agent-owned catalog for a manager backend.
The authenticated manager is always selected from Basic or Bearer credentials:
there is no `manager_id` request selector, and a manager cannot name or access
another manager’s files. A path is a relative slash-separated name. It is
canonicalized before use, cannot escape its manager root (including through
encoded traversal), and the response `name` is derived from its final path
segment.

Each upload `Label` header contains exactly one `key=value` pair. Repeat the
header for more labels; duplicate keys fail, even if their values match. Labels
headers are allowed only on `POST` create requests; use PATCH JSON to change
labels later. List/search uses repeated `label=key=value` query values and
accepts `label_match=all|any`; `name` filters by file name, while `limit`
(maximum 200) and `offset` paginate the normal
`{"items": [...], "limit": 50, "offset": 0, "total": 1}` envelope. A file
metadata response has `path`, derived `name`, `labels`, `content_type`, `size`,
`created_at`, and `updated_at`.

```sh
# List only API files named like "app" with both labels.
curl --fail-with-body --user "$MANAGER_ID:$MANAGER_PASSWORD" \
  "$MANAGER_API/files?name=app&label=tier%3Dweb&label=environment%3Dproduction&label_match=all&limit=50&offset=0"

# Stream-create bytes. Use one Label header per key=value pair.
curl --fail-with-body --user "$MANAGER_ID:$MANAGER_PASSWORD" \
  -X POST -H 'Content-Type: text/javascript' \
  -H 'Label: tier=web' -H 'Label: environment=production' \
  --data-binary @dist/app.js \
  "$MANAGER_API/files/assets/app.js"
```

The create result is `{"file": { ...metadata... }}` with `201 Created`.
`GET` streams the stored bytes and preserves the file content headers; use
normal manager authentication when reading from a backend:

```sh
curl --fail-with-body --user "$MANAGER_ID:$MANAGER_PASSWORD" \
  -o app.js "$MANAGER_API/files/assets/app.js"
```

`PUT` replaces bytes without changing labels. It changes the content type only
when `Content-Type` supplies a specific non-`application/octet-stream` value;
an absent or `application/octet-stream` header preserves the existing content
type. `PATCH` takes JSON and may rename (`path`), replace the content type
(`content_type`), or change labels. Its `labels` member supports `add`,
`remove`, and `replace`; the three forms below are separate valid requests.

```sh
curl --fail-with-body --user "$MANAGER_ID:$MANAGER_PASSWORD" \
  -X PUT -H 'Content-Type: text/javascript' --data-binary @dist/app.js \
  "$MANAGER_API/files/assets/app.js"

curl --fail-with-body --user "$MANAGER_ID:$MANAGER_PASSWORD" \
  -X PATCH -H 'Content-Type: application/json' \
  --data '{"labels":{"add":{"cache":"immutable"}}}' \
  "$MANAGER_API/files/assets/app.js"

curl --fail-with-body --user "$MANAGER_ID:$MANAGER_PASSWORD" \
  -X PATCH -H 'Content-Type: application/json' \
  --data '{"labels":{"remove":["environment"]}}' \
  "$MANAGER_API/files/assets/app.js"

curl --fail-with-body --user "$MANAGER_ID:$MANAGER_PASSWORD" \
  -X PATCH -H 'Content-Type: application/json' \
  --data '{"labels":{"replace":{"tier":"web","cache":"immutable"}}}' \
  "$MANAGER_API/files/assets/app.js"

curl --fail-with-body --user "$MANAGER_ID:$MANAGER_PASSWORD" \
  -X DELETE "$MANAGER_API/files/assets/app.js"
```

Successful `PUT` and `PATCH` return `200` with the same metadata envelope;
successful deletion returns `204`. File paths, malformed label values, empty
patches, and invalid pagination return `400`; a missing caller-owned file is
`404`, conflicting create/rename is `409`, and an exceeded upload limit is
`413`.

When a non-reserved manager is successfully deleted, Commander first commits
the dependent-record deletion transaction and then directs the agent to remove
that manager's API-file metadata database
`commander/manager-files.<manager-uuid>` and
`<agent-data-root>/manager-files/<manager-uuid>/` root. If this post-transaction
catalog cleanup fails, Commander reports a partial cleanup failure; the
already-committed dependent-record deletion is not rolled back.

Issue a download token after the file exists. The result contains `token`,
`expires_at`, and a relative `download_url` such as
`/api/v1/files/assets/app.js?token=...`.

```sh
DOWNLOAD_URL=$(curl --fail-with-body --user "$MANAGER_ID:$MANAGER_PASSWORD" \
  -X POST -H 'Content-Type: application/json' \
  --data '{"path":"assets/app.js"}' "$MANAGER_API/file-query-tokens" | jq -r '.download_url')

# The token query mode is the authorization: do not send Authorization.
curl --fail-with-body -o app.js "$MANAGER_API$DOWNLOAD_URL"
```

A query-token URL is a temporary bearer credential for exactly that manager,
path, and current file generation; it expires at the returned `expires_at` and
is invalidated when access generation changes. It needs no `Authorization`
header, must not be logged or shared, and should be sent with a no-referrer
policy. When rendering a returned URL, use it as an escaped URL attribute—not
by concatenating the raw token into HTML:

```html
<a id="download-file" download>Download</a>
<script type="module">
  const result = await issueFileQueryToken(); // { download_url, expires_at, ... }
  document
    .querySelector("#download-file")
    .setAttribute("href", encodeURI(result.download_url));
</script>
```

`MANAGER_FILES_QUERY_TOKEN_TTL` is a positive Go duration and defaults to
`48h`. Configure the optional upload ceiling as
`manager-files.upload-max-bytes` in Commander YAML; a non-empty
`MANAGER_FILES_UPLOAD_MAX_BYTES` environment value wins. An absent or zero
limit is unlimited. Invalid negative upload limits and malformed/non-positive
token TTL values fail startup.

### Database, inspection, and administration

```http
POST /api/v1/database/query
Authorization: Basic <credentials>
Content-Type: application/json

{"query":"RETURN $value","bindings":{"value":"example"}}
```

`query` is non-empty; `bindings`, when supplied, is an object. Unknown fields,
trailing JSON, and invalid input are rejected. Values remain bound. Response:
`{"results":[{"statement":0,"result":...}]}`.

```http
POST /api/v1/auth/inspect
Content-Type: application/json

{"token":"<manager-bearer-token>"}
```

The response contains `manager_id`, `username`, and optional `email`, `role`,
`subject`, `issued_at`, and `expires_at`. `GET /managers/with-users?limit=50&offset=0`
and `POST /managers/users` with `{"manager_id":"<uuid>","password":"..."}`
require the reserved manager whose name and kind are `commander`; ordinary
managers receive `403`. The administration response shapes are:

```json
{
  "total": 1,
  "managers": [
    {
      "id": "<manager-uuid>",
      "name": "my-manager",
      "kind": "deployment",
      "description": null,
      "redirect": null,
      "repo": null,
      "version": null,
      "has_user": true
    }
  ]
}
```

```http
POST /api/v1/managers/users
Authorization: Bearer <commander-manager-token>
Content-Type: application/json

{"manager_id":"<manager-uuid>","password":"<password>"}
```

The successful response is exactly:

```json
{ "id": "<manager-user-uuid>", "manager_id": "<manager-uuid>" }
```

## Installer run environment and agent API

For a complete from-scratch runner implementation, see the [standalone runner integration guide](../../../agent/RUNNER_INTEGRATION_GUIDE.md). That guide is authoritative for the runner image and runtime contract; this Commander guide remains authoritative for the manager approval workflow.

Docker runs receive `/run/config.json` (the complete run configuration,
including optional manager-owned `config`), persistent `/run/data`,
`AGENT_ENDPOINT`, an HS256 `TOKEN`, the Docker socket, and a manager-named
primary network. The token expires after one day and also requires the run to
remain active; after exit calls normally return `404 Run not found`.

All paths below are under `/v1` and require `Authorization: Bearer $TOKEN`:

| Method | Path                                       | Purpose                                                |
| ------ | ------------------------------------------ | ------------------------------------------------------ |
| POST   | `/events`                                  | Append event (`{"event":"phase","message":"..."}`).    |
| POST   | `/status`                                  | Set status (`{"status":1,"message":"..."}`).           |
| GET    | `/resources`                               | List UUIDs (`resource_type`, `limit`, `offset`).       |
| GET    | `/resources/{resourceID}`                  | Resolve resource and usable connection.                |
| POST   | `/resources`                               | Create run-manager resource.                           |
| DELETE | `/resources/{resourceID}`                  | Delete owned resource.                                 |
| DELETE | `/resources/name/{name}`                   | Delete owned resource by name.                         |
| GET    | `/connections`                             | List UUIDs (`manager`, `resource`, `limit`, `offset`). |
| GET    | `/connections/{resourceID}/{connectionID}` | Resolve connection metadata.                           |
| POST   | `/connections`                             | Create connection.                                     |
| DELETE | `/connections/{resourceID}/{connectionID}` | Delete connection.                                     |
| PATCH  | `/manager/redirect`                        | Set or clear run manager redirect.                     |

The current listener does not consistently apply active-run manager ownership
to resource detail or connection list/detail/create/delete. Do not retrieve
passwords through it. Resource/connection JSON remains flexible.

```sh
agent_request() {
  method=$1; path=$2; data=${3-}
  case "$AGENT_ENDPOINT" in
    tcp://*) base="http://${AGENT_ENDPOINT#tcp://}"; curl --fail-with-body -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' ${data:+--data "$data"} "$base$path" ;;
    http://*|https://*) curl --fail-with-body -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' ${data:+--data "$data"} "${AGENT_ENDPOINT%/}$path" ;;
    unix://*) curl --fail-with-body --unix-socket "${AGENT_ENDPOINT#unix://}" -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' ${data:+--data "$data"} "http://agent$path" ;;
    *) echo "Unsupported AGENT_ENDPOINT" >&2; return 2;;
  esac
}
```

This supports TCP, ordinary HTTP(S), and Unix sockets. Use an equivalent
client in production and never expose `TOKEN` in diagnostics.

## Docker deployment, redirect, and teardown

Resolve the Commander resource, require its `commander` name/type, and read
raw `resource.config.platform_connection` for the active platform. The example
is `{"network":"manager"}`. Attach every durable service explicitly:

```yaml
services:
  workload:
    connections:
      - type: Platform
        data: { network: manager }
```

Deploy through the mounted socket, attach the service to the advertised
network, and wait for health from Commander before changing the redirect. The
target must be resolvable by Commander, e.g. `http://my-manager-service:8080`.

```http
PATCH /v1/manager/redirect
Authorization: Bearer <run-token>
Content-Type: application/json

{"redirect":"http://my-manager-service:8080"}
```

The active run selects the manager; no manager ID is accepted. Clear with
`{"redirect":null}` (empty/whitespace also clears). On failed deployment leave
the old redirect; if redirect update fails, report the run failed and retry or
clean up. A single `teardown` run must clear the redirect and require that
operation to succeed before removing the durable services, volumes, manager
network, or resource. If redirect clearance fails, fail the run before Docker
removal. The runner then removes teardown-owned objects and installer-created
attachments; Deploy Commander removes connections attached to the resource.

## Security, failures, and checklist

Credentials, tokens, passwords, and connection configuration are secrets. Do
not trust metadata for identity or use frontend checks as authorization. Use
expected redirect schemes/hosts/ports. Commander and the registered agent are
authoritative; there is no local fallback. Connection creation, password
secret storage, and manager login creation are separate operations. Approval
deletes the new connection if secret storage or login creation fails; if that
cleanup fails, remove the connection before retrying. Deleting a connection
also deletes its connection secrets. Run dispatch failure records a failed
run. Treat non-2xx responses as failures after redacting diagnostic bodies.

Before shipping, verify: one stable wire; Commander manager UUID (not resource
UUID); `action: "create-connection"`; awaited `child.close`; structured denial
handling; secure password handoff; no current-manager selector in manager API
requests; explicit service network attachment; health before redirect; and
redirect clearance before teardown.

## Durable runs

Manager clients can query runs by action, status, or structured target. Use the
run event/log history endpoints with `after_seq` to catch up after downtime;
browser events are live notifications, not durable storage. Completed runs may
include a bounded structured `result` for small outputs, while events and logs
remain the source for narrative progress and diagnostics.

## Component labels

Managers, resources, connections, and runs accept an optional `labels` object
on creation. Keys are trimmed and must be non-empty; values are exact strings
and may be empty. Each component has one value per key. `PUT /labels/{key}`
replaces the value and `DELETE /labels/{key}` removes it. Manager-token callers
may mutate labels on their own runs and resources, and on connections attached
to resources they own; only authenticated users may mutate manager labels.

List and detail endpoints accept repeated `label=key=value` filters,
`label_match=all|any`, `include_labels=true`, and repeated `label_key=key`.
`label_key` implies inclusion; filters alone do not include labels in the
response. Values split on the first `=` so equals signs in values are
preserved. Responses omit `labels` unless requested and return `{}` when
labels were requested but none exist.

The embedded RPC bridge exposes `setRunLabel`/`removeRunLabel`,
`setResourceLabel`/`removeResourceLabel`, and
`setConnectionLabel`/`removeConnectionLabel`. It binds the hosted manager
identity and enforces the manager-owned run/resource and resource-owner
connection scopes. Human users may also use the corresponding authenticated
HTTP label routes, including manager labels; manager tokens cannot mutate
manager labels.

### Search by label and discover values

List filters accept repeatable `label_exists=key` parameters. A key is present
even when its value is the empty string. Exact `label=key=value` filters and
presence filters combine under `label_match=all` (the default) or `any`; keys
are trimmed, and empty keys return `400`. Filtering never adds labels to the
response. For example, find resources that have an environment label and an
exact API tier:

```sh
COMMANDER_API=https://commander.example.com
USER_COOKIE=<authenticated-user-session-cookie>
curl --fail-with-body --cookie "$USER_COOKIE" \
  "$COMMANDER_API/api/v1/resources?label_exists=environment&label=tier%3Dapi&label_match=all"
```

Use `label=tier%3D` to match an exact empty value. `label_exists=tier` matches
both empty and nonempty tier values.

Each collection also provides a label-values route. It accepts a required
`key`, the collection's ordinary selection filters, and `limit`/`offset` for
the distinct values. Values are deduplicated, sorted, and paginated after the
record scope and filters are applied. Empty string values are included. The
response is `{"key":"environment","values":["production"],"total":1,"limit":50,"offset":0}`;
`limit` defaults to 50 and is capped at 200.

| Collection        | Human API                                                                                                                                                                                                      | Manager-token API                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Managers          | `/api/v1/managers`, `/api/v1/managers/label-values`                                                                                                                                                            | `/api/v1/managers`, `/api/v1/managers/label-values` (Commander-manager privilege required)                                          |
| Runs              | `/api/v1/managers/{managerID}/runs`, `/api/v1/managers/{managerID}/runs/label-values`                                                                                                                          | `/api/v1/runs`, `/api/v1/runs/label-values`                                                                                         |
| Resources         | `/api/v1/resources`, `/api/v1/resources/label-values`                                                                                                                                                          | `/api/v1/resources`, `/api/v1/resources/label-values`; owned scope: `/api/v1/resources/mine`, `/api/v1/resources/mine/label-values` |
| Connections       | `/api/v1/resources/connections`, `/api/v1/resources/connections/label-values`; scoped: `/api/v1/resources/managers/{managerID}/connections`, `/api/v1/resources/managers/{managerID}/connections/label-values` | `/api/v1/connections`, `/api/v1/connections/label-values`                                                                           |
| Manager API files | `/api/v1/managers/{managerID}/api-files`, `/api/v1/managers/{managerID}/api-files/label-values`                                                                                                                | `/api/v1/files`, `/api/v1/files/label-values`                                                                                       |

For example, request the first page of distinct resource environments matching
an existing tier label:

```http
GET /api/v1/resources/label-values?key=environment&label_exists=tier&limit=25&offset=0
```

For a manager-token caller, run and file label values are scoped to its
authenticated manager:

```sh
curl --fail-with-body --user "$MANAGER_ID:$MANAGER_PASSWORD" \
  "$MANAGER_API/runs/label-values?key=environment&label_exists=tier"

curl --fail-with-body --user "$MANAGER_ID:$MANAGER_PASSWORD" \
  "$MANAGER_API/files/label-values?key=release&name=app.js&limit=25&offset=0"
```

Manager-token requests use the same Basic or Bearer authentication described
above. Run and file catalog values stay scoped to the authenticated manager;
connection values follow owner-or-resource-owner visibility. `/resources`
remains global, and `/resources/mine` remains owned-only. Human file catalog
routes require a valid manager ID. Manager API file catalog labels describe
backend API files; they are separate from the manager interface's published
HTML, JavaScript, and other interface bytes.

## General rules

When changing a run action or configuration, verify the value in the request,
Commander's stored run, the launched `/run/config.json`, and the runner code that
consumes it. Do not treat values copied from the request into a local response
as proof of what Commander stored.

State what each test proves. Mocked API tests verify local serialization and
handling; they do not verify a real Commander-to-runner handoff or deployment
cleanup.
