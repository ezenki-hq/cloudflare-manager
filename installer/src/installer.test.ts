import { describe, expect, it, vi } from "vitest";
import type { RPCCaller, RunItem } from "@ezenki/deploy-commander-installer-interface";
import { buildInstallRun, installationState, startInstall, type InstallInput } from "./installer";

const input: InstallInput = {
  backendImage: "ghcr.io/ezenki/cloudflare-manager:1.2.3",
  runnerImage: "ezenki/deploy-commander-runner:1.2.3",
  clientId: "cloudflare-oauth-client",
  publicOrigin: "https://cf-manager.example.test",
  commanderOrigin: "https://commander.example.test",
};

function run(action: string, status: number, queuedAt: string, id = `${action}-${status}`): RunItem {
  return { id, action, status, queued_at: queuedAt, created_at: queuedAt, updated_at: queuedAt };
}

describe("initial installer", () => {
  it("builds one service with network, health, redirect, and nonsecret configuration", () => {
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

  it("allows an install after a later successful teardown and blocks a later successful install", () => {
    const install = run("install", 2, "2026-10-15T10:00:00.000Z");
    const teardown = run("teardown", 2, "2026-10-15T11:00:00.000Z");
    expect(installationState(install, teardown)).toBe("ready");
    expect(installationState(run("install", 2, "2026-10-15T12:00:00.000Z"), teardown)).toBe("installed");
  });

  it("allows retry after failed install but blocks active runs", () => {
    expect(installationState(run("install", 3, "2026-10-15T10:00:00Z"), null)).toBe("ready");
    expect(installationState(run("install", 1, "2026-10-15T10:00:00Z"), null)).toBe("installing");
    expect(installationState(run("install", 2, "2026-10-15T09:00:00Z"), run("teardown", 0, "2026-10-15T10:00:00Z"))).toBe("tearing-down");
  });

  it("rejects ambiguous run chronology", () => {
    expect(() => installationState(run("install", 2, "2026-10-15T10:00:00Z"), run("teardown", 2, "2026-10-15T10:00:00Z"))).toThrow(/timestamps/i);
    expect(() => installationState(run("install", 2, "invalid"), run("teardown", 2, "2026-10-15T11:00:00Z"))).toThrow(/timestamps/i);
  });

  it("validates image references and same-site HTTPS origins", () => {
    expect(() => buildInstallRun({ ...input, backendImage: "" , managerId: "manager-uuid" })).toThrow(/backend image/i);
    expect(() => buildInstallRun({ ...input, runnerImage: "ezenki/deploy-commander-runner:latest", managerId: "manager-uuid" })).toThrow(/runner image.*version tag or SHA-256 digest/i);
    expect(() => buildInstallRun({ ...input, commanderOrigin: "https://other.example.org", managerId: "manager-uuid" })).toThrow(/same HTTPS site/i);
  });

  it("gets trusted manager identity and starts only when installation is ready", async () => {
    const caller = {
      getManager: vi.fn().mockResolvedValue("manager-uuid"),
      getLatestRun: vi.fn().mockResolvedValue(null),
      start: vi.fn().mockResolvedValue({ id: "run-1", queued_at: "now", status: 0 }),
    } as unknown as RPCCaller;
    const result = await startInstall(caller, input);
    expect(caller.getManager).toHaveBeenCalledOnce();
    expect(caller.getLatestRun).toHaveBeenCalledWith({ action: "install" });
    expect(caller.getLatestRun).toHaveBeenCalledWith({ action: "teardown" });
    expect(caller.start).toHaveBeenCalledWith(expect.objectContaining({ action: "install", runner: input.runnerImage }));
    expect(result.id).toBe("run-1");
  });

  it("does not start while an install is active or already installed", async () => {
    const caller = {
      getLatestRun: vi.fn().mockImplementation(async ({ action }: { action?: string } = {}) => action === "install" ? run("install", 2, "2026-10-15T10:00:00Z") : null),
      getManager: vi.fn(),
      start: vi.fn(),
    } as unknown as RPCCaller;
    await expect(startInstall(caller, input)).rejects.toThrow(/already installed/i);
    expect(caller.start).not.toHaveBeenCalled();
    vi.mocked(caller.getLatestRun).mockImplementation(async ({ action }: { action?: string } = {}) => action === "install" ? run("install", 1, "2026-10-15T10:00:00Z") : null);
    await expect(startInstall(caller, input)).rejects.toThrow(/already queued or running/i);
    expect(caller.start).not.toHaveBeenCalled();
  });
});
