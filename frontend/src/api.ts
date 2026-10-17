import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import { signRequestJWT } from "./jwt";
import { loadManagerSettings } from "./settings";

export interface Session { authenticated: boolean }
export interface Account { id: string; name: string }
export interface Zone { id: string; name: string; status?: string }
export interface Bucket { name: string; jurisdiction?: string; creation_date?: string; location?: string }
export interface BucketPage { buckets: Bucket[]; cursor?: string }
export interface Domain { domain: string; enabled: boolean; zoneId?: string; status?: unknown }
export interface CreateCredentialInput { jurisdiction: string; connection_id: string; permission: "read-only" | "read-write" }
export interface CloudflareCredential { token_id: string; access_key_id: string; secret_access_key: string }
export interface ConnectionSummary { connection: { id: string; resource: string; labels?: Record<string,string>; metadata?: Record<string,unknown> } }
export interface ProvisionResult { connection_id: string; token_id: string; access_key_id: string; secret_access_key: string }

export interface BackendAPI {
  clientID(): Promise<string>;
  saveClientID(value: string): Promise<void>;
  startOAuth(clientId: string, openerOrigin: string, apiOrigin: string): Promise<{ authorization_url: string }>;
  session(): Promise<Session>;
  listAccounts(): Promise<Account[]>;
  listZones(accountId: string): Promise<Zone[]>;
  listBuckets(accountId: string, jurisdiction: string, cursor?: string): Promise<BucketPage>;
  getBucket(accountId: string, jurisdiction: string, bucket: string): Promise<Bucket>;
  createBucket(accountId: string, jurisdiction: string, bucket: string): Promise<Bucket>;
  deleteBucket(accountId: string, jurisdiction: string, bucket: string): Promise<void>;
  listDomains(accountId: string, jurisdiction: string, bucket: string): Promise<Domain[]>;
  attachDomain(accountId: string, jurisdiction: string, bucket: string, domain: string, zoneId: string): Promise<void>;
  detachDomain(accountId: string, jurisdiction: string, bucket: string, domain: string): Promise<void>;
  createCredential(accountId: string, bucket: string, input: CreateCredentialInput): Promise<CloudflareCredential>;
  findCredential(accountId: string, connectionId: string): Promise<{ token_id: string }>;
  revokeCredential(accountId: string, input: { token_id: string; connection_id: string }): Promise<void>;
  findResource(accountId:string,jurisdiction:string,bucket:string):Promise<{ resource:{id:string};config:{metadata:Record<string,unknown>} }|null>;
  registerResource(input:{account_id:string;jurisdiction:string;bucket:string;s3_endpoint:string;primary_domain?:string}):Promise<{resource_id:string}>;
  listConnections(resourceId:string):Promise<ConnectionSummary[]>;
  provisionConnection(input:{resource_id:string;manager_id:string;permission:"read-only"|"read-write";labels?:Record<string,string>}):Promise<ProvisionResult>;
  confirmConnection(connectionId:string):Promise<ConnectionSummary>;
  abortConnection(connectionId:string):Promise<void>;
  revokeConnection(connectionId:string):Promise<void>;
  linkConnection(input:{resource_id:string;connection_id:string;labels:Record<string,string>}):Promise<ConnectionSummary>;
  unlinkConnection(input:{resource_id:string;connection_id:string;group:string}):Promise<ConnectionSummary>;
  deleteGroupConnections(connections:string[]):Promise<{deleted:string[]}>;
  prepareTeardown():Promise<{resource_ids:string[]}>;
}

export function createBackendAPI(baseURL: string, caller: RPCCaller, fetcher: typeof fetch = fetch, originProvider:()=>string = () => typeof window === "undefined" ? new URL(baseURL).origin : window.location.origin): BackendAPI {
  const base = new URL(baseURL, originProvider()).origin;
  const send = async <T>(path:string,data:unknown={}):Promise<T>=>{
    const settings=await loadManagerSettings(caller);if(!settings.jwtSecret)throw new Error("Manager JWT secret is missing; reinstall the manager to initialize it");
    const managerId=await caller.getManager();const origin=originProvider();const token=await signRequestJWT(settings.jwtSecret,managerId,path,origin,data);
    const response=await fetcher(`${base}${path}`,{method:"POST",credentials:"include",headers:{Accept:"application/json","Content-Type":"application/jwt"},body:token});
    if(response.status===204)return undefined as T;
    const payload:unknown=await response.json().catch(()=>undefined);
    if(!response.ok){const message=isRecord(payload)&&isRecord(payload.error)&&typeof payload.error.message==="string"?payload.error.message:`Manager API request failed (${response.status})`;const error=new Error(message) as Error&{status?:number};error.status=response.status;throw error}
    return payload as T;
  };
  return {
    clientID:async()=> (await loadManagerSettings(caller)).cloudflareClientId,
    saveClientID:(value)=>caller.databaseQuery("UPSERT manager_settings:current MERGE { cloudflare_client_id: $client_id }",{client_id:value.trim()}).then((r)=>{if(!r.results.length||r.results.some((x)=>x.status!=="OK"))throw new Error("Manager settings could not be saved")}),
    startOAuth:(clientId,openerOrigin,apiOrigin)=>send("/auth/start",{client_id:clientId,opener_origin:openerOrigin,api_origin:apiOrigin}),
    session:()=>send("/api/session",{}),
    listAccounts:()=>send("/api/accounts/list",{}),
    listZones:(accountId)=>send("/api/zones/list",{account_id:accountId}),
    listBuckets:(accountId,jurisdiction,cursor)=>send("/api/buckets/list",{account_id:accountId,jurisdiction,...(cursor?{cursor}:{})}),
    getBucket:(accountId,jurisdiction,bucket)=>send("/api/buckets/get",{account_id:accountId,jurisdiction,bucket}),
    createBucket:(accountId,jurisdiction,bucket)=>send("/api/buckets/create",{account_id:accountId,jurisdiction,bucket}),
    deleteBucket:(accountId,jurisdiction,bucket)=>send("/api/buckets/delete",{account_id:accountId,jurisdiction,bucket}),
    listDomains:(accountId,jurisdiction,bucket)=>send("/api/domains/list",{account_id:accountId,jurisdiction,bucket}),
    attachDomain:(accountId,jurisdiction,bucket,domain,zoneId)=>send("/api/domains/attach",{account_id:accountId,jurisdiction,bucket,domain,zone_id:zoneId}),
    detachDomain:(accountId,jurisdiction,bucket,domain)=>send("/api/domains/detach",{account_id:accountId,jurisdiction,bucket,domain}),
    createCredential:(accountId,bucket,input)=>send("/api/credentials/create",{account_id:accountId,bucket,...input}),
    findCredential:(accountId,connectionId)=>send("/api/credentials/find",{account_id:accountId,connection_id:connectionId}),
    revokeCredential:(accountId,input)=>send("/api/credentials/revoke",{account_id:accountId,...input}),
    findResource:(accountId,jurisdiction,bucket)=>send("/api/resources/find",{account_id:accountId,jurisdiction,bucket}),
    registerResource:(input)=>send("/api/resources/register",input),
    listConnections:(resourceId)=>send("/api/connections/list",{resource_id:resourceId}),
    provisionConnection:(input)=>send("/api/connections/provision",input),
    confirmConnection:(connectionId)=>send("/api/connections/confirm",{connection_id:connectionId}),
    abortConnection:(connectionId)=>send("/api/connections/abort",{connection_id:connectionId}),
    revokeConnection:(connectionId)=>send("/api/connections/revoke",{connection_id:connectionId}),
    linkConnection:(input)=>send("/api/connections/link",input),
    unlinkConnection:(input)=>send("/api/connections/unlink",input),
    deleteGroupConnections:(connections)=>send("/api/connections/delete-group",{connections}),
    prepareTeardown:()=>send("/api/teardown/prepare",{}),
  };
}

function isRecord(value: unknown):value is Record<string,any>{return typeof value==="object"&&value!==null&&!Array.isArray(value)}
