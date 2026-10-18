// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RPCCaller, RunItem } from "@ezenki/deploy-commander-installer-interface";
import type { CommanderBridge, InterfaceEvent } from "./commander";
import { InstallApp } from "./InstallApp";

const defaults = {
  backendImage: "ghcr.io/ezenki/cloudflare-manager:1.2.3",
  runnerImage: "ezenki/deploy-commander-runner@sha256:d3bdcc6470a469ca8344310e94292743e0020ef16bc097b6e9cc8b64d6c347c8",
};
const install: RunItem = { id: "install-1", action: "install", status: 1, queued_at: "2026-10-16T10:00:00Z", created_at: "2026-10-16T10:00:00Z", updated_at: "2026-10-16T10:00:00Z" };

afterEach(cleanup);

function setup(options: { initialRun?: RunItem | null; event?: { seq: number; message: string } | null; initialTeardown?: RunItem | null; startError?: Error; historyError?: Error; commanderConnection?: boolean } = {}) {
  let currentRun = options.initialRun === undefined ? install : options.initialRun;
  let currentTeardown = options.initialTeardown ?? null;
  let currentEvent = options.event === undefined ? { seq: 5, message: "Install runner started" } : options.event;
  let commanderConnectionExists = options.commanderConnection ?? true;
  const caller = {
    getLatestRun: vi.fn().mockImplementation(async ({ action }: { action: string }) => {
      if (action === "install" && options.historyError) throw options.historyError;
      return action === "install" ? currentRun : currentTeardown;
    }),
    getRunEvents: vi.fn().mockImplementation(async () => ({ events: currentEvent ? [{ ...currentEvent, phase: "deploy", at: "" }] : [], limit: 1, offset: 0, total: currentEvent ? 1 : 0 })),
    getManager: vi.fn().mockResolvedValue("manager-1"),
    getResources: vi.fn().mockResolvedValue({ items: [{ id: "commander-resource", manager: "commander-manager", type: "commander" }] }),
    getConnections: vi.fn().mockImplementation(async () => ({ items: commanderConnectionExists ? [{ id: "connection-1", manager: "manager-1", resource: "commander-resource" }] : [] })),
    getConnection: vi.fn().mockResolvedValue({ connection: { id: "connection-1", manager: "manager-1", resource: "commander-resource" }, config: { metadata: { manager_api: { host: "commander", port: 6080, tls: false } } } }),
    getSecretKeys: vi.fn().mockResolvedValue([{ key: "COMMANDER_PASSWORD", created_at: "", updated_at: "" }]),
    databaseQuery: vi.fn().mockResolvedValue({ results: [{ statement: 0, status: "OK", result: [{ cloudflare_client_id: "oauth-client" }] }] }),
    start: vi.fn().mockImplementation(async () => {
      if (options.startError) throw options.startError;
      return { id: "install-2", queued_at: "2026-10-16T11:00:00Z", status: 0 };
    }),
  } as unknown as RPCCaller;
  const listeners = new Set<(event: InterfaceEvent) => void>();
  const bridge: CommanderBridge = {
    caller,
    wire: { end: vi.fn(), startInterface: vi.fn().mockImplementation(async () => { commanderConnectionExists = true; return { id: "child", close: Promise.resolve({ manager: "commander-manager", ok: true, result: { connection: { id: "connection-1", manager: "manager-1", resource: "commander-resource" } } }) }; }) } as any,
    onEvent(handler) { listeners.add(handler); return () => listeners.delete(handler); },
  };
  return {
    caller,
    bridge,
    emit(event: InterfaceEvent) { listeners.forEach((handler) => handler(event)); },
    listenerCount: () => listeners.size,
    setRun(run: RunItem | null) { currentRun = run; },
    setTeardown(run: RunItem | null) { currentTeardown = run; },
    setEvent(event: { seq: number; message: string } | null) { currentEvent = event; },
  };
}

describe("installer interface", () => {
  it("reloads the containing Commander page once for a saved successful install", async () => {
    sessionStorage.clear();
    const reload = vi.fn();
    const done = { ...install, status: 2 };
    const harness = setup({ initialRun: done });
    const reloadPage = reload;
    render(<InstallApp bridge={harness.bridge} defaults={defaults} reloadPage={reloadPage} />);
    await screen.findByText("Installed", { selector: "span" });
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it("catches a missed install completion from saved status and avoids duplicate reloads", async () => {
    sessionStorage.clear();
    const reload = vi.fn();
    const harness = setup();
    const reloadPage = reload;
    render(<InstallApp bridge={harness.bridge} defaults={defaults} reloadPage={reloadPage} />);
    await screen.findByRole("button", { name: "Installing" });
    harness.setRun({ ...install, status: 2 });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it("does not reload for a failed install and offers retry when reload is blocked", async () => {
    sessionStorage.clear();
    const failed = { ...install, status: 3 };
    const harness = setup({ initialRun: failed });
    const failedReload = vi.fn();
    const first = render(<InstallApp bridge={harness.bridge} defaults={defaults} reloadPage={failedReload} />);
    await screen.findByRole("button", { name: "Install" });
    expect(screen.queryByText("Failed")).toBeNull();
    expect(failedReload).not.toHaveBeenCalled();
    first.unmount();

    sessionStorage.clear();
    const reload = vi.fn().mockImplementationOnce(() => { throw new Error("blocked"); });
    const doneHarness = setup({ initialRun: { ...failed, status: 2 } });
    const reloadPage = reload;
    render(<InstallApp bridge={doneHarness.bridge} defaults={defaults} reloadPage={reloadPage} />);
    expect(await screen.findByRole("button", { name: "Reload interface" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload interface" }));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("uses teardown status to guard Install without showing run details", async () => {
    const teardown = { ...install, id: "teardown-1", action: "teardown", status: 1, queued_at: "2026-10-16T11:00:00Z" } as RunItem;
    const harness = setup({ initialRun: { ...install, status: 2 }, initialTeardown: teardown });
    const reloadPage = vi.fn().mockReturnValue(true);
    render(<InstallApp bridge={harness.bridge} defaults={defaults} reloadPage={reloadPage} />);
    await screen.findByRole("button", { name: "Teardown in progress" });
    expect(screen.queryByText("teardown-1")).toBeNull();
    expect(screen.queryByText("Install runner started")).toBeNull();
    expect(screen.queryByLabelText("install run status")).toBeNull();
    expect(screen.queryByLabelText("teardown run status")).toBeNull();
    expect((screen.getByRole("button", { name: "Teardown in progress" }) as HTMLButtonElement).disabled).toBe(true);
    expect(harness.caller.getRunEvents).not.toHaveBeenCalled();
    harness.setTeardown({ ...teardown, status: 2 });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Install" })).toBeTruthy());
    expect((screen.getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("restores install status without showing its ID or saved event", async () => {
    const harness = setup();
    render(<InstallApp bridge={harness.bridge} defaults={defaults} />);
    expect(await screen.findByRole("button", { name: "Installing" })).toBeTruthy();
    expect(screen.queryByText("install-1")).toBeNull();
    expect(screen.queryByText("Install runner started")).toBeNull();
    expect(screen.queryByLabelText("install run status")).toBeNull();
    expect(harness.caller.getRunEvents).not.toHaveBeenCalled();
  });

  it("uses live run events to refresh lifecycle state without displaying event messages", async () => {
    const harness = setup();
    render(<InstallApp bridge={harness.bridge} defaults={defaults} />);
    harness.emit({ type: "event", eventType: "run-update", data: { type: "event", payload: { run_id: "install-1", seq: 6, message: "Service is healthy" } } });
    await waitFor(() => expect(harness.caller.getLatestRun).toHaveBeenCalledWith({ action: "install" }));
    harness.emit({ type: "event", eventType: "run-update", data: { type: "event", payload: { run_id: "install-1", seq: 4, message: "Old event" } } });
    harness.emit({ type: "event", eventType: "run-update", data: { type: "event", payload: { run_id: "other-run", seq: 10, message: "Other run" } } });
    harness.emit({ type: "event", eventType: "run-update", data: { type: "log", payload: { run_id: "install-1", seq: 11, message: "A log line" } } });
    harness.emit({ type: "event", eventType: "run-update", data: { type: "event", payload: { run_id: "install-1", seq: 7 } } });
    expect(screen.queryByText("Old event")).toBeNull();
    expect(screen.queryByText("Other run")).toBeNull();
    expect(screen.queryByText("A log line")).toBeNull();
    expect(screen.queryByText("Service is healthy")).toBeNull();
  });

  it("refreshes the run when an install starts", async () => {
    const harness = setup({ initialRun: null, event: null });
    render(<InstallApp bridge={harness.bridge} defaults={defaults} />);
    await screen.findByRole("button", { name: "Install" });
    harness.setRun({ ...install, id: "install-3", status: 1 });
    harness.emit({ type: "event", eventType: "run-start", data: { id: "install-3", manager: "manager-1", action: "install" } });
    await screen.findByRole("button", { name: "Installing" });
    expect(screen.queryByText("install-3")).toBeNull();
    expect(harness.caller.getLatestRun).toHaveBeenCalledWith({ action: "install" });
  });

  it("keeps retry available after an install start failure", async () => {
    const harness = setup({ initialRun: null, event: null, startError: new Error("Commander unavailable") });
    render(<InstallApp bridge={harness.bridge} defaults={defaults} />);
    await screen.findByText("Commander connection ready");
    const button = await screen.findByRole("button", { name: "Install" });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("Commander unavailable");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps installation disabled when initial run history is unavailable", async () => {
    const { bridge } = setup({ historyError: new Error("Commander run history unavailable") });
    render(<InstallApp bridge={bridge} defaults={defaults} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Commander run history unavailable");
    expect(screen.getByText("Status unavailable", { selector: "span" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Status unavailable" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps install disabled until Commander reports the new run", async () => {
    const harness = setup({ initialRun: null, event: null });
    render(<InstallApp bridge={harness.bridge} defaults={defaults} />);
    await screen.findByText("Commander connection ready");
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await waitFor(() => expect(harness.caller.start).toHaveBeenCalledOnce());
    expect((screen.getByRole("button", { name: "Installing" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("unsubscribes and ends the interface wire on unmount", async () => {
    const harness = setup();
    const view = render(<InstallApp bridge={harness.bridge} defaults={defaults} />);
    await screen.findByRole("button", { name: "Installing" });
    expect(harness.listenerCount()).toBe(1);
    view.unmount();
    expect(harness.listenerCount()).toBe(0);
    expect(harness.bridge.wire.end).toHaveBeenCalledOnce();
  });

  it("keeps installation to one button and makes the OAuth setup link open a new tab", async () => {
    render(<InstallApp bridge={setup({ initialRun: null, event: null }).bridge} defaults={defaults} />);
    expect(await screen.findByRole("button", { name: "Install" })).toBeTruthy();
    expect(screen.queryByLabelText(/backend image|runner image|manager public origin|deploy commander origin/i)).toBeNull();
    expect(screen.getByRole("link", { name: /create or get a client id/i }).getAttribute("target")).toBe("_blank");
  });

  it("shows the exact Cloudflare OAuth client settings and current-origin callback", async () => {
    render(<InstallApp bridge={setup({ initialRun: null, event: null }).bridge} defaults={defaults} />);
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

  it("loads and saves the optional OAuth client ID through manager settings", async () => {
    const harness=setup({initialRun:null,event:null});render(<InstallApp bridge={harness.bridge} defaults={defaults}/>);
    const field=await screen.findByLabelText("OAuth client ID") as HTMLInputElement;
    expect(field.value).toBe("oauth-client");fireEvent.change(field,{target:{value:"new-client"}});fireEvent.click(screen.getByRole("button",{name:"Save client ID"}));
    await waitFor(()=>expect(harness.caller.databaseQuery).toHaveBeenCalledWith("UPSERT manager_settings:current MERGE { cloudflare_client_id: $client_id }",{client_id:"new-client"}));
  });

  it("requires a Commander connection approval before enabling Install", async () => {
    const harness = setup({ initialRun: null, event: null, commanderConnection: false });
    render(<InstallApp bridge={harness.bridge} defaults={defaults} />);
    const install = await screen.findByRole("button", { name: "Install" }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create Commander connection" }));
    await waitFor(() => expect(screen.getByText("Commander connection ready")).toBeTruthy());
    expect(harness.bridge.wire.startInterface).toHaveBeenCalledOnce();
    expect(harness.bridge.wire.startInterface).toHaveBeenCalledWith(expect.objectContaining({ manager: "commander-manager" }));
    expect(install.disabled).toBe(false);
    fireEvent.click(install);
    await waitFor(() => expect(harness.caller.start).toHaveBeenCalledOnce());
    expect(harness.bridge.wire.startInterface).toHaveBeenCalledOnce();
  });
});
