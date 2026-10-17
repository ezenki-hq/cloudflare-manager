import { describe, expect, it, vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import { createBackendAPI } from "./api";

const secret=btoa(String.fromCharCode(...new Uint8Array(32).fill(9))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
function setup(fetcher:typeof fetch){const caller={getManager:vi.fn().mockResolvedValue("manager-1"),databaseQuery:vi.fn().mockResolvedValue({results:[{statement:0,status:"OK",result:[{cloudflare_client_id:"client-1",jwt_secret:secret}]}]})} as unknown as RPCCaller;return {caller,api:createBackendAPI("https://manager.example.test",caller,fetcher,()=>"https://frontend.example.test")}}
function claims(init:RequestInit){const token=String(init.body);const payload=token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/");return JSON.parse(atob(payload+"=".repeat((4-payload.length%4)%4))) as Record<string,any>}

describe("signed manager API client",()=>{
  it("sends a route-bound compact JWT in the whole body with credentials",async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({authenticated:true}),{status:200,headers:{"Content-Type":"application/json"}}));const {api}=setup(fetcher);await api.session();
    const [url,init]=vi.mocked(fetcher).mock.calls[0] as unknown as [string,RequestInit];expect(url).toBe("https://manager.example.test/api/session");expect(init.method).toBe("POST");expect(init.credentials).toBe("include");expect(new Headers(init.headers).get("Content-Type")).toBe("application/jwt");expect(claims(init)).toMatchObject({aud:"manager-1",path:"/api/session",origin:"https://frontend.example.test",data:{}});
  });
  it("keeps request data inside the JWT and maps bucket methods to dedicated routes",async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({buckets:[]}),{status:200,headers:{"Content-Type":"application/json"}}));const {api}=setup(fetcher);await api.listBuckets("account-1","eu","next");const [,init]=vi.mocked(fetcher).mock.calls[0] as unknown as [string,RequestInit];expect(claims(init)).toMatchObject({path:"/api/buckets/list",data:{account_id:"account-1",jurisdiction:"eu",cursor:"next"}});expect(String(init.body)).not.toContain("?");
  });
  it("surfaces structured errors and refuses to send when settings are missing",async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{message:"Unauthorized"}}),{status:401}));const {api}=setup(fetcher);await expect(api.session()).rejects.toMatchObject({status:401});
    const broken={getManager:vi.fn().mockResolvedValue("manager-1"),databaseQuery:vi.fn().mockResolvedValue({results:[{statement:0,status:"OK",result:[]}]})} as unknown as RPCCaller;const noSecret=createBackendAPI("https://manager.example.test",broken,fetcher,()=>"https://frontend.example.test");await expect(noSecret.session()).rejects.toThrow(/JWT secret/i);expect(fetcher).toHaveBeenCalledOnce();
  });
});
