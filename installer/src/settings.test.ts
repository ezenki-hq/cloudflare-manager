import { describe, expect, it, vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import { loadClientID, saveClientID } from "./settings";

function caller(results: any) { return { databaseQuery: vi.fn().mockResolvedValue({ results }) } as unknown as RPCCaller; }

describe("Cloudflare OAuth client setting", () => {
  it("loads the optional ID from manager_settings:current", async () => {
    const api = caller([{ statement: 0, status: "OK", result: [{ cloudflare_client_id: "client-123" }] }]);
    await expect(loadClientID(api)).resolves.toBe("client-123");
    expect(api.databaseQuery).toHaveBeenCalledWith("SELECT cloudflare_client_id FROM manager_settings:current LIMIT 1");
  });
  it("saves with a bound value so the JWT secret field is preserved", async () => {
    const api = caller([{ statement: 0, status: "OK", result: null }]);
    await saveClientID(api, " client-123 ");
    expect(api.databaseQuery).toHaveBeenCalledWith("UPSERT manager_settings:current MERGE { cloudflare_client_id: $client_id }", { client_id: "client-123" });
  });
  it("rejects statement errors and invalid IDs", async () => {
    await expect(loadClientID(caller([{ statement: 0, status: "ERR", result: "denied" }]))).rejects.toThrow(/settings/i);
    await expect(saveClientID(caller([{ statement: 0, status: "ERR" }]), "client")).rejects.toThrow(/settings/i);
    await expect(saveClientID(caller([]), "bad\nvalue")).rejects.toThrow(/invalid/i);
  });
});
