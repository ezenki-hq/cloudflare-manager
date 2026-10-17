import { describe, expect, it, vi } from "vitest";
import type { RPCCaller, Wire } from "@ezenki/deploy-commander-installer-interface";
import { managerAPIURL, resolveCommanderConnection } from "./commanderConnection";

function harness(existing = false) {
  const caller = {
    getManagers: vi.fn().mockResolvedValue({ items: [{ id: "commander-manager" }] }),
    getResources: vi.fn().mockResolvedValue({ items: [{ id: "commander-resource" }] }),
    getResource: vi.fn().mockResolvedValue({ resource: { id: "commander-resource", manager: "commander-manager", type: "commander" }, config: { metadata: { manager_api: { host: "commander", port: 6080, tls: false } } } }),
    getConnections: vi.fn().mockResolvedValue({ items: existing ? [{ id: "connection-1", manager: "manager-1", resource: "commander-resource" }] : [] }),
    getConnection: vi.fn().mockResolvedValue({ connection: { id: "connection-1", manager: "manager-1", resource: "commander-resource" }, config: { metadata: {} } }),
    getSecretKeys: vi.fn().mockResolvedValue([{ key: "COMMANDER_PASSWORD", created_at: "", updated_at: "" }]),
    setSecret: vi.fn(),
  } as unknown as RPCCaller;
  const wire = { startInterface: vi.fn().mockResolvedValue({ id: "child", close: Promise.resolve({ manager: "commander-manager", ok: true, result: { connection: { id: "connection-1", manager: "manager-1", resource: "commander-resource" } } }) }) } as unknown as Wire;
  return { caller, wire };
}

describe("Commander connection bootstrap", () => {
  it("approves a connection, stores the generated password as a secret, and checks it", async () => {
    const { caller, wire } = harness();
    const result = await resolveCommanderConnection(caller, wire, "manager-1");
    expect(result).toEqual({ resourceId: "commander-resource", connectionId: "connection-1", managerAPI: "http://commander:6080/api/v1" });
    expect(wire.startInterface).toHaveBeenCalledWith(expect.objectContaining({ manager: "commander-manager", metadata: expect.objectContaining({ action: "create-connection", metadata: { createUser: { password: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) } } }) }));
    const password = vi.mocked(caller.setSecret).mock.calls[0]?.[3];
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(vi.mocked(caller.getSecretKeys)).toHaveBeenCalledWith("connection", "connection-1");
  });

  it("reuses only the matching connection with the required password key", async () => {
    const { caller, wire } = harness(true);
    await expect(resolveCommanderConnection(caller, wire, "manager-1")).resolves.toMatchObject({ connectionId: "connection-1" });
    expect(wire.startInterface).not.toHaveBeenCalled();
    vi.mocked(caller.getSecretKeys).mockResolvedValue([]);
    await expect(resolveCommanderConnection(caller, wire, "manager-1")).rejects.toThrow(/COMMANDER_PASSWORD/i);
  });

  it("fails on ambiguity, identity mismatch, denial, and malformed API metadata", async () => {
    const ambiguous = harness(); vi.mocked(ambiguous.caller.getManagers).mockResolvedValue({ items: [{ id: "a" }, { id: "b" }] } as any);
    await expect(resolveCommanderConnection(ambiguous.caller, ambiguous.wire, "manager-1")).rejects.toThrow(/exactly one/i);
    const mismatch = harness(); vi.mocked(mismatch.wire.startInterface).mockResolvedValue({ id: "child", close: Promise.resolve({ manager: "commander-manager", ok: true, result: { connection: { id: "c", manager: "someone-else", resource: "commander-resource" } } }) } as any);
    await expect(resolveCommanderConnection(mismatch.caller, mismatch.wire, "manager-1")).rejects.toThrow(/identity/i);
    expect(vi.mocked(mismatch.caller.setSecret)).not.toHaveBeenCalled();
    expect(() => managerAPIURL({ host: "commander", port: 0, tls: false })).toThrow(/port/i);
    expect(() => managerAPIURL({ host: "commander", port: 6080, tls: "yes" })).toThrow(/TLS/i);
  });

  it("does not start a run after approval denial", async () => {
    const { caller, wire } = harness(); vi.mocked(wire.startInterface).mockResolvedValue({ id: "child", close: Promise.resolve({ manager: "commander-manager", ok: false, error: { message: "Denied" } }) } as any);
    await expect(resolveCommanderConnection(caller, wire, "manager-1")).rejects.toThrow("Denied");
  });
});
