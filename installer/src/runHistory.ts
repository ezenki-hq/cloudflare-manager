import type { RPCCaller, RunItem } from "@ezenki/deploy-commander-installer-interface";

export async function loadLatestInstall(caller: RPCCaller): Promise<RunItem | null> {
  return caller.getLatestRun({ action: "install" });
}

export async function loadLatestTeardown(caller: RPCCaller): Promise<RunItem | null> {
  return caller.getLatestRun({ action: "teardown" });
}
