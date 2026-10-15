import type { Labels, RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI, CloudflareCredential } from "./api";

export const ACCESS_KEY_SECRET = "AWS_ACCESS_KEY_ID";
export const SECRET_ACCESS_KEY_SECRET = "AWS_SECRET_ACCESS_KEY";

export interface ConnectionInput {
  resourceId: string;
  managerId: string;
  permission: "read-only" | "read-write";
  labels?: Labels;
}

interface BucketIdentity {
  accountId: string;
  bucket: string;
  jurisdiction: string;
  endpoint: string;
}

interface ConnectionMetadata extends BucketIdentity {
  aws_region: "auto";
  permission: "read-only" | "read-write";
  status: "pending" | "ready" | "revoke_pending" | "revoked";
  token_id?: string;
}

export async function provisionConnection(caller: RPCCaller, api: BackendAPI, input: ConnectionInput): Promise<string> {
  validateId(input.resourceId, "resource ID");
  validateId(input.managerId, "application manager ID");
  if (input.permission !== "read-only" && input.permission !== "read-write") throw new Error("Invalid R2 access permission");
  const identity = await getBucketIdentity(caller, input.resourceId);
  const pending: ConnectionMetadata = { ...identity, aws_region: "auto", permission: input.permission, status: "pending" };
  const created = await caller.createConnection(pending, input.managerId, false, input.resourceId, input.labels);
  const id = created.connection.id;
  if (!id) throw new Error("Deploy Commander returned a connection without an ID");

  let credentials: CloudflareCredential;
  try {
    credentials = await api.createCredential(identity.accountId, identity.bucket, {
      jurisdiction: identity.jurisdiction,
      connection_id: id,
      permission: input.permission,
    });
  } catch (error) {
    await deleteNewConnection(caller, id, error);
    throw error;
  }

  const withToken: ConnectionMetadata = { ...pending, token_id: credentials.token_id };
  try {
    await caller.updateConnection(id, withToken);
    await caller.setSecret("connection", id, ACCESS_KEY_SECRET, credentials.access_key_id);
    await caller.setSecret("connection", id, SECRET_ACCESS_KEY_SECRET, credentials.secret_access_key);
    await caller.updateConnection(id, { ...withToken, status: "ready" });
  } catch (error) {
    const original = error instanceof Error ? error.message : "Credential handoff failed";
    await rollbackCredential(caller, api, id, withToken, credentials, original);
  }
  // Drop the only frontend references as soon as the durable handoff succeeds.
  credentials = { token_id: "", access_key_id: "", secret_access_key: "" };
  void credentials;
  return id;
}

export async function revokeConnection(caller: RPCCaller, api: BackendAPI, connectionId: string): Promise<void> {
  validateId(connectionId, "connection ID");
  const saved = await caller.getConnection(connectionId, { include_labels: true });
  const connection = saved.connection;
  const resource = await getBucketIdentity(caller, connection.resource);
  const metadata = asConnectionMetadata(saved.config.metadata);
  if (metadata.accountId !== resource.accountId || metadata.bucket !== resource.bucket || metadata.jurisdiction !== resource.jurisdiction) {
    throw new Error("Connection does not match its attached Cloudflare bucket resource");
  }

  if (metadata.status !== "revoked") {
    let tokenId = metadata.token_id;
    if (!tokenId) tokenId = (await api.findCredential(metadata.accountId, connectionId)).token_id;
    if (tokenId) {
      await api.revokeCredential(metadata.accountId, { token_id: tokenId, connection_id: connectionId });
    }
    await caller.updateConnection(connectionId, { ...metadata, ...(tokenId ? { token_id: tokenId } : {}), status: "revoked" });
  }

  await caller.deleteSecret("connection", connectionId, ACCESS_KEY_SECRET);
  await caller.deleteSecret("connection", connectionId, SECRET_ACCESS_KEY_SECRET);
  await caller.deleteConnection(connectionId);
}

async function rollbackCredential(
  caller: RPCCaller,
  api: BackendAPI,
  connectionId: string,
  metadata: ConnectionMetadata,
  credentials: CloudflareCredential,
  originalError: string,
): Promise<never> {
  try {
    await api.revokeCredential(metadata.accountId, { token_id: credentials.token_id, connection_id: connectionId });
  } catch (revokeError) {
    try { await caller.updateConnection(connectionId, { ...metadata, token_id: credentials.token_id, status: "revoke_pending" }); } catch { /* the token name supports reconciliation if the record update failed */ }
    const detail = revokeError instanceof Error ? revokeError.message : "Cloudflare token revocation failed";
    throw new Error(`${originalError}; Cloudflare token revocation failed and the connection was retained for retry: ${detail}`);
  }

  try {
    await caller.updateConnection(connectionId, { ...metadata, token_id: credentials.token_id, status: "revoked" });
    await caller.deleteSecret("connection", connectionId, ACCESS_KEY_SECRET);
    await caller.deleteSecret("connection", connectionId, SECRET_ACCESS_KEY_SECRET);
    await caller.deleteConnection(connectionId);
  } catch (cleanupError) {
    const detail = cleanupError instanceof Error ? cleanupError.message : "connection cleanup failed";
    throw new Error(`${originalError}; Cloudflare token was revoked but Deploy Commander cleanup must be retried: ${detail}`);
  }
  throw new Error(originalError);
}

async function deleteNewConnection(caller: RPCCaller, connectionId: string, original: unknown): Promise<void> {
  try { await caller.deleteConnection(connectionId); }
  catch (cleanupError) {
    const originalMessage = original instanceof Error ? original.message : "Cloudflare credential creation failed";
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : "pending connection cleanup failed";
    throw new Error(`${originalMessage}; pending connection cleanup failed: ${cleanupMessage}`);
  }
}

async function getBucketIdentity(caller: RPCCaller, resourceId: string): Promise<BucketIdentity> {
  validateId(resourceId, "resource ID");
  const saved = await caller.getResource(resourceId);
  if (saved.resource.type !== "cloudflare-r2-bucket" || saved.resource.id !== resourceId) throw new Error("Resource is not a managed Cloudflare R2 bucket");
  const metadata = saved.config.metadata as Record<string, unknown>;
  const accountId = requiredString(metadata?.account_id, "resource account ID");
  const bucket = requiredString(metadata?.bucket_name, "resource bucket name");
  const jurisdiction = requiredString(metadata?.jurisdiction, "resource jurisdiction");
  const endpoint = requiredString(metadata?.s3_endpoint, "resource S3 endpoint");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId) || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(bucket)) throw new Error("Resource contains invalid Cloudflare bucket identity");
  if (!new Set(["default", "eu", "us", "fedramp", "fedramp-high"]).has(jurisdiction)) throw new Error("Resource contains invalid R2 jurisdiction");
  return { accountId, bucket, jurisdiction, endpoint };
}

function asConnectionMetadata(value: unknown): ConnectionMetadata {
  if (!isRecord(value)) throw new Error("Connection metadata is invalid");
  const permission = value.permission;
  const status = value.status;
  if ((permission !== "read-only" && permission !== "read-write") || !["pending", "ready", "revoke_pending", "revoked"].includes(String(status))) throw new Error("Connection metadata is invalid");
  return {
    accountId: requiredString(value.accountId ?? value.account_id, "connection account ID"),
    bucket: requiredString(value.bucket ?? value.bucket_name, "connection bucket name"),
    jurisdiction: requiredString(value.jurisdiction, "connection jurisdiction"),
    endpoint: requiredString(value.endpoint ?? value.s3_endpoint, "connection S3 endpoint"),
    aws_region: "auto",
    permission,
    status: status as ConnectionMetadata["status"],
    ...(typeof value.token_id === "string" ? { token_id: value.token_id } : {}),
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${label}`);
  return value;
}

function validateId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error(`Invalid ${label}`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
