import {beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {reset,applyD1Migrations,createExecutionContext,createMessageBatch,getQueueResult} from "cloudflare:test";
import {randomBytes} from "node:crypto";
import worker from "../src/index";
import {adminHeaders} from "./helpers";
import type {Env} from "../src/types";
const bindings=env as unknown as Env&{TEST_MIGRATIONS:any[]};let e:Env;
const origin="https://manager.example";
beforeEach(async()=>{await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);e={...bindings,JOBS:{send:vi.fn().mockResolvedValue(undefined)} as any,ASSETS:{fetch:vi.fn(async request=>new Response(new URL(request.url).pathname))} as any};});
async function call(path:string,body?:unknown,headers:Record<string,string>={}){return worker.fetch(new Request(origin+path,{method:body===undefined?"GET":"POST",headers:{Origin:origin,"Content-Type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)}),e,createExecutionContext());}
describe("public redemption routing and isolation",()=>{
  it("routes the public root separately from the admin shell",async()=>{
    expect(await(await call("/")).text()).toBe("/index.html");expect(await(await call("/admin")).text()).toBe("/admin.html");
    expect((await call("/api/accounts")).status).toBe(401);expect((await call("/api/redemption/batches",{})).status).toBe(401);
  });
  it("runs check → reservation → queue login → success without exposing credentials",async()=>{
    const headers=await adminHeaders(e);const generated=await call("/api/redemption/batches",{quantity:1,note:"模拟",schoolName:"模拟学校",type:2,lon:120,lat:30,address:"测试位置",durationValue:1,durationUnit:"days"},headers);
    expect(generated.status).toBe(201);const code=(await generated.json() as any).codes[0];
    const checked=await call("/api/public/redemption/check",{code});expect(checked.status).toBe(200);const preview=await checked.json() as any;expect(preview.schoolName).toBe("模拟学校");expect(preview).not.toHaveProperty("longitude");
    const receipt=randomBytes(32).toString("base64url");const started=await call("/api/public/redemption/start",{code,displayName:"模拟同学",username:"student",password:"private-password",receipt,consent:true});expect(started.status).toBe(202);
    const queued=(e.JOBS.send as any).mock.calls[0][0];expect(Object.keys(queued).sort()).toEqual(["id","kind"]);
    const transport=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
      const url=new URL(String(input));
      if(url.pathname.endsWith("/tenant/list"))return Response.json({data:[{id:"mock",name:"模拟学校",joinType:"CLOUD"}]});
      if(url.pathname.endsWith("/tenant/info"))return Response.json({data:[{joinType:"CLOUD",ampUrl:"https://mock.campusphere.net/portal"}]});
      if(url.pathname==="/portal")return new Response(null,{status:302,headers:{location:"https://login.example.edu/iap/login"}});
      if(url.pathname==="/iap/login")return new Response("login");
      if(url.pathname==="/iap/security/lt")return Response.json({result:{_lt:"mock-lt"}});
      if(url.pathname==="/iap/checkNeedCaptcha")return Response.json({needCaptcha:false});
      if(url.pathname==="/iap/doLogin")return new Response(null,{status:302,headers:{location:"https://mock.campusphere.net/callback"}});
      if(url.pathname==="/callback")return new Response("ok",{headers:{"Set-Cookie":"MOD_AUTH_CAS=mock-cookie; Path=/"}});
      throw new Error("Unexpected upstream call");
    });
    try{
      const batch=createMessageBatch("jrxy-auto-cf-jobs",[{id:"enrollment-message",timestamp:Date.now(),attempts:1,body:queued}]);await worker.queue(batch,e);
      expect((await getQueueResult(batch,createExecutionContext())).explicitAcks).toContain("enrollment-message");
      const result=await(await call("/api/public/redemption/status",{receipt})).json() as any;expect(result.status).toBe("succeeded");expect(result.schedule.enabled).toBe(true);expect(result.schedule.timezone).toBe("UTC+8");
      expect(JSON.stringify(result)).not.toContain("private-password");expect(JSON.stringify(result)).not.toContain("mock-cookie");
      expect(transport.mock.calls.some(([url])=>String(url).includes("submitSign")||String(url).includes("sctapi"))).toBe(false);
      const admin=await(await call("/api/accounts",undefined,headers)).json() as any;expect(admin.accounts).toHaveLength(1);expect(admin.accounts[0].notify_method).toBe(0);
      const reuse=await call("/api/public/redemption/start",{code,displayName:"模拟同学",username:"other",password:"other-password",receipt:randomBytes(32).toString("base64url"),consent:true});expect(reuse.status).toBe(409);
    }finally{transport.mockRestore();}
  });
});
