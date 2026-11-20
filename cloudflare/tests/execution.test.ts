import {beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {reset,applyD1Migrations} from "cloudflare:test";
import {saveAccount,setPriorities,setPaused} from "../src/storage";
import {enqueue,processJob,dispatch} from "../src/jobs";
import {updateExecution,executionView,reserveSlot,releaseSlot} from "../src/execution";
import {createCodeBatch,publicRedemption,processEnrollment} from "../src/redemption";
import {randomBytes} from "node:crypto";
import type {Env,Job} from "../src/types";
const bindings=env as unknown as Env&{TEST_MIGRATIONS:any[]};let e:Env;
beforeEach(async()=>{await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);e={...bindings,JRXY_INTERVAL:"0",JOBS:{send:vi.fn().mockResolvedValue(undefined)} as any};});
async function users(n:number){const names=Array.from({length:n},(_,i)=>"a"+i);for(const name of names)await saveAccount(e,name,{schoolName:"模拟学校",username:name,password:"synthetic-password",type:2},true);return names;}
async function jobRows(){return (await e.DB.prepare("SELECT * FROM jobs ORDER BY sequence_no").all<Job>()).results;}
const ok=()=>({status:"dry",message:"ok"} as const);
describe("bounded persistent execution slots",()=>{
  it.each([1,2,3])("runs exactly %s same-wave accounts concurrently without admitting the next wave",async(limit)=>{
    const names=await users(5);await updateExecution(e,{parallelism:limit});await enqueue(e,names,"dry","批量");const jobs=await jobRows();
    let active=0,peak=0;const releases:Array<()=>void>=[],entered=Array.from({length:limit},()=>Promise.withResolvers<void>());
    const run=vi.fn(async()=>{const index=active++;peak=Math.max(peak,active);entered[index].resolve();await new Promise<void>(resolve=>releases.push(resolve));active--;return ok();});
    const running=jobs.slice(0,limit).map(job=>processJob(e,job.id,run));await Promise.all(entered.map(item=>item.promise));
    const extra=vi.fn().mockResolvedValue(ok());await processJob(e,jobs[limit].id,extra);expect(extra).not.toHaveBeenCalled();
    expect((await executionView(e) as any).active).toBe(limit);expect(peak).toBe(limit);
    for(const release of releases)release();await Promise.all(running);
    await processJob(e,jobs[limit].id,extra);expect(extra).toHaveBeenCalledTimes(1);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM execution_slots WHERE owner IS NOT NULL").first<any>()).n).toBe(0);
  });
  it("snapshots descending priorities and blocks lower-weight out-of-order delivery",async()=>{
    const names=await users(4);await setPriorities(e,{names:[names[2],names[3]],priority:50});await updateExecution(e,{parallelism:2});
    await enqueue(e,names,"dry","批量");const jobs=await jobRows();expect(jobs.map(job=>job.account)).toEqual(["a2","a3","a0","a1"]);
    await setPriorities(e,{names:["a0"],priority:100});expect((await jobRows()).map(job=>job.priority)).toEqual([50,50,0,0]);
    const run=vi.fn().mockResolvedValue(ok());await processJob(e,jobs[2].id,run);expect(run).not.toHaveBeenCalled();
    await Promise.all(jobs.slice(0,2).map(job=>processJob(e,job.id,run)));await processJob(e,jobs[2].id,run);expect(run).toHaveBeenCalledTimes(3);
  });
  it("keeps the entire wave ahead of the interval and next wave",async()=>{
    e.JRXY_INTERVAL="10";const names=await users(3);await updateExecution(e,{parallelism:2});await enqueue(e,names,"dry","批量");const jobs=await jobRows();
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    const pending=processJob(e,jobs[0].id,async()=>{entered.resolve();await release.promise;return ok();});await entered.promise;
    const run=vi.fn().mockResolvedValue(ok());await processJob(e,jobs[1].id,run);expect(run).toHaveBeenCalledTimes(1);
    await processJob(e,jobs[2].id,run);expect(run).toHaveBeenCalledTimes(1);release.resolve();await pending;
    expect((await e.DB.prepare("SELECT next_at FROM jobs WHERE id=?").bind(jobs[2].id).first<any>()).next_at).toBeGreaterThan(Date.now()+8000);
  });
  it("limits concurrent dispatch reservations and restores failed sends",async()=>{
    const names=await users(5);await updateExecution(e,{parallelism:3});await enqueue(e,names,"dry");
    await Promise.all([dispatch(e),dispatch(e),dispatch(e)]);expect(e.JOBS.send).toHaveBeenCalledTimes(3);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM execution_slots WHERE task_id IS NOT NULL").first<any>()).n).toBe(3);
  });
  it("a queue send failure releases its reservation for later delivery",async()=>{
    await enqueue(e,await users(1),"dry");(e.JOBS.send as any).mockRejectedValueOnce(new Error("synthetic"));await dispatch(e);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM execution_slots WHERE task_id IS NOT NULL").first<any>()).n).toBe(0);
    await dispatch(e);expect(e.JOBS.send).toHaveBeenCalledTimes(2);
  });
  it("reduces admission without stopping active tasks and respects the old execution gate",async()=>{
    await updateExecution(e,{parallelism:3});const now=Date.now();await e.DB.prepare("UPDATE execution_gate SET owner='old-version',lease_until=? WHERE id=1").bind(now+60000).run();
    expect(await reserveSlot(e,"job","one")).toBe(false);await e.DB.prepare("UPDATE execution_gate SET lease_until=0 WHERE id=1").run();
    expect(await reserveSlot(e,"job","one")).toBe(true);expect(await reserveSlot(e,"job","two")).toBe(true);
    await updateExecution(e,{parallelism:1});expect(await reserveSlot(e,"job","three")).toBe(false);
    await releaseSlot(e,"job","one",null);await releaseSlot(e,"job","two",null);expect(await reserveSlot(e,"job","three")).toBe(true);
  });
  it("duplicate jobs never run twice and pause still prevents a parallel submission",async()=>{
    const names=await users(2);await updateExecution(e,{parallelism:2});const ids=await enqueue(e,names,"submit");
    const run=vi.fn(async(_a,_d,_m,options)=>{await setPaused(e,names[0],true);await expect(options.beforeSubmit({signInstanceWid:"t",signWid:"s"})).rejects.toMatchObject({status:"paused"});return{status:"paused",message:"stopped"} as const;});
    await Promise.all([processJob(e,ids[0],run),processJob(e,ids[0],run)]);expect(run).toHaveBeenCalledTimes(1);
  });
  it("waits for shared capacity before enrollment without losing the code",async()=>{
    const names=await users(1),[id]=await enqueue(e,names,"dry"),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    const pending=processJob(e,id,async()=>{entered.resolve();await release.promise;return ok();});await entered.promise;
    const batch=await createCodeBatch(e,{quantity:1,schoolName:"模拟学校",type:2,lon:120,lat:30,address:"模拟位置"}) as any,path="/api/public/redemption/start";
    await publicRedemption(new Request("https://manager.example"+path,{method:"POST",headers:{Origin:"https://manager.example","Content-Type":"application/json"},body:JSON.stringify({code:batch.codes[0],displayName:"模拟",username:"enroll",password:"synthetic",receipt:randomBytes(32).toString("base64url"),consent:true})}),e,path);
    const attempt=await e.DB.prepare("SELECT id FROM enrollment_attempts").first<any>(),login=vi.fn().mockResolvedValue({});await processEnrollment(e,attempt.id,login);
    expect(login).not.toHaveBeenCalled();expect((await e.DB.prepare("SELECT status FROM enrollment_attempts").first<any>()).status).toBe("pending");
    expect((await e.DB.prepare("SELECT status FROM redemption_codes").first<any>()).status).toBe("reserved");release.resolve();await pending;
    await processEnrollment(e,attempt.id,login);expect(login).toHaveBeenCalledTimes(1);expect((await e.DB.prepare("SELECT status FROM redemption_codes").first<any>()).status).toBe("used");
  });
  it("compares synthetic network wait time at concurrency 1, 2 and 3 without skipping jobs",async()=>{
    const measurements=[];
    for(const limit of [1,2,3]){
      await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);const names=await users(6);await updateExecution(e,{parallelism:limit});await enqueue(e,names,"dry","批量");const jobs=await jobRows();
      let active=0,peak=0,count=0;const run=vi.fn(async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,150));active--;count++;return ok();});
      const started=Date.now();for(let i=0;i<jobs.length;i+=limit)await Promise.all(jobs.slice(i,i+limit).map(job=>processJob(e,job.id,run)));
      measurements.push({limit,elapsedMs:Date.now()-started,peak,completed:count});expect(count).toBe(6);expect(peak).toBe(limit);
      expect((await e.DB.prepare("SELECT count(*) AS n FROM jobs WHERE status='done' AND report_pending=0").first<any>()).n).toBe(6);
    }
    console.log("Synthetic network-wait benchmark:",JSON.stringify(measurements));
  });
  it("measures query cost of a completed task and immediate follow-up scheduling",async()=>{
    const names=await users(6);await updateExecution(e,{parallelism:3});const ids=await enqueue(e,names,"dry");await processJob(e,ids[0],async()=>ok());await processJob(e,ids[1],async()=>ok());
    const raw=e.DB;let queries=0;
    function wrapped(statement:any):any{return{raw:statement,bind:(...values:any[])=>wrapped(statement.bind(...values)),first:async(...args:any[])=>{queries++;return statement.first(...args);},all:async(...args:any[])=>{queries++;return statement.all(...args);},run:async(...args:any[])=>{queries++;return statement.run(...args);}};}
    e={...e,DB:{prepare:(sql:string)=>wrapped(raw.prepare(sql)),batch:async(statements:any[])=>{queries+=statements.length;return raw.batch(statements.map(statement=>statement.raw));}} as any};
    await processJob(e,ids[2],async()=>ok());await dispatch(e);const {dispatchEnrollments}=await import("../src/redemption");await dispatchEnrollments(e);
    console.log("D1 statements for task + follow-up:",queries);expect(queries).toBeLessThanOrEqual(50);
  });
  it("does not advance a retry round until all concurrent reports complete",async()=>{
    const names=await users(3);await updateExecution(e,{parallelism:2});const ids=await enqueue(e,names,"submit","定时");await e.DB.prepare("UPDATE jobs SET trigger='schedule',max_attempts=2").run();await e.DB.prepare("UPDATE batches SET trigger='schedule'").run();
    const fail=vi.fn().mockResolvedValue({status:"error",message:"synthetic",retryable:true});
    await Promise.all(ids.slice(0,2).map(id=>processJob(e,id,fail)));expect((await e.DB.prepare("SELECT round FROM batches").first<any>()).round).toBe(1);
    await processJob(e,ids[0],fail);expect(fail).toHaveBeenCalledTimes(2);
    await processJob(e,ids[2],async()=>({status:"success",message:"done"}));expect((await e.DB.prepare("SELECT round FROM batches").first<any>()).round).toBe(2);
    expect((await e.DB.prepare("SELECT round_due FROM batches").first<any>()).round_due).toBeGreaterThan(Date.now()+290000);
  });
  it("keeps active slots when lowering parallelism until running work ends",async()=>{
    const names=await users(3);await updateExecution(e,{parallelism:3});const ids=await enqueue(e,names,"dry"),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let active=0;
    const run=vi.fn(async()=>{if(++active===2)entered.resolve();await release.promise;return ok();});
    const running=ids.slice(0,2).map(id=>processJob(e,id,run));await entered.promise;await updateExecution(e,{parallelism:1});
    const extra=vi.fn().mockResolvedValue(ok());await processJob(e,ids[2],extra);expect(extra).not.toHaveBeenCalled();expect((await executionView(e) as any).active).toBe(2);
    release.resolve();await Promise.all(running);await processJob(e,ids[2],extra);expect(extra).toHaveBeenCalledTimes(1);
  });
  it("a stale owner cannot submit or overwrite a new slot owner",async()=>{
    const [name]=await users(1),[id]=await enqueue(e,[name],"submit");
    await processJob(e,id,async(_a,_d,_m,options)=>{
      await e.DB.prepare("UPDATE execution_slots SET owner='replacement' WHERE task_id=?").bind(id).run();
      await expect(options.beforeSubmit({signInstanceWid:"t",signWid:"s"})).rejects.toThrow("租约");return{status:"success",message:"stale"};
    });
    expect((await e.DB.prepare("SELECT owner FROM execution_slots WHERE task_id=?").bind(id).first<any>()).owner).toBe("replacement");
    expect((await e.DB.prepare("SELECT result FROM jobs WHERE id=?").bind(id).first<any>()).result).toBeNull();
  });
  it("paused or deleted queued jobs free unused reservations",async()=>{
    const [name]=await users(1),[id]=await enqueue(e,[name],"submit");await dispatch(e);await setPaused(e,name,true);await dispatch(e);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM execution_slots WHERE task_id IS NOT NULL").first<any>()).n).toBe(0);
    await processJob(e,id,vi.fn());expect((await executionView(e) as any).active).toBe(0);
  });
  it("recovers expired reservations without replacing another task's valid slot",async()=>{
    await updateExecution(e,{parallelism:2});await reserveSlot(e,"job","expired");await reserveSlot(e,"job","valid");
    await e.DB.prepare("UPDATE execution_slots SET lease_until=? WHERE task_id='expired'").bind(Date.now()-1).run();
    expect(await reserveSlot(e,"job","replacement")).toBe(true);
    const slots=(await e.DB.prepare("SELECT task_id FROM execution_slots WHERE lease_until>?").bind(Date.now()).all<any>()).results;
    expect(slots.map(row=>row.task_id).sort()).toEqual(["replacement","valid"]);
  });
  it("keeps maintenance work bounded with expired accounts and abandoned authorizations",async()=>{
    const {tick}=await import("../src/scheduler");const names=await users(3);
    await e.DB.prepare("UPDATE accounts SET grant_code_id='expired',authorization_until=? WHERE name=?").bind(Date.now()-1,names[0]).run();
    const batch=await createCodeBatch(e,{quantity:1,schoolName:"模拟学校",type:2,lon:120,lat:30,address:"位置"}) as any,path="/api/public/redemption/start";
    await publicRedemption(new Request("https://manager.example"+path,{method:"POST",headers:{Origin:"https://manager.example","Content-Type":"application/json"},body:JSON.stringify({code:batch.codes[0],displayName:"模拟",username:"stale",password:"synthetic",receipt:randomBytes(32).toString("base64url"),consent:true})}),e,path);
    await e.DB.prepare("UPDATE enrollment_attempts SET expires_at=?").bind(Date.now()-1).run();
    const raw=e.DB;let queries=0;
    function wrapped(statement:any):any{return{raw:statement,bind:(...values:any[])=>wrapped(statement.bind(...values)),first:async(...args:any[])=>{queries++;return statement.first(...args);},all:async(...args:any[])=>{queries++;return statement.all(...args);},run:async(...args:any[])=>{queries++;return statement.run(...args);}};}
    const measured={...e,DB:{prepare:(sql:string)=>wrapped(raw.prepare(sql)),batch:async(statements:any[])=>{queries+=statements.length;return raw.batch(statements.map(statement=>statement.raw));}} as any};
    await tick(measured);console.log("D1 maintenance statements:",queries);expect(queries).toBeLessThanOrEqual(50);
  });
  it("counts pre-upgrade authorization verification toward the shared limit",async()=>{
    const batch=await createCodeBatch(e,{quantity:1,schoolName:"模拟学校",type:2,lon:120,lat:30,address:"位置"}) as any;
    const code=await e.DB.prepare("SELECT id FROM redemption_codes WHERE batch_id=?").bind(batch.id).first<any>();
    await e.DB.prepare("INSERT INTO enrollment_attempts(id,code_id,receipt_hash,request_hash,status,owner,lease_until,created_at,expires_at) VALUES('legacy',?,'legacy-receipt','request','verifying','old',?,?,?)")
      .bind(code.id,Date.now()+60000,Date.now(),Date.now()+600000).run();
    expect(await reserveSlot(e,"job","new")).toBe(false);await updateExecution(e,{parallelism:2});expect(await reserveSlot(e,"job","new")).toBe(true);expect(await reserveSlot(e,"job","extra")).toBe(false);
  });
  it("rejects invalid settings and priority values",async()=>{
    for(const parallelism of [0,4,1.5,"2"])await expect(updateExecution(e,{parallelism})).rejects.toThrow("并发");
    for(const priority of [-1,101,1.5,null])await expect(setPriorities(e,{names:["a"],priority})).rejects.toThrow("权重");
  });
});
