import { describe,expect,it,vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";
import { provisionConnection,revokeConnection,type ConnectionInput } from "./connections";

const resourceId="bucket-resource",connectionId="application-connection",managerId="app-manager";
const labels={custom_deployer_group_id:"group-1",custom_deployer_connection_origin:"created"};
function mocks(){
  const caller={setSecret:vi.fn().mockResolvedValue(undefined),getSecretKeys:vi.fn().mockResolvedValue([{key:"AWS_ACCESS_KEY_ID"},{key:"AWS_SECRET_ACCESS_KEY"}])} as unknown as RPCCaller;
  const api={provisionConnection:vi.fn().mockResolvedValue({connection_id:connectionId,token_id:"token-1",access_key_id:"key-1",secret_access_key:"secret-1"}),confirmConnection:vi.fn().mockResolvedValue({}),abortConnection:vi.fn().mockResolvedValue(undefined),revokeConnection:vi.fn().mockResolvedValue(undefined)} as unknown as BackendAPI;
  return {caller,api};
}
const input:ConnectionInput={resourceId,managerId,permission:"read-write",labels};

describe("application credential connections",()=>{
  it("stores S3 credentials through Commander RPC and confirms only after checking both keys",async()=>{
    const {caller,api}=mocks();await expect(provisionConnection(caller,api,input)).resolves.toBe(connectionId);
    expect(api.provisionConnection).toHaveBeenCalledWith({resource_id:resourceId,manager_id:managerId,permission:"read-write",labels});
    expect(caller.setSecret).toHaveBeenNthCalledWith(1,"connection",connectionId,"AWS_ACCESS_KEY_ID","key-1");expect(caller.setSecret).toHaveBeenNthCalledWith(2,"connection",connectionId,"AWS_SECRET_ACCESS_KEY","secret-1");
    expect(caller.getSecretKeys).toHaveBeenCalledWith("connection",connectionId);expect(api.confirmConnection).toHaveBeenCalledWith(connectionId);
  });
  it("aborts and revokes the pending token when secret handoff fails",async()=>{const {caller,api}=mocks();vi.mocked(caller.setSecret).mockRejectedValueOnce(new Error("secret store unavailable"));await expect(provisionConnection(caller,api,input)).rejects.toThrow("secret store unavailable");expect(api.abortConnection).toHaveBeenCalledWith(connectionId);expect(api.confirmConnection).not.toHaveBeenCalled()});
  it("requires both secret keys before confirmation",async()=>{const {caller,api}=mocks();vi.mocked(caller.getSecretKeys).mockResolvedValue([{key:"AWS_ACCESS_KEY_ID",created_at:"",updated_at:""}]);await expect(provisionConnection(caller,api,input)).rejects.toThrow(/both S3 secrets/i);expect(api.abortConnection).toHaveBeenCalledWith(connectionId)});
  it("delegates connection cleanup and Cloudflare token revocation to Go",async()=>{const {caller,api}=mocks();await revokeConnection(caller,api,connectionId);expect(api.revokeConnection).toHaveBeenCalledWith(connectionId);expect(caller.setSecret).not.toHaveBeenCalled()});
});
