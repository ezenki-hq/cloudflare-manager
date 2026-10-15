import { describe, expect, it, vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import { buildInstallRun, startInstall, type InstallInput } from "./installer";

const input: InstallInput = {
  backendImage: "ghcr.io/ezenki/cloudflare-manager:1.2.3",
  runnerImage: "ezenki/deploy-commander-runner:1.2.3",
  clientId: "cloudflare-oauth-client",
  publicOrigin: "https://cf-manager.example.test",
  commanderOrigin: "https://commander.example.test",
};

describe("initial installer", () => {
  it("builds a single pinned service with network, health, redirect, and no credentials", () => {
    const options = buildInstallRun({ ...input, managerId: "manager-uuid" });
    expect(options.action).toBe("install");
    expect(options.platform).toBe("docker");
    const metadata = options.metadata as any;
    expect(Object.keys(metadata.services)).toEqual(["cloudflare-manager"]);
    expect(metadata.services["cloudflare-manager"]).toEqual(expect.objectContaining({
      image: input.backendImage,
      aliases: ["cloudflare-manager-manager-uuid"],
      connections: [{ type: "Platform", data: { network: "manager" } }],
      environment: expect.objectContaining({ CF_CLIENT_ID: input.clientId, PUBLIC_ORIGIN: input.publicOrigin, COMMANDER_ORIGIN: input.commanderOrigin }),
      health_check: expect.objectContaining({ test: ["CMD", "/app/cloudflare-manager", "healthcheck"] }),
    }));
    expect(metadata.redirect.redirect).toBe("http://cloudflare-manager-manager-uuid:8080");
    expect(JSON.stringify(metadata)).not.toMatch(/client_secret|password|access_token/i);
  });

  it("uses the full-stack latest image and keeps the runner pinned", () => {
    const options = buildInstallRun({ ...input, backendImage: "ezenki/cloudflare-manager:latest", managerId: "manager-uuid" });
    expect((options.metadata as any).services["cloudflare-manager"].image).toBe("ezenki/cloudflare-manager:latest");
    expect(() => buildInstallRun({ ...input, runnerImage: "ezenki/deploy-commander-runner:latest", managerId: "manager-uuid" })).toThrow(/runner image.*version tag or SHA-256 digest/i);
  });

  it("gets the manager identity from trusted RPC and starts one install run", async () => {
    const caller = { getManager: vi.fn().mockResolvedValue("manager-uuid"), getLatestRun: vi.fn().mockResolvedValue(null), start: vi.fn().mockResolvedValue({ id: "run-1", queued_at: "now", status: 0 }) } as unknown as RPCCaller;
    const result = await startInstall(caller, input);
    expect(caller.getManager).toHaveBeenCalledOnce();
    expect(caller.start).toHaveBeenCalledOnce();
    expect(caller.start).toHaveBeenCalledWith(expect.objectContaining({ action: "install", runner: input.runnerImage }));
    expect(result.id).toBe("run-1");
  });

  it("does not turn a completed install into an update run", async () => {
    const caller = { getManager: vi.fn(), getLatestRun: vi.fn().mockResolvedValue({ id: "done", action: "install", status: 2 }), start: vi.fn() } as unknown as RPCCaller;
    await expect(startInstall(caller, input)).rejects.toThrow(/already installed/);
    expect(caller.start).not.toHaveBeenCalled();
  });
});
