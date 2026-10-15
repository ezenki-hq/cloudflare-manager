import type { InterfaceResponse, Labels, RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";
import { provisionConnection, revokeConnection } from "./connections";

const GROUP_LABEL = "custom_deployer_group_id";
const ORIGIN_LABEL = "custom_deployer_connection_origin";
const ALLOWED_LABELS = new Set([GROUP_LABEL, ORIGIN_LABEL]);

export async function handleChildAction(
  caller: RPCCaller,
  api: BackendAPI,
  metadata: unknown,
  callingManager: string | null,
): Promise<InterfaceResponse> {
  let manager: string;
  try { manager = await caller.getManager(); }
  catch { return { manager: "", ok: false, error: { message: "Unable to identify the current manager" } }; }

  try {
    if (!isRecord(metadata) || typeof metadata.action !== "string") throw new WorkflowError("A child action is required", 400);
    switch (metadata.action) {
      case "create-connection": return await createAction(caller, api, manager, metadata, callingManager);
      case "link-connection": return await linkAction(caller, manager, metadata);
      case "unlink-connection": return await unlinkAction(caller, manager, metadata);
      case "delete-connection": return await deleteAction(caller, api, manager, metadata);
      default: throw new WorkflowError(`Unsupported child action: ${metadata.action}`, 400);
    }
  } catch (error) {
    return { manager, ok: false, error: { message: safeError(error), ...(error instanceof WorkflowError ? { status: error.status } : {}) } };
  }
}

async function createAction(caller: RPCCaller, api: BackendAPI, manager: string, metadata: Record<string, unknown>, callingManager: string | null): Promise<InterfaceResponse> {
  const resourceId = stringField(metadata.resource, "resource");
  if (!callingManager) throw new WorkflowError("The requesting application manager is unavailable", 403);
  const labels = requestedLabels(metadata.labels, "created");
  const permission = metadata.permission === "read-write" ? "read-write" : "read-only";
  const connectionId = await provisionConnection(caller, api, { resourceId, managerId: callingManager, permission, labels });
  return { manager, ok: true, result: { connection: { id: connectionId, resource: resourceId, labels } } };
}

async function linkAction(caller: RPCCaller, manager: string, metadata: Record<string, unknown>): Promise<InterfaceResponse> {
  const resourceId = stringField(metadata.resource, "resource");
  const connectionId = stringField(metadata.connection, "connection");
  const labels = requestedLabels(metadata.labels, "imported");
  await requireBucketResource(caller, resourceId);
  const saved = await caller.getConnection(connectionId, { include_labels: true });
  if (saved.connection.resource !== resourceId) throw new WorkflowError("Connection is attached to a different resource", 403);
  for (const [key, value] of Object.entries(labels)) await caller.setConnectionLabel(connectionId, key, value);
  return { manager, ok: true, result: { connection: { id: saved.connection.id, resource: resourceId, labels } } };
}

async function unlinkAction(caller: RPCCaller, manager: string, metadata: Record<string, unknown>): Promise<InterfaceResponse> {
  const resourceId = stringField(metadata.resource, "resource");
  const connectionId = stringField(metadata.connection, "connection");
  const group = stringField(metadata.group, "group");
  await requireBucketResource(caller, resourceId);
  const saved = await caller.getConnection(connectionId, { include_labels: true });
  if (saved.connection.resource !== resourceId) throw new WorkflowError("Connection is attached to a different resource", 403);
  if (saved.connection.labels?.[GROUP_LABEL] !== group || saved.connection.labels?.[ORIGIN_LABEL] !== "imported") throw new WorkflowError("Only this group's imported connection can be unlinked", 409);
  await caller.removeConnectionLabel(connectionId, GROUP_LABEL);
  await caller.removeConnectionLabel(connectionId, ORIGIN_LABEL);
  const remainingLabels = { ...(saved.connection.labels ?? {}) };
  delete remainingLabels[GROUP_LABEL];
  delete remainingLabels[ORIGIN_LABEL];
  return { manager, ok: true, result: { connection: { id: connectionId, resource: resourceId, labels: remainingLabels } } };
}

async function deleteAction(caller: RPCCaller, api: BackendAPI, manager: string, metadata: Record<string, unknown>): Promise<InterfaceResponse> {
  if (!Array.isArray(metadata.connections) || metadata.connections.length === 0 || !metadata.connections.every((item) => typeof item === "string")) throw new WorkflowError("A list of connection IDs is required", 400);
  const result: Array<{ id: string; resource: string }> = [];
  for (const value of metadata.connections as string[]) {
    const connectionId = value;
    const saved = await caller.getConnection(connectionId, { include_labels: true });
    await requireBucketResource(caller, saved.connection.resource);
    if (saved.connection.labels?.[ORIGIN_LABEL] !== "created") throw new WorkflowError("Only a created group connection can be deleted", 409);
    await revokeConnection(caller, api, connectionId);
    result.push({ id: connectionId, resource: saved.connection.resource });
  }
  return { manager, ok: true, result: { connections: result } };
}

async function requireBucketResource(caller: RPCCaller, resourceId: string): Promise<void> {
  const saved = await caller.getResource(resourceId);
  if (saved.resource.id !== resourceId || saved.resource.type !== "cloudflare-r2-bucket") throw new WorkflowError("Resource is not owned by this Cloudflare manager", 403);
}

function requestedLabels(value: unknown, origin: "created" | "imported"): Labels {
  if (!isRecord(value)) throw new WorkflowError("Connection group labels are required", 400);
  for (const key of Object.keys(value)) if (!ALLOWED_LABELS.has(key)) throw new WorkflowError(`Unsupported connection label: ${key}`, 400);
  const group = value[GROUP_LABEL];
  const requestedOrigin = value[ORIGIN_LABEL];
  if (typeof group !== "string" || !group.trim() || requestedOrigin !== origin) throw new WorkflowError("Connection group labels are invalid", 400);
  return { [GROUP_LABEL]: group, [ORIGIN_LABEL]: origin };
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new WorkflowError(`Invalid ${label}`, 400);
  return value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Connection workflow failed";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class WorkflowError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
