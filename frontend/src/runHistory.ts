import type { RPCCaller, RunItem } from "@ezenki/deploy-commander-installer-interface";

export interface TeardownSnapshot {
  run: RunItem;
  lastEvent: { seq: number; message: string } | null;
}

export async function loadLatestTeardown(caller: RPCCaller): Promise<TeardownSnapshot | null> {
  const run = await caller.getLatestRun({ action: "teardown" });
  if (!run) return null;
  const result = await caller.getRunEvents({ run_id: run.id, limit: 1, order: "desc" });
  const event = result.events[0];
  return {
    run,
    lastEvent: event && typeof event.message === "string" && event.message.trim()
      ? { seq: event.seq, message: event.message }
      : null,
  };
}
