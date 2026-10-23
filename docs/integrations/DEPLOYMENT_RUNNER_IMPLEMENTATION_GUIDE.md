# Deploy Commander Runner — AI Implementation Guide

## Purpose

This document instructs an AI coding agent how to implement a Deploy Commander manager that uses the standard Deploy Commander runner.

The runner receives a JSON configuration containing the desired services, chronjobs, volumes, resources, connections, removals, and redirect state. It then translates that configuration into platform operations.

The current runner implementation supports Docker.

This guide is for implementing the manager-side planning code that produces runner configuration. It is not a guide for modifying the runner itself.

## Primary Goal

Your implementation should convert the manager’s configuration, user input, and current state into a valid runner configuration.

The resulting configuration must tell the runner:

- Which services should exist
- Which chronjob schedulers and fire-and-forget services should be installed or removed
- Which one-time runner steps should execute
- Which volumes should exist
- Which services or volumes should be removed
- Which resources services provide
- Which resource connections services consume
- Which Deploy Commander connections should be created or removed
- Whether the manager redirect should be set, changed, or cleared
- Which agent-stored secrets and run-scoped variables the runner should resolve, when the selected runner supports the opt-in contract

The manager defines intent.

The runner performs the platform-specific execution.

## Manager and Runner Responsibility Split

In this guide, the **manager** is the manager-side planner that produces the deployment metadata. The **runner** is the process that receives that metadata and applies it to Docker.

The boundary is deliberate: the manager must provide a complete, explicit execution plan, while the runner handles the Docker and agent operations needed to apply that plan. Manager code should not create Docker objects or reproduce runner naming formulas.

| Concern                             | The manager must provide                                                                                                                                                                          | The runner handles for the manager                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desired state                       | The services, chronjobs, one-time steps, volumes, resources, connections, removals, and redirect operation required for this run                                                                  | Applying only the supplied operations in lifecycle order; it does not invent missing deployment intent                                                                                          |
| Service identity and configuration  | Stable service keys, images, optional commands, roles, dependencies, environment, aliases, bindings, mounts, and network-group membership                                                         | Validating supported metadata, ordering dependencies, and creating or replacing manager-scoped containers                                                                                       |
| Config maps                         | Top-level named text-file maps and service projection paths                                                                                                                                       | Validating references and paths, copying files into stopped containers, and starting only after projection succeeds                                                                             |
| Volumes                             | Logical volume declarations, service mount paths, and explicit removal decisions                                                                                                                  | Generating manager-scoped Docker names, creating or reusing named volumes, mounting them, and removing requested or teardown-owned volumes                                                      |
| Manager-local networking            | Logical network-group membership; no Docker network names                                                                                                                                         | Creating manager-scoped group networks, creating the default manager network when needed, and attaching containers                                                                              |
| Produced resources                  | Stable resource type and name, resource metadata, and any valid public connection                                                                                                                 | Creating the resource network, attaching the producer, generating Docker platform-connection data, and publishing the resource through the agent                                                |
| Consumed resources                  | An advised `Connection` reference for each consuming service, with a resource UUID and optional authorized connection UUID, plus any application configuration derived from the resource contract | Resolving the reference through the agent before Docker mutations, validating the returned descriptor, and attaching the exact Docker network when the resolved type is `Platform`              |
| Deploy Commander connection changes | Explicit create/remove operations with the currently supported UUID references                                                                                                                    | Sending those operations to the Deploy Commander agent after service and removal operations                                                                                                     |
| Removals                            | Exact obsolete service and volume logical names; omission is not removal                                                                                                                          | Resolving manager-scoped Docker objects, removing only the requested objects, and cleaning up resources recorded on removed services                                                            |
| Redirect                            | Whether to leave it unchanged, set it, or clear it, preserving nil semantics                                                                                                                      | Sending the requested redirect update to the agent                                                                                                                                              |
| Full teardown                       | The top-level `teardown` action for the target manager; no teardown metadata is required                                                                                                          | Clear the manager redirect and require success before removing manager-owned containers, volumes, networks, and the published resource; Commander removes connections attached to that resource |

The runner does not query manager or commander state to decide what should be deployed. It also does not derive application credentials, translate address-based connections into environment variables, infer removals from omitted entries, or validate that a supplied external Docker network semantically belongs to a particular resource. Those planning and resolution decisions remain manager responsibilities.

### Teardown action contract

The top-level `action: "teardown"` performs complete teardown in one runner
run and does not require `metadata` or `metadata.redirect`. It must first clear
the active manager redirect through the agent by sending
`{"redirect":null}`. The runner must stop and report failure if that request
fails; it must not remove containers, volumes, networks, or the target resource
before redirect clearance succeeds. Afterward it removes all Docker objects
owned by the manager and deletes the published resource through the agent.
Deploy Commander removes connections attached to that resource as part of
resource deletion. The run is DONE only after the redirect, Docker objects, and
resource have all been removed successfully.

This is the required contract for the Corvo single-run teardown flow. The
implementation guide describes the contract; the runner source and published
image must be updated and verified separately before deploying a caller that
depends on it.

## Required Reading

Before implementing a manager with this runner, read:

- The project’s top-level `AGENTS.md`
- The manager project’s own `AGENTS.md`
- Any manager interface or RPC documentation used to obtain resources and connections
- The manager’s input and configuration models

This guide is intended to be sufficient when the runner source is not available to the implementing AI agent. The Go models and JSON examples below are the public manager-to-runner contract.

If shared runner models are available as a dependency, use them instead of creating duplicate types. Otherwise, reproduce only the contract required by the manager and preserve the JSON names, optionality, and nil semantics documented here.

Do not guess fields that are not documented in this guide. In particular, do not assume that a field accepted by Docker, a container image, or another deployment system is also accepted by this runner.

## Contract Boundary and Source Availability

An AI agent implementing a manager may rely on this guide without access to the runner checkout. It may:

- Generate the documented runner configuration and metadata
- Validate manager input before producing metadata
- Use the documented Docker platform-connection payload
- Test the manager’s serialization and planning behavior

It may not use this guide alone to add or change runner capabilities. A new metadata field is a versioned contract change that requires the runner source, including its shared model, platform translation, validation, cleanup behavior, tests, and documentation.

When a requested manager feature needs a field not documented here:

1. Do not emit the speculative field.
2. State that the installed runner contract does not support the feature.
3. Request the runner checkout or a runner version that explicitly implements the field.
4. If another repository owns related state, such as manager run-status values, request that repository or its authoritative API contract as well.

The runner implementation currently stores the service contract in `models/metadata_services.go` and translates services into Docker containers in `internal/services/docker/setup.go`. These paths are provided only to help a maintainer locate the implementation after obtaining the runner source; their contents are fully summarized by this guide for ordinary manager work.

## Runner Image

Use the following container image for the runner:

```text
ezenki/deploy-commander-runner:latest
```

Chronjob plans also install the matching
`ezenki/deploy-commander-chronjob:<same-version>` scheduler image. Publish the
runner and scheduler images with the same version so their private scheduler
configuration schemas stay paired.

## Runner Input

The runner reads its configuration from:

```text
/run/config.json
```

The top-level configuration has this shape:

```json
{
  "manager": "manager-uuid",
  "run": "run-uuid",
  "runner": "runner-name",
  "platform": "docker",
  "platform_data": {},
  "action": "setup",
  "metadata": {}
}
```

The corresponding Go model is:

```go
type Configuration struct {
	Manager      uuid.UUID        `json:"manager"`
	Run          uuid.UUID        `json:"run"`
	Runner       string           `json:"runner"`
	Platform     string           `json:"platform"`
	PlatformData *json.RawMessage `json:"platform_data,omitempty"`
	Action       string           `json:"action"`
	Metadata     *Metadata        `json:"metadata,omitempty"`
}
```

The manager implementation may only be responsible for generating `metadata`, depending on how Deploy Commander launches and wraps the runner.

Follow the surrounding manager framework rather than duplicating fields already supplied by Deploy Commander.

Before populating the top-level fields, determine which component owns them. Commonly, the surrounding Deploy Commander framework supplies execution-envelope fields such as `manager`, `run`, `runner`, `platform`, and `action`, while manager planning code supplies `metadata`. The manager must not replace authoritative framework values with locally generated identifiers.

## Supported Platform

The current supported platform value is:

```text
docker
```

Do not emit another platform unless that platform has been implemented and registered in the runner.

`platform_data` is available for platform-specific configuration but is not currently used by the Docker implementation.

## Actions

The current Docker runner recognizes:

```text
teardown
```

A top-level `action: "teardown"` removes the manager's labeled:

- Containers
- Volumes
- Networks
- Published resources

Before those removals, teardown clears the manager redirect through the agent
with `PATCH /v1/manager/redirect` and body `{"redirect":null}`. A failed patch
fails the run and prevents every removal. Deleting the published resource also
causes Deploy Commander to remove its attached connections. Teardown does not
read redirect values from metadata. All other action values currently use the
normal setup and reconciliation flow.

Use the action name expected by the Deploy Commander manager framework.

Do not invent action-specific behavior that the runner does not implement.

## Metadata Structure

Runner metadata has this shape:

```go
type Metadata struct {
	ValuesVersion   *int                       `json:"values_version,omitempty"`
	Services        map[string]MetadataService `json:"services,omitempty"`
	ChronJobs       map[string]ChronJob        `json:"chronjobs,omitempty"`
	RemoveChronJobs *[]string                  `json:"remove_chronjobs,omitempty"`
	ConfigMaps      map[string]map[string]string `json:"config_maps,omitempty"`
	RemoveServices  *[]string                  `json:"remove_services,omitempty"`
	Volumes         *[]string                  `json:"volumes,omitempty"`
	RemoveVolumes   *[]string                  `json:"remove_volumes,omitempty"`
	Connections     *ConnectionPlan            `json:"connections,omitempty"`
	Redirect        *Redirect                  `json:"redirect,omitempty"`
	ObjectHooks     *[]ObjectHooks             `json:"object_hooks,omitempty"`
}
```

Example:

```json
{
  "services": {
    "app": {
      "image": "example/app:latest",
      "network_groups": ["frontend"],
      "environment": {
        "PORT": "8080"
      },
      "bindings": [
        {
          "container_port": 8080,
          "host_port": 8080
        }
      ]
    }
  },
  "volumes": ["app-data"],
  "remove_services": ["old-worker"],
  "remove_volumes": ["old-data"]
}
```

## Unified Values

Value interpolation is opt-in. Add `"values_version": 1` to metadata and send
the plan only to a runner version that implements this contract. Omitted or
`null` keeps every string literal. The only supported non-null version is `1`;
other versions fail before Docker mutation. A legacy runner may ignore unknown
JSON fields, so the manager or Commander must select a values-capable runner
whenever a plan uses references or either create-spec `secrets` array.

Secret references retain their existing forms:

```text
[[secret:run:KEY]]
[[secret:manager:KEY]]
[[secret:resource:RESOURCE_UUID:KEY]]
[[secret:connection:CONNECTION_UUID:KEY]]
```

`run` and `manager` use the current run and manager UUIDs. Resource and
connection forms name existing owner UUIDs. `KEY` is a nonempty URL-percent-
encoded UTF-8 component; reserved characters such as `:`, `%`, and `]` must
be encoded. The runner decodes the key once. Missing or unauthorized values,
invalid encoding/UUIDs, unknown secret forms, and unterminated references fail
preflight. Empty stored values are valid. Inserted values remain opaque text and
are never parsed recursively.

Runner-role services can capture run-scoped variables from stdout or stderr
using named Go regular-expression groups:

```json
{
  "values_version": 1,
  "services": {
    "migrate": {
      "image": "example/migrate:latest",
      "role": "runner",
      "capture_variables": [
        { "stream": "stdout", "pattern": "host=(?P<DB_HOST>\\S+)" }
      ]
    },
    "api": {
      "image": "example/api:latest",
      "depends_on": ["migrate"],
      "environment": { "DATABASE_HOST": "[[variable:DB_HOST]]" }
    }
  }
}
```

Capture group names must be valid variable names and unique across the plan.
Every pattern requires a named group. A service using a variable must depend
directly or transitively on its runner producer. Chronjobs can use variables
produced by normal services. A fail runner can use its parent runner's values
and dependency ancestry, but fail-runner captures cannot satisfy normal
services or chronjobs. Missing required captures and references fail with
content-free errors.

`stream_output` defaults to true without captures and false with captures. Set
it explicitly to true to forward captured-runner logs; the runner first parses
the complete output and replaces captured values throughout stdout and stderr
with `[REDACTED]`, including values printed before the capture line. Streaming
that needs value redaction is limited to 16 MiB; exceeding the limit fails
without forwarding partial output. An explicit false suppresses logs without
captures too.

Parsing happens after JSON decoding. A decoded `\[[` escapes a marker opener;
in JSON, `"\\[[variable:NAME]]"` preserves that marker literally. Two decoded
backslashes (`"\\\\[[variable:NAME]]"`) leave one backslash before
expansion. Escaping applies to secret and variable markers. Substitution is
one pass.

All four secret reference forms above, including
`[[secret:connection:CONNECTION_UUID:KEY]]`, work in every supported value
position. With `values_version: 1`, the runner expands:

- Service and inline `fail_runner` command arguments and environment values.
- Regular-service `health_check.test` elements.
- Chronjob service command arguments and environment values.
- File contents of config maps referenced by a service or chronjob.
- String values nested recursively in database-hook bindings.
- Service and inline `fail_runner` `save_secrets[].value` fields.

Connection secrets are not limited to command, environment, and health-check
values. Hook query strings and binding keys remain literal. Names, images,
labels, mount paths and volume names, connection descriptors,
resource/connection metadata, redirects, and other arbitrary JSON remain
literal. A literal mount path does not prevent interpolation in the contents
of a config-map file projected at that path. Unused config maps are not parsed
or fetched. A normal run fetches all unique required secrets before Docker
mutation and resolves variables when their dependent services and hooks run.

A run secret may appear in any number of fields and may be copied to any number
of newly created owners. Add the exact run-secret key to
`CreateResourceSpec.secrets` or `CreateConnectionSpec.secrets`; the runner
copies the same key and value after creation. The run secret is not consumed.
Empty or omitted arrays request no copies; entries must be nonblank and unique
within a spec. A nonempty array requires `values_version: 1`. Reused owners are
not modified as a side effect of inspection. A manager can create a connection
only for a resource it owns; the agent remains the authority for that ownership
check.

### Saving values as secrets

Services and inline `fail_runner` services may save literal or interpolated
values with `save_secrets`. Each entry names a `key` and `value`, plus one
`owner` selector:

```json
{
  "save_secrets": [
    {
      "owner": { "kind": "run" },
      "key": "DB_PASSWORD",
      "value": "[[variable:DB_PASSWORD]]"
    },
    {
      "owner": { "kind": "manager" },
      "key": "LAST_DB_PASSWORD",
      "value": "[[variable:DB_PASSWORD]]"
    },
    {
      "owner": { "kind": "resource", "id": "<resource-uuid>" },
      "key": "PASSWORD",
      "value": "[[variable:DB_PASSWORD]]"
    },
    {
      "owner": { "kind": "connection", "id": "<connection-uuid>" },
      "key": "PASSWORD",
      "value": "[[variable:DB_PASSWORD]]"
    },
    {
      "owner": { "kind": "resource", "service": "database", "name": "primary" },
      "key": "PASSWORD",
      "value": "[[variable:DB_PASSWORD]]"
    },
    {
      "owner": { "kind": "connection", "name": "primary" },
      "key": "PASSWORD",
      "value": "[[variable:DB_PASSWORD]]"
    }
  ]
}
```

Existing resource and connection UUID writes use the agent's existing secret
API and ownership checks. A planned resource selector must identify one
resource in the named service; a planned connection selector must match one
named connection create operation. Exactly one owner selector form is
allowed. Writes require the unchanged `values_version: 1`, accept literals,
secret references, and `[[variable:NAME]]`, and substitute once. The runner
validates references and dependency ancestry before mutation. Duplicate
owner/key destinations and conflicts with a copy to the same new owner fail
validation.

Normal service writes happen after startup and health checks, before resource
publication. Runner writes happen after capture parsing and before handling a
nonzero exit, including writes with valid captures from a failed runner. A
planned resource or named connection is updated after its ID is returned and
before its after-hook or lifecycle event. Existing `secrets` arrays continue
to copy exact run-secret keys; a service can first save a run key and copy it
to a resource it creates.

When runner logs are streamed with `save_secrets`, the runner buffers at most
16 MiB and redacts pending write values before forwarding output. Set
`stream_output` to false to suppress output. Successful writes to existing
owners remain persisted if a later deployment operation fails; writes are not
part of run rollback. Newly created owners still use existing cleanup and
recovery. Chronjob service firings do not perform secret writes.

Chronjob values are captured when the scheduler is installed; replacing the
scheduler is required to refresh them. Schedulers receive only resolved
configuration, never the run token or agent endpoint. Docker operators can
inspect container commands and environment; projected config-map files use
mode `0444`. Teardown hook bindings can use secrets but cannot use run
variables. Do not log values or include them in errors, labels, events,
metadata, or hook query strings.

Example:

```json
{
  "values_version": 1,
  "services": {
    "api": {
      "image": "example/api:1",
      "command": ["--database-password", "[[secret:run:DB_PASSWORD]]"],
      "environment": { "API_TOKEN": "[[secret:manager:API_TOKEN]]" }
    }
  }
}
```

A produced resource or created connection can copy a reusable run secret with
`"secrets": ["DB_PASSWORD"]` on its respective create specification.

### Chronjobs

`chronjobs` maps safe job names to a timer and a nonempty service map. Timers
must have exactly five cron fields and are interpreted in UTC. The scheduler
starts at the next future firing and does not replay missed firings. Every
firing creates new containers even while earlier jobs are still running.

```json
{
  "chronjobs": {
    "cleanup": {
      "timer": "0 2 * * *",
      "services": {
        "prune": {
          "image": "example/prune:1",
          "command": ["--expired"],
          "connections": [
            {
              "type": "Connection",
              "data": { "resource": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }
            }
          ]
        }
      }
    }
  },
  "remove_chronjobs": ["retired-cleanup"]
}
```

Scheduled services accept only `image`, `command`, `environment`, `volumes`,
`config_maps`, `network_groups`, and `connections`. They do not support roles,
dependencies, bindings, health checks, scaling, failure runners, or produced
resources. The manager should provide normal resource `Connection` references;
the runner resolves them before passing only `Network` or `Platform`
descriptors to the scheduler. The scheduler has no agent endpoint or token.
Installing Docker chronjobs requires the runner's `DOCKER_HOST` to identify a
local Unix socket. The runner mounts that socket into the scheduler and
forwards the configuration's platform value.

`remove_chronjobs` stops the selected schedulers. Already launched child
containers continue running. Full teardown stops schedulers first, then
removes all remaining manager containers, volumes, and networks.

Only include operations the current run should perform.

### Object lifecycle hooks

The optional `object_hooks` field selects one database request before and/or
after a concrete object creation or removal. The shared contract is:

```go
type ObjectKind string

const (
	ObjectKindContainer  ObjectKind = "container"
	ObjectKindVolume     ObjectKind = "volume"
	ObjectKindNetwork    ObjectKind = "network"
	ObjectKindResource   ObjectKind = "resource"
	ObjectKindConnection ObjectKind = "connection"
)

type DatabaseQuery struct {
	Query    string         `json:"query"`
	Bindings map[string]any `json:"bindings,omitempty"`
}

type DatabaseQueryResult struct {
	Statement uint64          `json:"statement"`
	Status    string          `json:"status"`
	Time      string          `json:"time"`
	Result    json.RawMessage `json:"result"`
}

type DatabaseQueryResponse struct {
	Results []DatabaseQueryResult `json:"results"`
}

type OperationHooks struct {
	Before  *DatabaseQuery `json:"before,omitempty"`
	After   *DatabaseQuery `json:"after,omitempty"`
	Failure *DatabaseQuery `json:"failure,omitempty"`
}

type ObjectHooks struct {
	Kind   ObjectKind      `json:"kind"`
	Name   string          `json:"name"`
	Create *OperationHooks `json:"create,omitempty"`
	Remove *OperationHooks `json:"remove,omitempty"`
}

type Event struct {
	Event   string `json:"event"`
	Message string `json:"message"`
}
```

Complete manager metadata example:

```json
{
  "volumes": ["data"],
  "object_hooks": [
    {
      "kind": "volume",
      "name": "data",
      "create": {
        "before": {
          "query": "UPSERT deployment:current MERGE $state",
          "bindings": { "state": { "phase": "creating-volume" } }
        },
        "after": {
          "query": "UPSERT deployment:current MERGE $state",
          "bindings": { "state": { "phase": "volume-created" } }
        }
      }
    }
  ]
}
```

The runner uses this sequence only when the object is missing or a removal is
actually found:

```text
existence check -> before query -> mutation -> after query -> best-effort event
```

The five logical object kinds are `container`, `volume`, `network`, `resource`,
and `connection`. Names are stable selectors: service map key for a container;
declared volume name or reserved `@runner` for the runner-provided volume;
`@manager`, `group:<group>`, or `resource:<resource-name>` for networks;
resource specification/label name for resources; and the optional connection
plan `name` for connections. A connection hook requires a matching named
create or remove operation. Add a `Name *string` field with JSON tag
`json:"name,omitempty"` to both `CreateConnectionSpec` and
`RemoveConnectionSpec`; this runner-only field is not sent to the agent.

Before hooks are mandatory gates. If a before query or the Docker/agent
mutation fails, no after query or success event is emitted. The runner accepts
only a non-empty result list whose every statement has status exactly `OK`.
An after-query failure does not roll back the successful mutation; the runner
still attempts the event and then fails the run. An optional `failure` query
runs once if the before query, mutation, or after query fails. A failure-query
error is joined with the original error and does not trigger another failure
query. Event delivery is best-effort:
transport errors and non-`202 Accepted` responses are ignored. Query results
never alter the plan, and database requests are never retried.

Events use exactly `created` or `removed` and messages use Go-quoted logical
names, for example:

```json
{ "event": "created", "message": "created container \"api\"" }
```

Redelivery and ambiguous create/remove outcomes may duplicate events. Make
hooks idempotent with deterministic IDs, `UPSERT`, `IF NOT EXISTS`, unique
indexes, or transactions as appropriate. Do not depend on arbitrary query
result values to continue deployment.

### Failed-run recovery

On a non-`teardown` failure, the runner uses a bounded cleanup context to
remove manager/run-labeled Docker objects. It removes run-marked agent
connections before resources and restores prior service containers staged for
replacement. Resource and connection create requests preserve manager-supplied
agent labels and add a random run-recovery marker; empty user labels stay
empty, though the request includes that marker while recovery is active.
Cleanup is best-effort and continues across independent steps. It runs only
while the runner process is alive and cannot reverse database effects,
redirect updates, or explicit removals of preexisting objects.

Do not emit empty removal entries or invalid placeholder values.

## Nil, Empty, and Omitted Values

Optional fields use pointers deliberately.

The following states may have different meanings:

- Field omitted or pointer is nil
- Field present with an empty array
- Field present with a non-empty array
- Nested field present with a nil value

Do not convert every nil field into an empty collection automatically.

For ordinary setup metadata, omit sections that do not require an operation.

Example:

```json
{
  "services": {
    "app": {
      "image": "example/app:latest"
    }
  }
}
```

This is preferable to filling every optional field with empty arrays and objects.

## Services

Services are defined as a map:

```go
map[string]MetadataService
```

Example:

```json
{
  "services": {
    "database": {
      "image": "postgres:18"
    },
    "app": {
      "image": "example/app:latest",
      "depends_on": ["database"]
    }
  }
}
```

The map key is the service identity.

It is used for:

- Dependency references
- Docker container naming
- Docker labels
- Removal requests
- Service ordering

Choose service keys that are:

- Stable
- Unique within the manager
- Human-readable
- Safe to use as part of a Docker object name

Do not use dynamically generated service keys unless the manager truly creates dynamic service instances.

Changing a service key causes the runner to treat it as a different service.

## Service Definition

A service supports:

```go
type MetadataService struct {
	Image         string                `json:"image"`
	Command       *[]string             `json:"command,omitempty"`
	Aliases       *[]string             `json:"aliases,omitempty"`
	NetworkGroups *[]string             `json:"network_groups,omitempty"`
	Role          *ServiceRole          `json:"role,omitempty"`
	DependsOn     *[]string             `json:"depends_on,omitempty"`
	Bindings      *[]BindingSpec        `json:"bindings,omitempty"`
	ConfigMaps    *[]ConfigMapBinding   `json:"config_maps,omitempty"`
	Connections   *[]ResourceConnection `json:"connections,omitempty"`
	Resources     *[]CreateResourceSpec `json:"resources,omitempty"`
	Environment   map[string]string     `json:"environment,omitempty"`
	Volumes       *[]VolumeMount        `json:"volumes,omitempty"`
	Scale         *ScaleSpec            `json:"scale,omitempty"`
	HealthCheck   *HealthCheckSpec       `json:"health_check,omitempty"`
	FailRunner    *MetadataService       `json:"fail_runner,omitempty"`
	SaveSecrets   []SecretWrite          `json:"save_secrets,omitempty"`
}

type HealthCheckSpec struct {
	Test               []string `json:"test"`
	IntervalSeconds    int64    `json:"interval_seconds,omitempty"`
	TimeoutSeconds     int64    `json:"timeout_seconds,omitempty"`
	StartPeriodSeconds int64    `json:"start_period_seconds,omitempty"`
	Retries            int      `json:"retries,omitempty"`
	WaitTimeoutSeconds int64    `json:"wait_timeout_seconds,omitempty"`
	LogHealthOutput    bool     `json:"log_health_output,omitempty"`
	LogContainerOutput *bool    `json:"log_container_output,omitempty"`
}

type ConfigMapBinding struct {
	Name      string `json:"name"`
	MountPath string `json:"mount_path"`
}
```

A minimal service requires an image:

```json
{
  "services": {
    "app": {
      "image": "example/app:latest"
    }
  }
}
```

Do not emit a service with an empty image.

### Commands

`command` is an optional array of strings mapped to Docker `Config.Cmd`.

```json
{
  "image": "example/app:latest",
  "command": ["serve", "--port", "8080"]
}
```

Its semantics are:

- Omitted or `null`: preserve the image’s default command.
- Non-empty array: replace Docker `Cmd` with the supplied argument vector.
- Empty array: invalid for Docker metadata validation; do not emit it.

This field changes only `Cmd`; it does not change the image entrypoint. Each array element is passed as one argument, with no shell parsing or string splitting by the runner. Use a runner-role service when the command is one-time work; normal services retain their usual restart behavior.

### Health checks

Long-running services may request a Docker health check:

```json
{
  "health_check": {
    "test": ["CMD-SHELL", "curl -fsS http://localhost:8080/health"],
    "interval_seconds": 10,
    "timeout_seconds": 3,
    "start_period_seconds": 30,
    "retries": 3,
    "wait_timeout_seconds": 300,
    "log_health_output": true,
    "log_container_output": true
  }
}
```

`test` is required. It must be `CMD` followed by at least one argument, or
`CMD-SHELL` followed by exactly one nonblank command. The runner passes the
array to Docker as supplied and does not split command strings; `CMD-SHELL`
requires a shell in the image. Timing values and `retries` are optional and
must be nonnegative. Zero or omission leaves Docker timing and retry values
unset so image settings or Docker defaults apply. `wait_timeout_seconds`
defaults to 300 seconds; a positive value overrides it.

After starting a checked service, the runner inspects Docker health once per
second and waits for `healthy` before publishing that service's resources or
allowing its dependents to start. `unhealthy`, a stopped or restarting
container, unavailable or unexpected health status, Docker inspection failure,
context cancellation, or wait timeout fails setup. When enabled,
`log_health_output` prints Docker's retained probe records on a failed wait,
including the `restarting` case. It defaults to false. The independent
`log_container_output` option controls the last 100 stdout and stderr lines.
Omitting it preserves legacy behavior: the runner prints the tail when no
resolved values or service secret writes are active. Set it to `true` to
request the tail even when values are active, or `false` to suppress it.
Enabled sources print an explicit message when Docker has no output or cannot
provide it. Known secrets and captured values are redacted. Opted-in output
may still contain sensitive text the runner does not know, so managers should
enable it only when the container diagnostics are safe to show in the runner
log. Diagnostic retrieval does not replace the original setup error. The
container-created lifecycle event may already have been emitted before start
and health waiting; a later health failure fails the run and enters normal run
recovery. Health checks are invalid on `runner` and inline `fail_runner`
services, whose success is based on exit status.

For a normal service with a configured health check, diagnostic output is
selected independently by the two health check options above. If the health
check is absent or `null`, existing start-failure logging behavior applies
and setup does not wait for an image-defined Docker health check.
When present, the supplied test replaces the image health-check test, and
configured timing/retry values override the corresponding image values.

### Image availability

Before creating networks or replacing a service container, the Docker runner
asks the agent to ensure the configured image is available with
`POST /v1/images/ensure`. The runner sends the image name with bearer
authentication and accepts only `204 No Content`. Image pulling and registry
credentials stay inside the agent; the runner does not inspect Docker image
availability or read registry credential files. The runner image itself is
already running and is not ensured here.

## Long-Running Services

The default service role is a long-running service.

It may be explicitly represented as:

```json
{
  "role": "service"
}
```

A normal service container:

- Is started by Docker
- Uses an always-restart policy
- Remains running after the runner exits
- May expose ports
- May mount volumes
- May provide resources
- May consume resource connections
- May declare an optional Docker `health_check`

The role may be omitted for normal services.

## Runner Services

Use the `runner` role for one-time setup, migration, initialization, or command execution containers.

Example:

```json
{
  "services": {
    "migrate": {
      "image": "example/app:latest",
      "role": "runner",
      "environment": {
        "COMMAND": "migrate"
      }
    },
    "app": {
      "image": "example/app:latest",
      "depends_on": ["migrate"]
    }
  }
}
```

A runner-role container:

- Uses no restart policy
- Starts once
- Streams stdout and stderr
- Blocks dependent services until it completes
- Is removed after completion
- Fails the run when it exits with a nonzero status

Do not use a runner role for a process that must remain active.

An inline `fail_runner` may be declared on a runner-role service. It defaults
to role `runner`, runs once after its parent runner service fails, and cannot
nest another fail runner or declare dependencies. It cannot declare
`health_check`.

Do not create dependency cycles between runner and service containers.

## Execution Success and Run Status

The runner has no public manager run-status enum in this contract.

Runner execution succeeds when all requested platform operations return successfully. For a `runner`-role container, exit code `0` is success; every nonzero exit code is returned as an execution error. For the top-level runner process, successful platform execution returns normally and any returned error causes the process to fail.

Do not translate these outcomes into guessed manager status strings or numbers. The manager or commander framework owns its run-status type and the terminal value that means success. Use the constants and completion API provided by that framework. If those definitions are unavailable, request the authoritative manager/commander contract before implementing status updates.

This distinction is important:

- Container exit status belongs to the executed workload.
- Runner process success or failure belongs to platform execution.
- Manager run status belongs to the manager or commander framework.

## Dependencies

Dependencies reference service map keys:

```json
{
  "services": {
    "database": {
      "image": "postgres:18"
    },
    "app": {
      "image": "example/app:latest",
      "depends_on": ["database"]
    }
  }
}
```

Every dependency must exist in the same `services` map for that run.

The runner rejects:

- Missing dependency keys
- Circular dependency graphs

Dependencies control setup ordering only.

Dependencies do not perform application-level checks by themselves. A
long-running dependency with an explicit `health_check` must become healthy
before dependent service setup continues.

A container being started does not necessarily mean the application inside it is ready to accept traffic. Without an explicit `health_check`, setup continues after Docker starts the container, as before.

Use an explicit runner step, a service `health_check`, or application retry behavior when startup readiness matters.

## Environment Variables

Environment variables are supplied as a string map:

```json
{
  "environment": {
    "PORT": "8080",
    "DATABASE_HOST": "database",
    "LOG_LEVEL": "info"
  }
}
```

Every value must be represented as a string.

Do not place secrets into ordinary logs. Explicit health diagnostic options
redact values known to the runner, but may reveal sensitive text emitted by a
container that the runner cannot identify.

Do not include environment variables unrelated to the service.

Prefer stable service aliases or connection data over hard-coded container IP addresses.

## Network Groups

Network groups allow selected services to share an isolated Docker network.

Example:

```json
{
  "services": {
    "proxy": {
      "image": "example/proxy:latest",
      "network_groups": ["frontend"]
    },
    "app": {
      "image": "example/app:latest",
      "network_groups": ["frontend", "backend"]
    },
    "database": {
      "image": "postgres:18",
      "network_groups": ["backend"]
    }
  }
}
```

The Docker runner scopes network group names to the manager.

Use a network group when multiple services within the same manager need direct communication.

Do not use network groups to reference a resource owned by another manager. Use a resource platform connection for that case.

## Default Network

When a service has no:

- Network groups
- Platform resource connection networks
- Produced resource networks

the Docker runner attaches it to a manager-level default network.

Do not depend on the exact Docker name of this default network from manager implementation code.

Use aliases and service configuration rather than reconstructing runner-generated object names.

## Aliases

Aliases are Docker network aliases applied to each network joined by the service.

Example:

```json
{
  "aliases": ["api", "internal-api"]
}
```

Use aliases when another service needs a stable hostname that differs from the service key.

Avoid duplicate aliases that would create ambiguous DNS resolution on the same Docker network.

## Volumes

Top-level volumes declare manager-owned persistent volumes:

```json
{
  "volumes": ["database-data", "uploads"]
}
```

A service mounts a declared volume using:

```json
{
  "volumes": [
    {
      "name": "database-data",
      "mount_path": "/var/lib/postgresql/data"
    }
  ]
}
```

Mount paths must:

- Be non-empty
- Be absolute
- Be unique within the service

Volume names must:

- Be non-empty
- Be unique in `metadata.volumes`

A named volume that is not declared in the current metadata must already exist for that manager.

Do not rely on undeclared volume creation.

Declare new volumes explicitly.

## Runner-Provided Volume

A volume mount with a null name requests the runner-provided manager volume:

```json
{
  "volumes": [
    {
      "name": null,
      "mount_path": "/runner"
    }
  ]
}
```

Use this only when the manager framework or runner contract expects shared runner-provided data at that mount.

Do not use an omitted `name` accidentally. In Go, this is represented with a nil pointer.

## Config maps

`metadata.config_maps` is a map from logical config-map names to text file contents. A service projects a named map with:

```json
{
  "config_maps": [
    {
      "name": "app-config",
      "mount_path": "/etc/app"
    }
  ]
}
```

Each map key must be a filename without path separators. The mount path must be absolute and clean, must not overlap a service volume mount, and must not be repeated within the service. During Docker setup the runner creates the replacement container, copies a deterministic tar archive containing the files to `/`, and starts the container only after the copy succeeds. Files use mode `0444`; content is text-only and is not an immutable mount.

## Removing Volumes

Volumes are removed using logical names:

```json
{
  "remove_volumes": ["old-data"]
}
```

Do not include a volume in both `volumes` and `remove_volumes` in the same plan.

Do not remove a volume still required by a service that remains deployed.

Volume deletion is destructive.

The manager implementation must decide removals deliberately.

## Bindings

Bindings define container ports and optional host publication.

Example:

```json
{
  "bindings": [
    {
      "container_port": 8080,
      "host_port": 8080,
      "host_ip": "0.0.0.0"
    }
  ]
}
```

Supported fields are:

```go
type BindingSpec struct {
	ContainerPort *int
	HostPort      *int
	HostIP        *string
	ContainerIP   *string
}
```

The current Docker runner applies:

- `container_port`
- `host_port`
- `host_ip`

`container_ip` is not currently implemented.

The Docker implementation currently exposes each binding for both TCP and UDP.

Do not depend on protocol-specific binding behavior until the model and runner support protocol selection explicitly.

Use a valid numeric IP address for `host_ip`.

Do not use a hostname for `host_ip`.

## Produced Resources

A long-running service may publish one or more Deploy Commander resources.

Example:

```json
{
  "services": {
    "database": {
      "image": "postgres:18",
      "resources": [
        {
          "resource_type": "postgres",
          "name": "primary-database",
          "secrets": ["DB_PASSWORD"],
          "metadata": {
            "database": "app"
          }
        }
      ]
    }
  }
}
```

The resource specification contains:

```go
type CreateResourceSpec struct {
	ResourceType     string
	Name             string
	PublicConnection *PublicConnection
	Metadata         json.RawMessage
	Labels           map[string]string `json:"labels,omitempty"`
	Secrets          []string          `json:"secrets,omitempty"`
}
```

### What the manager must provide

The manager must place the resource specification on the producing service and provide:

- A stable, non-empty resource type
- A stable, non-empty resource name
- Resource metadata needed by authorized consumers
- A public connection only when the resource is externally reachable

The manager should also give the producing service any Docker alias that consumers are expected to use as a hostname. The runner applies declared aliases, but it does not invent a resource hostname.

Labels are optional agent metadata. The runner preserves supplied label keys
and values, including empty string values; nil or empty manager maps add no
manager labels. During an active run, the runner also adds a random
run-recovery marker to resource creation requests. Label validation belongs to
the agent. These are not Docker ownership labels.

Do not add Docker platform-connection data to `CreateResourceSpec`. The manager declares the resource; it does not calculate or create the resource's Docker network.

### What the runner handles

For a normal Docker service, the runner:

1. Creates a dedicated Docker resource network.
2. Attaches the producing service to the network.
3. Generates Docker platform connection data containing the exact network name.
4. Publishes the resource and generated platform connection through the agent.

Use stable resource names.

Resource names are used during cleanup.

Do not publish two different logical resources with the same name unless the surrounding agent contract explicitly supports it.

## Resource Metadata

Resource metadata is arbitrary JSON.

Example:

```json
{
  "metadata": {
    "engine": "postgres",
    "version": "18",
    "database": "app"
  }
}
```

Metadata should contain the information a consuming manager needs to understand or configure use of the resource.

Do not include sensitive credentials unless the resource contract specifically requires them and Deploy Commander provides secure handling.

Platform connection data is added by the runner and should not be manually placed in resource metadata.

## Public Connections

A produced resource may advertise a public address and port:

```json
{
  "public_connection": {
    "address": "database.example.com",
    "port": 5432
  }
}
```

Both fields are optional.

Only provide a public connection when the resource is actually reachable at that address.

Do not use a container-local address as a public connection.

## Consuming Resource Connections

Services should consume resources through the advised `Connection` reference.
The resource UUID is required. The connection UUID is optional:

```json
{
  "type": "Connection",
  "data": {
    "resource": "11111111-1111-1111-1111-111111111111"
  }
}
```

Use the resource-only form only when the active manager owns the resource. The
agent API enforces that ownership rule; the runner does not duplicate the
authorization policy. When consumption is authorized through a Deploy
Commander connection, include both UUIDs:

```json
{
  "type": "Connection",
  "data": {
    "resource": "11111111-1111-1111-1111-111111111111",
    "connection": "22222222-2222-2222-2222-222222222222"
  }
}
```

The resource UUID remains required because the connection-detail endpoint uses
both IDs. The runner resolves these references before Docker mutations and
normalizes the live descriptor into the service's working metadata.

Inline `Platform` and `Network` forms remain supported alternatives when a
manager specifically needs to provide authoritative data directly. They are
not the advised default.

A Docker platform connection has this exact serialized structure:

```json
{
  "type": "Platform",
  "data": {
    "network": "existing-docker-network-name"
  }
}
```

Example service:

```json
{
  "services": {
    "app": {
      "image": "example/app:latest",
      "connections": [
        {
          "type": "Platform",
          "data": {
            "network": "resource-network-name"
          }
        }
      ]
    }
  }
}
```

### What the manager must provide

The manager must:

1. Prefer a `Connection` reference with the required resource UUID.
2. Omit the connection UUID only when the active manager owns the resource; otherwise provide the authorized connection UUID.
3. Translate resource metadata, public connection data, credentials, or address-based connection data into the consuming application's configuration when its resource contract requires that translation.

For a directly supplied Docker `Platform` connection, the `data` object must contain a non-empty string field named `network`. For a `Connection` reference, use the network descriptor returned by the runner's agent lookup exactly as provided.

The manager must not provide a resource name, service name, manager ID, container name, or URL in place of the Docker network name. It must not prefix the value with the consuming manager ID, reconstruct it from a resource name, create the network itself, or substitute a network-group name.

### What the runner handles

For each `Connection` reference, the runner:

1. Calls the resource-detail endpoint when `connection` is omitted or `null`, or the connection-detail endpoint when it is present.
2. Fails before Docker mutations if the lookup, returned ID, or required Docker platform descriptor is invalid.
3. Normalizes the live platform descriptor to the existing Docker connection path.
4. Verifies that a resolved `Platform` network exists.
5. Includes that exact network in the container's Docker endpoint configuration.

For each inline Docker `Platform` connection, the runner:

1. Decodes the platform connection data.
2. Verifies that the named Docker network exists.
3. Includes that exact network in the container's Docker endpoint configuration.
4. Attaches the service when it creates the container.

The runner execution for the resource-producing manager creates and owns the resource network. The producing manager supplies the resource declaration; the consuming manager supplies the resolved connection returned for that resource. Neither manager implementation should create the Docker network directly.

The runner verifies only that the supplied network exists. It trusts resolved
platform data and does not independently prove that an inline network belongs
to the intended resource. Resource-only ownership is enforced by the agent;
the manager must use an authorized connection UUID when it does not own the
resource.

## Network Connections

The shared model also defines a network connection:

```json
{
  "type": "Network",
  "data": {
    "address": "service.example.com",
    "port": 443
  }
}
```

The current Docker setup logic specifically uses platform connections for Docker network attachment.

Network connection data may still be useful to manager application configuration, such as generating environment variables.

Do not assume the Docker runner automatically converts network connections into service environment variables.

The manager implementation must translate usable connection details into the service’s configuration.

The runner currently skips a `Network` connection when assembling Docker network endpoints. Supplying only an address-based `Network` connection will not attach the container to a Docker network.

## Creating Deploy Commander Connections

Connection creation plans are separate from service connection attachment.

This distinction is critical:

- `services.<service>.connections` tells the runner which already-resolved platform networks the service must join during container creation.
- Top-level `metadata.connections.create` tells the runner to create a Deploy Commander connection record through the agent.

The runner applies service setup before the top-level connection plan. Creating a connection record in the same runner configuration does not resolve it into a service connection or retroactively attach an already-created container. The manager must supply the advised `Connection` reference separately in the consuming service's `connections` array when attachment is required in that run.

Example:

```json
{
  "connections": {
    "create": [
      {
        "manager": "consumer-manager-uuid",
        "resource": {
          "id": "resource-uuid"
        },
        "metadata": {
          "purpose": "primary database"
        },
        "secrets": ["DB_PASSWORD"],
        "labels": {
          "environment": "production",
          "region": "west"
        }
      }
    ]
  }
}
```

A create specification contains:

- The manager receiving the connection
- A resource reference
- Arbitrary connection metadata
- Optional agent labels as a string map
- Optional `secrets` array of current-run secret keys to copy to a newly created connection

The field is represented in the shared model as:

```go
Secrets []string `json:"secrets,omitempty"`
```

- An optional runner-only logical `name` used to select connection hooks and
  format lifecycle events

`CreateConnectionSpec.Labels` is forwarded to the agent through
`CreateConnectionRequest.Labels`, preserving supplied keys and values. During
an active run, the runner also adds a random run-recovery marker to connection
creation requests. `CreateConnectionSpec.Name` remains runner-only and is not
serialized into the agent request. `CreateConnectionSpec.Secrets` is also
runner-only; after the agent creates a connection, the runner copies each
listed current-run secret under the same key before success hooks or events.

The current runner requires the resource reference to contain an existing resource UUID:

```json
{
  "resource": {
    "id": "resource-uuid"
  }
}
```

Although the model supports service and name references, the current runner cannot resolve:

```json
{
  "resource": {
    "service": "database",
    "name": "primary-database"
  }
}
```

Do not emit service/name references until runner-side resolution is implemented.

If a database hook targets a connection create, the create specification must
have a nonblank `name`, and names must be unique within the create list. The
logical name is not sent in the agent request. An unnamed create still emits a
best-effort event using the UUID returned by the agent, but cannot be selected
by a connection hook.

## Removing Deploy Commander Connections

A connection removal currently requires both:

- The connection UUID
- The related resource UUID

Example:

```json
{
  "connections": {
    "remove": [
      {
        "id": "connection-uuid",
        "resource": {
          "id": "resource-uuid"
        }
      }
    ]
  }
}
```

Resource-only removal is not currently supported.

An optional nonblank `name` may identify a removal for lifecycle hooks; names
must be unique within the remove list. A removal hook requires a matching named
remove operation. The name is runner-only and is not sent to the agent. For an
unnamed removal, the lifecycle event uses the existing connection UUID.

Do not emit:

```json
{
  "resource": {
    "id": "resource-uuid"
  }
}
```

without a connection ID and expect all resource connections to be removed.

## Redirects

Redirect metadata controls the manager redirect stored by the Deploy Commander agent.

Set a redirect:

```json
{
  "redirect": {
    "redirect": "https://example.com"
  }
}
```

Clear the redirect:

```json
{
  "redirect": {
    "redirect": null
  }
}
```

Do not update the redirect:

```json
{}
```

or omit `redirect` from the metadata.

These states are intentionally different.

Do not emit an empty redirect object unless the intention is to clear the redirect.

## Removing Services

Services are removed by service key:

```json
{
  "remove_services": ["old-worker"]
}
```

The Docker runner resolves this to the manager-scoped container name.

When removing a service, the runner also inspects its labels and attempts to delete resources previously published by that service.

Use the exact stable service key originally used to create the service.

Do not use:

- Container IDs
- Image names
- Resource names
- Network aliases

in `remove_services`.

Do not include the same service in both `services` and `remove_services` in one plan.

## Full Teardown

A teardown configuration uses:

```json
{
  "action": "teardown"
}
```

The Docker runner removes manager-owned resources in this order:

1. Services
2. Volumes
3. Networks

Teardown is based on Docker ownership labels associated with the manager UUID.

Do not attempt to reproduce full teardown using large `remove_services` and `remove_volumes` lists.

Use the teardown action when the entire manager deployment should be removed.

## Scale Specification

The shared model contains:

```go
type ScaleSpec struct {
	Mode string
	Min  *int
	Max  *int
}
```

Known scale modes include:

```text
single
autoscale
autoscale-core
global
```

The current Docker runner does not implement scaling behavior.

Do not rely on `scale` changing the number of Docker containers.

You may preserve scale intent in generated metadata for compatibility, but do not claim that it is currently enforced.

## Reconciliation Model

The runner does not perform a full declarative comparison against every existing Docker object.

It performs the operations explicitly represented by metadata:

- Services in `services` are created or replaced.
- Volumes in `volumes` are created if missing.
- Services in `remove_services` are removed.
- Volumes in `remove_volumes` are removed.
- Connection plans are applied.
- Redirect changes are applied.

The manager implementation is responsible for generating the correct operation plan.

Do not assume that omitting an old service automatically removes it.

Explicitly include it in `remove_services`.

Do not assume that omitting an old volume automatically removes it.

Explicitly include it in `remove_volumes`.

## Update Strategy

When updating an existing manager deployment:

1. Determine the desired service definitions.
2. Determine which existing service keys are no longer desired.
3. Include desired or changed services in `services`.
4. Include obsolete services in `remove_services`.
5. Include new required volumes in `volumes`.
6. Include intentionally deleted volumes in `remove_volumes`.
7. Add advised `Connection` references for required resources, omitting the connection UUID only for resources owned by this manager.
8. Build connection create or remove plans.
9. Set redirect metadata only when a redirect operation is required.

Do not remove persistent data merely because a service was removed.

Treat volume removal as a separate destructive decision.

## Idempotency Expectations

Generated metadata should be safe to apply more than once where practical.

Prefer:

- Stable service keys
- Stable resource names
- Stable volume names
- Stable network group names
- Deterministic configuration
- Explicit removals

Avoid:

- Random service names
- Random resource names
- Recreating connection plans without checking current connections
- Deleting and recreating persistent volumes during ordinary updates
- Using timestamps as identities

The runner replaces a service container when that service appears in the current setup plan.

Your manager should avoid including unrelated unchanged services when unnecessary, unless the manager intentionally performs full service reconciliation.

Lifecycle events can be duplicated when a runner is redelivered or a create
response is ambiguous after a transport failure. Database hooks must therefore
be idempotent. Use deterministic record IDs, `UPSERT`, `IF NOT EXISTS`, unique
indexes, or transactions. The runner does not retry database requests, dedupe
events, or roll back an object after an after-query failure.

## Current-State Queries

Before generating removal or connection operations, use the Deploy Commander manager interface or RPC calls to inspect current state where needed.

Relevant queries may include:

- Existing manager resources
- Existing connections
- Connections for a specific manager
- Connections for a specific resource
- Existing redirect state
- Prior manager configuration
- Current deployment metadata

Use the actual available RPC contract.

Do not invent RPC calls.

Do not infer connection ownership from names alone.

## Resource and Connection Ownership

A manager must only access connection data that it is authorized to retrieve.

Connection access should be limited to connections where:

- The connection is owned by the calling manager, or
- The associated resource is owned by the calling manager

Follow the Deploy Commander interface and RPC authorization model.

Do not attempt to bypass ownership by requesting raw object-store configuration or internal commander data.

## Error Handling in Manager Code

Manager implementation code should return errors through the manager framework.

Do not:

- Panic for configuration errors
- Call `os.Exit`
- Call `log.Fatal`
- Ignore failed RPC calls
- Continue after required resource resolution fails
- Emit partially valid runner metadata as though generation succeeded

Errors should identify:

- The input or configuration field
- The service or resource involved
- The failed operation
- The underlying error where useful

Use `%w` in Go when preserving the original error.

## Validation Before Returning Metadata

Validate generated metadata before returning it.

At minimum, check:

- Required images are non-empty
- Service keys are non-empty
- Dependencies reference included services
- No dependency cycles exist
- Volume names are non-empty
- Mount paths are absolute
- Mount paths are unique within each service
- Resource names are non-empty
- Resource types are non-empty
- Port values are valid
- Host IP values are valid IP addresses
- Service resource references contain a non-zero resource UUID and, when present, a non-zero connection UUID
- Removal entries are non-empty
- A service is not both created and removed
- A volume is not both created and removed
- Connection removals contain the required IDs

Do not rely exclusively on the runner to reject easily detectable manager-generation mistakes.

## JSON Encoding

Use proper JSON serialization.

Do not manually assemble JSON strings.

In Go, use:

```go
json.Marshal(...)
```

Use `json.RawMessage` for arbitrary JSON fields such as:

- Resource metadata
- Connection metadata
- Platform connection data
- Platform data

Ensure every `json.RawMessage` contains valid JSON.

For an empty JSON object, use:

```go
json.RawMessage(`{}`)
```

Do not use an empty byte slice as valid metadata.

## Example: Basic Application

```json
{
  "services": {
    "app": {
      "image": "example/app:1.0.0",
      "environment": {
        "PORT": "8080"
      },
      "bindings": [
        {
          "container_port": 8080,
          "host_port": 8080,
          "host_ip": "0.0.0.0"
        }
      ]
    }
  }
}
```

## Example: Application with Persistent Data

```json
{
  "volumes": ["app-data"],
  "services": {
    "app": {
      "image": "example/app:1.0.0",
      "volumes": [
        {
          "name": "app-data",
          "mount_path": "/var/lib/app"
        }
      ]
    }
  }
}
```

## Example: Migration Followed by Application Startup

```json
{
  "services": {
    "migrate": {
      "image": "example/app:1.0.0",
      "role": "runner",
      "environment": {
        "APP_COMMAND": "migrate"
      }
    },
    "app": {
      "image": "example/app:1.0.0",
      "depends_on": ["migrate"]
    }
  }
}
```

## Example: Internal Service Networks

```json
{
  "services": {
    "proxy": {
      "image": "example/proxy:1.0.0",
      "network_groups": ["frontend"],
      "bindings": [
        {
          "container_port": 80,
          "host_port": 80
        }
      ]
    },
    "app": {
      "image": "example/app:1.0.0",
      "network_groups": ["frontend", "backend"],
      "aliases": ["app"]
    },
    "database": {
      "image": "postgres:18",
      "network_groups": ["backend"],
      "aliases": ["database"]
    }
  }
}
```

## Example: Producing a Resource

```json
{
  "volumes": ["database-data"],
  "services": {
    "database": {
      "image": "postgres:18",
      "aliases": ["database"],
      "environment": {
        "POSTGRES_DB": "app"
      },
      "volumes": [
        {
          "name": "database-data",
          "mount_path": "/var/lib/postgresql/data"
        }
      ],
      "resources": [
        {
          "resource_type": "postgres",
          "name": "primary-database",
          "metadata": {
            "database": "app",
            "host": "database"
          }
        }
      ]
    }
  }
}
```

Here the manager provides the stable resource declaration and the `database` alias. The runner creates the resource network, attaches the producer, and publishes the runner-generated Docker platform connection.

## Example: Consuming a Docker Resource

```json
{
  "services": {
    "app": {
      "image": "example/app:1.0.0",
      "environment": {
        "DATABASE_HOST": "database"
      },
      "connections": [
        {
          "type": "Connection",
          "data": {
            "resource": "11111111-1111-1111-1111-111111111111",
            "connection": "22222222-2222-2222-2222-222222222222"
          }
        }
      ]
    }
  }
}
```

The runner resolves the resource and connection UUIDs and obtains the live
platform network from the agent.

Do not construct the network name manually. For a resource-only reference, the
active manager must own the resource; the agent API enforces that requirement.

The `DATABASE_HOST` value is application configuration supplied by the consuming manager from the resource contract. The runner attaches the container to the resolved network, but it does not derive or inject that hostname.

## Example: Removing Obsolete State

```json
{
  "remove_services": ["old-worker", "old-proxy"],
  "remove_volumes": ["temporary-cache"]
}
```

## Example: Updating a Redirect

```json
{
  "redirect": {
    "redirect": "https://app.example.com"
  }
}
```

## Example: Clearing a Redirect

```json
{
  "redirect": {
    "redirect": null
  }
}
```

## Implementation Workflow for AI Agents

When asked to implement a manager using this runner, follow this sequence.

### 1. Inspect the Manager Project

Identify:

- Manager entry point
- Input models
- Configuration models
- Available RPC calls
- Current metadata generation code
- Existing tests
- Local `AGENTS.md` instructions
- Expected response or return type

Do not begin by creating a new architecture when an established manager pattern exists.

### 2. Determine Manager Intent

Document internally:

- Services the manager owns
- Runner steps required
- Persistent volumes required
- Resources produced
- Resources consumed
- Connections created
- Connections removed
- Redirect behavior
- Teardown behavior

Keep this aligned with the actual user request.

Do not add speculative services or infrastructure.

At this stage, decide **what** the deployment requires. Do not calculate Docker container, volume, or network names; those are runner implementation details.

### 3. Resolve External State

Use available RPC calls to retrieve:

- Required resources
- Resource connections
- Existing connections
- Existing manager state

Validate ownership and availability.

Return a clear error when required state cannot be resolved.

For every consumed resource, prefer retaining the authorized resource and
connection UUIDs needed to emit a `Connection` reference. Use resource-only
references only for resources owned by the active manager. Do not expect a
top-level connection-creation request to become a resolved service connection
automatically.

### 4. Build Shared Models

If the manager project imports the runner's shared models, construct `models.Metadata` and its nested models directly.

If those shared models are unavailable, define manager-side transport types that reproduce the documented JSON contract exactly. Keep these transport types at the manager-to-runner boundary so they cannot drift into a competing domain model.

Do not add fields merely because an underlying container platform supports them.

Convert manager-local configuration into runner models at a clear boundary.

### 5. Validate the Plan

Check service dependencies, volumes, resources, bindings, and removals before returning the plan.

Ensure every raw JSON payload is valid.

### 6. Return Through the Manager Framework

Return metadata or configuration using the manager framework’s expected response.

Do not write `/run/config.json` directly unless the manager framework explicitly assigns that responsibility to the manager.

### 7. Add Tests

Do not assume the runner's tests establish conventions for the manager project. Follow the manager repository's existing test conventions while testing the runner contract described here.

Test:

- Minimal setup
- Full setup
- Missing required input
- Invalid resource resolution
- Existing connection behavior
- Update removals
- Redirect set and clear
- Teardown behavior
- JSON serialization
- Omission versus explicit empty values for pointer-backed fields
- Rejection of requested features that the runner contract does not support

Use deterministic UUIDs and values in unit tests.

### 8. Update Documentation

Update the manager’s:

- `README.md`
- `AGENTS.md`
- Configuration examples
- Input documentation

Do not update the runner documentation for manager-specific behavior.

## Rules for AI Implementers

When implementing code that targets this runner:

- Use the shared runner models.
- Preserve JSON field names.
- Preserve nil semantics.
- Keep service keys stable.
- Keep resource names stable.
- Prefer `Connection` references that resolve platform data through the agent.
- Use resource-only references only for resources owned by the active manager; use an authorized connection UUID otherwise.
- Keep inline `Platform` and `Network` forms only when a direct alternative is specifically required.
- Do not construct external network names.
- Do not create Docker containers, volumes, or networks from manager planning code.
- Do not reproduce runner-owned Docker naming formulas in the manager.
- Provide application-level hostnames, credentials, and connection settings when the resource contract requires them; the runner does not synthesize them.
- Declare new volumes explicitly.
- Remove services and volumes explicitly.
- Treat volume removal as destructive.
- Use runner roles only for one-time work.
- Return errors instead of terminating.
- Do not log secrets.
- Do not invent unsupported runner behavior.
- Do not silently modify the runner.
- Do not move manager files or package responsibilities without explicitly calling out the structural change.
- Make the smallest coherent implementation that satisfies the manager’s requirements.

## Unsupported Assumptions

Do not assume the runner currently provides:

- Kubernetes support
- Automatic removal of omitted services
- Automatic removal of omitted volumes
- Autoscaling
- Protocol-specific port bindings
- Static container IP assignment
- Service/name resource reference resolution
- Resource-only connection deletion
- Transactional rollback
- Automatic secret generation or refresh; runner interpolation is opt-in and limited to version-one supported fields
- Automatic environment generation from connection metadata
- Automatic image pulling policy configuration
- CPU or memory limits
- Host-path mounts

These require explicit runner changes before manager code may depend on them.

## Completion Checklist

Before declaring the manager implementation complete, verify:

- The manager returns valid runner metadata.
- All service images are defined.
- Service keys are stable.
- Dependencies exist and are acyclic.
- Required volumes are declared.
- Mount paths are absolute.
- Produced resources have stable names and types.
- Consumed resources use the advised `Connection` reference with a required resource UUID and optional connection UUID.
- Resource-only references are used only for resources owned by the active manager; connection-specific references use authorized connection UUIDs.
- Every service that needs a Docker resource network resolves to an exact live `Platform` descriptor before setup.
- Top-level connection plans are not being mistaken for service network attachments.
- Manager code does not create Docker objects or calculate runner-owned Docker names.
- Removal operations are explicit.
- Connection operations use UUID-based resource references.
- Redirect nil semantics are correct.
- Any service command is a non-empty explicit string array; empty arrays are invalid for Docker, and no shell splitting or entrypoint override is assumed.
- Any `health_check` is a valid Docker test on a long-running service, and dependents wait until it is healthy.
- No unsupported runner feature is assumed.
- Errors are returned with useful context.
- Value interpolation uses `values_version: 1` only on a capable runner and only in supported fields.
- Secret keys copied to resources or connections are exact current-run keys.
- Secrets are not included in ordinary logs; explicitly enabled health diagnostics redact known values and may expose unknown sensitive container output.
- Tests cover setup, update, and failure paths.
- Documentation reflects the implementation.
- The project passes formatting, tests, vetting, and build checks.

## Core Principle

Generate an explicit, valid execution plan and let the runner own platform execution.

The manager should decide what needs to happen.

The runner should decide how that plan is applied to Docker.

### General rules for implementation and verification

Implement redirect removal in the runner's `teardown` action. The manager
backend starts the run; it must not clear the redirect itself. The runner
clears the redirect before removing deployment resources and fails the run if
clearing fails. Teardown must not require redirect metadata from the manager.

Distinguish a required contract from behavior implemented in source and
behavior present in the deployed image. Describe a capability as current only
after verifying the image used by the caller; record its version or digest.

Verify full teardown by checking removal of the redirect, owned containers,
volumes, networks, published resource, and attached connections. Check failure
behavior as well. A `DONE` status or log message alone does not prove those
effects occurred.

Leave blocked completion checks open. Do not mark an integration complete while
a required runner change or end-to-end check remains unverified.
