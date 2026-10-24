# Cloudflare Manager Integration Guide

This guide describes how another Deploy Commander manager can request a Cloudflare R2 bucket resource and then create a bucket scoped S3 connection for its own manager.

The integration uses two child interfaces:

1. `create-bucket` asks the signed-in user to choose or create an R2 bucket and optionally attach a CDN hostname.
2. `create-connection` creates application access for the requesting manager and stores its access key pair in that manager's Commander connection secrets.

The bucket request never includes S3 credentials. Creating a bucket and creating an application connection are separate actions.

## Find the Cloudflare Manager provisioner

The full stack Cloudflare Manager publishes one external Commander resource with type `s3` and name `Cloudflare R2 S3`. Its private configuration has metadata `provider: cloudflare-r2`, `role: provisioner`, `contract_version: 1`. Discover it using your manager's RPC caller and check the public resource summary:

```ts
const cloudflareManagerId = "<cloudflare-manager-id>";
async function listCloudflareResources(type: string) {
  const resources: Awaited<ReturnType<typeof caller.getResources>>["items"] = [];
  for (let offset = 0; ; ) {
    const page = await caller.getResources({
      type,
      external: true,
      manager: cloudflareManagerId,
      limit: 100,
      offset,
    });
    resources.push(...page.items);
    if (page.items.length === 0 && offset < page.total) {
      throw new Error("Commander returned an incomplete resource list");
    }
    if (offset + page.items.length >= page.total) return resources;
    offset += page.items.length;
  }
}

const candidates = (await listCloudflareResources("s3")).filter(
  (item) => item.name === "Cloudflare R2 S3" && item.manager === cloudflareManagerId,
);
if (candidates.length !== 1) {
  throw new Error("Cloudflare Manager's S3 provisioner is missing or ambiguous");
}
const provisioner = candidates[0];
```

Commander exposes only summaries to other managers. Your manager cannot read this provisioner's private configuration with `getResource`. Cloudflare Manager validates its full resource detail and metadata in the `create-bucket` child before any Cloudflare operation. The resource is created during full stack installation and reused on later installs. Installation does not need a Cloudflare account or OAuth session.

## Request a bucket resource

Open Cloudflare Manager's published interface with the `create-bucket` action. Suggestions can prefill controls, but the user can change them. They are never authorization or mutation instructions by themselves.

```ts
const child = await wire.startInterface({
  manager: cloudflareManagerId,
  metadata: {
    action: "create-bucket",
    resource: provisioner.id,
    suggested: {
      account_id: "<optional-account-id>",
      jurisdiction: "default",
      bucket: "media-files",
      domain: "cdn.example.com",
      zone_id: "<optional-zone-id>",
    },
  },
});

const response = await child.close;
if (!response.ok) {
  throw new Error(response.error?.message ?? "Bucket setup was not completed");
}

const result = response.result as {
  resource: { id: string; manager: string; type: string };
  bucket: {
    account_id: string;
    jurisdiction: string;
    name: string;
    s3_endpoint: string;
  };
  cdn?: { domain: string; enabled: boolean; status?: unknown };
};
```

The child prompts the user to sign in to Cloudflare if needed, then loads accounts and zones available to that user. Cloudflare bucket and domain operations begin only after the user confirms the form. The user chooses create or existing bucket mode, account, jurisdiction, bucket name, and optionally one CDN hostname and zone.

Successful response example:

```json
{
  "manager": "cloudflare-manager-id",
  "ok": true,
  "result": {
    "resource": {
      "id": "bucket-resource-id",
      "manager": "cloudflare-manager-id",
      "type": "cloudflare-r2-bucket"
    },
    "bucket": {
      "account_id": "account-id",
      "jurisdiction": "default",
      "name": "media-files",
      "s3_endpoint": "https://account-id.r2.cloudflarestorage.com"
    },
    "cdn": {
      "domain": "cdn.example.com",
      "enabled": false,
      "status": { "ownership": "pending", "ssl": "pending" }
    }
  }
}
```

The `cdn` field is omitted when the user does not request a hostname. Its `enabled` and `status` values report Cloudflare's current state. Domain ownership or TLS can still be pending after successful setup.

Check the returned identity and look it up in Commander's public resource summaries before using it:

```ts
if (
  response.manager !== cloudflareManagerId ||
  !result?.resource?.id ||
  result.resource.manager !== cloudflareManagerId ||
  result.resource.type !== "cloudflare-r2-bucket"
) {
  throw new Error("Cloudflare Manager returned an unexpected bucket resource");
}

const bucketResource = (await listCloudflareResources("cloudflare-r2-bucket")).find(
  (item) => item.id === result.resource.id,
);
if (
  !bucketResource ||
  bucketResource.manager !== cloudflareManagerId ||
  bucketResource.type !== "cloudflare-r2-bucket" ||
  !bucketResource.external
) {
  throw new Error("Cloudflare Manager returned an unexpected bucket resource");
}
```

The lookup confirms public identity only; `getResource` cannot read another manager's private bucket configuration. The response contains resource identity and nonsecret bucket settings only. Do not treat it as a credential response.

## Create an application connection

After verifying the bucket resource, open a separate `create-connection` child action. Supply the bucket resource ID and your manager ID comes from trusted Commander caller context. Generic managers can omit `labels`:

```ts
const connectionChild = await wire.startInterface({
  manager: cloudflareManagerId,
  metadata: {
    action: "create-connection",
    resource: result.resource.id,
    permission: "read-only", // or "read-write"
  },
});

const connectionResponse = await connectionChild.close;
if (!connectionResponse.ok) {
  throw new Error(connectionResponse.error?.message ?? "Connection setup was not completed");
}

const connection = connectionResponse.result?.connection as {
  id: string;
  resource: string;
};

if (
  connectionResponse.manager !== cloudflareManagerId ||
  !connection?.id ||
  connection.resource !== result.resource.id
) {
  throw new Error("Cloudflare Manager returned an unexpected connection");
}

const savedConnection = await caller.getConnection(connection.id);
if (
  savedConnection.connection.id !== connection.id ||
  savedConnection.connection.manager !== await caller.getManager() ||
  savedConnection.connection.resource !== result.resource.id
) {
  throw new Error("The connection does not belong to this manager and bucket");
}
```

Custom Deployer can continue to pass its group labels. Both labels must be present and valid together:

```ts
metadata: {
  action: "create-connection",
  resource: result.resource.id,
  permission: "read-only",
  labels: {
    custom_deployer_group_id: "<group-id>",
    custom_deployer_connection_origin: "created",
  },
}
```

The `create-connection` action uses the user's active Cloudflare session. If that session has expired, sign in to Cloudflare Manager and retry the action. Cloudflare Manager creates a token scoped to the selected bucket and permission, saves the key pair as secrets on the consuming manager's Commander connection, confirms that connection, and returns its identity. The child response does not include either key value. Your manager can read this connection's detail because it owns the connection.

## Use the connection in a deployment

Read the approved connection through Commander and configure the consuming deployment with the returned bucket endpoint and region. Reference the connection secrets by their exact keys:

```ts
const deploymentEnvironment = {
  AWS_ACCESS_KEY_ID: `[[secret:connection:${connection.id}:AWS_ACCESS_KEY_ID]]`,
  AWS_SECRET_ACCESS_KEY: `[[secret:connection:${connection.id}:AWS_SECRET_ACCESS_KEY]]`,
  AWS_REGION: "auto",
};

const objectStorageConfiguration = {
  endpoint: result.bucket.s3_endpoint,
  region: deploymentEnvironment.AWS_REGION,
};
```

Use the endpoint field supported by your S3 client and the runner's Deploy Commander `[[secret:connection:CONNECTION_UUID:KEY]]` value interpolation for the key values. Keep credentials in Commander secret storage; do not copy them into manager metadata, labels, child requests, logs, or deployment source files.

## Install prompt, failures, and retries

If a caller launches a metadata command before the full stack service is installed, including after teardown, the published installer displays the action name and asks the user to install the full stack Cloudflare Manager. It keeps the normal install controls available and does not attempt the action itself. After installation, Commander may or may not retain the child context through redirect and reload. If the command did not resume in the manager, open it again and retry.

Bucket creation, Commander resource registration, CDN attachment, and primary-domain metadata updates are separate steps. If one fails, the child displays completed steps and remains available for retry. A bucket that already exists can be selected in existing mode. A previously attached domain is detected before another attach is attempted. The child does not delete a bucket, resource record, or domain during failure handling or cancellation. Cancel returns a failed `InterfaceResponse`; resources created before cancellation remain for a later retry.

Invalid action metadata, an unavailable calling-manager identity, or a resource that fails provisioner verification returns a structured failure before any Cloudflare mutation. Unsupported child actions also return a structured failed response.

## Teardown and persistence

Full stack teardown preserves the `Cloudflare R2 S3` provisioner resource, registered bucket resource records, Cloudflare R2 buckets, and CDN domains. Reinstalling the manager reuses the provisioner record. Existing bucket resources and Cloudflare state remain available to consuming managers once the service is reinstalled.

Application connections and their access keys are managed separately from bucket setup and may remain active after full stack teardown. Revoke an application connection through the normal Cloudflare Manager lifecycle when that application should lose bucket access.
