# MANAGER_INTERFACE_GUIDE.md

## Purpose

This guide explains how to build a manager frontend that runs inside the Deploy Commander interface and communicates with Deploy Commander through:

`@ezenki/deploy-commander-installer-interface`

This document is intended for:

- Coding agents implementing a manager frontend
- Developers integrating an existing frontend with Deploy Commander
- Developers building parent and child manager workflows
- Developers using manager-scoped resources, connections, runs, events, and tokens

This guide is for consumers of the library.

It is not a guide for modifying the library itself.

## How the Integration Works

A manager frontend runs inside a page or frame controlled by the Deploy Commander frontend.

The manager frontend does not normally call the Deploy Commander HTTP API directly.

Instead, communication follows this path:

```text
Manager frontend
    ↓
Interface library
    ↓
window.postMessage
    ↓
Deploy Commander frontend
    ↓
Deploy Commander HTTP API
    ↓
Deploy Commander backend
```

The library provides:

- A wire transport
- Typed RPC methods
- Parent and child interface communication
- Child-interface lifecycle handling
- Run event delivery
- Manager-token refresh support

## Core Security Model

The manager frontend must not choose its own trusted manager identity.

Deploy Commander knows which manager interface is running and injects that manager context into scoped operations.

For manager-scoped calls, the library generally sends only the requested resource, run, or connection ID.

For example:

```ts
await caller.getConnection(connectionId);
```

The library sends the connection ID.

The Deploy Commander frontend injects the current manager ID and calls the manager-scoped backend endpoint.

Do not add a caller-controlled current-manager argument to scoped RPC calls.

The backend remains the final authorization boundary.

## Installation

Install the package:

```sh
npm install @ezenki/deploy-commander-installer-interface@^0.7.0
```

The package provides:

- ESM output
- CommonJS output
- TypeScript declarations

## Create a manager project

The interactive NPX initializer guides you through the supported framework,
language, manager metadata, credentials, and package manager:

```bash
npx @ezenki/deploy-commander-installer-interface init my-manager
```

The complete noninteractive form is:

```bash
COMMANDER_PASSWORD="$COMMANDER_PASSWORD" npx @ezenki/deploy-commander-installer-interface init my-manager \
  --framework react \
  --language typescript \
  --manager-name my-manager \
  --manager-kind pipeline \
  --manager-description "My Deploy Commander manager" \
  --label environment=development \
  --commander-url https://commander.example.com \
  --commander-username admin \
  --package-manager npm
```

Compatibility matrix:

| Framework | TypeScript | JavaScript |
| --------- | ---------- | ---------- |
| React     | yes        | yes        |
| Vue       | yes        | yes        |
| Svelte    | yes        | yes        |
| Angular   | yes        | no         |

The positional directory, `--framework`, and (for non-Angular templates)
`--language` are required for noninteractive initialization. Available flags
are `--manager-name`, `--manager-kind`, `--manager-description`, repeatable
`--label key=value`, `--commander-url`, `--commander-username`,
`--commander-password`, `--package-manager npm|pnpm|yarn|bun`, and
`--no-install`. Defaults are the directory basename, `pipeline`, no
description or labels. Interactive init prompts for the package manager;
noninteractive init detects it from the invoking user agent (npm when
unknown). Angular always uses TypeScript and rejects an explicit JavaScript
selection.

Commander URL, username, and password can come from the corresponding
`COMMANDER_*` environment variables. Password input is masked interactively;
avoid password flags because process listings may expose them. The generated
`.env` stores credentials, is git-ignored, and is mode `0600` on POSIX systems;
`.env.example` shows the expected keys without secrets. `--no-install` skips
dependency installation, and existing nonempty or symlinked directories are
never overwritten.

Generated projects include `dev`, `build`, `publish:manager`, and `deploy`
commands. Run `npm run build` to build, `npm run publish:manager` to upload the
already-built interface, or the generated `deploy` command for the configured
end-to-end workflow.

## Publishing a Built Manager Interface

The package also installs the `deploy-commander` command. Use it to publish
manager files that your project has already built. The command never runs a
build step.

Install the package as a development dependency and expose the command through
an npm script:

```sh
npm install --save-dev @ezenki/deploy-commander-installer-interface
```

```json
{
  "scripts": {
    "publish:manager": "deploy-commander publish"
  }
}
```

Create `deploy-commander.json` in the consuming project:

```json
{
  "name": "example-manager",
  "kind": "pipeline",
  "description": "Example manager",
  "labels": {
    "environment": "production"
  },
  "buildDirectory": "dist"
}
```

The required fields are `name`, `kind`, and `buildDirectory`. `description`
and `labels` are optional. `redirect` is not supported by this command and is
never changed.

Create a `.env` file beside the JSON configuration:

```dotenv
COMMANDER_URL=https://example.com
COMMANDER_USERNAME=admin
COMMANDER_PASSWORD=replace-me
```

Do not commit `.env`. Exported environment variables take precedence over
values in the file. `COMMANDER_URL` may include a path prefix, but it must be
an absolute HTTP or HTTPS URL without credentials, a query, or a fragment.

Build the manager with the consuming project's own build command, then publish
it separately:

```sh
npm run build
npm run publish:manager
```

To select another configuration file, pass its path through the npm script:

```sh
npm run publish:manager -- --config config/deploy-commander.json
```

Both `buildDirectory` and `.env` are resolved relative to the selected JSON
file. The build directory must be a non-empty directory below the configuration
directory. Missing, unreadable, empty, symlinked, or unsafe output is rejected
before authentication or any other network request. The configuration directory
itself cannot be published, preventing the adjacent `.env` from entering the
archive.

On the first publish, the command looks up a local manager by name and creates
it when it does not exist. It streams the build directory as a rootless TAR.GZ
archive to Deploy Commander's existing compressed-interface endpoint. It does
not create a temporary archive. Later publishes use the same endpoint to
replace the existing interface atomically in the agent-owned secure interface
file store.

For an existing manager, `name`, `kind`, and `description` are creation-only.
The command reports a notice when configured creation-only metadata differs but
does not attempt to update it. Redirect configuration remains untouched.

Label behavior on repeat publishes is explicit:

- Omitting `labels` preserves all existing labels.
- Supplying `labels` makes the object the exact desired label set.
- Supplying `{}` removes all existing labels.

Platform credential permission grants can also be configured for a manager:

```json
{
  "name": "example-manager",
  "kind": "pipeline",
  "permissions": {
    "platform_credentials": {
      "add": ["docker"],
      "remove": ["docker"]
    }
  },
  "buildDirectory": "dist"
}
```

Each list names the exact platform and grants that action independently. Omit
`permissions` on a repeat publish to preserve current grants. Supplying a
`permissions` object replaces the full grant set; use `"permissions": {}` to
remove all grants. Platform names are checked against the connected agent.
These are manager authorization grants only. Never put registry usernames,
passwords, tokens, or other credential values in `deploy-commander.json` or the
published build directory.

HTTP and validation failures are reported as a single sanitized error without
printing the configured password or authentication token. If initial upload
fails after creating a manager, rerun the same publish command to replace its
interface.

## Basic Initialization

A manager frontend normally creates:

1. A wire instance
2. An RPC caller
3. An event handler
4. An incoming parent or child RPC handler
5. Cleanup behavior

Example:

```ts
import {
  createWire,
  type RPCCall,
  type RPCResponse,
} from "@ezenki/deploy-commander-installer-interface";

import { RPC, Events } from "@ezenki/deploy-commander-installer-interface";

async function handleIncomingCall(call: RPCCall): Promise<RPCResponse> {
  switch (call.request) {
    case "ping":
      return {
        ok: true,
        result: {
          message: "pong",
        },
      };

    default:
      return {
        ok: false,
        error: {
          message: `Unknown interface request: ${call.request}`,
        },
      };
  }
}

function handleEvent(event: Events.InterfaceEvent) {
  switch (event.eventType) {
    case "run-start":
      console.log("Run started", event.data);
      break;

    case "run-update":
      if (event.data.type === "event") {
        console.log("Run event", event.data.payload);
      } else {
        console.log("Run log", event.data.payload);
      }
      break;
  }
}

const wire = createWire(handleIncomingCall, handleEvent);

const caller = RPC.SetupRPCCaller(wire);
```

The same `wire` instance should be used for the lifetime of the manager interface.

## Cleanup

When the manager frontend is destroyed or unmounted, call:

```ts
wire.end();
```

This removes the browser message listener.

It does not close the manager interface.

It also does not currently reject pending RPC or child-interface promises.

Do not call `wire.end()` while the application still expects responses.

In a framework component, cleanup may look like:

```ts
return () => {
  wire.end();
};
```

## RPC Error Handling

RPC methods throw the structured error returned by Deploy Commander.

The thrown value is not guaranteed to be an `Error` instance.

Use defensive error handling:

```ts
try {
  const run = await caller.getRun(runId);
  console.log(run);
} catch (error: any) {
  console.error(
    error?.message ?? "RPC call failed",
    error?.status,
    error?.details,
  );
}
```

Typical RPC errors use this shape:

```ts
{
  message: string;
  status?: number;
  details?: any;
}
```

Do not rely only on:

```ts
error instanceof Error;
```

## Available RPC Calls

## Runs

### Run Status Values

Run status fields and the `statuses` and `not_statuses` filters use these numeric values:

```ts
import {
  STATUS_QUEUED,
  STATUS_RUNNING,
  STATUS_DONE,
  STATUS_FAILED,
} from "@ezenki/deploy-commander-installer-interface";
```

### Start a Run

```ts
const result = await caller.start({
  action: "deploy",
  runner: runnerId,
  metadata: { requestedBy: "release-page" },
  config: { image: "example/app:1.2.3" },
  note: "Deploy version 1.2.3",
  platform: "docker",
  platform_data: { image: "example/app:1.2.3" },
  labels: { environment: "production" },
  target: { kind: "resource", id: resourceId },
  secrets: { REGISTRY_TOKEN: "<initial-secret-value>" },
});
```

The options-object form is preferred. Run configuration fields have separate
owners and purposes:

| Field            | Purpose                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `manager`, `run` | Trusted Commander-assigned manager and run UUIDs.                             |
| `runner`         | Runner image or executable selected for the action.                           |
| `platform`       | Optional execution platform, such as `docker`.                                |
| `platform_data`  | Optional platform-specific action input.                                      |
| `action`         | Action the runner should execute.                                             |
| `metadata`       | Flexible input for the runner action.                                         |
| `config`         | Optional raw JSON input owned by the manager.                                 |
| `target`         | Optional structured association to a durable object operated on by the run.   |
| `secrets`        | Optional string map stored for this exact run and omitted from runner config. |

`note` and `labels` belong to the run record, not its runner configuration.
Commander and the agent forward manager `config` without interpreting its
structure, and the runner receives the complete configuration with it included
when supplied. Omit `config` or use `null` when no manager config is supplied.
Use `target` when a run acts on a durable resource, deployment, or other
managed entity; it makes the association queryable without relying on arbitrary
metadata.

The legacy positional form remains supported:

```ts
start(
  action,
  runner,
  metadata,
  note?,
  platform?,
  platform_data?,
  target?,
  labels?,
  config?,
  secrets?
)
```

Returns:

```ts
{
  id: string;
  queued_at: string;
  status: number;
}
```

The `metadata` and `platform_data` values are intentionally unstructured.
Do not use metadata as a substitute for `target` when the relationship should
be filterable.

Initial secret values are sent once with the start request. The agent stores
them under the new run's ID; they are not returned in run configuration,
ordinary run responses, or manager RPC results.

### Secret calls

```ts
const keys = await caller.getSecretKeys("resource", resourceId);
await caller.setSecret("resource", resourceId, "REGISTRY_TOKEN", "<value>");
await caller.deleteSecret("resource", resourceId, "REGISTRY_TOKEN");
```

`getSecretKeys` returns only key names and timestamps. The library has no
method to read a stored value. The manager ID recorded on a connection may
list its keys. The manager that owns the connection's resource may also list
keys and may change that secret. The current manager identity is injected by Deploy
Commander, and each operation is authorized by the backend.

### List Runs

```ts
const result = await caller.getRuns({
  action: "deploy",
  statuses: ["1", "2"],
  target_kind: "resource",
  target_id: resourceId,
  sort: "-created_at",
  limit: 50,
  offset: 0,
});
```

Filtering happens in Deploy Commander; do not download a large run list and
filter it in the browser. The options-object form supports `user_id`, `action`,
`statuses`, `not_statuses`, `target_kind`, `target_id`, `sort`, `limit`, and
`offset`. The legacy positional overload remains available:

```ts
getRuns(
  user_id?,
  statuses?,
  not_statuses?,
  sort?,
  limit?,
  offset?
)
```

Returns:

```ts
{
  items: RunItem[];
  limit: number;
  offset: number;
  total: number;
}
```

### Get One Run

```ts
const result = await caller.getRun(runId);
```

Returns:

```ts
{
  run: RunItem;
  config: RunConfiguration;
}
```

The call is scoped to the current manager.

Run list items expose an optional structured `target`. A run detail may also
contain a small structured `result`, for example a created resource ID or
deployed version. Results are terminal outputs, not a replacement for event or
log history and not storage for large payloads.

### Get the Latest Relevant Run

```ts
const latest = await caller.getLatestRun({
  action: "deploy",
  target_kind: "resource",
  target_id: resourceId,
});
```

This performs a server-filtered one-item query and returns `RunItem | null`.

### Get Run Events

Use `getRunEvents` when an interface opens after a run started, reconnects, or
needs an authoritative event history.

```ts
let afterSeq = -1;

do {
  const page = await caller.getRunEvents({
    run_id: runId,
    after_seq: afterSeq,
    limit: 100,
    phase: "deploy",
    order: "asc",
  });

  for (const event of page.events) {
    console.log(event.seq, event.phase, event.status, event.message);
  }

  afterSeq = page.next_after_seq ?? afterSeq;
  if (!page.has_more) break;
} while (true);
```

`after_seq: -1` explicitly starts at the beginning. Cursor mode is ascending
and returns `next_after_seq` plus `has_more`; keep the returned watermark even
when a page is empty. Do not combine cursor mode with offset pagination or
descending order. Without `after_seq`, use `limit`, `offset`, and `total` for
ordinary pagination. Optional event filters are `phase` and `status`.

### Get Run Logs

```ts
const page = await caller.getRunLogs({
  run_id: runId,
  after_seq: -1,
  limit: 200,
  stream: "stderr",
  level: "error",
  order: "asc",
});
```

Log history has its own sequence space and watermark. Its optional filters are
`stream` and `level`; its cursor and offset rules match run events.

### Catch Up Events and Logs Together

```ts
const updates = await caller.getRunUpdates({
  run_id: runId,
  event_after_seq: eventWatermark ?? -1,
  log_after_seq: logWatermark ?? -1,
  limit: 100,
});

eventWatermark = updates.events.next_after_seq ?? eventWatermark;
logWatermark = updates.logs.next_after_seq ?? logWatermark;
```

Event and log watermarks are independent. Persist them independently for each
run. `getRunUpdates` is a convenience for durable catch-up; it does not open an
SSE stream.

## Manager Context

### Get the Current Manager

```ts
const managerId = await caller.getManager();
```

The result is the current manager ID as a `string`. Use it when the application
needs to identify the manager whose interface is currently running.

### Get Agent Platforms and Nodes

```ts
const agent = await caller.getAgent();
```

This returns only the registered agent's platform metadata and node
information:

```ts
{
  platforms: Record<string, unknown>;
  nodes: AgentNode[];
}
```

The rest of the agent record is not exposed through this RPC.

### Get the Calling Manager

```ts
const callingManager = await caller.getCallingManager();
```

This returns the manager ID that opened the current manager interface.

For a root interface, there may be no calling manager.

Consumers should be prepared for a null-like runtime result even if the current public type is stricter.

Example:

```ts
const callingManager = await caller.getCallingManager();

if (callingManager) {
  console.log("Opened by manager", callingManager);
}
```

### Get Interface Metadata

```ts
const metadata = await caller.getMetadata();
```

This returns the metadata supplied when the current interface was opened.

Metadata is intentionally unrestricted.

Validate it before using it.

Example:

```ts
const metadata = await caller.getMetadata();

if (
  metadata &&
  typeof metadata === "object" &&
  typeof metadata.resourceId === "string"
) {
  console.log(metadata.resourceId);
}
```

### List Managers and Manager API Files

The parent bridge exposes manager and API-file catalog lists through options
objects. Deploy Commander applies the list filters on the server:

```ts
const managers = await caller.getManagers({
  name: "production",
  label_exists: ["environment"],
  limit: 25,
  offset: 0,
});

const files = await caller.getFiles({
  name: "app.js",
  label_exists: ["release"],
  limit: 25,
  offset: 0,
});
```

`getFiles` searches the current manager's API-file catalog. Its labels describe
backend API files and their metadata. They are separate from the HTML,
JavaScript, and other bytes in the published manager interface.

Manager interfaces can read label values through the same RPC bridge:

```ts
const environments = await caller.getManagerLabelValues({
  key: "environment",
  limit: 25,
  offset: 0,
});
```

Manager-list visibility and authorization follow the current parent bridge
policy.

### Platform Credentials

Platform credentials are stored by the agent's platform and are not owned by
the manager. The interface library sends credential batches through the
Deploy Commander RPC bridge; the host applies the current manager scope and
checks the manager's add or remove grant for each platform.

#### Docker credential setup

Use the platform name `docker` for Docker Hub and every other Docker registry,
including GHCR. A Docker credential contains an `auth` object. For username and
password authentication, use `kind: "basic"` inside `auth`; a registry token
used as a password belongs in the `password` field.

Add or replace Docker Hub and registry-prefix credentials in one call:

```ts
const added = await caller.addPlatformCredentials([
  {
    platform: "docker",
    credential: {
      kind: "docker_hub",
      auth: {
        kind: "basic",
        username: "robot",
        password: passwordFromSecureInput,
      },
    },
  },
  {
    platform: "docker",
    credential: {
      kind: "prefix",
      prefix: "ghcr.io/team",
      auth: {
        kind: "basic",
        username: "robot",
        password: tokenFromSecureInput,
      },
    },
  },
]);
```

For registries that issue a Docker identity token, `auth` can instead be
`{ kind: "identity_token", token: tokenFromSecureInput }`. A Docker Hub
credential is selected for image names without an explicit registry host, such
as `alpine:latest` or `library/alpine:latest`. An image with a host, including
`docker.io/library/alpine:latest`, uses the longest matching prefix credential;
it does not fall back to the Docker Hub credential. A prefix can be a registry
host (`ghcr.io`) or a host plus repository path (`ghcr.io/team`). Matching
respects path boundaries, so `ghcr.io/team` does not match `ghcr.io/team2`.
Prefixes must omit URL schemes and trailing slashes. Adding a credential again
for the same Docker Hub scope or normalized prefix replaces its value.

Remove either credential scope with `removePlatformCredentials` and its
selector:

```ts
const removed = await caller.removePlatformCredentials([
  {
    platform: "docker",
    selector: { kind: "docker_hub" },
  },
  {
    platform: "docker",
    selector: { kind: "prefix", prefix: "ghcr.io/team" },
  },
]);
```

Both methods return one ordered result for each submitted item. A result has an
`index`, a `status` of `ok` or `error`, and an optional safe code such as
`invalid_entry`, `unknown_platform`, `operation_failed`, or `forbidden`.
Valid items continue after an invalid or denied item. Managers need separate
add and remove grants for each exact platform name. Do not include a manager ID
in the call; Deploy Commander injects the trusted current manager ID. These
browser RPC methods use the logged-in interface session and manager grants,
not the manager Basic/Bearer API. Never put credential values in interface
metadata or publish configuration.

## Resources

### List Resources

```ts
const result = await caller.getResources("database", false, undefined, 50, 0);
```

Arguments:

```ts
getResources(
  resourceType?,
  external?,
  manager?,
  limit?,
  offset?
)
```

This returns resource summaries.

Each item has the following shape:

```ts
interface ResourceItem {
  agent?: string;
  created_at: string;
  external: boolean;
  id: string;
  name: string;
  manager: string;
  type: string;
  updated_at: string;
}
```

The `manager` field identifies the manager that owns the resource.

It does not return full resource configuration.

The optional `manager` argument is a list filter.

It does not redefine the identity of the current interface.

### List Resources Owned by the Current Manager

```ts
const result = await caller.getMyResources("database", false, 50, 0);
```

Arguments:

```ts
getMyResources(
  resourceType?,
  external?,
  limit?,
  offset?
)
```

Deploy Commander injects the current manager scope.

### Get One Resource

```ts
const result = await caller.getResource(resourceId);
```

Returns:

```ts
{
  resource: ResourceItem;
  config: ResourceConfiguration;
}
```

The returned `resource.manager` identifies the manager that owns the resource.

This call only succeeds when the resource is owned by the current manager.

A manager frontend cannot use this call to retrieve another manager's private resource configuration.

### Create a Resource

```ts
const result = await caller.createResource(
  {
    metadata: {
      engine: "postgres",
      version: "17",
    },
    name: "primary-database",
    platform_connection: {
      namespace: "production",
    },
    public_connection: {
      address: "db.example.com",
      port: 5432,
    },
  },
  false,
  "Primary Database",
  "database",
);
```

Arguments:

```ts
createResource(config, external, name, type);
```

The current manager is injected by Deploy Commander.

Do not include or attempt to override the owning manager in the config.

The config field is:

```ts
metadata;
```

Do not use the previous misspelling:

```ts
medatata;
```

### Update a Resource

```ts
const updated = await caller.updateResource(resourceId, {
  name: "Primary Database",
  external: false,
  config: {
    metadata: { engine: "postgres", version: "17.1" },
  },
});
```

The patch accepts only `name`, `external`, and object-valued `config`.
Deploy Commander injects the trusted current manager and preserves omitted
resource fields, including manager-specific flexible fields. Immutable identity
fields such as the resource ID, manager, agent, and resource type cannot be
changed through this call. A resource outside the current manager scope is
reported as not found.

### Delete a Resource

```ts
await caller.deleteResource(resourceId);
```

Deletion is scoped to resources owned by the current manager and returns no
result data. Treat deletion as irreversible application state even though the
RPC promise resolves with `void`.

## Connections

Connections associate a manager with a resource.

A connection may be visible to the current manager because:

- The current manager owns the connection
- The current manager owns the resource attached to the connection

### List Connections

```ts
const result = await caller.getConnections(50, 0, undefined, resourceId);
```

Arguments:

```ts
getConnections(
  limit?,
  offset?,
  manager?,
  resource?
)
```

Optional filters:

- Connection-owning manager
- Resource
- Limit
- Offset

The manager filter only narrows the visible result set.

It does not allow the interface to escape its current authorization scope.

Returns:

```ts
{
  items: ConnectionItem[];
  limit: number;
  offset: number;
  total: number;
}
```

The list contains connection summaries and does not contain full connection configuration.

### Get One Connection

```ts
const result = await caller.getConnection(connectionId);
```

Returns:

```ts
{
  connection: ConnectionItem;
  config: GetConnectionConfiguration;
}
```

`GetConnectionConfiguration` extends the stored connection configuration with
these optional fields:

```ts
interface GetConnectionConfiguration extends ConnectionConfiguration {
  platform_connection?: unknown;
  public_connection?: {
    address: string;
    port: number;
  };
}
```

The descriptors are read live from the attached resource and appear under
`config` only for a single-connection read. Each field is omitted independently
when not configured. No resource object or resource metadata is exposed, and
the descriptors are not copied into connection metadata. List, create, update,
and delete contracts remain unchanged.

This call only succeeds when:

- The current manager owns the connection
- Or the current manager owns the attached resource

The library sends only the connection ID.

Deploy Commander injects the current manager identity.

### Create a Connection

```ts
const result = await caller.createConnection(
  {
    username: "manager-id",
    password: generatedPassword,
  },
  connectionOwningManagerId,
  false,
  resourceId,
);
```

Arguments:

```ts
createConnection(config, manager, external, resource);
```

The `manager` argument is the manager that will own the connection.

The current interface manager is treated as the resource-owning manager.

The resource-owner identity is injected by Deploy Commander and cannot be overridden by the embedded frontend.

### Update a Connection

```ts
const result = await caller.updateConnection(connectionId, {
  username: "updated-user",
  password: updatedPassword,
});
```

Signature:

```ts
updateConnection(
  id: string,
  metadata: any
): Promise<UpdateConnection>
```

Returns:

```ts
{
  connection: ConnectionItem;
  config: {
    id: string;
    resource: string;
    manager: string;
    external: boolean;
    metadata: any;
    created_at: string;
    updated_at: string;
  }
}
```

The payload contains exactly `id` and `metadata`. Deploy Commander injects the trusted current manager identity when authorizing the update.

### Delete a Connection

```ts
await caller.deleteConnection(connectionId);
```

Signature:

```ts
deleteConnection(id: string): Promise<void>
```

The payload contains only `id`, and a successful response contains no data. Deploy Commander injects the trusted current manager identity when authorizing the deletion.

## Checking for an Existing Connection

Before creating a connection, use `getConnections` with manager and resource filters.

Example:

```ts
const existing = await caller.getConnections(
  1,
  0,
  connectionOwningManagerId,
  resourceId,
);

if (existing.total > 0) {
  throw new Error("A connection already exists for this manager and resource");
}
```

This check improves user experience.

The backend should still enforce any required uniqueness rules.

Do not rely only on the frontend check for correctness under concurrent requests.

## Manager Database

Each manager has its own isolated SurrealDB database. The library exposes `databaseQuery` for running SurrealQL against the current manager's database.

```ts
const response = await caller.databaseQuery(
  `
    UPDATE setup_state:current
    SET status = $status,
        updated_at = time::now()
  `,
  {
    status: "ready",
  },
);
```

The method signature is:

```ts
databaseQuery(
  query: string,
  bindings?: Record<string, unknown>
): Promise<DatabaseQueryResult>
```

`query` is SurrealQL. Each entry in `bindings` is bound to the SurrealQL variable with the same name. In the example, `$status` receives the value of `bindings.status`. Use bindings for application values instead of constructing queries through string interpolation. Omit `bindings` when the query has no variables.

The response contains the result of each statement in the query:

```ts
interface DatabaseQueryResult {
  results: Array<{
    statement: number;
    status: "OK" | "ERR";
    time: string;
    result: unknown;
  }>;
}
```

The exact value of each `result` depends on the SurrealQL statement that produced it. A statement with `status: "ERR"` is returned as part of a successful RPC response; inspect every statement status. Transport, protocol, and policy failures still reject the call.

## Manager Tokens

Manager frontends may need a short-lived manager token for calling another authenticated service.

### Retrieve a Token Directly

```ts
const response = await caller.getManagerToken();

console.log(response.token, response.expires_at);
```

### Use the Token Manager

The higher-level token manager automatically refreshes the token before expiration.

```ts
import { Caller } from "@ezenki/deploy-commander-installer-interface";

const tokenManager = await Caller.generateTokenManager(caller);

const initialToken = tokenManager.getToken();
```

Register for updates:

```ts
const handleTokenUpdate = (token: string) => {
  console.log("Token updated", token);
};

tokenManager.addTokenUpdateEvent(handleTokenUpdate);
```

Remove a listener:

```ts
tokenManager.removeTokenUpdateEvent(handleTokenUpdate);
```

Dispose the manager:

```ts
tokenManager.dispose();
```

Always dispose the token manager when the application no longer needs it.

The token manager currently refreshes 30 seconds before expiration.

A failed scheduled refresh may stop automatic refreshing, so consuming applications should handle authentication failures from services using the token.

## Receiving Events

Pass an event callback to `createWire`.

Browser events are live notifications, not the durable source of truth. An
interface can be closed while a run executes, and a reconnect can replay an
already-seen update. Reconcile the latest relevant run with `getLatestRun`,
catch up with `getRunEvents`, `getRunLogs`, or `getRunUpdates`, and suppress
duplicates by `(run_id, update type, sequence)` before applying live updates.
Both event and log update payloads include the required `run_id` field.

```ts
function handleEvent(event: Events.InterfaceEvent) {
  switch (event.eventType) {
    case "run-start":
      handleRunStart(event.data);
      break;

    case "run-update":
      handleRunUpdate(event.data);
      break;
  }
}
```

## Run-Start Events

A run-start event has:

```ts
{
  type: "event";
  eventType: "run-start";
  data: {
    id: string;
    manager: string;
    action: string;
    note?: string;
    created?: string;
  };
}
```

Example:

```ts
function handleRunStart(data: Events.RunStartEventData) {
  console.log(`Run ${data.id} started for ${data.manager}`);
}
```

## Run Updates

A run update contains either:

- A structured event
- A log entry

Example:

```ts
function handleRunUpdate(update: Events.RunUpdateData) {
  if (update.type === "event") {
    const event = update.payload;

    console.log(
      event.run_id,
      event.seq,
      event.phase,
      event.status,
      event.message,
    );

    return;
  }

  const log = update.payload;

  console.log(log.run_id, log.seq, log.stream, log.level, log.message);
}
```

The `run_id` field is required on both payload types. Other live event and log
payload fields are optional.

Sequence zero may be omitted by older live producers. In that compatibility
case, deliver the update but do not advance a durable watermark from it. For
persisted history, `seq` is authoritative. Keep event and log sequence
watermarks separate because each stream advances independently.

Do not assume values such as `seq`, `message`, or `at` are always present.

## Parent and Child Interface Calls

A manager interface may communicate with the interface that opened it or with interfaces it opened.

## Send a Call to the Parent

```ts
const response = await wire.sendToParent({
  request: "registrationComplete",
  payload: {
    resourceId,
  },
});
```

Handle the response:

```ts
if (!response.ok) {
  throw response.error;
}
```

A root interface has no parent.

In that case Deploy Commander returns a failed RPC response.

## Send a Call to a Child

```ts
const response = await wire.sendToChild(childId, {
  request: "getStatus",
  payload: {},
});
```

The child must be a valid interface opened through the current parent relationship.

## Handle Incoming Parent or Child Calls

The first argument passed to `createWire` handles incoming interface RPC calls.

Example:

```ts
async function handleIncomingCall(call: RPCCall): Promise<RPCResponse> {
  try {
    switch (call.request) {
      case "getStatus":
        return {
          ok: true,
          result: {
            ready: true,
          },
        };

      case "setConfiguration":
        await applyConfiguration(call.payload);

        return {
          ok: true,
          result: null,
        };

      default:
        return {
          ok: false,
          error: {
            message: `Unknown request: ${call.request}`,
          },
        };
    }
  } catch (error: any) {
    return {
      ok: false,
      error: {
        message: error?.message ?? "Incoming call failed",
      },
    };
  }
}
```

The handler must return a complete `RPCResponse`.

Do not throw deliberately for normal validation failures.

Return a structured failed response instead.

## Starting a Child Manager Interface

Use:

```ts
const child = await wire.startInterface({
  manager: childManagerId,
  metadata: {
    resourceId,
    purpose: "configure",
  },
});
```

The result contains:

```ts
{
  id: string;
  close: Promise<InterfaceResponse>;
}
```

The child ID may be used with:

```ts
wire.sendToChild(...)
```

Wait for the child to close:

```ts
const closeResponse = await child.close;

if (!closeResponse.ok) {
  console.error(closeResponse.error);
} else {
  console.log(closeResponse.result);
}
```

## Closing the Current Interface

When the current manager workflow is complete, call:

```ts
wire.close({
  manager: managerId,
  ok: true,
  result: {
    resourceId,
  },
});
```

To close with an error:

```ts
wire.close({
  manager: managerId,
  ok: false,
  error: {
    message: "A connection already exists",
    status: 409,
  },
});
```

Closing the interface is different from throwing an exception.

Use a close response when the manager workflow itself has completed or failed and the parent interface needs the result.

## Recommended Application Startup Flow

A typical manager frontend startup flow is:

1. Create the wire.
2. Create the RPC caller.
3. Retrieve manager context.
4. Retrieve interface metadata.
5. Validate metadata.
6. Load required resources and connections.
7. Initialize optional token management.
8. Render the application.
9. Close with a result or error when the workflow finishes.
10. Dispose timers and end the wire listener during final cleanup.

Example:

```ts
import {
  createWire,
  RPC,
  Caller,
  type RPCCall,
  type RPCResponse,
} from "@ezenki/deploy-commander-installer-interface";

async function handleIncomingCall(call: RPCCall): Promise<RPCResponse> {
  return {
    ok: false,
    error: {
      message: `Unsupported request: ${call.request}`,
    },
  };
}

async function startApplication() {
  const wire = createWire(handleIncomingCall, (event) => {
    console.log("Interface event", event);
  });

  const caller = RPC.SetupRPCCaller(wire);

  let tokenManager:
    | Awaited<ReturnType<typeof Caller.generateTokenManager>>
    | undefined;

  try {
    const managerId = await caller.getManager();

    const metadata = await caller.getMetadata();

    tokenManager = await Caller.generateTokenManager(caller);

    return {
      wire,
      caller,
      managerId,
      metadata,
      tokenManager,
    };
  } catch (error) {
    tokenManager?.dispose();
    wire.end();
    throw error;
  }
}
```

## Recommended Manager Workflow Pattern

For a manager that configures a resource and connection:

```ts
async function configureManager(
  caller: ReturnType<typeof RPC.SetupRPCCaller>,
  wire: ReturnType<typeof createWire>,
) {
  const currentManager = await caller.getManager();

  const callingManager = await caller.getCallingManager();

  const metadata = await caller.getMetadata();

  if (
    !metadata ||
    typeof metadata !== "object" ||
    typeof metadata.resourceId !== "string"
  ) {
    wire.close({
      manager: currentManager.id,
      ok: false,
      error: {
        message: "metadata.resourceId is required",
      },
    });

    return;
  }

  const existing = await caller.getConnections(
    1,
    0,
    callingManager || undefined,
    metadata.resourceId,
  );

  if (existing.total > 0) {
    wire.close({
      manager: currentManager.id,
      ok: false,
      error: {
        message: "A connection already exists",
        status: 409,
      },
    });

    return;
  }

  const created = await caller.createConnection(
    {
      username: callingManager,
      password: generatePassword(),
    },
    callingManager,
    false,
    metadata.resourceId,
  );

  wire.close({
    manager: currentManager.id,
    ok: true,
    result: created,
  });
}
```

The exact metadata and connection configuration depend on the manager implementation.

## Input Validation

Treat the following as untrusted:

- Interface metadata
- Parent RPC payloads
- Child RPC payloads
- RPC error details
- Optional backend fields
- Platform-specific configuration
- Resource metadata
- Connection metadata

Validate required fields before using them.

Example:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
```

Use named validation functions for complex metadata instead of repeated type assertions.

## Do Not Call Deploy Commander APIs Directly

Do not bypass the library with calls such as:

```ts
fetch("/api/v1/resources/...");
```

unless the application has a deliberate separate API integration approved by the Deploy Commander design.

Direct API calls can:

- Bypass interface context injection
- Depend on undocumented routes
- Break manager ownership assumptions
- Duplicate RPC behavior
- Make the manager frontend harder to run outside one Deploy Commander deployment

Use `RPCCaller` for platform operations.

## Do Not Supply Trusted Manager Identity

Do not design calls like:

```ts
getResource(currentManagerId, resourceId);
```

or:

```ts
getConnection(currentManagerId, connectionId);
```

The current manager identity belongs to Deploy Commander.

The library should only send the requested object ID for these scoped operations.

## Application State Guidance

Manager frontends should separate:

- Local UI state
- Deploy Commander data
- Interface metadata
- Parent or child interface state
- Temporary manager tokens

Do not store temporary tokens in long-term browser storage unless there is a specific reason.

Prefer in-memory storage through the token manager.

Do not treat the manager database as a replacement for resource configuration owned by Deploy Commander.

Use the manager database for manager-owned application data.

## Framework Integration

The library is framework-independent.

Framework code should wrap it at the application boundary.

For React, a provider or top-level hook may own:

- `Wire`
- `RPCCaller`
- Event dispatch
- Token manager
- Cleanup

For Vue or Svelte, use an equivalent application-level service or store.

Do not create a new wire instance during every component render.

Use one stable instance for the manager interface lifecycle.

## Agent Implementation Checklist

An agent implementing a manager frontend should confirm:

- The package is installed.
- A single wire instance is created.
- An incoming RPC handler is provided.
- An event handler is provided when run events are needed.
- `RPC.SetupRPCCaller` is used.
- Interface metadata is validated.
- Scoped calls do not include a caller-selected current manager ID.
- Resource ownership restrictions are understood.
- Connection visibility restrictions are understood.
- Existing connections are checked before creation when required.
- RPC errors are handled as structured objects.
- Child-interface close responses are handled.
- Manager workflows close with `wire.close`.
- Local listeners are removed with `wire.end`.
- Token managers are disposed.
- Direct Deploy Commander API calls are avoided.
- Public connection and resource types match the library.
- The application handles optional event fields.

## Important Access Rules

Keep these rules visible when implementing manager workflows:

### Resources

`getResource(id)` only retrieves resources owned by the current manager.

### Connections

`getConnections(...)` only lists connections:

- Owned by the current manager
- Or attached to resources owned by the current manager

`getConnection(id)` follows the same visibility rule and includes full connection configuration.

`updateConnection(id, metadata)` and `deleteConnection(id)` also rely on this trusted interface context. Their payloads must not include a caller-controlled manager identity.

### Manager Identity

The current manager identity is injected by Deploy Commander.

It must not be supplied or overridden by the embedded interface.

### Connection Creation

The manager argument to `createConnection` is the manager that will own the connection.

The current interface manager is the trusted resource-owning manager.

## Final Guidance

Run history is durable and should be fetched after startup or reconnect. Use
`getLatestRun` with filters for reconciliation, then consume `getRunEvents`,
`getRunLogs`, or `getRunUpdates` with independent sequence cursors. Completed
runs may expose a small structured `result` and optional `target`; these do
not replace event/log history. Resource updates are merge patches and deletes
are manager-scoped; never put a manager identifier in the payload.

Use the library as the platform boundary for manager frontend code.

A well-structured manager frontend should:

- Create one wire
- Create one typed caller
- Validate all incoming metadata
- Use RPC calls instead of direct platform fetches
- Respect manager-scoped resource and connection rules
- Handle structured errors
- Clean up timers and listeners
- Close the interface with a meaningful result or error

The most important rule is that the manager frontend may request actions, but Deploy Commander owns the trusted manager context and authorization boundary.

## Labels

Runs, resources, connections, the current manager, and manager API file
catalog entries can expose optional string labels. Use the label-aware
list/detail query options to request
`include_labels` or selected `label_key` values; label filters are exact
`key=value` expressions and support `all` or `any` matching. `label_key`
implies inclusion, while filters alone do not add labels to responses.

List options also accept `label_exists: string[]`. This finds records carrying
a key whether its value is empty or nonempty. Exact `labels` and
`label_exists` predicates combine with `label_match: "all" | "any"`; the
default is `all`. For example:

```ts
const runs = await caller.getRuns({
  labels: { tier: "api" },
  label_exists: ["environment"],
  label_match: "all",
  limit: 50,
  offset: 0,
});

const resources = await caller.getMyResources({
  label_exists: ["environment"],
});
```

Use collection-specific methods to find distinct values. Each takes one
options object with a required `key`, the collection's filters, and optional
value pagination. The result has `key`, sorted `values`, `total`, `limit`, and
`offset`. Empty values are returned as `""`.

```ts
const environments = await caller.getResourceLabelValues({
  key: "environment",
  type: "service",
  label_exists: ["tier"],
  limit: 25,
  offset: 0,
});

const connectionRegions = await caller.getConnectionLabelValues({
  key: "region",
  resource: resourceId,
});

const fileReleases = await caller.getFileLabelValues({
  key: "release",
  name: "app.js",
});
```

The available methods are `getManagerLabelValues`, `getRunLabelValues`,
`getResourceLabelValues`, `getMyResourceLabelValues`,
`getConnectionLabelValues`, and `getFileLabelValues`. Resource methods keep
global and current-manager-owned scopes distinct. Run and file methods use the
trusted current manager, and connection values follow the existing
owner-or-resource-owner visibility rule. The library sends these calls through
RPC; manager frontends should not call the HTTP routes directly.

The caller may replace or remove labels through the typed `set*Label` and
`remove*Label` RPC methods. The bridge supplies the trusted manager context;
embedded payloads must not contain a manager selector. Manager interfaces may
mutate only their own runs/resources and connections attached to resources they
own. Label values are strings (including the empty string), and setting a key
replaces its previous value.

## Best Practices

Manager interfaces should prefer Deploy Commander’s built-in primitives and lifecycle features before creating additional state or custom mechanisms.

### Prefer Deploy Commander primitives

Use the existing Deploy Commander objects for the state they naturally represent:

- **Resources** represent durable things managed by a manager.
- **Connections** represent durable relationships or access between managers and resources.
- **Runs** represent operations, their status, and their outcomes.
- **Run events and logs** represent execution history.
- **Labels** provide classification, grouping, and lookup across Deploy Commander objects.
- **Manager database data** should represent manager-specific application or domain data that does not fit the primitives above.

Do not duplicate authoritative Deploy Commander state in the manager database. For example, do not maintain separate database fields indicating that a resource exists, a connection has been created, or a deployment succeeded when resources, connections, or runs already provide that information.

Before creating database-backed state, determine whether the requirement can be represented with resources, connections, runs, run results, targets, history, or labels.

### Use labels for organization and discovery

Use labels to group, classify, and locate related Deploy Commander objects.

Examples include:

```text
environment=production
stage=development
application=ghost
role=database
deployment-group=example
```

Labels should help locate authoritative objects rather than replace their state.

For example:

- Use the actual run status instead of a `status=running` label.
- Use the existence of a connection instead of a `connected=true` label.
- Store resource configuration on the resource rather than encoding it into labels.

### Use structured run targets

When a run directly operates on a durable object, use the run `target` rather than placing the relationship only in arbitrary metadata.

Use metadata for additional information that does not need to define the queryable relationship between the run and the object it affects.

### Treat live events as notifications

Live browser events improve responsiveness but must not be the only source of state.

A manager interface may be closed, refreshed, disconnected, or opened after a run has already completed.

Manager interfaces should be capable of reconstructing their important state without having observed the original live events.

When opening or reconnecting:

1. Load the relevant resources and connections.
2. Find the relevant recent or latest runs.
3. Retrieve persisted run events or logs when necessary.
4. Reconcile that durable state with the UI.
5. Continue processing live events for new updates.

Use event and log sequence cursors independently when catching up on run history.

### Prefer server-side querying

Use available filters, targets, and labels to narrow data in Deploy Commander.

Avoid retrieving large collections solely to filter them in the browser when the interface provides a server-side query mechanism for the same purpose.

### Keep frontend state disposable

Local browser state is appropriate for:

- Form values
- UI selections
- Open tabs or panels
- Temporary caches
- Other presentation state

Important deployment or manager state should not depend on a particular browser session remaining open.

### Keep run results small

Structured run results are appropriate for small durable outputs such as:

- Created resource IDs
- Deployed versions
- Generated identifiers
- Other small operation results

Do not use run results as general-purpose storage or as a replacement for run events, logs, resources, or manager database data.

### Use the manager database when the manager owns additional domain data

The manager database is appropriate when a manager needs searchable or structured data that Deploy Commander does not otherwise model.

This is particularly useful for managers that manage multiple logical deployments or maintain manager-specific relationships and application data.

The database should extend the Deploy Commander model rather than duplicate it.

### Initialize new managers with the provided initializer

Prefer the package initializer when creating a new manager project:

```bash
npx @ezenki/deploy-commander-installer-interface init my-manager
```

Use the generated project structure and scripts instead of manually recreating the expected manager setup unless the project has a specific reason to do otherwise.

### Keep build and publish separate

The consuming manager project owns its build process.

Publishing should upload an already-built manager interface and should not implicitly run the project build.

A typical workflow is:

```bash
npm run build
npm run publish:manager
```

This keeps Deploy Commander publishing independent from the framework or build system used by the manager.

### Publish only generated build output

Publish the configured build directory rather than the manager project root.

Treat the build directory as generated output and keep source files, local development files, credentials, and unrelated project files outside the published interface.

### Keep publishing credentials out of source control

Store Deploy Commander credentials in environment variables or a git-ignored local `.env` file.

Prefer environment variables for CI and automated publishing.

Avoid passing passwords directly through command-line arguments when possible because command-line arguments may be visible to other processes or system tooling.

Never include credentials in `deploy-commander.json` or published build output.

### Be deliberate when publishing labels

Publishing labels has replacement semantics:

- Omitting `labels` preserves the manager's existing labels.
- Providing `labels` makes the supplied object the desired complete label set.
- Providing an empty object removes all existing labels.

Do not include labels in publish configuration unless the publish workflow should manage those labels.

### Preserve Deploy Commander as the authorization boundary

Manager frontends should use the provided interface RPC methods instead of directly calling Deploy Commander APIs.

Do not supply or attempt to override trusted current-manager identity in scoped operations.

Deploy Commander owns manager context and remains the final authorization boundary.

### General rule

Prefer Deploy Commander’s native resources, connections, runs, history, labels, and lifecycle tooling before introducing additional persistence or custom infrastructure.

Add manager-specific database state only when the existing platform primitives do not represent the requirement cleanly. If you are using the database ensure you check to see if the database is initialized and if not initialize it.

Use the `createWire` event callback for live run updates. Register and remove listeners with the active view. Use run history for initial state and missed events; do not poll for live events.

Describe a specific outcome such as “teardown complete” only when the durable run identifies the intended action and the verified runner contract makes that outcome part of a successful run.

Never require a manager frontend to perform an operation immediately after a run completes. Assume the manager interface is no longer open when the run finishes. Any required post-run work must be part of the durable run/backend workflow or be safely recoverable when the manager is opened again.

Do not allow conflicting runs while a relevant run is queued or running.
When a run that affects an action is queued or running, disable the UI and other manager mechanisms that could start that action again. Do not assume the current browser initiated the run; it may have been started by another browser, manager instance, or backend process.
Check existing run state when the manager loads, listen for run-start events to detect newly started runs, and re-enable the action only after the relevant run reaches a terminal state.

A manager frontend may request teardown and observe its status, but must not chain teardown steps in browser callbacks. The backend must continue or resume the workflow if the user navigates away or closes the tab. Runner jobs must clear the redirect before full teardown removes the service.

Managers should be frontend-only whenever possible, using existing Deploy Commander APIs and capabilities instead of introducing a dedicated backend.
If a backend is necessary, explain to the developer why it is required and why a frontend-only approach is insufficient.
Manager backends must be implemented in Go unless the developer explicitly specifies another language.
Do not introduce a backend unnecessarily. The image base should be gcr.io/distroless/static-debian12:nonroot as we would want to make the backend image as small and simple as possible.

Always use ezenki/deploy-commander-runner for deployment operations. Never create a custom runner unless explicitly instructed by the developer. If the runner's integration guide is missing or the runner appears to lack required functionality, inform the developer before proceeding.

Use Tailwind CSS to create a clean, polished, modern, and responsive manager interface unless explicitly instructed otherwise. Maintain consistent styling and a user-friendly experience throughout the manager.
