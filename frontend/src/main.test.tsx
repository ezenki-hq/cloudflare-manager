// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const { createRoot, render, bridge, createBackendAPI, handleChildAction, validateBucketRequest } = vi.hoisted(() => ({
  createRoot: vi.fn(), render: vi.fn(), bridge: { caller: { getMetadata: vi.fn(), getCallingManager: vi.fn(), getManager: vi.fn() }, wire: { close: vi.fn(), end: vi.fn() }, onEvent: vi.fn() },
  createBackendAPI: vi.fn(), handleChildAction: vi.fn(), validateBucketRequest: vi.fn(),
}));
vi.mock("react-dom/client", () => ({ createRoot }));
vi.mock("./App", () => ({ App: () => null }));
vi.mock("./BucketSetup", () => ({ BucketSetup: () => null }));
vi.mock("./commander", () => ({ createCommanderBridge: () => bridge }));
vi.mock("./api", () => ({ createBackendAPI }));
vi.mock("./childWorkflow", () => ({ handleChildAction }));
vi.mock("./bucketWorkflow", () => ({ validateBucketRequest }));

async function launch(metadata: unknown, callerName: string | null = "app-manager") {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  bridge.caller.getMetadata.mockResolvedValue(metadata);
  bridge.caller.getCallingManager.mockResolvedValue(callerName);
  bridge.caller.getManager.mockResolvedValue("cloudflare-manager");
  createRoot.mockReturnValue({ render });
  createBackendAPI.mockReturnValue({});
  await import("./main");
  await waitFor(() => expect(createRoot).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("published manager child dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateBucketRequest.mockResolvedValue({ serviceResourceId: "service-resource", callingManagerId: "app-manager" });
  });

  it("closes unsupported actions with a structured failure", async () => {
    await launch({ action: "delete-all" });
    await waitFor(() => expect(bridge.wire.close).toHaveBeenCalledWith({ manager: "cloudflare-manager", ok: false, error: { message: "Unsupported child action: delete-all", status: 400 } }));
    expect(bridge.wire.close).toHaveBeenCalledTimes(1);
    expect(bridge.wire.end).toHaveBeenCalledTimes(1);
  });

  it("closes invalid bucket requests before rendering or making API calls", async () => {
    validateBucketRequest.mockRejectedValueOnce(new Error("The selected resource is not this manager's S3 provisioner"));
    await launch({ action: "create-bucket", resource: "foreign-resource" });
    await waitFor(() => expect(bridge.wire.close).toHaveBeenCalledWith({ manager: "cloudflare-manager", ok: false, error: { message: "The selected resource is not this manager's S3 provisioner" } }));
    expect(render).not.toHaveBeenCalled();
    expect(handleChildAction).not.toHaveBeenCalled();
  });

  it("routes a validated bucket request to the guided child and closes once with its response", async () => {
    const metadata = { action: "create-bucket", resource: "service-resource" };
    await launch(metadata);
    const element = vi.mocked(render).mock.calls[0][0] as { type: unknown; props: { onClose: (response: unknown) => void } };
    expect(element.type).toBeTruthy();
    const response = { manager: "cloudflare-manager", ok: true, result: { resource: { id: "bucket-resource" } } };
    element.props.onClose(response);
    element.props.onClose(response);
    expect(bridge.wire.close).toHaveBeenCalledTimes(1);
    expect(bridge.wire.close).toHaveBeenCalledWith(response);
    await waitFor(() => expect(bridge.wire.end).toHaveBeenCalledTimes(1));
  });

  it("dispatches existing connection actions through their handler", async () => {
    const response = { manager: "cloudflare-manager", ok: true, result: { connection: { id: "connection-1" } } };
    handleChildAction.mockResolvedValueOnce(response);
    const metadata = { action: "create-connection", resource: "bucket-resource" };
    await launch(metadata);
    await waitFor(() => expect(handleChildAction).toHaveBeenCalledWith(bridge.caller, expect.anything(), metadata, "app-manager"));
    expect(bridge.wire.close).toHaveBeenCalledWith(response);
  });
});
