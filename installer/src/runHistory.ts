import type { RPCCaller, RunItem } from "@ezenki/deploy-commander-installer-interface";

export interface LatestInstallEvent {
  seq: number;
  at: string;
  phase: string;
  message: string;
}

export async function loadLatestInstall(caller: RPCCaller): Promise<RunItem | null> {
  return caller.getLatestRun({ action: "install" });
}

export async function loadLatestInstallEvent(caller: RPCCaller, runId: string): Promise<LatestInstallEvent | null> {
  const result = await caller.getRunEvents({ run_id: runId, limit: 1, order: "desc" });
  return result.events[0] ?? null;
}

export async function loadLatestTeardown(caller: RPCCaller): Promise<RunItem | null> {
  return caller.getLatestRun({ action: "teardown" });
}
