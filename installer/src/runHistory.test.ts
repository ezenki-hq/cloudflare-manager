import { describe, expect, it, vi } from "vitest";
import type { RPCCaller, RunItem } from "@ezenki/deploy-commander-installer-interface";
import { loadLatestInstall, loadLatestTeardown } from "./runHistory";

const install: RunItem = { id: "install-1", action: "install", status: 1, queued_at: "2026-10-16T10:00:00Z", created_at: "2026-10-16T10:00:00Z", updated_at: "2026-10-16T10:00:00Z" };
const teardown: RunItem = { ...install, id: "teardown-1", action: "teardown" };

describe("installer run history", () => {
  it("loads only the latest install status", async () => {
    const caller = { getLatestRun: vi.fn().mockResolvedValue(install), getRunEvents: vi.fn() } as unknown as RPCCaller;
    await expect(loadLatestInstall(caller)).resolves.toEqual(install);
    expect(caller.getLatestRun).toHaveBeenCalledWith({ action: "install" });
    expect(caller.getRunEvents).not.toHaveBeenCalled();
  });

  it("loads only the latest teardown status", async () => {
    const caller = { getLatestRun: vi.fn().mockResolvedValue(teardown), getRunEvents: vi.fn() } as unknown as RPCCaller;
    await expect(loadLatestTeardown(caller)).resolves.toEqual(teardown);
    expect(caller.getLatestRun).toHaveBeenCalledWith({ action: "teardown" });
    expect(caller.getRunEvents).not.toHaveBeenCalled();
  });

  it("returns null when no matching run exists", async () => {
    const caller = { getLatestRun: vi.fn().mockResolvedValue(null), getRunEvents: vi.fn() } as unknown as RPCCaller;
    await expect(loadLatestInstall(caller)).resolves.toBeNull();
    expect(caller.getRunEvents).not.toHaveBeenCalled();
  });
});
