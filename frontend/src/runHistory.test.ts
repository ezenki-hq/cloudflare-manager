import { describe, expect, it, vi } from "vitest";
import type { RPCCaller, RunItem } from "@ezenki/deploy-commander-installer-interface";
import { loadLatestTeardown } from "./runHistory";

const teardown: RunItem = { id: "teardown-1", action: "teardown", status: 1, created_at: "2026-10-16T10:00:00Z", queued_at: "2026-10-16T10:00:00Z", updated_at: "2026-10-16T10:00:00Z" };

describe("teardown run history", () => {
  it("loads the latest persisted event without paging through the full history", async () => {
    const caller = {
      getLatestRun: vi.fn().mockResolvedValue(teardown),
      getRunEvents: vi.fn().mockResolvedValue({ events: [{ seq: 204, message: "Redirect cleared", phase: "teardown", at: "" }], limit: 1, offset: 0, total: 205 }),
    } as unknown as RPCCaller;
    await expect(loadLatestTeardown(caller)).resolves.toEqual({ run: teardown, lastEvent: { seq: 204, message: "Redirect cleared" } });
    expect(caller.getLatestRun).toHaveBeenCalledWith({ action: "teardown" });
    expect(caller.getRunEvents).toHaveBeenCalledWith({ run_id: "teardown-1", limit: 1, order: "desc" });
  });

  it("returns no snapshot when there is no teardown run", async () => {
    const caller = { getLatestRun: vi.fn().mockResolvedValue(null), getRunEvents: vi.fn() } as unknown as RPCCaller;
    await expect(loadLatestTeardown(caller)).resolves.toBeNull();
    expect(caller.getRunEvents).not.toHaveBeenCalled();
  });
});
