// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    setSessionHandle: vi.fn(),
    clearSessionHandle: vi.fn(),
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
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

describe("Cloudflare Manager interface", () => {
  it("renders the teardown page on a direct route load when the manager API is unavailable", async () => {
    window.history.replaceState(null, "", "/teardown?context=commander%2F1");
    const { api, bridge } = setup({ session: vi.fn().mockRejectedValue(new Error("Manager unavailable")) });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);
    expect(await screen.findByRole("heading", { name: "Tear down Cloudflare Manager" })).toBeTruthy();
    expect(screen.queryByText("R2 storage, under control.")).toBeNull();
  });

  it("opens and leaves the teardown page through manager history navigation", async () => {
    const { api, bridge } = setup();
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);
    fireEvent.click(await screen.findByRole("button", { name: "Tear down" }));
    expect(window.location.pathname).toBe("/teardown");
    expect(await screen.findByRole("heading", { name: "Tear down Cloudflare Manager" })).toBeTruthy();
    window.history.pushState(null, "", "/?context=commander%2F1");
    fireEvent(window, new PopStateEvent("popstate"));
    expect(await screen.findByText("R2 storage, under control.")).toBeTruthy();
  });

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
    const confirm = vi.spyOn(window, "confirm");
    const reloadPage = vi.fn().mockReturnValue(true);
    const { api, bridge, caller } = setup({}, {
      getLatestRun: vi.fn().mockImplementation(async ({ action }: { action?: string } = {}) => action === "install" ? { id: "install-1", action: "install", status: 2, queued_at: "", created_at: "", updated_at: "" } : null),
      getRun: vi.fn().mockResolvedValue({ config: { runner: "ezenki/deploy-commander-runner:latest" } }),
    });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" reloadPage={reloadPage} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Tear down" }))[0]);
    expect(await screen.findByRole("heading", { name: "Tear down Cloudflare Manager" })).toBeTruthy();
    expect(screen.getByText(/application access keys may remain active/i)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: /type cloudflare to confirm/i }), { target: { value: "cloudflare" } });
    vi.mocked(api.session).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Tear down" }));
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(caller.start).toHaveBeenCalledWith({ action: "teardown", runner: "ezenki/deploy-commander-runner:latest", platform: "docker" }));
    expect(api.session).not.toHaveBeenCalled();
    expect(api.prepareTeardown).not.toHaveBeenCalled();
    expect(caller.deleteResource).not.toHaveBeenCalled();
  });

  it("keeps the teardown form disabled during an active run", async () => {
    const { api, bridge, caller } = setup({}, {
      getLatestRun: vi.fn().mockImplementation(async ({ action }: { action?: string } = {}) => action === "teardown" ? { id: "teardown-1", action: "teardown", status: 1, created_at: "", queued_at: "", updated_at: "" } : null),
    });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" reloadPage={vi.fn().mockReturnValue(true)} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Tear down" }))[0]);
    fireEvent.change(await screen.findByRole("textbox", { name: /type cloudflare to confirm/i }), { target: { value: "cloudflare" } });
    const button = screen.getByRole("button", { name: "Tear down" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(caller.start).not.toHaveBeenCalled();
  });

  it("shows a Commander start failure and allows retry", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const { api, bridge, caller } = setup({}, {
      getLatestRun: vi.fn().mockImplementation(async ({ action }: { action?: string } = {}) => action === "install" ? { id: "install-1", action: "install", status: 2, queued_at: "", created_at: "", updated_at: "" } : null),
      getRun: vi.fn().mockResolvedValue({ config: { runner: "ezenki/deploy-commander-runner:latest" } }),
      start: vi.fn().mockRejectedValueOnce(new Error("Commander unavailable")).mockResolvedValue({ id: "teardown-1", queued_at: "now", status: 0 }),
    });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" reloadPage={vi.fn().mockReturnValue(true)} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Tear down" }))[0]);
    fireEvent.change(await screen.findByRole("textbox", { name: /type cloudflare to confirm/i }), { target: { value: "cloudflare" } });
    const button = screen.getByRole("button", { name: "Tear down" });
    fireEvent.click(button);
    expect((await screen.findByRole("status")).textContent).toContain("Commander unavailable");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(caller.start).toHaveBeenCalledTimes(2));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("reloads Commander once when the active teardown redirect clears", async () => {
    sessionStorage.clear();
    window.history.replaceState(null, "", "/teardown");
    const reload = vi.fn();
    const teardown = { id: "teardown-1", action: "teardown", status: 1, created_at: "", queued_at: "", updated_at: "" };
    const { api, bridge, handlers } = setup({}, {
      getLatestRun: vi.fn().mockImplementation(async ({ action }: { action?: string } = {}) => action === "teardown" ? teardown : null),
      getManagers: vi.fn().mockResolvedValue({ items: [{ id: "manager-1", redirect: null }], offset: 0, limit: 100, count: 1 }),
    });
    const reloadPage = reload;
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" reloadPage={reloadPage} />);
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(window.location.pathname).toBe("/");
    handlers.forEach((handler) => handler({ type: "event", eventType: "run-update", data: { type: "event", payload: { run_id: "teardown-1", seq: 2, message: "Redirect cleared" } } }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it("lets the manual retry reload the current interface after automatic reload throws", async () => {
    sessionStorage.clear();
    const reloadPage = vi.fn().mockImplementationOnce(() => { throw new Error("reload failed"); });
    const { api, bridge } = setup({}, {
      getLatestRun: vi.fn().mockImplementation(async ({ action }: { action?: string } = {}) => action === "install"
        ? { id: "install-1", action: "install", status: 2, queued_at: "", created_at: "", updated_at: "" }
        : null),
      getManagers: vi.fn().mockResolvedValue({ items: [{ id: "manager-1", redirect: "https://app.example" }], offset: 0, limit: 100, count: 1 }),
    });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" reloadPage={reloadPage} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reload interface" }));
    expect(reloadPage).toHaveBeenCalledTimes(2);
  });

  it("stays on the manager after teardown fails before redirect clearance", async () => {
    window.history.replaceState(null, "", "/teardown");
    const reloadPage = vi.fn();
    const { api, bridge } = setup({}, {
      getLatestRun: vi.fn().mockResolvedValue({ id: "teardown-1", action: "teardown", status: 3, created_at: "", queued_at: "", updated_at: "" }),
    });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" reloadPage={reloadPage} />);
    expect((await screen.findByRole("status")).textContent).toContain("Teardown failed");
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it("enables teardown again after a newer install follows an old teardown", async () => {
    window.history.replaceState(null, "", "/teardown");
    const { api, bridge } = setup({}, {
      getLatestRun: vi.fn().mockImplementation(async ({ action }: { action?: string } = {}) => action === "teardown"
        ? { id: "teardown-old", action: "teardown", status: 2, queued_at: "2026-10-16T10:00:00Z", created_at: "", updated_at: "" }
        : { id: "install-new", action: "install", status: 2, queued_at: "2026-10-16T11:00:00Z", created_at: "", updated_at: "" }),
    });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" reloadPage={vi.fn().mockReturnValue(true)} />);
    await screen.findByRole("heading", { name: "Tear down Cloudflare Manager" });
    fireEvent.change(screen.getByRole("textbox", { name: /type cloudflare to confirm/i }), { target: { value: "cloudflare" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Tear down" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("catches a missed install completion with the three-second saved-state poll", async () => {
    sessionStorage.clear();
    const reload = vi.fn();
    const originalSetInterval = window.setInterval.bind(window);
    const intervalSpy = vi.spyOn(window, "setInterval").mockImplementation((handler, delay, ...args) => originalSetInterval(handler, delay, ...args));
    const harness = setup({}, { getLatestRun: vi.fn().mockImplementation(async ({ action }: { action?: string } = {}) => action === "install" ? { id: "install-1", action: "install", status: 1, queued_at: "", created_at: "", updated_at: "" } : null) });
    const reloadPage = reload;
    render(<App bridge={harness.bridge} api={harness.api} backendOrigin="https://cf-manager.example.test" reloadPage={reloadPage} />);
    await screen.findByText("photos");
    const poll = intervalSpy.mock.calls.find(([, delay]) => delay === 3000)?.[0];
    expect(poll).toBeTruthy();
    vi.mocked(harness.caller.getLatestRun).mockImplementation(async ({ action }: { action?: string } = {}) => action === "install" ? { id: "install-1", action: "install", status: 2, queued_at: "", created_at: "", updated_at: "" } : null);
    await act(async () => { (poll as () => void)(); });
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
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
    const scopes = guide.querySelectorAll(".oauth-scope-list li");
    expect(scopes).toHaveLength(5);
    expect(guide.textContent).toContain("Account Settings Read");
    expect(guide.textContent).toContain("account-settings.read");
    expect(guide.textContent).toContain("Account API Tokens Write");
    expect(guide.textContent).toContain("account-api-tokens.write");
    expect(guide.textContent).not.toContain("account.read");
    expect(guide.textContent).not.toContain("account-api-tokens.read");
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

  it("keeps OAuth sign-in available when the initial session check reports the manager unavailable", async () => {
    const popup = { close: vi.fn(), location: { href: "" } } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const { api, bridge } = setup({ session: vi.fn().mockRejectedValue(Object.assign(new Error("Manager API returned 502"), { status: 502 })) });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);

    expect(await screen.findByRole("heading", { name: "Manager service is unavailable" })).toBeTruthy();
    const button = screen.getByRole("button", { name: /sign in with cloudflare/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(api.startOAuth).toHaveBeenCalledWith("oauth-client", window.location.origin, "https://cf-manager.example.test");
    expect(screen.getByRole("button", { name: "Retry connection" })).toBeTruthy();
  });

  it("explains that a client ID is needed before sign-in can start", async () => {
    const { api, bridge } = setup({ clientID: vi.fn().mockResolvedValue(""), session: vi.fn().mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 })) });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);

    expect(await screen.findByText(/save the oauth client id above before signing in/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /sign in with cloudflare/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a useful retry state when the new OAuth session is not accepted", async () => {
    const popup = { close: vi.fn(), location: { href: "" } } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const { api, bridge } = setup({ session: vi.fn().mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 })) });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);
    fireEvent.click(await screen.findByRole("button", { name: /sign in with cloudflare/i }));
    fireEvent(window, new MessageEvent("message", { origin: "https://cf-manager.example.test", source: popup, data: { type: "cloudflare-oauth-complete", session_handle: "handle-1" } }));
    expect(await screen.findByRole("button", { name: "Retry sign-in" })).toBeTruthy();
    expect(screen.queryByText(/third.party cookies/i)).toBeNull();
    expect(api.clearSessionHandle).toHaveBeenCalledOnce();
  });

  it("refreshes the manager session after Cloudflare OAuth completes", async () => {
    const popup = { close: vi.fn(), location: { href: "" } } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const session = vi.fn()
      .mockResolvedValueOnce({ authenticated: false })
      .mockResolvedValueOnce({ authenticated: true });
    const { api, bridge } = setup({ session });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);

    fireEvent.click(await screen.findByRole("button", { name: /sign in with cloudflare/i }));
    await waitFor(() => expect(api.startOAuth).toHaveBeenCalledOnce());
    fireEvent(window, new MessageEvent("message", { origin: "https://cf-manager.example.test", source: popup, data: { type: "cloudflare-oauth-complete", session_handle: "handle-2" } }));

    expect(await screen.findByText("Cloudflare connected")).toBeTruthy();
    expect(session).toHaveBeenCalledTimes(2);
    expect(api.setSessionHandle).toHaveBeenCalledWith("handle-2");
  });

  it("ignores forged, empty-handle, and wrong-origin completion messages", async () => {
    const popup = { close: vi.fn(), location: { href: "" } } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const { api, bridge } = setup({ session: vi.fn().mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 })) });
    render(<App bridge={bridge} api={api} backendOrigin="https://cf-manager.example.test" />);
    fireEvent.click(await screen.findByRole("button", { name: /sign in with cloudflare/i }));
    await waitFor(() => expect(api.startOAuth).toHaveBeenCalledOnce());
    fireEvent(window, new MessageEvent("message", { origin: "https://cf-manager.example.test", source: window, data: { type: "cloudflare-oauth-complete", session_handle: "forged" } }));
    fireEvent(window, new MessageEvent("message", { origin: "https://cf-manager.example.test", source: popup, data: { type: "cloudflare-oauth-complete", session_handle: "" } }));
    fireEvent(window, new MessageEvent("message", { origin: "https://evil.example.test", source: popup, data: { type: "cloudflare-oauth-complete", session_handle: "forged" } }));
    expect(api.setSessionHandle).not.toHaveBeenCalled();
    expect(api.session).toHaveBeenCalledOnce();
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

  it("shows and live-updates teardown status on the dedicated page", async () => {
    window.history.replaceState(null, "", "/teardown");
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

  it("does not let an older teardown refresh replace a newer status message", async () => {
    window.history.replaceState(null, "", "/teardown");
    const firstRefresh = deferred<any>();
    const secondRefresh = deferred<any>();
    const oldRun = { id: "teardown-old", action: "teardown", status: 1, created_at: "", queued_at: "2026-10-16T10:00:00Z", updated_at: "" };
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
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Event for teardown-new"));
    expect(screen.queryByText("Event for teardown-old")).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
