// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";
import type { CommanderBridge } from "./commander";
import { App } from "./App";

function setup(apiOverrides: Partial<BackendAPI> = {}, callerOverrides: Partial<RPCCaller> = {}) {
  const api = {
    clientID: vi.fn().mockResolvedValue("oauth-client"),
    saveClientID: vi.fn().mockResolvedValue(undefined),
    startOAuth: vi.fn().mockResolvedValue({ authorization_url: "https://cloudflare.example/authorize" }),
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
    findResource: vi.fn().mockResolvedValue(null),
    registerResource: vi.fn().mockResolvedValue({ resource_id: "resource-1" }),
    listConnections: vi.fn().mockResolvedValue([]),
    provisionConnection: vi.fn(),
    confirmConnection: vi.fn(),
    abortConnection: vi.fn(),
    revokeConnection: vi.fn(),
    linkConnection: vi.fn(),
    unlinkConnection: vi.fn(),
    deleteGroupConnections: vi.fn(),
    prepareTeardown: vi.fn(),
    ...apiOverrides,
  } as unknown as BackendAPI;
  const caller = {
    getLatestRun: vi.fn().mockImplementation(async ({ action }: { action?: string } = {}) => action === "install" ? { id: "install-1", action: "install", status: 2, created_at: "", queued_at: "", updated_at: "" } : null),
    getManager: vi.fn().mockResolvedValue("manager-1"),
    getManagers: vi.fn().mockResolvedValue({ items: [{ id: "manager-1", redirect: "https://app.example" }], offset: 0, limit: 100, count: 1 }),
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
    getRunEvents: vi.fn().mockResolvedValue({ events: [], limit: 1, offset: 0, total: 0 }),
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
afterEach(cleanup);

describe("Cloudflare Manager interface", () => {
  it.each([
    ["checking", undefined],
    ["signed-out", { session: vi.fn().mockResolvedValue({ authenticated: false }) }],
    ["unavailable", { session: vi.fn().mockRejectedValue(new Error("Manager unavailable")) }],
  ])("keeps Tear down available while Cloudflare auth is %s", async (_state, overrides) => {
    const { api, bridge } = setup(overrides);
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);
    expect(await screen.findByRole("button", { name: "Tear down" })).toBeTruthy();
  });

  it("starts teardown without Cloudflare session or cleanup calls and warns that keys may remain", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const reloadHost = vi.fn().mockReturnValue(true);
    const { api, bridge, caller } = setup({}, {
      getLatestRun: vi.fn().mockImplementation(async ({ action }: { action?: string } = {}) => action === "install" ? { id: "install-1", action: "install", status: 2, queued_at: "", created_at: "", updated_at: "" } : null),
      getRun: vi.fn().mockResolvedValue({ config: { runner: "ezenki/deploy-commander-runner:latest" } }),
    });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" reloadHost={reloadHost} />);
    fireEvent.click(await screen.findByRole("button", { name: "Tear down" }));
    vi.mocked(api.session).mockClear();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("access keys may remain active"));
    await waitFor(() => expect(caller.start).toHaveBeenCalledWith({ action: "teardown", runner: "ezenki/deploy-commander-runner:latest", platform: "docker" }));
    expect(api.session).not.toHaveBeenCalled();
    expect(api.prepareTeardown).not.toHaveBeenCalled();
    expect(caller.deleteResource).not.toHaveBeenCalled();
  });

  it("shows the exact Cloudflare OAuth client settings and current-origin callback", async () => {
    const { api, bridge } = setup();
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);
    const guide = await screen.findByLabelText("Cloudflare OAuth client configuration");
    expect(guide.textContent).toContain(`${window.location.origin}/auth/callback`);
    expect(guide.textContent).toContain("Client nameCloudflare Manager");
    expect(guide.textContent).toContain("Response typeCode");
    expect(guide.textContent).toContain("Grant typeAuthorization Code");
    expect(guide.textContent).toContain("Token authentication methodNone (PKCE)");
    expect(guide.textContent).toContain("Redirect URLs");
    expect(guide.textContent).toContain("Account Read, Zone Read, Workers R2 Storage Read, Workers R2 Storage Write, Account API Tokens Read, and Account API Tokens Write");
    expect(guide.textContent).toContain("Copy the client ID Cloudflare gives you into the field below");
    expect(guide.textContent).toContain(`set Client URL to ${window.location.origin}`);
  });

  it("shows user initiated Cloudflare sign-in when the session is missing", async () => {
    const popup = { close: vi.fn(), location: { href: "" } } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const { api, caller, bridge } = setup({ session: vi.fn().mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 })) });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);
    const button = await screen.findByRole("button", { name: /sign in with cloudflare/i });
    fireEvent.click(button);
    expect(window.open).toHaveBeenCalledWith("about:blank", "cloudflare-oauth", expect.stringContaining("popup"));
    expect(api.startOAuth).toHaveBeenCalledWith("oauth-client", window.location.origin, "https://cf-manager.example.test");
    expect(caller.start).not.toHaveBeenCalled();
  });

  it("shows same-site cookie guidance when popup authorization completes but session stays unauthorized", async () => {
    const popup = { close: vi.fn(), location: { href: "" } } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const { api, bridge } = setup({ session: vi.fn().mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 })) });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);
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
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);

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

  it("keeps management visible when Commander run history is unavailable", async () => {
    const { api, bridge } = setup({}, { getLatestRun: vi.fn().mockRejectedValue(new Error("Commander run history unavailable")) });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);
    expect(await screen.findByText("photos")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /start installation/i })).toBeNull();
  });

  it("shows and live-updates the latest teardown event", async () => {
    const teardown = { id: "teardown-1", action: "teardown", status: 1, created_at: "", queued_at: "", updated_at: "" };
    const { api, bridge, caller, handlers } = setup({}, {
      getLatestRun: vi.fn().mockImplementation(async ({ action }: { action?: string } = {}) => action === "teardown" ? teardown : null),
      getRunEvents: vi.fn().mockResolvedValue({ events: [{ seq: 7, message: "Credential cleanup started", phase: "cleanup", at: "" }], limit: 1, offset: 0, total: 7 }),
    });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);
    expect(await screen.findByText("Credential cleanup started")).toBeTruthy();
    handlers.forEach((handler) => handler({ type: "event", eventType: "run-update", data: { type: "event", payload: { run_id: "teardown-1", seq: 8, message: "Redirect cleared" } } }));
    expect(await screen.findByText("Redirect cleared")).toBeTruthy();
    handlers.forEach((handler) => handler({ type: "event", eventType: "run-update", data: { type: "event", payload: { run_id: "teardown-1", seq: 6, message: "Old event" } } }));
    handlers.forEach((handler) => handler({ type: "event", eventType: "run-update", data: { type: "event", payload: { run_id: "other-run", seq: 20, message: "Other run" } } }));
    handlers.forEach((handler) => handler({ type: "event", eventType: "run-update", data: { type: "log", payload: { run_id: "teardown-1", seq: 21, message: "log entry" } } }));
    handlers.forEach((handler) => handler({ type: "event", eventType: "run-update", data: { type: "event", payload: { run_id: "teardown-1", seq: 22, message: "" } } }));
    expect(screen.getByText("Redirect cleared")).toBeTruthy();
    expect(screen.queryByText("Old event")).toBeNull();
    expect(screen.queryByText("Other run")).toBeNull();
    expect(screen.queryByText("log entry")).toBeNull();
    expect(screen.queryByText("Old event")).toBeNull();
    expect(caller.getRunEvents).toHaveBeenCalledWith({ run_id: "teardown-1", limit: 1, order: "desc" });
  });

  it("does not let an older teardown refresh replace a newer run", async () => {
    const firstRefresh = deferred<any>();
    const secondRefresh = deferred<any>();
    const oldRun = { id: "teardown-old", action: "teardown", status: 2, created_at: "", queued_at: "2026-10-16T10:00:00Z", updated_at: "" };
    const newRun = { id: "teardown-new", action: "teardown", status: 1, created_at: "", queued_at: "2026-10-16T11:00:00Z", updated_at: "" };
    const { api, bridge, caller, handlers } = setup({}, {
      getLatestRun: vi.fn().mockResolvedValueOnce(oldRun),
      getRunEvents: vi.fn().mockImplementation(async ({ run_id }: { run_id: string }) => ({ events: [{ seq: 1, message: `Event for ${run_id}` }], limit: 1, offset: 0, total: 1 })),
    });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);
    expect(await screen.findByText("Event for teardown-old")).toBeTruthy();
    vi.mocked(caller.getLatestRun).mockImplementation(async ({ action }: { action?: string } = {}) => {
      if (action !== "teardown") return null;
      return firstRefresh.promise;
    });
    handlers.forEach((handler) => handler({ type: "event", eventType: "run-start", data: { id: "teardown-new", manager: "manager-1", action: "teardown" } }));
    vi.mocked(caller.getLatestRun).mockImplementation(async ({ action }: { action?: string } = {}) => action === "teardown" ? secondRefresh.promise : null);
    handlers.forEach((handler) => handler({ type: "event", eventType: "run-update", data: { type: "log", payload: { run_id: "teardown-new", seq: 1, message: "progress" } } }));
    secondRefresh.resolve(newRun);
    expect(await screen.findByText("Event for teardown-new")).toBeTruthy();
    firstRefresh.resolve(oldRun);
    await waitFor(() => expect(screen.getByLabelText("teardown run status").textContent).toContain("teardown-new"));
    expect(screen.queryByText("Event for teardown-old")).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
