import { describe, expect, it, vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";
import { loadRunHistory, startTeardown } from "./teardown";

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
    getLatestRun: vi.fn().mockResolvedValue({ id: "install-run", action: "install", status: 2, created_at: "", queued_at: "", updated_at: "" }),
    getRun: vi.fn().mockResolvedValue({ run: { id: "install-run", action: "install", status: 2, created_at: "", queued_at: "", updated_at: "" }, config: { action: "install", manager: "manager", run: "install-run", runner: "ezenki/deploy-commander-runner:1.2.3", metadata: {} } }),
    getRunUpdates: vi.fn().mockResolvedValue({ events: { events: [] }, logs: { items: [] } }),
    start: vi.fn().mockImplementation(async (options: any) => { sequence.push("start"); return { id: "teardown-run", queued_at: "now", status: 0, options }; }),
  } as unknown as RPCCaller;
  const api = {
    session: vi.fn().mockResolvedValue({ authenticated: true }),
    revokeCredential: vi.fn().mockResolvedValue(undefined).mockImplementation(async () => { sequence.push("cloudflare"); }),
    findCredential: vi.fn().mockResolvedValue({ token_id: "token-1" }),
  } as unknown as BackendAPI;
  return { caller, api, sequence };
}

describe("manager teardown", () => {
  it("revokes application tokens and removes records before one teardown run", async () => {
    const { caller, api, sequence } = mocks();
    const result = await startTeardown(caller, api);
    expect(sequence).toEqual(["cloudflare", "secret", "secret", "connection", "resource", "start"]);
    expect(caller.start).toHaveBeenCalledOnce();
    const options = vi.mocked(caller.start).mock.calls[0]?.[0] as any;
    expect(options).toEqual({ action: "teardown", runner: "ezenki/deploy-commander-runner:1.2.3", platform: "docker" });
    expect(result.id).toBe("teardown-run");
  });

  it("blocks teardown when OAuth has expired", async () => {
    const { caller, api } = mocks();
    vi.mocked(api.session).mockRejectedValueOnce(Object.assign(new Error("Sign in"), { status: 401 }));
    await expect(startTeardown(caller, api)).rejects.toThrow("Sign in");
    expect(caller.start).not.toHaveBeenCalled();
  });

  it("blocks teardown and retains records when Cloudflare revocation fails", async () => {
    const { caller, api } = mocks();
    vi.mocked(api.revokeCredential).mockRejectedValueOnce(new Error("Cloudflare unavailable"));
    await expect(startTeardown(caller, api)).rejects.toThrow("Cloudflare unavailable");
    expect(caller.deleteConnection).not.toHaveBeenCalled();
    expect(caller.deleteResource).not.toHaveBeenCalled();
    expect(caller.start).not.toHaveBeenCalled();
  });

  it("recovers latest durable run status and updates after reload", async () => {
    const { caller } = mocks();
    const history = await loadRunHistory(caller, "install");
    expect(caller.getLatestRun).toHaveBeenCalledWith({ action: "install" });
    expect(caller.getRunUpdates).toHaveBeenCalledWith({ run_id: "install-run", event_after_seq: 0, log_after_seq: 0, limit: 100 });
    expect(history?.run.id).toBe("install-run");
  });
});
