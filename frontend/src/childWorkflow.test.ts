import { describe, expect, it, vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";
import { handleChildAction } from "./childWorkflow";

const groupLabels = { custom_deployer_group_id: "group-42", custom_deployer_connection_origin: "imported" };
const resourceId = "resource-7";
const connectionId = "connection-8";

function mocks() {
  const caller = {
    getManager: vi.fn().mockResolvedValue("bucket-manager"),
    getResource: vi.fn().mockResolvedValue({ resource: { id: resourceId, name: "images", type: "cloudflare-r2-bucket", manager: "bucket-manager", external: false, created_at: "", updated_at: "" }, config: { id: resourceId, manager: "bucket-manager", name: "images", agent: "", resource_type: "cloudflare-r2-bucket", metadata: { account_id: "account-1", jurisdiction: "default", bucket_name: "images", s3_endpoint: "https://account-1.r2.cloudflarestorage.com" } } }),
    getConnection: vi.fn().mockResolvedValue({ connection: { id: connectionId, manager: "app-manager", resource: resourceId, external: false, created_at: "", updated_at: "", labels: { environment: "production", ...groupLabels } }, config: { id: connectionId, manager: "app-manager", metadata: { accountId: "account-1", jurisdiction: "default", bucket: "images", endpoint: "https://account-1.r2.cloudflarestorage.com", permission: "read-only", token_id: "token-1", status: "ready" } } }),
    setConnectionLabel: vi.fn().mockResolvedValue(undefined),
    removeConnectionLabel: vi.fn().mockResolvedValue(undefined),
    deleteSecret: vi.fn().mockResolvedValue(undefined),
    deleteConnection: vi.fn().mockResolvedValue(undefined),
    updateConnection: vi.fn().mockResolvedValue(undefined),
    createConnection: vi.fn().mockResolvedValue({ connection: { id: connectionId, manager: "app-manager", resource: resourceId, external: false, created_at: "", updated_at: "", labels: { custom_deployer_group_id: "group-42", custom_deployer_connection_origin: "created" } }, config: { id: connectionId, manager: "app-manager", metadata: {} } }),
  } as unknown as RPCCaller;
  const api = {
    createCredential: vi.fn().mockResolvedValue({ token_id: "token-1", access_key_id: "key", secret_access_key: "secret" }),
    revokeCredential: vi.fn().mockResolvedValue(undefined),
    findCredential: vi.fn().mockResolvedValue({ token_id: "token-1" }),
  } as unknown as BackendAPI;
  return { caller, api };
}

describe("resource connection child actions", () => {
  it("links an existing connection with exact group labels and keeps unrelated labels", async () => {
    const { caller, api } = mocks();
    const response = await handleChildAction(caller, api, { action: "link-connection", resource: resourceId, connection: connectionId, labels: { custom_deployer_group_id: "group-42", custom_deployer_connection_origin: "imported" } }, "app-manager");
    expect(caller.setConnectionLabel).toHaveBeenCalledWith(connectionId, "custom_deployer_group_id", "group-42");
    expect(caller.setConnectionLabel).toHaveBeenCalledWith(connectionId, "custom_deployer_connection_origin", "imported");
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({ connection: { id: connectionId, resource: resourceId, labels: { custom_deployer_group_id: "group-42", custom_deployer_connection_origin: "imported" } } });
    expect(JSON.stringify(response)).not.toContain("secret");
    expect(api.createCredential).not.toHaveBeenCalled();
  });

  it("unlinks group labels while preserving unrelated labels and connection", async () => {
    const { caller } = mocks();
    const response = await handleChildAction(caller, {} as BackendAPI, { action: "unlink-connection", resource: resourceId, connection: connectionId, group: "group-42" }, "app-manager");
    expect(caller.removeConnectionLabel).toHaveBeenCalledWith(connectionId, "custom_deployer_group_id");
    expect(caller.removeConnectionLabel).toHaveBeenCalledWith(connectionId, "custom_deployer_connection_origin");
    expect(caller.deleteConnection).not.toHaveBeenCalled();
    expect(response.ok).toBe(true);
  });

  it("handles the guide's array of delete connection IDs", async () => {
    const { caller, api } = mocks();
    vi.mocked(caller.getConnection).mockResolvedValueOnce({
      connection: { id: connectionId, manager: "app-manager", resource: resourceId, external: false, created_at: "", updated_at: "", labels: { custom_deployer_group_id: "group-42", custom_deployer_connection_origin: "created" } },
      config: { id: connectionId, manager: "app-manager", resource: resourceId, metadata: { accountId: "account-1", jurisdiction: "default", bucket: "images", endpoint: "https://account-1.r2.cloudflarestorage.com", permission: "read-only", token_id: "token-1", status: "ready" } },
    });
    const response = await handleChildAction(caller, api, { action: "delete-connection", connections: [connectionId] }, "app-manager");
    expect(response.ok).toBe(true);
    expect(caller.deleteConnection).toHaveBeenCalledWith(connectionId);
    expect(api.revokeCredential).toHaveBeenCalled();
  });

  it("rejects a connection attached to a different resource", async () => {
    const { caller, api } = mocks();
    vi.mocked(caller.getConnection).mockResolvedValueOnce({ connection: { id: connectionId, manager: "app-manager", resource: "other-resource", external: false, created_at: "", updated_at: "" }, config: { id: connectionId, manager: "app-manager", resource: "other-resource", metadata: {} } });
    const response = await handleChildAction(caller, api, { action: "link-connection", resource: resourceId, connection: connectionId, labels: groupLabels }, "app-manager");
    expect(response.ok).toBe(false);
    expect(caller.setConnectionLabel).not.toHaveBeenCalled();
  });
});
