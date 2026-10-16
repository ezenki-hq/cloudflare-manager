import type { RPCCaller, RunItem } from "@ezenki/deploy-commander-installer-interface";

export interface InstallSnapshot {
  run: RunItem;
  lastEvent: { seq: number; message: string } | null;
}

export async function loadLatestInstall(caller: RPCCaller): Promise<InstallSnapshot | null> {
  const run = await caller.getLatestRun({ action: "install" });
  if (!run) return null;
  const page = await caller.getRunEvents({ run_id: run.id, limit: 1, order: "desc" });
  const event = page.events[0];
  return { run, lastEvent: event ? { seq: event.seq, message: event.message } : null };
}
