import { describe, expect, it, vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";
import { provisionConnection, revokeConnection, type ConnectionInput } from "./connections";

const resourceId = "bucket-resource";
const connectionId = "application-connection";
const managerId = "app-manager";
const labels = { custom_deployer_group_id: "group-1", custom_deployer_connection_origin: "created" };

function resource() {
  return { resource: { id: resourceId, type: "cloudflare-r2-bucket", name: "uploads", manager: "current", external: false, created_at: "", updated_at: "" }, config: { id: resourceId, manager: "current", name: "uploads", agent: "agent", resource_type: "cloudflare-r2-bucket", metadata: { account_id: "account-1", jurisdiction: "eu", bucket_name: "uploads", s3_endpoint: "https://account-1.eu.r2.cloudflarestorage.com" } } };
}

function mocks() {
  const caller = {
    getResource: vi.fn().mockResolvedValue(resource()),
    createConnection: vi.fn().mockResolvedValue({ connection: { id: connectionId, manager: managerId, resource: resourceId, external: false, created_at: "", updated_at: "" }, config: { id: connectionId, manager: managerId, metadata: {} } }),
    getConnection: vi.fn().mockResolvedValue({ connection: { id: connectionId, manager: managerId, resource: resourceId, external: false, created_at: "", updated_at: "", labels }, config: { id: connectionId, manager: managerId, metadata: { accountId: "account-1", jurisdiction: "eu", bucket: "uploads", endpoint: "https://account-1.eu.r2.cloudflarestorage.com", permission: "read-write", token_id: "token-1", status: "ready" } } }),
    setSecret: vi.fn().mockResolvedValue(undefined),
    deleteSecret: vi.fn().mockResolvedValue(undefined),
    updateConnection: vi.fn().mockResolvedValue(undefined),
    deleteConnection: vi.fn().mockResolvedValue(undefined),
    getConnectionLabelValues: vi.fn(),
    setConnectionLabel: vi.fn().mockResolvedValue(undefined),
    removeConnectionLabel: vi.fn().mockResolvedValue(undefined),
  } as unknown as RPCCaller;
  const api = {
    createCredential: vi.fn().mockResolvedValue({ token_id: "token-1", access_key_id: "key-1", secret_access_key: "secret-1" }),
    findCredential: vi.fn().mockResolvedValue({ token_id: "token-1" }),
    revokeCredential: vi.fn().mockResolvedValue(undefined),
  } as unknown as BackendAPI;
  return { caller, api };
}

const input: ConnectionInput = { resourceId, managerId, permission: "read-write", labels };

describe("application credential connections", () => {
  it("creates pending connection, provisions scoped credentials, stores secrets, and marks ready", async () => {
    const { caller, api } = mocks();
    const id = await provisionConnection(caller, api, input);
    expect(id).toBe(connectionId);
    expect(caller.createConnection).toHaveBeenCalledWith(expect.objectContaining({ status: "pending", permission: "read-write" }), managerId, false, resourceId, labels);
    expect(api.createCredential).toHaveBeenCalledWith("account-1", "uploads", { jurisdiction: "eu", connection_id: connectionId, permission: "read-write" });
    expect(caller.setSecret).toHaveBeenNthCalledWith(1, "connection", connectionId, "AWS_ACCESS_KEY_ID", "key-1");
    expect(caller.setSecret).toHaveBeenNthCalledWith(2, "connection", connectionId, "AWS_SECRET_ACCESS_KEY", "secret-1");
    expect(caller.updateConnection).toHaveBeenLastCalledWith(connectionId, expect.objectContaining({ status: "ready", token_id: "token-1" }));
    expect(JSON.stringify(id)).not.toContain("secret-1");
  });

  it("revokes the Cloudflare token when the secret handoff fails", async () => {
    const { caller, api } = mocks();
    vi.mocked(caller.setSecret).mockRejectedValueOnce(new Error("secret store unavailable"));
    await expect(provisionConnection(caller, api, input)).rejects.toThrow("secret store unavailable");
    expect(api.revokeCredential).toHaveBeenCalledWith("account-1", { token_id: "token-1", connection_id: connectionId });
    expect(caller.deleteConnection).toHaveBeenCalledWith(connectionId);
  });

  it("leaves a retriable connection when rollback cannot revoke the Cloudflare token", async () => {
    const { caller, api } = mocks();
    vi.mocked(caller.setSecret).mockRejectedValueOnce(new Error("secret store unavailable"));
    vi.mocked(api.revokeCredential).mockRejectedValueOnce(new Error("Cloudflare unavailable"));
    await expect(provisionConnection(caller, api, input)).rejects.toThrow(/Cloudflare unavailable/);
    expect(caller.updateConnection).toHaveBeenCalledWith(connectionId, expect.objectContaining({ token_id: "token-1", status: "revoke_pending" }));
    expect(caller.deleteConnection).not.toHaveBeenCalled();
  });

  it("revokes Cloudflare before deleting secrets or the Deploy Commander connection", async () => {
    const { caller, api } = mocks();
    const order: string[] = [];
    vi.mocked(api.revokeCredential).mockImplementation(async () => { order.push("cloudflare"); });
    vi.mocked(caller.deleteSecret).mockImplementation(async () => { order.push("secret"); });
    vi.mocked(caller.deleteConnection).mockImplementation(async () => { order.push("connection"); });
    await revokeConnection(caller, api, connectionId);
    expect(order[0]).toBe("cloudflare");
    expect(order.slice(-1)).toEqual(["connection"]);
    expect(order.indexOf("cloudflare")).toBeLessThan(order.indexOf("secret"));
  });
});
