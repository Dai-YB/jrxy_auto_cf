import {beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {reset,applyD1Migrations,createExecutionContext,waitOnExecutionContext} from "cloudflare:test";
import worker from "../src/index";
import {saveAccount,setPaused} from "../src/storage";
import {enqueue,processJob} from "../src/jobs";
import {adminHeaders} from "./helpers";
import type {Env} from "../src/types";
const bindings=env as unknown as Env&{TEST_MIGRATIONS:any[]};let e:Env,headers:Record<string,string>;
beforeEach(async()=>{await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);e={...bindings,JRXY_INTERVAL:"0",JOBS:{send:vi.fn().mockResolvedValue(undefined)} as any};headers=await adminHeaders(e);});
async function users(names:string[]){for(const name of names)await saveAccount(e,name,{schoolName:"模拟学校",username:name,password:"synthetic-password",type:2},true);}
async function api(path="/api/batch-run",mode="submit"){
  const ctx=createExecutionContext(),response=await worker.fetch(new Request("https://manager.example"+path,{method:"POST",headers,body:JSON.stringify({mode})}),e,ctx);
  await waitOnExecutionContext(ctx);return {status:response.status,body:await response.json() as any};
}
async function retrying(names:string[]){
  const ids=await enqueue(e,names,"submit","定时");await e.DB.prepare("UPDATE jobs SET trigger='schedule',max_attempts=6").run();await e.DB.prepare("UPDATE batches SET trigger='schedule'").run();
  for(const id of ids)await processJob(e,id,async()=>({status:"error",message:"上游服务暂不可用（HTTP 520）",retryable:true,transientFailure:true}));return ids;
}
async function snapshots(){return (await e.DB.prepare("SELECT id,attempts,max_attempts,next_at,batch_id FROM jobs ORDER BY id").all()).results;}
describe("manual admission reconnects scheduled retries",()=>{
  it("returns every waiting retry without creating jobs or advancing the retry clock",async()=>{
    await users(["a","b"]);const ids=await retrying(["a","b"]),before=await snapshots();
    const response=await api();expect(response.status).toBe(202);expect(response.body.ids.sort()).toEqual(ids.sort());
    expect(response.body).toMatchObject({created:0,continued:2,completed:0,skipped:0});expect(await snapshots()).toEqual(before);
    expect(await e.DB.prepare("SELECT count(*) FROM batches").first("count(*)")).toBe(1);
  });
  it("adds only idle accounts and reports each skip reason",async()=>{
    await users(["retry-a","retry-b","idle","paused","other","expired"]);const ids=await retrying(["retry-a","retry-b"]);
    await setPaused(e,"paused",true);await enqueue(e,["other"],"login");await e.DB.prepare("UPDATE accounts SET authorization_until=? WHERE name='expired'").bind(Date.now()-1).run();
    const response=await api();expect(response.status).toBe(202);expect(response.body.ids).toEqual(expect.arrayContaining(ids));
    expect(response.body).toMatchObject({created:1,continued:2,completed:0,skipped:3,reasons:{paused:1,busy:1,unavailable:1}});
    expect(await e.DB.prepare("SELECT count(*) FROM jobs WHERE account='idle'").first("count(*)")).toBe(1);
    expect(await e.DB.prepare("SELECT count(*) FROM jobs WHERE account IN('paused','expired')").first("count(*)")).toBe(0);
  });
  it("does not requeue success from the same still-unfinished batch",async()=>{
    await users(["a","b"]);const ids=await enqueue(e,["a","b"],"submit","定时");await e.DB.prepare("UPDATE jobs SET trigger='schedule',max_attempts=6").run();
    await processJob(e,ids[0],async()=>({status:"success",message:"confirmed"}));
    await processJob(e,ids[1],async()=>({status:"error",message:"temporary",retryable:true}));
    const response=await api();expect(response.body.ids.sort()).toEqual(ids.sort());expect(response.body).toMatchObject({created:0,continued:1,completed:1});
    expect(await e.DB.prepare("SELECT count(*) FROM jobs WHERE account='a'").first("count(*)")).toBe(1);
  });
  it("reconnects both a single-account batch and a single-account button",async()=>{
    await users(["a"]);const [id]=await retrying(["a"]);
    for(const path of ["/api/batch-run","/api/accounts/a/run"]){const response=await api(path);expect(response.status).toBe(202);expect(response.body).toMatchObject({ids:[id],created:0,continued:1,completed:0,skipped:0});}
  });
  it("classifies another operation as busy even when it is the only eligible account",async()=>{
    await users(["a"]);await enqueue(e,["a"],"login");const response=await api();expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ids:[],created:0,continued:0,skipped:1,reasons:{busy:1}});
    const single=await api("/api/accounts/a/run");expect(single.status).toBe(409);
  });
  it("parallel manual clicks converge on the same existing retries and new idle job",async()=>{
    await users(["a","b","idle"]);const ids=await retrying(["a","b"]),responses=await Promise.all([api(),api(),api()]);
    const all=(await e.DB.prepare("SELECT id FROM jobs ORDER BY id").all<{id:string}>()).results.map(row=>row.id).sort();expect(all).toHaveLength(3);
    for(const response of responses){expect(response.status).toBe(202);expect(response.body.ids.sort()).toEqual(all);expect(response.body.ids).toEqual(expect.arrayContaining(ids));}
    expect(responses.reduce((n,response)=>n+response.body.created,0)).toBe(1);
  });
  it("does not reconnect paused or expired submissions and keeps dry operations single-shot",async()=>{
    await users(["a","b","c"]);await retrying(["a","b"]);await setPaused(e,"a",true);await e.DB.prepare("UPDATE accounts SET authorization_until=? WHERE name='b'").bind(Date.now()-1).run();await enqueue(e,["c"],"dry");
    const response=await api();expect(response.body).toMatchObject({ids:[],skipped:3,reasons:{paused:1,unavailable:1,busy:1}});
    await expect(enqueue(e,["c"],"dry")).rejects.toThrow("已有待执行");
  });
});
