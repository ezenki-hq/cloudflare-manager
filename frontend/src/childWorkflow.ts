import type { InterfaceResponse, Labels, RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";
import { provisionConnection } from "./connections";

const GROUP_LABEL="custom_deployer_group_id";const ORIGIN_LABEL="custom_deployer_connection_origin";const ALLOWED_LABELS=new Set([GROUP_LABEL,ORIGIN_LABEL]);

export async function handleChildAction(caller:RPCCaller,api:BackendAPI,metadata:unknown,callingManager:string|null):Promise<InterfaceResponse>{
  let manager:string;try{manager=await caller.getManager()}catch{return{manager:"",ok:false,error:{message:"Unable to identify the current manager"}}}
  try{
    if(!isRecord(metadata)||typeof metadata.action!=="string")throw new WorkflowError("A child action is required",400);
    switch(metadata.action){
      case "create-connection":return await createAction(caller,api,manager,metadata,callingManager);
      case "link-connection":return await linkAction(api,manager,metadata);
      case "unlink-connection":return await unlinkAction(api,manager,metadata);
      case "delete-connection":return await deleteAction(api,manager,metadata);
      default:throw new WorkflowError(`Unsupported child action: ${metadata.action}`,400);
    }
  }catch(error){return{manager,ok:false,error:{message:safeError(error),...(error instanceof WorkflowError?{status:error.status}:{})}}}
}

async function createAction(caller:RPCCaller,api:BackendAPI,manager:string,metadata:Record<string,unknown>,callingManager:string|null):Promise<InterfaceResponse>{
  const resource=stringField(metadata.resource,"resource");if(!callingManager)throw new WorkflowError("The requesting application manager is unavailable",403);const labels=requestedLabels(metadata.labels,"created");const permission=metadata.permission==="read-write"?"read-write":"read-only";
  const id=await provisionConnection(caller,api,{resourceId:resource,managerId:callingManager,permission,labels});return{manager,ok:true,result:{connection:{id,resource,labels}}};
}
async function linkAction(api:BackendAPI,manager:string,metadata:Record<string,unknown>):Promise<InterfaceResponse>{
  const resource=stringField(metadata.resource,"resource"),connection=stringField(metadata.connection,"connection"),labels=requestedLabels(metadata.labels,"imported");const result=await api.linkConnection({resource_id:resource,connection_id:connection,labels});return{manager,ok:true,result:result.connection};
}
async function unlinkAction(api:BackendAPI,manager:string,metadata:Record<string,unknown>):Promise<InterfaceResponse>{
  const resource=stringField(metadata.resource,"resource"),connection=stringField(metadata.connection,"connection"),group=stringField(metadata.group,"group");const result=await api.unlinkConnection({resource_id:resource,connection_id:connection,group});return{manager,ok:true,result:result.connection};
}
async function deleteAction(api:BackendAPI,manager:string,metadata:Record<string,unknown>):Promise<InterfaceResponse>{
  if(!Array.isArray(metadata.connections)||metadata.connections.length===0||!metadata.connections.every((value)=>typeof value==="string"))throw new WorkflowError("A list of connection IDs is required",400);
  const ids=metadata.connections as string[];const result=await api.deleteGroupConnections(ids);if(result.deleted.length!==ids.length)throw new WorkflowError("Not every created group connection was deleted",502);return{manager,ok:true,result:{connections:result.deleted.map((id)=>({id}))}};
}
function requestedLabels(value:unknown,origin:"created"|"imported"):Labels{if(!isRecord(value))throw new WorkflowError("Connection group labels are required",400);for(const key of Object.keys(value))if(!ALLOWED_LABELS.has(key))throw new WorkflowError(`Unsupported connection label: ${key}`,400);const group=value[GROUP_LABEL];if(typeof group!=="string"||!group.trim()||value[ORIGIN_LABEL]!==origin)throw new WorkflowError("Connection group labels are invalid",400);return{[GROUP_LABEL]:group,[ORIGIN_LABEL]:origin}}
function stringField(value:unknown,label:string):string{if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new WorkflowError(`Invalid ${label}`,400);return value}
function safeError(error:unknown):string{return error instanceof Error?error.message:"Connection workflow failed"}
function isRecord(value:unknown):value is Record<string,any>{return typeof value==="object"&&value!==null&&!Array.isArray(value)}
class WorkflowError extends Error{constructor(message:string,readonly status:number){super(message)}}
