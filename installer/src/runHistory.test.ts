import { describe, expect, it, vi } from "vitest";
import type { RPCCaller, RunItem } from "@ezenki/deploy-commander-installer-interface";
import { loadLatestInstall } from "./runHistory";

const run: RunItem = { id: "install-1", action: "install", status: 1, queued_at: "2026-10-16T10:00:00Z", created_at: "2026-10-16T10:00:00Z", updated_at: "2026-10-16T10:00:00Z" };

describe("installer run history", () => {
  it("loads the latest saved structured event for the current install", async () => {
    const caller = {
      getLatestRun: vi.fn().mockResolvedValue(run),
      getRunEvents: vi.fn().mockResolvedValue({ events: [{ seq: 240, message: "Service is healthy", phase: "deploy", at: "" }], limit: 1, offset: 0, total: 241 }),
    } as unknown as RPCCaller;
    await expect(loadLatestInstall(caller)).resolves.toEqual({ run, lastEvent: { seq: 240, message: "Service is healthy" } });
    expect(caller.getRunEvents).toHaveBeenCalledWith({ run_id: "install-1", limit: 1, order: "desc" });
  });

  it("returns no event while a run has not emitted one", async () => {
    const caller = {
      getLatestRun: vi.fn().mockResolvedValue(run),
      getRunEvents: vi.fn().mockResolvedValue({ events: [], limit: 1, offset: 0, total: 0 }),
    } as unknown as RPCCaller;
    await expect(loadLatestInstall(caller)).resolves.toEqual({ run, lastEvent: null });
  });

  it("returns null when no install run exists", async () => {
    const caller = { getLatestRun: vi.fn().mockResolvedValue(null), getRunEvents: vi.fn() } as unknown as RPCCaller;
    await expect(loadLatestInstall(caller)).resolves.toBeNull();
    expect(caller.getRunEvents).not.toHaveBeenCalled();
  });
});
