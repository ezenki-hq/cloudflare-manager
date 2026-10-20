import { describe, expect, it, vi } from "vitest";
import type { RPCCaller, RunItem } from "@ezenki/deploy-commander-installer-interface";
import { buildInstallRun, installationState, startInstall, type InstallInput } from "./installer";

const input: InstallInput = { backendImage: "ezenki/cloudflare-manager:latest", stateTTLImage: "ezenki/cloudflare-manager-state-ttl:latest", runnerImage: "ezenki/deploy-commander-runner:latest" };
const commander = { resourceId: "commander-resource", connectionId: "connection-id", managerAPI: "http://commander:6080/api/v1" };
const run = (action: string, status: number, queued_at: string): RunItem => ({ id: `${action}-${status}`, action, status, queued_at, created_at: queued_at, updated_at: queued_at });

describe("initial installer", () => {
  it("builds a values-enabled one-click install with approved Commander connection", () => {
    const options = buildInstallRun({ ...input, managerId: "manager-uuid", commander });
    expect(options.action).toBe("install"); expect(options.platform).toBe("docker"); expect(options.runner).toBe(input.runnerImage);
    const metadata = options.metadata as any;
    expect(metadata.values_version).toBe(1);
    expect(metadata.services["generate-jwt-secret"]).toMatchObject({ role:"runner", command:["generate-jwt-secret"], stream_output:false, capture_variables:[{stream:"stdout",pattern:"(?P<JWT_SECRET>[A-Za-z0-9_-]{43})"}] });
    expect(metadata.services["cloudflare-manager"]).toMatchObject({ depends_on:["generate-jwt-secret"], connections:[{type:"Connection",data:{resource:"commander-resource",connection:"connection-id"}}], environment:{ MANAGER_ID:"manager-uuid", MANAGER_API:commander.managerAPI, MANAGER_PASSWORD:"[[secret:connection:connection-id:COMMANDER_PASSWORD]]", JWT_SECRET:"[[variable:JWT_SECRET]]" } });
    expect(metadata.services).not.toHaveProperty("oauth-state-ttl");
    expect(metadata.chronjobs["oauth-state-ttl"]).toEqual({ timer:"* * * * *", services:{ prune:{ image:input.stateTTLImage, connections:[{type:"Connection",data:{resource:"commander-resource",connection:"connection-id"}}], environment:{ MANAGER_ID:"manager-uuid", MANAGER_API:commander.managerAPI, MANAGER_PASSWORD:"[[secret:connection:connection-id:COMMANDER_PASSWORD]]" } } } });
    expect(Object.keys(metadata.chronjobs["oauth-state-ttl"].services.prune).sort()).toEqual(["connections","environment","image"].sort());
    expect(options.action).toBe("install"); expect(metadata).not.toHaveProperty("remove_chronjobs");
    expect(metadata.object_hooks[0]).toMatchObject({ kind:"container",name:"cloudflare-manager",create:{after:{query:"UPSERT manager_settings:current SET jwt_secret = $jwt_secret",bindings:{jwt_secret:"[[variable:JWT_SECRET]]"}}} });
    expect(JSON.stringify(options)).not.toContain("oauth-client"); expect(JSON.stringify(options)).not.toContain("COMMANDER_ORIGIN");
  });

  it("accepts latest runner tags and rejects missing Commander inputs", () => {
    expect(buildInstallRun({ ...input, managerId:"manager", commander }).runner).toBe("ezenki/deploy-commander-runner:latest");
    expect(() => buildInstallRun({ ...input, managerId:"", commander })).toThrow(/manager ID/i);
    expect(() => buildInstallRun({ ...input, managerId:"manager", commander:{...commander,connectionId:""} })).toThrow(/connection ID/i);
    expect(() => buildInstallRun({ ...input, stateTTLImage:"", managerId:"manager", commander })).toThrow(/state ttl image/i);
    expect(() => buildInstallRun({ ...input, stateTTLImage:"ezenki/ttl", managerId:"manager", commander })).toThrow(/tag or SHA-256 digest/i);
    for (const stateTTLImage of ["ezenki/ttl::bad", "ezenki/ttl:bad:", "Ezenki/ttl:latest", "ezenki//ttl:latest", "registry.example:99999/ezenki/ttl:v2"]) {
      expect(() => buildInstallRun({ ...input, stateTTLImage, managerId:"manager", commander })).toThrow(/valid tagged image reference/i);
    }
    expect(() => buildInstallRun({ ...input, stateTTLImage:"ezenki/ttl@sha256:"+"a".repeat(64), managerId:"manager", commander })).not.toThrow();
    expect(() => buildInstallRun({ ...input, stateTTLImage:"registry.example:5000/ezenki/ttl:v2", managerId:"manager", commander })).not.toThrow();
  });

  it("computes install state and blocks conflicting runs", () => {
    const install=run("install",2,"2026-10-15T10:00:00Z"),teardown=run("teardown",2,"2026-10-15T11:00:00Z");
    expect(installationState(install,teardown)).toBe("ready"); expect(installationState(teardown,install)).toBe("installed");
    expect(installationState(run("install",1,"2026-10-15T10:00:00Z"),null)).toBe("installing");
    expect(installationState(null,run("teardown",0,"2026-10-15T10:00:00Z"))).toBe("tearing-down");
  });

  it("rechecks the preapproved Commander connection before starting the run", async () => {
    const caller={getLatestRun:vi.fn().mockResolvedValue(null),getManager:vi.fn().mockResolvedValue("manager-1"),start:vi.fn().mockResolvedValue({id:"run-1",queued_at:"now",status:0}),getResources:vi.fn().mockResolvedValue({items:[{id:"commander-resource",manager:"commander-manager",type:"commander"}]}),getConnections:vi.fn().mockResolvedValue({items:[{id:"connection-id",manager:"manager-1",resource:"commander-resource"}]}),getConnection:vi.fn().mockResolvedValue({connection:{id:"connection-id",manager:"manager-1",resource:"commander-resource"},config:{metadata:{manager_api:{host:"commander",port:6080,tls:false}}}}),getSecretKeys:vi.fn().mockResolvedValue([{key:"COMMANDER_PASSWORD"}] )} as unknown as RPCCaller;
    await startInstall(caller,input,commander);
    expect(caller.start).toHaveBeenCalledWith(expect.objectContaining({action:"install",runner:input.runnerImage}));
  });

  it("does not create a Commander connection or start a run during installation", async () => {
    const caller={getLatestRun:vi.fn().mockResolvedValue(null),getManager:vi.fn().mockResolvedValue("manager-1"),start:vi.fn(),getResources:vi.fn().mockResolvedValue({items:[{id:"commander-resource",manager:"commander-manager",type:"commander"}]}),getConnections:vi.fn().mockResolvedValue({items:[]})} as unknown as RPCCaller;
    await expect(startInstall(caller,input,commander)).rejects.toThrow(/create a Commander connection before installing/i);
    expect(caller.start).not.toHaveBeenCalled();
  });

  it("does not start a run when the connection is missing or a run conflicts", async () => {
    const caller={getLatestRun:vi.fn().mockResolvedValue(null),getManager:vi.fn().mockResolvedValue("manager-1"),start:vi.fn()} as unknown as RPCCaller;
    const ext=caller as unknown as Record<string,unknown>;
    Object.assign(ext,{getResources:vi.fn().mockResolvedValue({items:[{id:"commander-resource",manager:"commander-manager",type:"commander"}]}),getConnections:vi.fn().mockResolvedValue({items:[]})});
    await expect(startInstall(caller,input,commander)).rejects.toThrow(/create a Commander connection before installing/i); expect(caller.start).not.toHaveBeenCalled();
    vi.mocked(caller.getLatestRun).mockImplementation(async ({action}:any)=>action==="install"?run("install",1,"2026-10-15T10:00:00Z"):null);
    await expect(startInstall(caller,input,commander)).rejects.toThrow(/already queued or running/i); expect(caller.start).not.toHaveBeenCalled();
  });
});
