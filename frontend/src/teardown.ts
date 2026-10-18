import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";
import { BUCKET_RESOURCE_TYPE, removeBucketRecord } from "./resources";

export async function startTeardown(
  caller: RPCCaller,
  api: BackendAPI,
): Promise<Awaited<ReturnType<RPCCaller["start"]>>> {
  await ensureNoActiveTeardown(caller);
  const session = await api.session();
  if (!session.authenticated) throw new Error("Sign in to Cloudflare before tearing down the manager");

  const install = await caller.getLatestRun({ action: "install" });
  if (!install) throw new Error("No install run is available to identify the runner image");
  const savedInstall = await caller.getRun(install.id);
  const runnerImage = savedInstall.config.runner;
  if (typeof runnerImage !== "string" || !hasImageTagOrDigest(runnerImage)) {
    throw new Error("The installed runner image is missing or has no tag or SHA-256 digest");
  }

  const owned = await listAllBucketResources(caller);
  const prepared = await api.prepareTeardown();
  const safe = new Set(prepared.resource_ids);
  if (owned.some(({ id }) => !safe.has(id)) || safe.size !== owned.length) {
    throw new Error(
      "Some R2 resources still have connections or could not be cleaned up; the manager service remains installed so cleanup can be retried",
    );
  }

  for (const resource of owned) await removeBucketRecord(caller, resource.id);
  return caller.start({ action: "teardown", runner: runnerImage, platform: "docker" });
}

async function ensureNoActiveTeardown(caller: RPCCaller): Promise<void> {
  const teardown = await caller.getLatestRun({ action: "teardown" });
  const install = await caller.getLatestRun({ action: "install" });
  for (const run of [teardown, install]) {
    if (run && (run.status === 0 || run.status === 1)) {
      throw new Error(`A ${run.action} run is already queued or running`);
    }
  }
}

async function listAllBucketResources(caller: RPCCaller): Promise<Array<{ id: string }>> {
  const result: Array<{ id: string }> = [];
  const limit = 100;
  for (let offset = 0; offset < 5000; offset += limit) {
    const page = await caller.getMyResources({
      type: BUCKET_RESOURCE_TYPE,
      external: false,
      limit,
      offset,
    });
    result.push(
      ...page.items
        .filter((resource) => resource.type === BUCKET_RESOURCE_TYPE)
        .map((resource) => ({ id: resource.id })),
    );
    if (result.length >= page.total || page.items.length < limit) return result;
  }
  throw new Error("Too many bucket resources to tear down safely");
}

function hasImageTagOrDigest(value: string): boolean {
  return /@sha256:[a-f0-9]{64}$/.test(value) || /:[^/:]+$/.test(value);
}
