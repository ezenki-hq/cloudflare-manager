import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";

export async function startTeardown(caller: RPCCaller): Promise<Awaited<ReturnType<RPCCaller["start"]>>> {
  const [teardown, install] = await Promise.all([
    caller.getLatestRun({ action: "teardown" }),
    caller.getLatestRun({ action: "install" }),
  ]);
  ensureTeardownCanStart(teardown, install);
  if (!install) throw new Error("No install run is available to identify the runner image");
  const savedInstall = await caller.getRun(install.id);
  const runnerImage = savedInstall.config.runner;
  if (typeof runnerImage !== "string" || !hasImageTagOrDigest(runnerImage)) {
    throw new Error("The installed runner image is missing or has no tag or SHA-256 digest");
  }

  return caller.start({ action: "teardown", runner: runnerImage, platform: "docker" });
}

function ensureTeardownCanStart(
  teardown: Awaited<ReturnType<RPCCaller["getLatestRun"]>>,
  install: Awaited<ReturnType<RPCCaller["getLatestRun"]>>,
): void {
  for (const run of [teardown, install]) {
    if (run && (run.status === 0 || run.status === 1)) {
      throw new Error(`A ${run.action} run is already queued or running`);
    }
  }
  if (teardown?.status === 2) {
    const teardownTime = Date.parse(teardown.queued_at ?? "");
    const installTime = Date.parse(install?.queued_at ?? "");
    if (!Number.isFinite(teardownTime) || !Number.isFinite(installTime) || installTime <= teardownTime) {
      throw new Error("The manager has already been torn down. Install it again before starting another teardown.");
    }
  }
}

function hasImageTagOrDigest(value: string): boolean {
  return /@sha256:[a-f0-9]{64}$/.test(value) || /:[^/:]+$/.test(value);
}
