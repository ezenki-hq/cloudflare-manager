import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";
import { revokeConnection } from "./connections";
import { BUCKET_RESOURCE_TYPE, removeBucketRecord } from "./resources";

export async function startTeardown(caller: RPCCaller, api: BackendAPI): Promise<Awaited<ReturnType<RPCCaller["start"]>>> {
  await ensureNoActiveTeardown(caller);
  const session = await api.session();
  if (!session.authenticated) throw new Error("Sign in to Cloudflare before tearing down the manager");

  const install = await caller.getLatestRun({ action: "install" });
  if (!install) throw new Error("No install run is available to identify the runner image");
  const savedInstall = await caller.getRun(install.id);
  const runnerImage = savedInstall.config.runner;
  if (typeof runnerImage !== "string" || !isPinnedImage(runnerImage)) throw new Error("The installed runner image is missing or unpinned");

  const resources = await listAllBucketResources(caller);
  const cleanup: Array<{ resourceId: string; connectionIds: string[] }> = [];
  for (const resource of resources) {
    const connections = await listAllResourceConnections(caller, resource.id);
    const managed: string[] = [];
    for (const connection of connections) {
      const saved = await caller.getConnection(connection.id);
      if (isManagedConnection(saved.config.metadata)) managed.push(connection.id);
    }
    cleanup.push({ resourceId: resource.id, connectionIds: managed });
  }

  for (const resource of cleanup) {
    for (const connectionId of resource.connectionIds) await revokeConnection(caller, api, connectionId);
    await removeBucketRecord(caller, resource.resourceId);
  }

  return caller.start({ action: "teardown", runner: runnerImage, platform: "docker" });
}

async function ensureNoActiveTeardown(caller: RPCCaller): Promise<void> {
  const teardown = await caller.getLatestRun({ action: "teardown" });
  const install = await caller.getLatestRun({ action: "install" });
  for (const run of [teardown, install]) {
    if (run && (run.status === 0 || run.status === 1)) throw new Error(`A ${run.action} run is already queued or running`);
  }
}

async function listAllBucketResources(caller: RPCCaller) {
  const result: Array<{ id: string }> = [];
  const limit = 100;
  for (let offset = 0; offset < 5000; offset += limit) {
    const page = await caller.getMyResources({ type: BUCKET_RESOURCE_TYPE, external: false, limit, offset });
    result.push(...page.items.filter((resource) => resource.type === BUCKET_RESOURCE_TYPE).map((resource) => ({ id: resource.id })));
    if (result.length >= page.total || page.items.length < limit) return result;
  }
  throw new Error("Too many bucket resources to tear down safely");
}

async function listAllResourceConnections(caller: RPCCaller, resource: string) {
  const result: Awaited<ReturnType<RPCCaller["getConnections"]>>["items"] = [];
  const limit = 100;
  for (let offset = 0; offset < 5000; offset += limit) {
    const page = await caller.getConnections({ resource, limit, offset, include_labels: true });
    result.push(...page.items);
    if (result.length >= page.total || page.items.length < limit) return result;
  }
  throw new Error("Too many bucket connections to tear down safely");
}

function isManagedConnection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.permission === "read-only" || value.permission === "read-write")
    && typeof value.accountId === "string"
    && typeof value.bucket === "string"
    && typeof value.jurisdiction === "string"
    && ["pending", "ready", "revoke_pending", "revoked"].includes(String(value.status));
}

function isPinnedImage(value: string): boolean {
  return /@sha256:[a-f0-9]{64}$/.test(value) || /:[^/:]+$/.test(value) && !value.endsWith(":latest");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
