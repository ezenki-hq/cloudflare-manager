import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";

export const BUCKET_RESOURCE_TYPE = "cloudflare-r2-bucket";
export interface ManagedBucket { accountId:string; jurisdiction:string; name:string; s3Endpoint:string; primaryDomain?:string }

export async function registerBucket(api:BackendAPI,bucket:ManagedBucket):Promise<string>{
  const result=await api.registerResource({account_id:bucket.accountId,jurisdiction:bucket.jurisdiction,bucket:bucket.name,s3_endpoint:bucket.s3Endpoint,...(bucket.primaryDomain?{primary_domain:bucket.primaryDomain}:{})});
  if(!result.resource_id)throw new Error("Manager did not return the R2 resource ID");return result.resource_id;
}
export async function findBucketResource(api:BackendAPI,bucket:ManagedBucket){return api.findResource(bucket.accountId,bucket.jurisdiction,bucket.name)}
export async function setBucketPrimaryDomain(caller:RPCCaller,resourceId:string,domain?:string):Promise<void>{if(!resourceId.trim())throw new Error("Resource ID is required");const saved=await caller.getResource(resourceId);const metadata=isRecord(saved.config.metadata)?{...saved.config.metadata}:{};if(domain)metadata.primary_domain=domain;else delete metadata.primary_domain;await caller.updateResource(resourceId,{config:{metadata}})}
export async function removeBucketRecord(caller:RPCCaller,resourceId:string):Promise<void>{if(!resourceId.trim())throw new Error("Resource ID is required");await caller.deleteResource(resourceId)}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value)}
