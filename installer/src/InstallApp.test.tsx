// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RPCCaller, RunItem } from "@ezenki/deploy-commander-installer-interface";
import type { CommanderBridge, InterfaceEvent } from "./commander";
import { InstallApp } from "./InstallApp";

const defaults = {
  backendImage: "ghcr.io/ezenki/cloudflare-manager:1.2.3",
  runnerImage: "ezenki/deploy-commander-runner:1.2.3",
  clientId: "oauth-client",
  publicOrigin: "https://cf-manager.example.test",
  commanderOrigin: "https://commander.example.test",
};
const install: RunItem = { id: "install-1", action: "install", status: 1, queued_at: "2026-10-16T10:00:00Z", created_at: "2026-10-16T10:00:00Z", updated_at: "2026-10-16T10:00:00Z" };

afterEach(cleanup);

function setup(options: { initialRun?: RunItem | null; event?: { seq: number; message: string } | null; startError?: Error } = {}) {
  let currentRun = options.initialRun === undefined ? install : options.initialRun;
  let currentEvent = options.event === undefined ? { seq: 5, message: "Install runner started" } : options.event;
  const caller = {
    getLatestRun: vi.fn().mockImplementation(async ({ action }: { action: string }) => action === "install" ? currentRun : null),
    getRunEvents: vi.fn().mockImplementation(async () => ({ events: currentEvent ? [{ ...currentEvent, phase: "deploy", at: "" }] : [], limit: 1, offset: 0, total: currentEvent ? 1 : 0 })),
    getManager: vi.fn().mockResolvedValue("manager-1"),
    start: vi.fn().mockImplementation(async () => {
      if (options.startError) throw options.startError;
      return { id: "install-2", queued_at: "2026-10-16T11:00:00Z", status: 0 };
    }),
  } as unknown as RPCCaller;
  const listeners = new Set<(event: InterfaceEvent) => void>();
  const bridge: CommanderBridge = {
    caller,
    wire: { end: vi.fn() } as any,
    onEvent(handler) { listeners.add(handler); return () => listeners.delete(handler); },
  };
  return {
    caller,
    bridge,
    emit(event: InterfaceEvent) { listeners.forEach((handler) => handler(event)); },
    listenerCount: () => listeners.size,
    setRun(run: RunItem | null) { currentRun = run; },
    setEvent(event: { seq: number; message: string } | null) { currentEvent = event; },
  };
}

describe("installer interface", () => {
  it("restores install status and the latest saved event after opening", async () => {
    const { bridge } = setup();
    render(<InstallApp bridge={bridge} defaults={defaults} />);
    expect(await screen.findByText("Install runner started")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("shows a waiting message when the run has no structured event", async () => {
    render(<InstallApp bridge={setup({ event: null }).bridge} defaults={defaults} />);
    expect(await screen.findByText("Waiting for the first install event…")).toBeTruthy();
  });

  it("updates from matching live events and ignores stale or unrelated updates", async () => {
    const harness = setup();
    render(<InstallApp bridge={harness.bridge} defaults={defaults} />);
    expect(await screen.findByText("Install runner started")).toBeTruthy();
    harness.emit({ type: "event", eventType: "run-update", data: { type: "event", payload: { run_id: "install-1", seq: 6, message: "Service is healthy" } } });
    expect(await screen.findByText("Service is healthy")).toBeTruthy();
    harness.emit({ type: "event", eventType: "run-update", data: { type: "event", payload: { run_id: "install-1", seq: 4, message: "Old event" } } });
    harness.emit({ type: "event", eventType: "run-update", data: { type: "event", payload: { run_id: "other-run", seq: 10, message: "Other run" } } });
    harness.emit({ type: "event", eventType: "run-update", data: { type: "log", payload: { run_id: "install-1", seq: 11, message: "A log line" } } });
    harness.emit({ type: "event", eventType: "run-update", data: { type: "event", payload: { run_id: "install-1", seq: 7 } } });
    expect(screen.getByText("Service is healthy")).toBeTruthy();
    expect(screen.queryByText("Old event")).toBeNull();
    expect(screen.queryByText("Other run")).toBeNull();
    expect(screen.queryByText("A log line")).toBeNull();
  });

  it("refreshes the run when an install starts", async () => {
    const harness = setup({ initialRun: null, event: null });
    render(<InstallApp bridge={harness.bridge} defaults={defaults} />);
    await screen.findByRole("button", { name: "Start installation" });
    harness.setRun({ ...install, id: "install-3", status: 1 });
    harness.emit({ type: "event", eventType: "run-start", data: { id: "install-3", manager: "manager-1", action: "install" } });
    await waitFor(() => expect(screen.getByLabelText("install run status").textContent).toContain("Running"));
    expect(harness.caller.getLatestRun).toHaveBeenCalledWith({ action: "install" });
  });

  it("keeps retry available after an install start failure", async () => {
    const harness = setup({ initialRun: null, event: null, startError: new Error("Commander unavailable") });
    render(<InstallApp bridge={harness.bridge} defaults={defaults} />);
    const button = await screen.findByRole("button", { name: "Start installation" });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("Commander unavailable");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps install disabled until Commander reports the new run", async () => {
    const harness = setup({ initialRun: null, event: null });
    render(<InstallApp bridge={harness.bridge} defaults={defaults} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start installation" }));
    await waitFor(() => expect(harness.caller.start).toHaveBeenCalledOnce());
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("unsubscribes and ends the interface wire on unmount", async () => {
    const harness = setup();
    const view = render(<InstallApp bridge={harness.bridge} defaults={defaults} />);
    await screen.findByText("Install runner started");
    expect(harness.listenerCount()).toBe(1);
    view.unmount();
    expect(harness.listenerCount()).toBe(0);
    expect(harness.bridge.wire.end).toHaveBeenCalledOnce();
  });
});
