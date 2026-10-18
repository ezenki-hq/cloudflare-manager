import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";

export async function startTeardown(caller: RPCCaller): Promise<Awaited<ReturnType<RPCCaller["start"]>>> {
  await ensureNoActiveTeardown(caller);

  const install = await caller.getLatestRun({ action: "install" });
  if (!install) throw new Error("No install run is available to identify the runner image");
  const savedInstall = await caller.getRun(install.id);
  const runnerImage = savedInstall.config.runner;
  if (typeof runnerImage !== "string" || !hasImageTagOrDigest(runnerImage)) {
    throw new Error("The installed runner image is missing or has no tag or SHA-256 digest");
  }

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

function hasImageTagOrDigest(value: string): boolean {
  return /@sha256:[a-f0-9]{64}$/.test(value) || /:[^/:]+$/.test(value);
}
