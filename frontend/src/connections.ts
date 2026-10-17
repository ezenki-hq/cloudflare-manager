import type { Labels, RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";

export const ACCESS_KEY_SECRET="AWS_ACCESS_KEY_ID";
export const SECRET_ACCESS_KEY_SECRET="AWS_SECRET_ACCESS_KEY";
export interface ConnectionInput{resourceId:string;managerId:string;permission:"read-only"|"read-write";labels?:Labels}

export async function provisionConnection(caller:RPCCaller,api:BackendAPI,input:ConnectionInput):Promise<string>{
  validateId(input.resourceId,"resource ID");validateId(input.managerId,"application manager ID");
  if(input.permission!=="read-only"&&input.permission!=="read-write")throw new Error("Invalid R2 access permission");
  let provisioned=await api.provisionConnection({resource_id:input.resourceId,manager_id:input.managerId,permission:input.permission,...(input.labels?{labels:input.labels}:{})});
  const id=provisioned.connection_id;if(!id)throw new Error("Manager did not return the pending connection ID");
  try{
    await caller.setSecret("connection",id,ACCESS_KEY_SECRET,provisioned.access_key_id);
    await caller.setSecret("connection",id,SECRET_ACCESS_KEY_SECRET,provisioned.secret_access_key);
    const keys=await caller.getSecretKeys("connection",id);const names=new Set(keys.map((item)=>item.key));
    if(!names.has(ACCESS_KEY_SECRET)||!names.has(SECRET_ACCESS_KEY_SECRET))throw new Error("Commander did not confirm both S3 secrets");
    await api.confirmConnection(id);
  }catch(error){
    const original=error instanceof Error?error.message:"S3 secret handoff failed";
    try{await api.abortConnection(id)}catch(cleanup){const detail=cleanup instanceof Error?cleanup.message:"connection cleanup failed";throw new Error(`${original}; pending connection cleanup failed: ${detail}`)}
    throw error;
  }finally{provisioned={connection_id:"",token_id:"",access_key_id:"",secret_access_key:""}}
  return id;
}

export async function revokeConnection(_caller:RPCCaller,api:BackendAPI,connectionId:string):Promise<void>{validateId(connectionId,"connection ID");await api.revokeConnection(connectionId)}
function validateId(value:string,label:string):void{if(!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new Error(`Invalid ${label}`)}
