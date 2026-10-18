import { describe, expect, it, vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import { loadLatestTeardown } from "./runHistory";
import { startTeardown } from "./teardown";

function mocks() {
  const caller = {
    getMyResources: vi.fn(),
    deleteResource: vi.fn(),
    getConnections: vi.fn(),
    deleteConnection: vi.fn(),
    getLatestRun: vi.fn().mockImplementation(async ({ action }: { action?: string } = {}) => action === "teardown"
      ? { id: "teardown-run", action: "teardown", status: 2, created_at: "", queued_at: "", updated_at: "" }
      : { id: "install-run", action: "install", status: 2, created_at: "", queued_at: "", updated_at: "" }),
    getRun: vi.fn().mockResolvedValue({ run: { id: "install-run", action: "install", status: 2, created_at: "", queued_at: "", updated_at: "" }, config: { action: "install", manager: "manager", run: "install-run", runner: "ezenki/deploy-commander-runner:latest", metadata: {} } }),
    getRunUpdates: vi.fn().mockResolvedValue({ events: { events: [] }, logs: { items: [] } }),
    getRunEvents: vi.fn().mockResolvedValue({ events: [{ seq: 3, message: "Runner stopped" }], limit: 1, offset: 0, total: 3 }),
    start: vi.fn().mockImplementation(async (options: any) => ({ id: "teardown-run", queued_at: "now", status: 0, options })),
  } as unknown as RPCCaller;
  return { caller };
}

describe("manager teardown", () => {
  it("starts teardown through Commander without calling resource or connection APIs", async () => {
    const { caller } = mocks();
    const result = await startTeardown(caller);
    expect(caller.start).toHaveBeenCalledOnce();
    const options = vi.mocked(caller.start).mock.calls[0]?.[0] as any;
    expect(options).toEqual({ action: "teardown", runner: "ezenki/deploy-commander-runner:latest", platform: "docker" });
    expect(caller.getMyResources).not.toHaveBeenCalled();
    expect(caller.deleteResource).not.toHaveBeenCalled();
    expect(caller.getConnections).not.toHaveBeenCalled();
    expect(caller.deleteConnection).not.toHaveBeenCalled();
    expect(result.id).toBe("teardown-run");
  });

  it.each(["install", "teardown"])("blocks teardown while a %s run is active", async (action) => {
    const { caller } = mocks();
    vi.mocked(caller.getLatestRun).mockImplementation(async ({ action: requested }: { action?: string } = {}) => requested === action
      ? { id: "active-run", action, status: 1, created_at: "", queued_at: "", updated_at: "" }
      : null);
    await expect(startTeardown(caller)).rejects.toThrow("already queued or running");
    expect(caller.start).not.toHaveBeenCalled();
  });

  it("requires a saved install run", async () => {
    const { caller } = mocks();
    vi.mocked(caller.getLatestRun).mockImplementation(async ({ action }: { action?: string } = {}) => action === "teardown" ? null : null);
    await expect(startTeardown(caller)).rejects.toThrow("No install run");
    expect(caller.start).not.toHaveBeenCalled();
  });

  it("rejects a malformed saved runner reference", async () => {
    const { caller } = mocks();
    vi.mocked(caller.getRun).mockResolvedValueOnce({ config: { runner: "bad image" } } as any);
    await expect(startTeardown(caller)).rejects.toThrow("missing or has no tag");
    expect(caller.start).not.toHaveBeenCalled();
  });

  it("allows retry after Commander rejects the start", async () => {
    const { caller } = mocks();
    vi.mocked(caller.start).mockRejectedValueOnce(new Error("Commander unavailable"));
    await expect(startTeardown(caller)).rejects.toThrow("Commander unavailable");
    await expect(startTeardown(caller)).resolves.toMatchObject({ id: "teardown-run" });
    expect(caller.start).toHaveBeenCalledTimes(2);
  });

  it("recovers the latest durable teardown event after reload", async () => {
    const { caller } = mocks();
    const history = await loadLatestTeardown(caller);
    expect(caller.getLatestRun).toHaveBeenCalledWith({ action: "teardown" });
    expect(caller.getRunEvents).toHaveBeenCalledWith({ run_id: "teardown-run", limit: 1, order: "desc" });
    expect(history?.lastEvent).toEqual({ seq: 3, message: "Runner stopped" });
  });
});
