import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";

export type ManagerRedirectState = "set" | "cleared" | "unknown";

export async function getCurrentManagerRedirect(caller: RPCCaller): Promise<ManagerRedirectState> {
  try {
    const managerId = await caller.getManager();
    for (let offset = 0; offset < 5000; offset += 100) {
      const page = await caller.getManagers({ limit: 100, offset });
      const manager = page.items.find((item) => item.id === managerId);
      if (manager) {
        if (!("redirect" in manager)) return "unknown";
        return manager.redirect == null || manager.redirect === "" ? "cleared" : "set";
      }
      if (page.items.length < 100 || offset + page.items.length >= page.count) break;
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}
