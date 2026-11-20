import {beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {applyD1Migrations,reset,createExecutionContext} from "cloudflare:test";
import {randomBytes} from "node:crypto";
import {Session,responseCookies} from "../src/engine/http";
import {login} from "../src/engine/login";
import {safeDiagnostic} from "../src/diagnostics";
import {createCodeBatch,publicRedemption,processEnrollment,listEnrollments,cleanupEnrollments} from "../src/redemption";
import {EngineError,type Account,type Env} from "../src/types";
import worker from "../src/index";
import {adminHeaders} from "./helpers";
const bindings=env as unknown as Env & {TEST_MIGRATIONS:any[]};let e:Env;
const origin="https://manager.example";
beforeEach(async()=>{await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);e={...bindings,JOBS:{send:vi.fn().mockResolvedValue(undefined)} as any};});
async function attempt(){
  const batch=await createCodeBatch(e,{quantity:1,schoolName:"模拟学校",type:2,lon:120,lat:30,address:"模拟位置",durationValue:1,durationUnit:"days"}) as any;
  const receipt=randomBytes(32).toString("base64url"),path="/api/public/redemption/start";
  await publicRedemption(new Request(origin+path,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({code:batch.codes[0],displayName:"隐私测试姓名",username:"private-student",password:"private-password",receipt,consent:true})}),e,path);
  return {row:await e.DB.prepare("SELECT id FROM enrollment_attempts").first<any>(),receipt,code:batch.codes[0]};
}
describe("safe request diagnostics",()=>{
  it("keeps only allowed metadata and removes credentials, URLs and exception content",()=>{
    const value={stage:"login_submit",kind:"http",host:"login.example.edu",method:"POST",httpStatus:503,elapsedMs:1.5,url:"https://login.example.edu/?password=private",body:"private",message:"private",cookie:"private"};
    expect(safeDiagnostic(value)).toEqual({stage:"login_submit",kind:"http",host:"login.example.edu",method:"POST",httpStatus:503,elapsedMs:2});
    expect(safeDiagnostic({...value,host:"private-student.example.edu"},["private-student"])).not.toHaveProperty("host");
    expect(safeDiagnostic({...value,host:value.url})).not.toHaveProperty("host");expect(safeDiagnostic({stage:"injected",kind:"transport"})).toBeNull();
  });
  it("supports both cookie APIs without splitting Expires commas or merging cookies",()=>{
    const values=["first=a; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Path=/","second=b; Path=/"];
    expect(responseCookies({getSetCookie:()=>values} as any)).toEqual(values);
    const getAll=vi.fn(()=>values);expect(responseCookies({getAll} as any)).toEqual(values);expect(getAll).toHaveBeenCalledWith("Set-Cookie");
    expect(responseCookies({has:()=>false} as any)).toEqual([]);
    expect(()=>responseCookies({has:()=>true} as any)).toThrow("Set-Cookie");
  });
  it("does not report response header processing exceptions as a network failure",async()=>{
    const response=new Response("ok");Object.defineProperty(response.headers,"getSetCookie",{value:()=>{throw new Error("private-password hidden detail");}});
    const transport=vi.fn(async()=>response);
    const error=await new Session(transport as any).at("tenant_list").request("https://mobile.campushoy.com/list").catch(value=>value);
    expect(error).toMatchObject({retryable:false,diagnostic:{kind:"response_processing",phase:"headers",httpStatus:200}});
    expect(JSON.stringify(error)).not.toContain("private-password");expect(transport).toHaveBeenCalledTimes(1);
  });
  it("distinguishes a broken response stream from failure before response headers",async()=>{
    const stream=new ReadableStream({start(controller){controller.error(new Error("private-cookie"));}});
    const error=await new Session(vi.fn(async()=>new Response(stream)) as any).at("portal").request("https://login.example.edu/").catch(value=>value);
    expect(error).toMatchObject({retryable:true,diagnostic:{kind:"body_read",phase:"body",httpStatus:200}});expect(error.message).not.toContain("private-cookie");
  });
  it("preserves the new processing phase in safe metadata without any error text",()=>{
    expect(safeDiagnostic({stage:"portal",kind:"response_processing",phase:"headers",message:"private"})).toEqual({stage:"portal",kind:"response_processing",phase:"headers"});
    expect(safeDiagnostic({stage:"portal",kind:"transport",phase:"private"})).not.toHaveProperty("phase");
  });
  it("distinguishes a transport failure from an HTTP response without copying the exception",async()=>{
    const transport=vi.fn(async()=>{throw new Error("TLS or DNS details with password=private-password");});
    const session=new Session(transport as any).at("login_submit");
    const error=await session.request("https://login.example.edu/iap/doLogin?password=private-password",{method:"POST"}).catch(value=>value);
    expect(error).toMatchObject({retryable:true,diagnostic:{stage:"login_submit",kind:"transport",host:"login.example.edu",method:"POST"}});
    expect(error.diagnostic).not.toHaveProperty("httpStatus");expect(error.message).not.toContain("private-password");expect(JSON.stringify(error.diagnostic)).not.toContain("doLogin");expect(transport).toHaveBeenCalledTimes(1);
  });
  it("distinguishes the per-request timeout from the total network deadline",async()=>{
    const transport=vi.fn(async(_input,init)=>new Promise<Response>((_resolve,reject)=>init.signal.addEventListener("abort",()=>reject(new Error("aborted secret")),{once:true})));
    for(const [timeout,total,kind] of [[5,1000,"timeout"],[1000,5,"total_timeout"]] as const){
      await expect(new Session(transport as any,timeout,total).at("portal").request("https://login.example.edu/"))
        .rejects.toMatchObject({retryable:true,diagnostic:{kind,stage:"portal"}});
    }
  });
  it("reports the real HTTP status and redirected target without response bodies",async()=>{
    const transport=vi.fn(async(input)=>String(input).includes("campusphere")?new Response(null,{status:302,headers:{Location:"https://login.example.edu/auth?ticket=private"}}):new Response("private HTML",{status:503}));
    const error=await new Session(transport as any).at("portal").request("https://school.campusphere.net/").catch(value=>value);
    expect(error.diagnostic).toMatchObject({kind:"http",stage:"portal",host:"login.example.edu",httpStatus:503,method:"GET"});
    expect(JSON.stringify(error.diagnostic)).not.toContain("private");expect(error.message).toContain("503");
  });
  it("identifies the failing login stage without sending credentials to diagnostics",async()=>{
    const account={schoolName:"阶段测试学校",username:"private-student",password:"private-password"} as Account;
    const transport=vi.fn(async(input)=>{
      const url=new URL(String(input));
      if(url.pathname.endsWith("/tenant/list"))return Response.json({data:[{name:account.schoolName,id:"sample",joinType:"CLOUD"}]});
      if(url.pathname.endsWith("/tenant/info"))return Response.json({data:[{joinType:"CLOUD",ampUrl:"https://mock.campusphere.net/portal"}]});
      if(url.pathname==="/portal")return new Response(null,{status:302,headers:{Location:"https://login.example.edu/login"}});
      if(url.pathname==="/login")return new Response("login");
      if(url.pathname==="/iap/security/lt")return Response.json({result:{_lt:"private-ticket"}});
      if(url.pathname==="/iap/checkNeedCaptcha")return Response.json({needCaptcha:false});
      return new Response("private-password",{status:502});
    });
    const error=await login(account,new Session(transport as any)).catch(value=>value);
    expect(error.diagnostic).toMatchObject({stage:"login_submit",kind:"http",httpStatus:502,host:"login.example.edu"});
    expect(JSON.stringify(error.diagnostic)).not.toMatch(/private|doLogin|password/);
  });
  it("exposes short-lived safe diagnostics only to the administrator and releases the code",async()=>{
    const {row,receipt,code}=await attempt();
    const transport=vi.fn(async()=>{throw new Error("private-password private-student private-cookie");});
    await processEnrollment(e,row.id,vi.fn(async()=>{await new Session(transport as any).at("login_submit").request("https://login.example.edu/iap/doLogin?password=private-password",{method:"POST"});return {} as any;}));
    const rows=await listEnrollments(e) as any[];expect(rows).toHaveLength(1);expect(rows[0].diagnostic).toMatchObject({stage:"login_submit",kind:"transport"});
    expect(JSON.stringify(rows)).not.toMatch(/private-|隐私测试姓名/);expect(JSON.stringify(rows)).not.toContain(code);expect(JSON.stringify(rows)).not.toContain(receipt);
    const stored=await e.DB.prepare("SELECT credentials,identity_key,device_id,error_code FROM enrollment_attempts").first<any>();expect(stored).toEqual({credentials:"",identity_key:null,device_id:"",error_code:"network"});
    expect((await e.DB.prepare("SELECT status FROM redemption_codes").first<any>()).status).toBe("unused");
    const path="/api/redemption/attempts",ctx=createExecutionContext();expect((await worker.fetch(new Request(origin+path),e,ctx)).status).toBe(401);
    const response=await worker.fetch(new Request(origin+path,{headers:await adminHeaders(e)}),e,ctx);expect(response.status).toBe(200);
    const statusPath="/api/public/redemption/status";const publicResponse=await publicRedemption(new Request(origin+statusPath,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({receipt})}),e,statusPath);
    const text=await publicResponse.text();expect(text).not.toContain("diagnostic");expect(text).not.toContain("login.example.edu");expect(text).toContain("未消耗兑换码");
    await e.DB.prepare("UPDATE enrollment_attempts SET expires_at=?").bind(Date.now()-1).run();expect(await listEnrollments(e)).toEqual([]);await cleanupEnrollments(e);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM enrollment_attempts").first<any>()).n).toBe(0);
  });
  it.each([["timeout","timeout"],["total_timeout","timeout"],["http","upstream"],["body_read","response_read"],["response_processing","protocol"]] as const)("maps %s to a safe public category without retrying login",async(kind,code)=>{
    const {row}=await attempt(),run=vi.fn().mockRejectedValue(new EngineError("do not expose this error","error",true,{stage:"captcha_check",kind,httpStatus:kind==="http"?503:undefined}));
    await processEnrollment(e,row.id,run);await processEnrollment(e,row.id,run);expect(run).toHaveBeenCalledTimes(1);
    expect((await e.DB.prepare("SELECT error_code FROM enrollment_attempts").first<any>()).error_code).toBe(code);
    expect((await e.DB.prepare("SELECT status FROM redemption_codes").first<any>()).status).toBe("unused");
    expect((await e.DB.prepare("SELECT count(*) AS n FROM accounts").first<any>()).n).toBe(0);
  });
});
