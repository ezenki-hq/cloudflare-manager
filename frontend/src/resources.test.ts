import { describe,expect,it,vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";
import { findBucketResource,registerBucket,removeBucketRecord,setBucketPrimaryDomain,type ManagedBucket } from "./resources";

const bucket:ManagedBucket={accountId:"account-1",jurisdiction:"eu",name:"media-files",s3Endpoint:"https://account-1.eu.r2.cloudflarestorage.com",primaryDomain:"cdn.example.test"};
describe("Cloudflare bucket resources",()=>{
  it("uses signed Go routes to register and find a resource",async()=>{
    const api={registerResource:vi.fn().mockResolvedValue({resource_id:"resource-1"}),findResource:vi.fn().mockResolvedValue({resource:{id:"resource-1"},config:{metadata:{}}})} as unknown as BackendAPI;
    await expect(registerBucket(api,bucket)).resolves.toBe("resource-1");await expect(findBucketResource(api,bucket)).resolves.toMatchObject({resource:{id:"resource-1"}});
    expect(api.registerResource).toHaveBeenCalledWith({account_id:"account-1",jurisdiction:"eu",bucket:"media-files",s3_endpoint:bucket.s3Endpoint,primary_domain:"cdn.example.test"});
  });
  it("uses authorized RPC only for primary-domain metadata and resource deletion",async()=>{
    const caller={getResource:vi.fn().mockResolvedValue({config:{metadata:{keep:true}}}),updateResource:vi.fn(),deleteResource:vi.fn()} as unknown as RPCCaller;
    await setBucketPrimaryDomain(caller,"resource-1","cdn.example.test");expect(caller.updateResource).toHaveBeenCalledWith("resource-1",{config:{metadata:{keep:true,primary_domain:"cdn.example.test"}}});
    await removeBucketRecord(caller,"resource-1");expect(caller.deleteResource).toHaveBeenCalledWith("resource-1");
  });
});
