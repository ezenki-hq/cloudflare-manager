# Resource Connection Manager Guide

This guide is for Deploy Commander managers that own resources and manage connections attached to them. Custom Deployer's default group form asks the resource-owning manager to create, link, unlink, or delete connections. It does not implement resource-specific setup or cleanup.

For manager startup, authentication, RPC, and authorization, use the current [Manager Interface Guide](docs/integration/MANAGER_INTERFACE_GUIDE.md) and [Commander Manager Integration Guide](docs/integration/COMMANDER_MANAGER_INTEGRATION_GUIDE.md). For runner connection references, use the [Deployment Runner Implementation Guide](docs/integration/DEPLOYMENT_RUNNER_IMPLEMENTATION_GUIDE.md).

## Ownership and membership

The manager that owns a resource owns setup and cleanup for connections attached to that resource. Validate the supplied resource and connection through the authorized manager interface. Deploy Commander provides the trusted identity of the opened manager; do not trust a caller-supplied manager identity or accept a connection attached to an unrelated resource.

Custom Deployer discovers group membership from Deploy Commander connection labels. Its query uses the exact **custom_deployer_group_id** label and requests labels in the result. It does not filter by connection manager. A connection is available to a group when it has that group's label and is attached to an eligible resource. Stage-labeled connections and connections attached to Commander or Corvo resources are excluded.

The origin label is:

```text
custom_deployer_connection_origin = created | imported
```

It records whether the connection was created for this group or imported from an existing visible connection. It controls cleanup behavior, not membership. Preserve unrelated labels when adding or removing group labels. Do not put connection metadata, credentials, or secrets in labels.

The default form does not save active connection IDs in group shared configuration. Older saved lists are migration hints only. Managers that do not implement the link and unlink requests below cannot complete import, legacy migration, or removal of imported connections.

## Create a group connection

Custom Deployer opens the manager identified by the selected resource's **manager** field and sends:

```json
{
  "action": "create-connection",
  "resource": "<resource-id>",
  "labels": {
    "custom_deployer_group_id": "<deployment-group-id>",
    "custom_deployer_connection_origin": "created"
  }
}
```

Run the manager's normal resource-specific setup and validation. Create the connection attached to the requested resource, preserving existing labels and applying the requested labels. The successful interface result must contain a **connection** object identifying the created Deploy Commander connection:

```json
{
  "connection": {
    "id": "<connection-id>",
    "resource": "<resource-id>",
    "labels": {
      "custom_deployer_group_id": "<deployment-group-id>",
      "custom_deployer_connection_origin": "created"
    }
  }
}
```

Custom Deployer verifies the returned identity and then confirms the connection appears in a fresh group-label query. Do not return connection configuration or secrets in the interface result. A failed or cancelled workflow must return the standard failed interface response.

### Declaring connection secret keys

When a connection has secrets that a consuming deployment may use, include their key names in the live connection metadata under `secret_keys`:

```json
{
  "metadata": {
    "host": "db.internal",
    "secret_keys": ["PASSWORD", "REPLICATION_TOKEN"]
  }
}
```

This is a declaration of available keys only. Never include secret values in connection metadata or the interface result. Keep the list in sync when the owning manager adds or removes connection secrets. Custom Deployer uses the declared key name to create a runner secret reference; the runner reads the value through Deploy Commander's authorized secret API. In the default form, secret bindings are supported for command arguments, environment values, and health-check test strings.

## Link an existing visible connection

When a user imports an existing unlinked connection, Custom Deployer opens that resource's owning manager and sends:

```json
{
  "action": "link-connection",
  "resource": "<resource-id>",
  "connection": "<connection-id>",
  "labels": {
    "custom_deployer_group_id": "<deployment-group-id>",
    "custom_deployer_connection_origin": "imported"
  }
}
```

Validate that the connection is attached to the requested resource and that the resource belongs to the current manager. Add the requested labels without replacing unrelated labels. Return a successful interface result containing the authoritative **connection** object with the same **id** and **resource**, plus the requested labels. Custom Deployer verifies that identity and confirms group membership with a fresh label query after the manager closes.

The same request is used to migrate a legacy saved connection reference that has not yet been labeled for the group.

## Remove a connection from a group

Group membership removal depends on the origin:

- A connection with origin **created** is deleted through the resource manager using the generic delete request below.
- A connection with origin **imported** stays in Deploy Commander and is unlinked using the request below.

Custom Deployer prevents removal while a stage service still references the connection. It verifies that the connection no longer appears in the group after the manager workflow. Do not directly delete or unlink another manager's connection state outside the owning manager workflow.

### Delete a created connection

Custom Deployer sends an array even when deleting a single connection:

```json
{
  "action": "delete-connection",
  "connections": ["<connection-id>"]
}
```

Resolve every connection through the current manager's authorized interface, confirm its attached resource is owned by this manager, perform required resource-specific cleanup, and delete the Deploy Commander connection. Close successfully only after deletion is complete.

### Unlink an imported connection

Custom Deployer sends:

```json
{
  "action": "unlink-connection",
  "resource": "<resource-id>",
  "connection": "<connection-id>",
  "group": "<deployment-group-id>"
}
```

Validate that the connection is attached to the requested resource and that the resource belongs to this manager. Remove the requested group's **custom_deployer_group_id** and origin labels while preserving unrelated labels and the Deploy Commander connection itself. Close successfully after the label update; Custom Deployer confirms the connection is no longer a member of the group.

If the manager does not support **link-connection** or **unlink-connection**, return a failed interface response. Custom Deployer will leave its labels unchanged and display the workflow error. Do not silently delete an imported connection or have Custom Deployer modify labels directly.

## Keep Corvo routing separate

Corvo connections carry routing state and use Corvo's dedicated create, update, and delete workflow. Do not handle them as generic group resource connections. Follow the [Corvo Manager Integration Guide](docs/integration/CORVO_MANAGER_INTEGRATION_GUIDE.md).

## Runner boundary

For each service that uses a group connection, Custom Deployer sends the runner a reference:

```json
{
  "type": "Connection",
  "data": {
    "resource": "<resource-id>",
    "connection": "<connection-id>"
  }
}
```

Before starting a deploy run, Custom Deployer reads current connection metadata and resolves any service-field bindings. The runner receives the concrete service configuration plus the resource and connection IDs; it resolves the live platform connection descriptor under the runner contract. Do not return connection metadata or secrets in group labels, published form files, or the child-interface result.
