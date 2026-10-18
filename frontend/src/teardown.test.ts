import { describe, expect, it, vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";
import { loadLatestTeardown } from "./runHistory";
import { startTeardown } from "./teardown";

const resourceId = "bucket-resource";
const connectionId = "application-connection";

function mocks() {
  const sequence: string[] = [];
  const caller = {
    getMyResources: vi.fn().mockResolvedValue({ items: [{ id: resourceId, type: "cloudflare-r2-bucket", name: "uploads", manager: "current", external: false, created_at: "", updated_at: "" }], limit: 100, offset: 0, total: 1 }),
    getConnections: vi.fn().mockResolvedValue({ items: [{ id: connectionId, manager: "app", resource: resourceId, external: false, created_at: "", updated_at: "" }], limit: 100, offset: 0, total: 1 }),
    getConnection: vi.fn().mockResolvedValue({ connection: { id: connectionId, manager: "app", resource: resourceId, external: false, created_at: "", updated_at: "" }, config: { id: connectionId, manager: "app", resource: resourceId, metadata: { accountId: "account-1", bucket: "uploads", jurisdiction: "default", endpoint: "https://account-1.r2.cloudflarestorage.com", permission: "read-write", token_id: "token-1", status: "ready" } } }),
    getResource: vi.fn().mockResolvedValue({ resource: { id: resourceId, type: "cloudflare-r2-bucket", name: "uploads", manager: "current", external: false, created_at: "", updated_at: "" }, config: { id: resourceId, manager: "current", name: "uploads", agent: "", resource_type: "cloudflare-r2-bucket", metadata: { account_id: "account-1", bucket_name: "uploads", jurisdiction: "default", s3_endpoint: "https://account-1.r2.cloudflarestorage.com" } } }),
    deleteSecret: vi.fn().mockResolvedValue(undefined).mockImplementation(async () => { sequence.push("secret"); }),
    updateConnection: vi.fn().mockResolvedValue(undefined),
    deleteConnection: vi.fn().mockResolvedValue(undefined).mockImplementation(async () => { sequence.push("connection"); }),
    deleteResource: vi.fn().mockResolvedValue(undefined).mockImplementation(async () => { sequence.push("resource"); }),
    getLatestRun: vi.fn().mockImplementation(async ({ action }: { action?: string } = {}) => action === "teardown"
      ? { id: "teardown-run", action: "teardown", status: 2, created_at: "", queued_at: "", updated_at: "" }
      : { id: "install-run", action: "install", status: 2, created_at: "", queued_at: "", updated_at: "" }),
    getRun: vi.fn().mockResolvedValue({ run: { id: "install-run", action: "install", status: 2, created_at: "", queued_at: "", updated_at: "" }, config: { action: "install", manager: "manager", run: "install-run", runner: "ezenki/deploy-commander-runner:latest", metadata: {} } }),
    getRunUpdates: vi.fn().mockResolvedValue({ events: { events: [] }, logs: { items: [] } }),
    getRunEvents: vi.fn().mockResolvedValue({ events: [{ seq: 3, message: "Runner stopped" }], limit: 1, offset: 0, total: 3 }),
    start: vi.fn().mockImplementation(async (options: any) => { sequence.push("start"); return { id: "teardown-run", queued_at: "now", status: 0, options }; }),
  } as unknown as RPCCaller;
  const api = {
    session: vi.fn().mockResolvedValue({ authenticated: true }),
    prepareTeardown: vi.fn().mockResolvedValue({ resource_ids: [resourceId] }).mockImplementation(async () => { sequence.push("prepare"); return { resource_ids: [resourceId] }; }),
    revokeCredential: vi.fn().mockResolvedValue(undefined).mockImplementation(async () => { sequence.push("cloudflare"); }),
    findCredential: vi.fn().mockResolvedValue({ token_id: "token-1" }),
  } as unknown as BackendAPI;
  return { caller, api, sequence };
}

describe("manager teardown", () => {
  it("asks Go to clean connections, removes safe resource records, then starts one teardown run", async () => {
    const { caller, api, sequence } = mocks();
    const result = await startTeardown(caller, api);
    expect(sequence).toEqual(["prepare", "resource", "start"]);
    expect(caller.start).toHaveBeenCalledOnce();
    const options = vi.mocked(caller.start).mock.calls[0]?.[0] as any;
    expect(options).toEqual({ action: "teardown", runner: "ezenki/deploy-commander-runner:latest", platform: "docker" });
    expect(result.id).toBe("teardown-run");
  });

  it("blocks teardown when OAuth has expired", async () => {
    const { caller, api } = mocks();
    vi.mocked(api.session).mockRejectedValueOnce(Object.assign(new Error("Sign in"), { status: 401 }));
    await expect(startTeardown(caller, api)).rejects.toThrow("Sign in");
    expect(caller.start).not.toHaveBeenCalled();
  });

  it("blocks teardown and retains resources when Go cannot finish cleanup", async () => {
    const { caller, api } = mocks();
    vi.mocked(api.prepareTeardown).mockRejectedValueOnce(new Error("Cloudflare unavailable"));
    await expect(startTeardown(caller, api)).rejects.toThrow("Cloudflare unavailable");
    expect(caller.deleteConnection).not.toHaveBeenCalled();
    expect(caller.deleteResource).not.toHaveBeenCalled();
    expect(caller.start).not.toHaveBeenCalled();
  });

  it("keeps resource records and does not start teardown unless Go marks every resource safe", async () => {
    const { caller, api } = mocks();
    vi.mocked(api.prepareTeardown).mockResolvedValue({ resource_ids: [] });
    await expect(startTeardown(caller, api)).rejects.toThrow(/connections or could not be cleaned up/i);
    expect(caller.deleteResource).not.toHaveBeenCalled();
    expect(caller.start).not.toHaveBeenCalled();
  });

  it("recovers the latest durable teardown event after reload", async () => {
    const { caller } = mocks();
    const history = await loadLatestTeardown(caller);
    expect(caller.getLatestRun).toHaveBeenCalledWith({ action: "teardown" });
    expect(caller.getRunEvents).toHaveBeenCalledWith({ run_id: "teardown-run", limit: 1, order: "desc" });
    expect(history?.lastEvent).toEqual({ seq: 3, message: "Runner stopped" });
  });
});
