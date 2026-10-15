// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";
import type { CommanderBridge } from "./commander";
import { App } from "./App";

const installDefaults = {
  backendImage: "ghcr.io/ezenki/cloudflare-manager:1.2.3",
  runnerImage: "ezenki/deploy-commander-runner:1.2.3",
  clientId: "oauth-client",
  publicOrigin: "https://cf-manager.example.test",
  commanderOrigin: "https://commander.example.test",
};

function setup(apiOverrides: Partial<BackendAPI> = {}, callerOverrides: Partial<RPCCaller> = {}) {
  const api = {
    session: vi.fn().mockResolvedValue({ authenticated: true }),
    listAccounts: vi.fn().mockResolvedValue([{ id: "account-1", name: "Production" }]),
    listZones: vi.fn().mockResolvedValue([{ id: "zone-1", name: "example.test" }]),
    listBuckets: vi.fn().mockResolvedValue({ buckets: [{ name: "photos", jurisdiction: "default" }], cursor: "next" }),
    getBucket: vi.fn().mockResolvedValue({ name: "photos", jurisdiction: "default" }),
    createBucket: vi.fn().mockResolvedValue({ name: "new-bucket", jurisdiction: "default" }),
    deleteBucket: vi.fn().mockResolvedValue(undefined),
    listDomains: vi.fn().mockResolvedValue([{ domain: "cdn.example.test", enabled: true, status: { ownership: "active", ssl: "active" } }]),
    attachDomain: vi.fn().mockResolvedValue(undefined),
    detachDomain: vi.fn().mockResolvedValue(undefined),
    createCredential: vi.fn(),
    findCredential: vi.fn(),
    revokeCredential: vi.fn(),
    ...apiOverrides,
  } as unknown as BackendAPI;
  const caller = {
    getLatestRun: vi.fn().mockImplementation(async ({ action }: { action: string }) => action === "install" ? { id: "install-1", action: "install", status: 2, created_at: "", queued_at: "", updated_at: "" } : null),
    getManager: vi.fn().mockResolvedValue("manager-1"),
    getMyResources: vi.fn().mockResolvedValue({ items: [], limit: 100, offset: 0, total: 0 }),
    getResource: vi.fn(),
    createResource: vi.fn().mockResolvedValue({ resource: { id: "resource-1" } }),
    updateResource: vi.fn(),
    getConnections: vi.fn().mockResolvedValue({ items: [], limit: 100, offset: 0, total: 0 }),
    getConnection: vi.fn(),
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
    createConnection: vi.fn(),
    updateConnection: vi.fn(),
    deleteConnection: vi.fn(),
    deleteResource: vi.fn(),
    start: vi.fn().mockResolvedValue({ id: "run-1", queued_at: "now", status: 0 }),
    getRun: vi.fn(),
    getRunUpdates: vi.fn().mockResolvedValue({ events: { events: [] }, logs: { items: [] } }),
    ...callerOverrides,
  } as unknown as RPCCaller;
  const handlers = new Set<(event: any) => void>();
  const bridge: CommanderBridge = {
    wire: { end: vi.fn() } as any,
    caller,
    onEvent: (handler: (event: any) => void) => { handlers.add(handler); return () => handlers.delete(handler); },
  } as CommanderBridge;
  return { api, caller, bridge, handlers };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Cloudflare Manager interface", () => {
  it("shows user initiated Cloudflare sign-in when the session is missing", async () => {
    const popup = {} as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const { api, caller, bridge } = setup({ session: vi.fn().mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 })) });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" installDefaults={installDefaults} />);
    const button = await screen.findByRole("button", { name: /sign in with cloudflare/i });
    fireEvent.click(button);
    expect(window.open).toHaveBeenCalledWith("https://cf-manager.example.test/auth/start", "cloudflare-oauth", expect.stringContaining("popup"));
    expect(caller.start).not.toHaveBeenCalled();
  });

  it("shows same-site cookie guidance when popup authorization completes but session stays unauthorized", async () => {
    const popup = {} as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const { api, bridge } = setup({ session: vi.fn().mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 })) });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" installDefaults={installDefaults} />);
    fireEvent.click(await screen.findByRole("button", { name: /sign in with cloudflare/i }));
    fireEvent(window, new MessageEvent("message", { origin: "https://cf-manager.example.test", source: popup, data: { type: "cloudflare-oauth-complete" } }));
    expect(await screen.findByText(/same https site/i)).toBeTruthy();
    expect(await screen.findByText(/third.party cookies/i)).toBeTruthy();
  });

  it("loads paginated buckets, shows domain status, and confirms bucket deletion", async () => {
    const listBuckets = vi.fn().mockResolvedValue({ buckets: [] })
      .mockResolvedValueOnce({ buckets: [{ name: "photos", jurisdiction: "default" }], cursor: "cursor-2" })
      .mockResolvedValueOnce({ buckets: [{ name: "archives", jurisdiction: "default" }] });
    const { api, bridge } = setup({ listBuckets });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" installDefaults={installDefaults} />);

    expect(await screen.findByText("photos")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(await screen.findByText("archives")).toBeTruthy();
    expect(api.listBuckets).toHaveBeenLastCalledWith("account-1", "default", "cursor-2");

    fireEvent.click(screen.getByRole("button", { name: /photos/i }));
    expect(await screen.findByText(/ownership: active/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /delete bucket/i }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(api.deleteBucket).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /delete bucket/i }));
    await waitFor(() => expect(api.deleteBucket).toHaveBeenCalledWith("account-1", "default", "photos"));
  });
});
