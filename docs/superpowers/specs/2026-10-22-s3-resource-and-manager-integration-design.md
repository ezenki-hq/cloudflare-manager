# S3 Resource and Manager Integration Design

## Purpose

Cloudflare Manager must publish an S3 service resource when its full stack service is installed. Other Deploy Commander managers must be able to ask it to set up an R2 bucket, optionally attach a custom CDN domain, and then obtain a bucket scoped S3 connection through the existing connection workflow. The published installer must explain that the full stack manager needs installation when it receives an interface metadata command while the service is unavailable.

This design preserves Cloudflare buckets, CDN domains, and Deploy Commander resource records through teardown. A later installation reuses the existing service resource. Cloudflare authorization remains tied to the user operating the manager; installation requires no Cloudflare account or OAuth grant.

## Existing boundaries

- The installer starts the `install` run, and the Go service starts only after its Commander connection is available. The runner waits for service health before setting the manager redirect.
- The Go service owns Cloudflare API calls and creates `cloudflare-r2-bucket` records through the authenticated Commander API. The React frontend owns Cloudflare sign-in and the browser bound child interface protocol.
- The management frontend currently handles `create-connection`, `link-connection`, `unlink-connection`, and `delete-connection` child actions. A `create-connection` result identifies the connection but does not expose S3 secrets.
- The existing teardown leaves Cloudflare buckets and domains intact, and bucket resource records may remain in Commander.

## Installation time S3 resource

After verifying its Commander credentials and before serving health requests, the Go service ensures exactly one manager owned external resource with type `s3`, name `Cloudflare R2 S3`, and nonsecret metadata `{ "provider": "cloudflare-r2", "role": "provisioner", "contract_version": 1 }`. It carries no bucket name, account ID, S3 endpoint, CDN address, platform connection, public connection, or secrets. The resource is a stable discovery and launch point for bucket provisioning, not a claim that a bucket already exists.

The service lists its owned `s3` resources, checks the exact identity and metadata, and reuses the matching resource. An ambiguous or conflicting match fails startup with an actionable error rather than creating another service resource. If resource creation or verification fails, the service does not become healthy and the install run must not be reported as successful. A service restart or reinstall uses the same resource ID. Teardown preserves this record, matching the persistence of bucket resources and external Cloudflare state.

Other managers discover this resource through Commander's resource listing by type `s3` and its owning manager ID. Resource list results are summaries, so callers must not assume they can read private resource metadata. They pass the discovered resource ID to a child interface opened for the resource's owning Cloudflare Manager.

## Bucket and CDN child workflow

The consuming manager opens Cloudflare Manager with this request:

```json
{
  "action": "create-bucket",
  "resource": "<s3-service-resource-id>",
  "suggested": {
    "account_id": "<optional-account-id>",
    "jurisdiction": "default",
    "bucket": "<optional-bucket-name>",
    "domain": "<optional-cdn-hostname>",
    "zone_id": "<optional-zone-id>"
  }
}
```

Every `suggested` field is optional, and suggestions are untrusted. The child requires a trusted nonempty `getCallingManager()` result and verifies that `resource` is this manager's `s3` provisioner. Invalid or unsupported metadata closes with a structured failed `InterfaceResponse`; it does not start a Cloudflare operation.

The child renders a guided form and uses the existing Cloudflare OAuth popup and session handle flow if sign-in is needed. It lists accounts and zones available to the signed-in user. The user confirms the account, jurisdiction, bucket name, and whether to create a new bucket or use an existing one. The user may also enter one optional custom CDN hostname and select an accessible zone. No mutation occurs before the user confirms the form.

For a new bucket, the child calls the existing bucket creation API. For an existing bucket, it verifies the bucket through Cloudflare. It then registers or reuses the `cloudflare-r2-bucket` resource identified by account, jurisdiction, and bucket. If a CDN hostname was requested, it checks the current domain list and attaches it through the existing Cloudflare API when needed. It saves the chosen primary domain in nonsecret bucket resource metadata. It reads the resulting domain status from Cloudflare; ownership and TLS activation may still be pending when the workflow finishes.

Successful child completion returns only the identities and nonsecret connection settings needed by the caller:

```json
{
  "resource": {
    "id": "<bucket-resource-id>",
    "manager": "<cloudflare-manager-id>",
    "type": "cloudflare-r2-bucket"
  },
  "bucket": {
    "account_id": "<account-id>",
    "jurisdiction": "default",
    "name": "<bucket-name>",
    "s3_endpoint": "https://<account-id>.r2.cloudflarestorage.com"
  },
  "cdn": {
    "domain": "cdn.example.com",
    "enabled": false,
    "status": {
      "ownership": "pending",
      "ssl": "pending"
    }
  }
}
```

This object is the `result` member of a successful `InterfaceResponse`; `manager` and `ok: true` are the outer envelope. The `cdn` member is omitted when no CDN hostname was requested. Its `enabled` and `status` fields mirror the current Cloudflare domain response; the shown pending values are an example, not a promise about timing. The result never includes OAuth tokens or S3 access keys. The caller verifies the returned resource ID, type, and owning manager against a fresh Commander resource listing before using it.

The child does not issue application credentials as part of `create-bucket`. A caller that needs S3 access opens the existing `create-connection` child action with the returned bucket resource ID. That action uses trusted caller identity, provisions one bucket scoped credential pair, stores secret values in the consuming manager's Commander connection secrets, and returns only connection identity. The integration guide must show both calls, the secret key names, and runner secret references.

## Errors, retries, and persistence

Bucket registration is idempotent for the Cloudflare account, jurisdiction, and bucket tuple. Retrying after a successful bucket create but failed resource registration reuses the Cloudflare bucket rather than creating a duplicate. Retrying a requested CDN hostname first checks whether it is already attached to the selected bucket. Errors from Cloudflare or Commander are shown without tokens or raw upstream bodies.

If domain attachment or metadata update fails, the child stays open and shows what succeeded, the failed step, and a retry action. It does not report overall success until every requested step succeeds. Cancelling closes with a structured failed response and leaves any bucket, resource, or domain already created in place for later recovery. No automatic bucket or domain deletion is attempted. A domain that has attached successfully but whose Cloudflare ownership or TLS status is pending can complete with that pending status.

Existing `create-connection` behavior remains a separate operation. Its failures continue to follow the current pending connection and credential cleanup rules. The new bucket workflow never returns application secret values in child metadata, results, logs, resource metadata, or labels.

## Installer command handling

The published installer reads its interface metadata on startup. If it contains a nonempty string `action`, the installer prominently tells the user to install the full stack Cloudflare Manager to use that command. It shows the command's action name and the normal Commander connection and Install controls, but does not attempt to execute the command itself. The installer does not automatically close the child interface before the user can see this guidance.

After a successful install, the existing health gated redirect and reload open the management frontend. If Commander retains the child metadata across that transition, the frontend handles supported actions. The integration guide tells the requesting manager to retry the action if its child session does not survive the redirect. When no action metadata is present, the installer remains the normal installation interface.

## Integration documentation

Add `CLOUDFLARE_MANAGER_INTEGRATION_GUIDE.md` in the project root for consuming manager authors and link it from the README. It must document resource discovery, the exact `create-bucket` request and response, the signed-in user's confirmation step, CDN status, cancellation and retry behavior, the existing `create-connection` request and secret names, how to consume the resulting connection, and the install prompt when the full stack service is unavailable. It must state that teardown preserves the S3 service resource, bucket records, Cloudflare buckets, and CDN domains.

## Verification

Go tests cover first startup creation, reuse after restart or reinstall, conflicting or duplicate service resources, Commander failure blocking health, and absence of Cloudflare credentials in the service resource. Frontend tests cover child metadata and trusted caller validation, OAuth needed state, new and existing bucket paths, idempotent registration, optional CDN attachment and pending status, partial failure and retry, cancellation, and a result without secrets. Installer tests cover action metadata guidance while preserving normal Install behavior. Run the Go and both React test and build suites. A staging check with Deploy Commander and Cloudflare must verify child launch, redirect behavior, OAuth in the child, bucket and CDN setup, and retry after installation when the child context does not survive redirect.
