// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendAPI } from "./api";
import type { CommanderBridge } from "./commander";
import { BucketSetupError, type BucketRequest, type BucketSetupResult } from "./bucketWorkflow";
import { BucketSetup } from "./BucketSetup";

const { setupBucket } = vi.hoisted(() => ({ setupBucket: vi.fn() }));
vi.mock("./bucketWorkflow", async (importOriginal) => ({ ...(await importOriginal<typeof import("./bucketWorkflow")>()), setupBucket }));

const request: BucketRequest = { serviceResourceId: "service-resource", callingManagerId: "app-manager", suggested: { account_id: "account-1", bucket: "media-files", jurisdiction: "default" } };
const result: BucketSetupResult = { resource: { id: "bucket-resource", manager: "cloudflare-manager", type: "cloudflare-r2-bucket" }, bucket: { account_id: "account-1", jurisdiction: "default", name: "media-files", s3_endpoint: "https://account-1.r2.cloudflarestorage.com" } };

function setup(authenticated = true) {
  const api = {
    session: vi.fn().mockResolvedValue({ authenticated }), clientID: vi.fn().mockResolvedValue("client-id"), listAccounts: vi.fn().mockResolvedValue([{ id: "account-1", name: "Account One" }]),
    listZones: vi.fn().mockResolvedValue([{ id: "zone-1", name: "example.test" }]), startOAuth: vi.fn().mockResolvedValue({ authorization_url: "https://cloudflare.test/oauth" }), setSessionHandle: vi.fn(), clearSessionHandle: vi.fn(),
  } as unknown as BackendAPI;
  const bridge = { caller: { getManager: vi.fn().mockResolvedValue("cloudflare-manager") }, wire: { close: vi.fn(), end: vi.fn() }, onEvent: vi.fn(() => vi.fn()) } as unknown as CommanderBridge;
  const onClose = vi.fn();
  render(<BucketSetup request={request} api={api} bridge={bridge} backendOrigin="https://manager.test" onClose={onClose} />);
  return { api, bridge, onClose };
}

describe("bucket child setup interface", () => {
  afterEach(() => cleanup());
  beforeEach(() => setupBucket.mockReset());

  it("offers the existing OAuth popup flow while signed out", async () => {
    const { api } = setup(false);
    expect(await screen.findByRole("button", { name: /sign in to cloudflare/i })).toBeTruthy();
    expect(api.listAccounts).not.toHaveBeenCalled();
  });

  it("signs in through the origin and source checked popup flow, then loads accounts and zones", async () => {
    const { api } = setup(false);
    const popup = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    await waitFor(() => expect(api.session).toHaveBeenCalledTimes(1));
    vi.mocked(api.session).mockResolvedValue({ authenticated: true });
    fireEvent.click(await screen.findByRole("button", { name: /sign in to cloudflare/i }));
    await waitFor(() => expect(api.startOAuth).toHaveBeenCalledWith("client-id", window.location.origin, "https://manager.test"));
    expect(popup.location.href).toBe("https://cloudflare.test/oauth");
    window.dispatchEvent(Object.assign(new Event("message"), { origin: "https://attacker.test", source: popup, data: { type: "cloudflare-oauth-complete", session_handle: "ignored" } }));
    expect(api.setSessionHandle).not.toHaveBeenCalled();
    window.dispatchEvent(Object.assign(new Event("message"), { origin: "https://manager.test", source: popup, data: { type: "cloudflare-oauth-complete", session_handle: "session-handle" } }));
    await waitFor(() => expect(api.listAccounts).toHaveBeenCalled());
    expect(api.listZones).toHaveBeenCalledWith("account-1");
  });

  it("shows suggestions without mutating until the user confirms", async () => {
    setupBucket.mockResolvedValue(result);
    setup();
    expect((await screen.findByLabelText("Bucket name") as HTMLInputElement).value).toBe("media-files");
    expect(screen.getByLabelText("Account")).toBeTruthy();
    expect(screen.getByLabelText("CDN hostname (optional)")).toBeTruthy();
    expect(setupBucket).not.toHaveBeenCalled();
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(setupBucket).toHaveBeenCalledWith(expect.anything(), expect.anything(), request, expect.objectContaining({ accountId: "account-1", jurisdiction: "default", bucket: "media-files", mode: "create" }), expect.any(Function)));
  });

  it("passes existing bucket and optional CDN selections only after confirmation", async () => {
    setupBucket.mockResolvedValue({ ...result, cdn: { domain: "cdn.example.test", enabled: false, status: { ownership: "pending" } } });
    setup();
    await screen.findByRole("button", { name: /create bucket and resource/i });
    fireEvent.change(screen.getByLabelText("Bucket mode"), { target: { value: "existing" } });
    fireEvent.change(screen.getByLabelText("CDN hostname (optional)"), { target: { value: "cdn.example.test" } });
    await screen.findByRole("option", { name: "example.test" });
    fireEvent.change(screen.getByLabelText("Cloudflare zone"), { target: { value: "zone-1" } });
    expect(setupBucket).not.toHaveBeenCalled();
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(setupBucket).toHaveBeenCalledWith(expect.anything(), expect.anything(), request, { accountId: "account-1", jurisdiction: "default", bucket: "media-files", mode: "existing", domain: "cdn.example.test", zoneId: "zone-1" }, expect.any(Function)));
  });

  it("returns the successful nonsecret result and closes exactly once", async () => {
    setupBucket.mockResolvedValue(result);
    const { onClose, bridge } = setup();
    await screen.findByRole("button", { name: /create bucket and resource/i });
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(onClose).toHaveBeenCalledWith({ manager: "cloudflare-manager", ok: true, result }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(bridge.wire.close).not.toHaveBeenCalled();
  });

  it("keeps partial progress open and retries using the existing bucket mode", async () => {
    setupBucket.mockRejectedValueOnce(new BucketSetupError("resource", "The bucket resource could not be registered.", { bucketExists: true, domainAttached: false, lastCompleted: "bucket" })).mockResolvedValue(result);
    setup();
    await screen.findByRole("button", { name: /create bucket and resource/i });
    fireEvent.submit(document.querySelector("form")!);
    expect(await screen.findByText(/bucket exists/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry setup/i }));
    await waitFor(() => expect(setupBucket).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), request, expect.objectContaining({ mode: "existing" }), expect.any(Function)));
  });

  it("cancels with a structured failure response", async () => {
    const { onClose } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledWith({ manager: "cloudflare-manager", ok: false, error: { message: "Bucket setup was cancelled" } });
  });
});
