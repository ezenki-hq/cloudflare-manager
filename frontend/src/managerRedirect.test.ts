import { describe, expect, it, vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import { getCurrentManagerRedirect } from "./managerRedirect";

function caller(pages: Array<any>) {
  return { getManager: vi.fn().mockResolvedValue("self"), getManagers: vi.fn().mockImplementation(async ({ offset }: any) => pages[offset / 100] ?? { items: [], count: 0 }) } as unknown as RPCCaller;
}

describe("getCurrentManagerRedirect", () => {
  it("finds this manager on a later page", async () => {
    const pages = [{ items: Array.from({ length: 100 }, (_, i) => ({ id: `other-${i}`, redirect: "x" })), count: 101 }, { items: [{ id: "self", redirect: "https://app.example" }], count: 101 }];
    const rpc = caller(pages);
    expect(await getCurrentManagerRedirect(rpc)).toBe("set");
    expect(rpc.getManagers).toHaveBeenCalledTimes(2);
  });
  it("does not treat another manager's empty redirect as ours", async () => expect(await getCurrentManagerRedirect(caller([{ items: [{ id: "other", redirect: "" }], count: 1 }]))).toBe("unknown"));
  it("treats omitted redirect as unknown", async () => expect(await getCurrentManagerRedirect(caller([{ items: [{ id: "self" }], count: 1 }]))).toBe("unknown"));
  it.each([null, ""])("recognizes explicit cleared redirect %s", async (redirect) => expect(await getCurrentManagerRedirect(caller([{ items: [{ id: "self", redirect }], count: 1 }]))).toBe("cleared"));
  it("returns unknown when Commander fails", async () => {
    const rpc = caller([]);
    vi.mocked(rpc.getManagers).mockRejectedValue(new Error("offline"));
    expect(await getCurrentManagerRedirect(rpc)).toBe("unknown");
  });
});
