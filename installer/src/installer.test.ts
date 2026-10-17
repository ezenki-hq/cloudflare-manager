import { describe, expect, it, vi } from "vitest";
import type { RPCCaller, RunItem, Wire } from "@ezenki/deploy-commander-installer-interface";
import { buildInstallRun, installationState, startInstall, type InstallInput } from "./installer";

const input: InstallInput = { backendImage: "ghcr.io/ezenki/cloudflare-manager:latest", runnerImage: "ezenki/deploy-commander-runner@sha256:d3bdcc6470a469ca8344310e94292743e0020ef16bc097b6e9cc8b64d6c347c8" };
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
    expect(metadata.object_hooks[0]).toMatchObject({ kind:"container",name:"cloudflare-manager",create:{after:{query:"UPSERT manager_settings:current SET jwt_secret = $jwt_secret",bindings:{jwt_secret:"[[variable:JWT_SECRET]]"}}} });
    expect(JSON.stringify(options)).not.toContain("oauth-client"); expect(JSON.stringify(options)).not.toContain("COMMANDER_ORIGIN");
  });

  it("requires a pinned runner image and rejects missing Commander inputs", () => {
    expect(() => buildInstallRun({ ...input, runnerImage:"ezenki/deploy-commander-runner:latest", managerId:"manager", commander })).toThrow(/runner image.*version tag or SHA-256 digest/i);
    expect(() => buildInstallRun({ ...input, managerId:"", commander })).toThrow(/manager ID/i);
    expect(() => buildInstallRun({ ...input, managerId:"manager", commander:{...commander,connectionId:""} })).toThrow(/connection ID/i);
  });

  it("computes install state and blocks conflicting runs", () => {
    const install=run("install",2,"2026-10-15T10:00:00Z"),teardown=run("teardown",2,"2026-10-15T11:00:00Z");
    expect(installationState(install,teardown)).toBe("ready"); expect(installationState(teardown,install)).toBe("installed");
    expect(installationState(run("install",1,"2026-10-15T10:00:00Z"),null)).toBe("installing");
    expect(installationState(null,run("teardown",0,"2026-10-15T10:00:00Z"))).toBe("tearing-down");
  });

  it("resolves the Commander connection before starting the run", async () => {
    const caller={getLatestRun:vi.fn().mockResolvedValue(null),getManager:vi.fn().mockResolvedValue("manager-1"),start:vi.fn().mockResolvedValue({id:"run-1",queued_at:"now",status:0})} as unknown as RPCCaller;
    const wire={startInterface:vi.fn().mockResolvedValue({id:"child",close:Promise.resolve({ok:true,manager:"commander",result:{connection:{id:"connection-id",manager:"manager-1",resource:"commander-resource"}}})})} as unknown as Wire;
    const extension=caller as unknown as Record<string,unknown>;
    Object.assign(extension,{getManagers:vi.fn().mockResolvedValue({items:[{id:"commander-manager"}]}),getResources:vi.fn().mockResolvedValue({items:[{id:"commander-resource"}]}),getResource:vi.fn().mockResolvedValue({resource:{id:"commander-resource",manager:"commander-manager",type:"commander"},config:{metadata:{manager_api:{host:"commander",port:6080,tls:false}}}}),getConnections:vi.fn().mockResolvedValue({items:[]}),setSecret:vi.fn(),getSecretKeys:vi.fn().mockResolvedValue([{key:"COMMANDER_PASSWORD"}])});
    await startInstall(caller,wire,input);
    expect(caller.start).toHaveBeenCalledWith(expect.objectContaining({action:"install",runner:input.runnerImage}));
  });

  it("does not start a run after approval denial or when a run conflicts", async () => {
    const caller={getLatestRun:vi.fn().mockResolvedValue(null),getManager:vi.fn().mockResolvedValue("manager-1"),start:vi.fn()} as unknown as RPCCaller;
    const denied={startInterface:vi.fn().mockResolvedValue({id:"child",close:Promise.resolve({ok:false,error:{message:"Denied"}})})} as unknown as Wire;
    const ext=caller as unknown as Record<string,unknown>;
    Object.assign(ext,{getManagers:vi.fn().mockResolvedValue({items:[{id:"commander-manager"}]}),getResources:vi.fn().mockResolvedValue({items:[{id:"commander-resource"}]}),getResource:vi.fn().mockResolvedValue({resource:{id:"commander-resource",manager:"commander-manager",type:"commander"},config:{metadata:{manager_api:{host:"commander"}}}}),getConnections:vi.fn().mockResolvedValue({items:[]}),setSecret:vi.fn(),getSecretKeys:vi.fn()});
    await expect(startInstall(caller,denied,input)).rejects.toThrow("Denied"); expect(caller.start).not.toHaveBeenCalled();
    vi.mocked(caller.getLatestRun).mockImplementation(async ({action}:any)=>action==="install"?run("install",1,"2026-10-15T10:00:00Z"):null);
    await expect(startInstall(caller,denied,input)).rejects.toThrow(/already queued or running/i); expect(denied.startInterface).toHaveBeenCalledOnce();
  });
});
