// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunItem } from "@ezenki/deploy-commander-installer-interface";
import type { TeardownSnapshot } from "../runHistory";
import { TeardownPage, type TeardownPageProps } from "./TeardownPage";

const install: RunItem = { id: "install-1", action: "install", status: 2, queued_at: "2026-10-16T11:00:00Z", created_at: "2026-10-16T11:00:00Z", updated_at: "2026-10-16T11:00:00Z" };
const teardown: RunItem = { id: "teardown-1", action: "teardown", status: 1, queued_at: "2026-10-16T10:00:00Z", created_at: "2026-10-16T10:00:00Z", updated_at: "2026-10-16T10:00:00Z" };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function props(overrides: Partial<TeardownPageProps> = {}): TeardownPageProps {
  return {
    run: null,
    installRun: install,
    starting: false,
    startError: "",
    reloadBlocked: false,
    onBack: vi.fn(),
    onStart: vi.fn().mockResolvedValue(undefined),
    onReload: vi.fn(),
    ...overrides,
  };
}

describe("teardown page", () => {
  it("requires the exact lowercase confirmation and starts without a native dialog", () => {
    const confirm = vi.spyOn(window, "confirm");
    const alert = vi.spyOn(window, "alert");
    const page = props();
    render(<TeardownPage {...page} />);
    const input = screen.getByRole("textbox", { name: /type cloudflare to confirm/i });
    const button = screen.getByRole("button", { name: "Tear down" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "Cloudflare" } });
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "cloudflare extra" } });
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: " cloudflare " } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(page.onStart).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("shows accessible status immediately while teardown starts", () => {
    render(<TeardownPage {...props({ starting: true })} />);
    expect(screen.getByRole("status").textContent).toContain("Starting teardown");
  });

  it("shows saved progress and failure in the status message without a run ID", () => {
    const active: TeardownSnapshot = { run: teardown, lastEvent: { seq: 2, message: "Stopping manager service" } };
    const { rerender } = render(<TeardownPage {...props({ run: active, installRun: { ...install, queued_at: "2026-10-16T09:00:00Z" } })} />);
    expect(screen.getByRole("status").textContent).toContain("Stopping manager service");
    expect(screen.queryByText("teardown-1")).toBeNull();
    const failed: TeardownSnapshot = { run: { ...teardown, status: 3 }, lastEvent: { seq: 4, message: "Runner stopped unexpectedly" } };
    rerender(<TeardownPage {...props({ run: failed, installRun: { ...install, queued_at: "2026-10-16T09:00:00Z" } })} />);
    expect(screen.getByRole("status").textContent).toContain("Teardown failed");
    expect(screen.getByRole("status").textContent).toContain("Runner stopped unexpectedly");
  });

  it("shows a Commander start error and keeps retry enabled", () => {
    render(<TeardownPage {...props({ startError: "Commander unavailable" })} />);
    expect(screen.getByRole("status").textContent).toContain("Commander unavailable");
    fireEvent.change(screen.getByRole("textbox", { name: /type cloudflare to confirm/i }), { target: { value: "cloudflare" } });
    expect((screen.getByRole("button", { name: "Tear down" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("prevents duplicate teardown and permits teardown after a newer install", () => {
    const active = { ...teardown, status: 1 };
    const view = render(<TeardownPage {...props({ run: { run: active, lastEvent: null }, installRun: null })} />);
    fireEvent.change(screen.getByRole("textbox", { name: /type cloudflare to confirm/i }), { target: { value: "cloudflare" } });
    expect((screen.getByRole("button", { name: "Tear down" }) as HTMLButtonElement).disabled).toBe(true);
    const done: TeardownSnapshot = { run: { ...teardown, status: 2 }, lastEvent: null };
    view.rerender(<TeardownPage {...props({ run: done, installRun: { ...install, queued_at: "2026-10-16T09:00:00Z" } })} />);
    expect((screen.getByRole("button", { name: "Tear down" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<TeardownPage {...props({ run: done, installRun: install })} />);
    expect((screen.getByRole("button", { name: "Tear down" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("returns to manager and retries the current page reload when asked", () => {
    const page = props({ reloadBlocked: true });
    render(<TeardownPage {...page} />);
    fireEvent.click(screen.getByRole("button", { name: "Back to manager" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload interface" }));
    expect(page.onBack).toHaveBeenCalledOnce();
    expect(page.onReload).toHaveBeenCalledOnce();
  });
});
