import type { RPCCaller, RunItem } from "@ezenki/deploy-commander-installer-interface";

export interface RunSnapshot {
  run: RunItem;
  lastEvent: { seq: number; message: string } | null;
}

export async function loadLatestInstall(caller: RPCCaller): Promise<RunSnapshot | null> {
  return loadLatestRun(caller, "install");
}

export async function loadLatestTeardown(caller: RPCCaller): Promise<RunSnapshot | null> {
  return loadLatestRun(caller, "teardown");
}

async function loadLatestRun(caller: RPCCaller, action: "install" | "teardown"): Promise<RunSnapshot | null> {
  const run = await caller.getLatestRun({ action });
  if (!run) return null;
  const page = await caller.getRunEvents({ run_id: run.id, limit: 1, order: "desc" });
  const event = page.events[0];
  return { run, lastEvent: event ? { seq: event.seq, message: event.message } : null };
}
