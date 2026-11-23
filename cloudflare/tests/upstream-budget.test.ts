import {beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {reset,applyD1Migrations,createExecutionContext} from "cloudflare:test";
import {Session} from "../src/engine/http";
import {execute} from "../src/engine/sign";
import {fetchSecret} from "../src/engine/crypto";
import {settings} from "../src/config";
import {saveAccount} from "../src/storage";
import {enqueue,processJob} from "../src/jobs";
import {createCodeBatch,publicRedemption,processEnrollment} from "../src/redemption";
import {EngineError,type Env,type Account} from "../src/types";
import worker from "../src/index";
import {adminHeaders} from "./helpers";
const bindings=env as unknown as Env&{TEST_MIGRATIONS:any[]};let e:Env;
const account:Account={schoolName:"等待预算模拟学校",username:"sample-student",password:"synthetic-password",type:2,lon:120,lat:30,address:"合成位置",abnormalReason:"",notifyKey:""};
beforeEach(async()=>{await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);e={...bindings,JOBS:{send:vi.fn().mockResolvedValue(undefined)} as any};});
async function settle<T>(pending:Promise<T>,milliseconds:number):Promise<T>{
  const result=pending.then(value=>({value}),error=>({error}));await vi.advanceTimersByTimeAsync(milliseconds);const outcome=await result;if("error" in outcome)throw outcome.error;return outcome.value;
}
function delayed(ms:number){let signal:AbortSignal|undefined;const transport=vi.fn(async(_url,init)=>{signal=init.signal;await new Promise(resolve=>setTimeout(resolve,ms));return new Response("ok");});return{transport,signal:()=>signal};}
describe("bounded sixty-second upstream budget",()=>{
  it("keeps configuration and direct Session defaults aligned, without extending the total budget",()=>{
    expect(settings({...e,JRXY_HTTP_TIMEOUT:undefined,JRXY_RUN_TIMEOUT:undefined})).toMatchObject({httpTimeoutMs:60000,runTimeoutMs:300000});
    expect(settings(e)).toMatchObject({httpTimeoutMs:60000,runTimeoutMs:300000});
    expect(settings({...e,JRXY_HTTP_TIMEOUT:"30",JRXY_RUN_TIMEOUT:"180"})).toMatchObject({httpTimeoutMs:30000,runTimeoutMs:180000});
    expect(settings({...e,JRXY_HTTP_TIMEOUT:"bad"})).toHaveProperty("httpTimeoutMs",60000);
  });
  it.each([['portal','GET'],['login_submit','POST'],['login_callback','POST']] as const)("allows a 45-second %s reply once, while explicit 30 seconds still times out",async(stage,method)=>{
    vi.useFakeTimers();try{
      const slow=delayed(45000);const response=await settle(new Session(slow.transport as any).at(stage).request("https://login.example.edu/step",{method}),45001);
      expect(response.text).toBe("ok");expect(slow.transport).toHaveBeenCalledTimes(1);expect(slow.signal()?.aborted).toBe(false);
      const legacy=delayed(45000);const error=await settle(new Session(legacy.transport as any,30000).at(stage).request("https://login.example.edu/step",{method}).catch(value=>value),45001);
      expect(error.diagnostic).toMatchObject({kind:"timeout",stage,timeoutMs:30000,phase:"send"});expect(legacy.transport).toHaveBeenCalledTimes(1);expect(legacy.signal()?.aborted).toBe(true);
    }finally{vi.useRealTimers();}
  });
  it("stops at 60 seconds and discards late response cookies without replaying the POST",async()=>{
    vi.useFakeTimers();try{
      const late=Promise.withResolvers<Response>(),cancel=vi.fn();const transport=vi.fn(()=>late.promise),session=new Session(transport as any);
      const error=await settle(session.at("login_callback").request("https://login.example.edu/callback",{method:"POST"}).catch(value=>value),60001);
      expect(error.diagnostic).toMatchObject({kind:"timeout",timeoutMs:60000,elapsedMs:60000,receivedBytes:0});
      late.resolve(new Response(new ReadableStream({cancel}),{headers:{"Set-Cookie":"late=synthetic; Path=/"}}));await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledTimes(1);expect(session.jar.names()).toEqual([]);expect(transport).toHaveBeenCalledTimes(1);
    }finally{vi.useRealTimers();}
  });
  it("keeps the 300-second total deadline across repeated slow replies",async()=>{
    vi.useFakeTimers();try{
      const slow=delayed(50000),session=new Session(slow.transport as any);
      for(let i=0;i<5;i++)expect((await settle(session.request("https://login.example.edu/step"),50000)).status).toBe(200);
      const error=await settle(session.request("https://login.example.edu/step").catch(value=>value),50000);
      expect(error.diagnostic).toMatchObject({kind:"total_timeout",timeoutMs:60000,sessionElapsedMs:300000});
    }finally{vi.useRealTimers();}
  });
  it("the execution entry can complete a delayed callback without submitting during a login test",async()=>{
    vi.useFakeTimers();try{
      const slow=delayed(45000);const loginFn=vi.fn(async(_account,session)=>{const response=await session.at("login_callback").request("https://login.example.edu/callback",{method:"POST"});expect(response.text).toBe("ok");return{session,host:"https://school.campusphere.net/",tenantId:"mock",sessionToken:""};});
      const transport=vi.spyOn(globalThis,"fetch").mockImplementation(slow.transport as any);
      try{const result=await settle(execute(account,"fixed-device","login",{loginFn}),45001);expect(result.status).toBe("success");expect(slow.transport).toHaveBeenCalledTimes(1);}finally{transport.mockRestore();}
    }finally{vi.useRealTimers();}
  });
  it("passes effective budgets through queue execution and holds the matching lease",async()=>{
    await saveAccount(e,"a",{...account,deviceId:"fixed-device"},true);const [id]=await enqueue(e,["a"],"login");const started=Date.now();
    const run=vi.fn(async()=>{const slot=await e.DB.prepare("SELECT lease_until FROM execution_slots WHERE task_id=?").bind(id).first<{lease_until:number}>();expect(slot!.lease_until-started).toBeGreaterThanOrEqual(360000);return{status:"success",message:"login ok"} as const;});
    await processJob(e,id,run);expect(run.mock.calls[0][3]).toMatchObject({httpTimeoutMs:60000,runTimeoutMs:300000});
  });
  it("passes the 60-second budget to enrollment login without changing the ten-minute receipt",async()=>{
    const codes=await createCodeBatch(e,{quantity:1,schoolName:account.schoolName,type:2,lon:120,lat:30,address:"合成位置"}) as any,path="/api/public/redemption/start";
    const response=await publicRedemption(new Request("https://manager.example"+path,{method:"POST",headers:{Origin:"https://manager.example","Content-Type":"application/json"},body:JSON.stringify({code:codes.codes[0],displayName:"模拟",username:"sample-enrollment",password:"synthetic-password",receipt:"r".repeat(43),consent:true})}),e,path);expect(response.status).toBe(202);
    const attempt=await e.DB.prepare("SELECT id,created_at,expires_at FROM enrollment_attempts").first<any>();expect(attempt.expires_at-attempt.created_at).toBe(600000);
    let observed=0;
    const transport=vi.spyOn(globalThis,"fetch").mockImplementation(async(_url,init)=>new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener("abort",()=>reject(new Error("synthetic aborted")),{once:true});}));
    try{await processEnrollment(e,attempt.id,async(_a,session)=>{
      vi.useFakeTimers();try{const error=await settle(session!.at("login_submit").request("https://login.example.edu/submit",{method:"POST"}).catch(value=>value),60001);observed=error.diagnostic.timeoutMs;throw error;}finally{vi.useRealTimers();}
    });expect(observed).toBe(60000);}finally{transport.mockRestore();}
    expect(await e.DB.prepare("SELECT status FROM enrollment_attempts").first("status")).toBe("failed");
  });
  it("keeps dynamic-key and signing submit limits at 20 seconds",async()=>{
    const keySession={json:vi.fn().mockRejectedValue(new EngineError("synthetic","error",true))} as any;
    await expect(fetchSecret(keySession,"tenant","fixed-device")).rejects.toThrow("动态密钥");
    expect(keySession.json).toHaveBeenCalledTimes(2);for(const call of keySession.json.mock.calls)expect(call[3]).toEqual({timeoutMs:20000});
    const {createPublicKey,publicEncrypt,constants}=await import("node:crypto"),{PROTOCOL_PRIVATE_KEY}=await import("../src/engine/constants"),target={signInstanceWid:"t",signWid:"s",isPhoto:0,isMalposition:0};
    const json=vi.fn(async(url)=>url.includes("getStu")?{datas:{unSignedTasks:[target],leaveTasks:[]}}:url.includes("detailSign")?{datas:target}:url.includes("getSecretKey")?{data:publicEncrypt({key:createPublicKey(PROTOCOL_PRIVATE_KEY),padding:constants.RSA_PKCS1_PADDING},new TextEncoder().encode("random|loginraw|9hriwfra")).toString("base64")}:{message:"SUCCESS"});
    const session={json,request:vi.fn().mockResolvedValue({}),jar:{get:()=>"",names:()=>[]}} as any;
    const result=await execute(account,"fixed-device","submit",{loginFn:vi.fn().mockResolvedValue({session,host:"https://school.campusphere.net/",tenantId:"mock",sessionToken:""}),beforeSubmit:async()=>{}});
    expect(result.status).toBe("success");expect(json.mock.calls.find(call=>call[0].includes("submitSign"))![3]).toEqual({timeoutMs:20000,ascii:false});
  });
  it("exposes effective timeout values only on the authenticated administrator status",async()=>{
    const headers=await adminHeaders(e),response=await worker.fetch(new Request("https://manager.example/api/status",{headers}),e,createExecutionContext());
    expect((await response.json() as any).network).toEqual({httpTimeoutSeconds:60,runTimeoutSeconds:300,submitTimeoutSeconds:20});
  });
});
