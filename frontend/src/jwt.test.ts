import { describe, expect, it } from "vitest";
import { signRequestJWT } from "./jwt";

describe("manager request JWT", () => {
  it("signs a short-lived route-bound HS256 token with Web Crypto", async () => {
    const secret = btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
    const token = await signRequestJWT(secret,"manager-1","/api/accounts/list","https://manager.example.test",{},1000_000);
    const [head,payload,sig]=token.split(".");
    expect(JSON.parse(atob(head.replace(/-/g,"+").replace(/_/g,"/")))).toEqual({alg:"HS256",typ:"JWT"});
    expect(JSON.parse(atob(payload.replace(/-/g,"+").replace(/_/g,"/")))).toEqual({aud:"manager-1",path:"/api/accounts/list",origin:"https://manager.example.test",iat:1000,exp:1060,data:{}});
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("rejects malformed secrets before signing", async () => {
    await expect(signRequestJWT("bad","manager","/path","https://example.test",{})).rejects.toThrow(/secret/i);
  });
});
