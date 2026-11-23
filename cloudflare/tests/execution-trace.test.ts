import {beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {reset,applyD1Migrations,createExecutionContext} from "cloudflare:test";
import {Session} from "../src/engine/http";
import {safeRequestTrace,safeExecutionReport} from "../src/diagnostics";
import {saveAccount} from "../src/storage";
import {enqueue,processJob,jobView} from "../src/jobs";
import {execute} from "../src/engine/sign";
import {adminHeaders} from "./helpers";
import worker from "../src/index";
import type {Env,ExecutionReport} from "../src/types";
const bindings=env as unknown as Env&{TEST_MIGRATIONS:any[]};let e:Env;
const uuid="11111111-2222-4333-8444-555555555555";
beforeEach(async()=>{await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);e={...bindings,JRXY_INTERVAL:"0",JOBS:{send:vi.fn().mockResolvedValue(undefined)} as any,VERSION_METADATA:{id:uuid,tag:"do not export private tag",timestamp:"do not export"}};});
async function advance<T>(promise:Promise<T>,ms:number):Promise<T>{const done=promise.then(value=>({value}),error=>({error}));await vi.advanceTimersByTimeAsync(ms);const result=await done;if("error" in result)throw result.error;return result.value;}
function report(requests:any[]=[]):ExecutionReport{return{schema:1,id:uuid,startedAt:1700000000000,finishedAt:1700000000100,mode:"submit",trigger:"schedule",attempt:1,maxAttempts:6,batchRound:1,concurrencyLimit:2,verificationOnly:false,result:"error",retryable:true,network:{httpTimeoutMs:60000,runTimeoutMs:300000,submitTimeoutMs:20000},requests,truncated:false};}
describe("bounded privacy-safe execution traces",()=>{
  it("records first-request timeout without inventing response, DNS or TLS evidence",async()=>{
    vi.useFakeTimers();try{
      const transport=vi.fn(async()=>new Promise<Response>(()=>{})),session=new Session(transport as any);
      const pending=session.at("tenant_list").request("https://mobile.campushoy.com/v6/config/guest/tenant/list?token=private");
      expect(session.trace()).toMatchObject([{outcome:"started",stage:"tenant_list",requestIndex:1}]);
      await advance(pending.catch(error=>error),60001);const trace=session.trace();
      expect(trace).toHaveLength(1);expect(trace[0]).toMatchObject({outcome:"failed",kind:"timeout",stage:"tenant_list",elapsedMs:60000,timeoutMs:60000,phase:"send",receivedBytes:0});
      expect(trace[0]).not.toHaveProperty("headersMs");expect(trace[0]).not.toHaveProperty("httpStatus");expect(JSON.stringify(trace)).not.toMatch(/private|token|tenant\/list|dnsMs|tlsMs/);expect(transport).toHaveBeenCalledTimes(1);
    }finally{vi.useRealTimers();}
  });
  it("captures successful hops, response timings and a later POST timeout in order",async()=>{
    vi.useFakeTimers();try{
      const transport=vi.fn(async(input)=>{
        if(String(input).endsWith("/start"))return new Response(null,{status:302,headers:{Location:"https://login.example.edu/page?ticket=private"}});
        if(String(input).includes("/page")){await new Promise(resolve=>setTimeout(resolve,40));return new Response("private HTML",{headers:{"Content-Type":"text/html","CF-Ray":"abcdef1234567890-ABC","Set-Cookie":"sid=private; Secure; Path=/"}});}
        return new Promise<Response>(()=>{});
      });
      const session=new Session(transport as any,100,1000);await advance(session.at("portal").request("https://school.campusphere.net/start"),50);
      await advance(session.at("login_submit").request("https://login.example.edu/submit?password=private",{method:"POST",body:"private"}).catch(error=>error),101);
      const trace=session.trace();expect(trace.map(item=>item.outcome)).toEqual(["completed","completed","failed"]);expect(trace.map(item=>item.requestIndex)).toEqual([1,2,3]);
      expect(trace[1]).toMatchObject({stage:"portal",redirectCount:1,httpStatus:200,headersMs:40,responseType:"html",rayId:"abcdef1234567890-ABC"});
      expect(trace[2]).toMatchObject({stage:"login_submit",method:"POST",phase:"send",kind:"timeout"});expect(JSON.stringify(trace)).not.toContain("private");expect(transport).toHaveBeenCalledTimes(3);
    }finally{vi.useRealTimers();}
  });
  it("distinguishes an HTTP 520 from stalled response bodies and JSON parsing failures",async()=>{
    vi.useFakeTimers();try{
      const session=new Session(vi.fn(async()=>new Response("synthetic",{status:520,headers:{"Content-Type":"text/plain"}})) as any);
      await session.at("portal").request("https://school.campusphere.net/").catch(()=>{});
      expect(session.trace()[0]).toMatchObject({outcome:"failed",kind:"http",httpStatus:520,responseType:"text",receivedBytes:9});
      const stalled=new Session(vi.fn(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));}}))) as any,30,200);
      await advance(stalled.at("login_callback").request("https://school.campusphere.net/callback",{method:"POST"}).catch(error=>error),31);
      expect(stalled.trace()[0]).toMatchObject({outcome:"failed",phase:"body",kind:"timeout",httpStatus:200,headersMs:0,bodyMs:30,receivedBytes:1});
      const invalid=new Session(vi.fn(async()=>new Response("private non-json")) as any);await invalid.json("https://school.campusphere.net/list").catch(()=>{});
      expect(invalid.trace()[0]).toMatchObject({outcome:"failed",kind:"response",phase:"json"});
    }finally{vi.useRealTimers();}
  });
  it("drops arbitrary properties and rejects unsafe domain, ray, code and version values",()=>{
    const trace=safeRequestTrace([{stage:"portal",outcome:"failed",kind:"transport",startedAt:1700000000000,requestIndex:1,host:"private-user.example.edu",rayId:"private cookie",errorCode:"secret-error",url:"https://example.edu/?password=private",body:"private",stack:"private",elapsedMs:999999}],['private-user']);
    const coerced=safeRequestTrace([{stage:"portal",outcome:"failed",kind:"transport",startedAt:1700000000000,method:{toString:()=>"GET",password:"private"},phase:{toString:()=>"send",cookie:"private"},host:"127.0.0.1"}]);
    expect(coerced[0]).not.toHaveProperty("method");expect(coerced[0]).not.toHaveProperty("phase");expect(coerced[0]).not.toHaveProperty("host");
    expect(trace).toHaveLength(1);expect(trace[0]).not.toHaveProperty("host");expect(trace[0]).not.toHaveProperty("rayId");expect(trace[0]).not.toHaveProperty("errorCode");expect(trace[0].elapsedMs).toBe(600000);
    const safe=safeExecutionReport({...report(trace),version:"private-tag",account:"private",password:"private",jobId:"account-name",raw:"private"});
    expect(safe).not.toHaveProperty("version");expect(JSON.stringify(safe)).not.toContain("private");expect(safeExecutionReport({...report(),id:"account-name"})).toBeNull();
  });
  it("caps trace rows and serialized report size, preserving separate Session state",async()=>{
    const a=new Session(vi.fn(async()=>new Response("ok")) as any),b=new Session(vi.fn(async()=>new Response("ok")) as any);
    for(let i=0;i<42;i++)await a.request("https://school.campusphere.net/endpoint").catch(()=>{});
    expect(a.trace()).toHaveLength(41);expect(a.trace().at(-1)).toMatchObject({kind:"request_limit",outcome:"failed"});expect(b.trace()).toEqual([]);
    const snapshot=a.trace();snapshot[0].host="mutated.example.edu";expect(a.trace()[0].host).not.toBe(snapshot[0].host);
    const safe=safeExecutionReport(report(Array(1000).fill(a.trace()[0])));expect(safe!.requests).toHaveLength(41);expect(safe!.truncated).toBe(true);expect(new TextEncoder().encode(JSON.stringify(safe)).length).toBeLessThanOrEqual(32768);
  });
  it("drops device and notification secrets even when an upstream header or host resembles them",async()=>{
    await saveAccount(e,"a",{schoolName:"模拟学校",username:"private-student",password:"private-password",type:2,deviceId:"private-device",notifyMethod:0,notifyRcv:"abcdef1234567890-ABC"},true);
    const [id]=await enqueue(e,["a"],"login"),run=vi.fn().mockResolvedValue({status:"error",message:"private-password private-device",requestTrace:[{startedAt:Date.now(),stage:"portal",outcome:"failed",kind:"http",httpStatus:520,host:"private-device.example.edu",rayId:"abcdef1234567890-ABC",url:"https://example.edu/?ticket=private-ticket"}],diagnostic:{stage:"portal",kind:"http",host:"private-device.example.edu"}});
    await processJob(e,id,run);const result=(await jobView(e,[id]))[0].result as any;
    expect(result.executionReport.requests).toHaveLength(1);expect(JSON.stringify(result.executionReport)).not.toMatch(/private-|abcdef1234567890/);expect(result.message).not.toContain("private-device");
  });
  it("keeps only known transport error codes without serializing exception text",async()=>{
    const error=Object.assign(new Error("password=private and sessionToken=private"),{code:"ECONNRESET"});
    const session=new Session(vi.fn(async()=>{throw error;}) as any);await session.request("https://login.example.edu/").catch(()=>{});
    expect(session.trace()[0]).toMatchObject({kind:"transport",errorCode:"ECONNRESET"});expect(JSON.stringify(session.trace())).not.toContain("private");
  });
  it("persists each attempt separately and exports only safe reports through administrator APIs",async()=>{
    await saveAccount(e,"synthetic-id",{schoolName:"模拟学校",username:"private-student",password:"private-password",displayName:"合成隐私姓名",type:2,deviceId:"private-device"},true);
    const [id]=await enqueue(e,["synthetic-id"],"login");await e.DB.prepare("UPDATE jobs SET trigger='schedule',max_attempts=2 WHERE id=?").bind(id).run();
    const loginFn=vi.fn(async(_user,session)=>{await session.at("tenant_list").json("https://school.campusphere.net/list?ticket=private-ticket");return {session,host:"https://school.campusphere.net/",tenantId:"private-tenant",sessionToken:"private-token"};});
    const transport=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("private response",{status:520}));
    try{
      await processJob(e,id,(account,device,mode,options)=>execute(account,device,mode,{...options,loginFn}));
      const first=(await jobView(e,[id]))[0] as any;expect(first.result.executionReport).toMatchObject({schema:1,version:uuid,attempt:1,maxAttempts:2,mode:"login",result:"error",requests:[{stage:"tenant_list",httpStatus:520}]});
      expect(first.result.executionReport.id).not.toBe(id);
      await e.DB.prepare("UPDATE jobs SET next_at=0 WHERE id=?").bind(id).run();await e.DB.prepare("UPDATE batches SET round_due=0").run();
      transport.mockResolvedValue(Response.json({data:[]}));await processJob(e,id,(account,device,mode,options)=>execute(account,device,mode,{...options,loginFn}));
      const logs=(await e.DB.prepare("SELECT diagnostic FROM sign_log WHERE account='synthetic-id' AND diagnostic IS NOT NULL ORDER BY id").all<{diagnostic:string}>()).results;
      expect(logs).toHaveLength(2);const reports=logs.map(row=>JSON.parse(row.diagnostic));expect(reports.map(value=>value.attempt)).toEqual([1,2]);expect(reports[0].id).not.toBe(reports[1].id);
      expect(JSON.stringify(reports)).not.toMatch(/private|synthetic-id|合成隐私姓名|password|ticket=|sessionToken/);
      const headers=await adminHeaders(e),response=await worker.fetch(new Request("https://manager.example/api/logs",{headers}),e,createExecutionContext());
      const rows=(await response.json() as any).logs;expect(rows.filter(row=>row.diagnostic)).toHaveLength(2);
      const unauth=await worker.fetch(new Request("https://manager.example/api/logs"),e,createExecutionContext());expect(unauth.status).toBe(401);
      const run=vi.fn();await processJob(e,id,run);expect(run).not.toHaveBeenCalled();expect(await e.DB.prepare("SELECT count(*) FROM sign_log WHERE diagnostic IS NOT NULL").first("count(*)")).toBe(2);
    }finally{transport.mockRestore();}
  });
});
