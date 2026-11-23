import {beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {reset,applyD1Migrations,createMessageBatch,createExecutionContext,getQueueResult} from "cloudflare:test";
import {saveAccount} from "../src/storage";
import {enqueue,processJob,dispatch,jobView} from "../src/jobs";
import {updateExecution} from "../src/execution";
import {settings} from "../src/config";
import worker from "../src/index";
import type {Env,Job} from "../src/types";
const bindings=env as unknown as Env&{TEST_MIGRATIONS:any[]};let e:Env;
beforeEach(async()=>{await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);e={...bindings,JOBS:{send:vi.fn().mockResolvedValue(undefined)} as any,JRXY_INTERVAL:"0",RETRY_DELAY_SECONDS:"1"};});
async function users(){for(const name of ["a","b","c"])await saveAccount(e,name,{schoolName:"模拟学校",username:name,password:"synthetic",type:2},true);}
async function makeScheduled(){await users();const ids=await enqueue(e,["a","b","c"],"submit","定时");await e.DB.prepare("UPDATE jobs SET trigger='schedule',max_attempts=6").run();await e.DB.prepare("UPDATE batches SET trigger='schedule'").run();return ids;}
async function deliver(run:any){(e.JOBS.send as any).mockClear();await dispatch(e);const messages=(e.JOBS.send as any).mock.calls.map((call:any)=>call[0]);await Promise.all(messages.map((message:any)=>processJob(e,message.id,run,message.deliveryToken)));return messages;}
describe("round retries through durable dispatch",()=>{
  it("defaults to five extra retries",()=>{expect(settings({...e,MAX_RETRIES:undefined}).maxAttempts).toBe(6);});
  it("keeps a submitted checkpoint while scheduling verification after a timeout",async()=>{
    const ids=await makeScheduled();const run=vi.fn(async(_a,_d,_m,options)=>{await options.beforeSubmit({signInstanceWid:"target",signWid:"sign"});return{status:"uncertain",message:"response unknown",retryable:true,retryAction:"verify"} as const;});
    await processJob(e,ids[0],run);const row=await e.DB.prepare("SELECT * FROM jobs WHERE id=?").bind(ids[0]).first<Job>();
    expect(row!.status).toBe("pending");expect(JSON.parse(row!.checkpoint!)).toMatchObject({signInstanceWid:"target"});
  });
  it("surfaces an active account's existing task instead of creating another",async()=>{
    const ids=await makeScheduled();await expect(enqueue(e,["a"],"submit")).resolves.toEqual([ids[0]]);
    expect(await e.DB.prepare("SELECT count(*) FROM jobs WHERE account='a'").first("count(*)")).toBe(1);
  });
  it("carries unresolved submission evidence into a later manual attempt",async()=>{
    await users();const [id]=await enqueue(e,["a"],"submit");const checkpoint={signInstanceWid:"target",signWid:"sign"};
    await e.DB.prepare("UPDATE jobs SET status='done',checkpoint=?,result=?,finished_at=? WHERE id=?").bind(JSON.stringify(checkpoint),JSON.stringify({status:"uncertain",message:"unknown"}),Date.now(),id).run();
    await e.DB.prepare("UPDATE accounts SET submission_checkpoint=? WHERE name='a'").bind(JSON.stringify(checkpoint)).run();
    const [next]=await enqueue(e,["a"],"submit");expect(next).not.toBe(id);
    const row=await e.DB.prepare("SELECT checkpoint FROM jobs WHERE id=?").bind(next).first<{checkpoint:string}>();expect(JSON.parse(row!.checkpoint)).toEqual(checkpoint);
  });
  it("retains failure evidence on all six rounds and never reruns already completed accounts",async()=>{
    await updateExecution(e,{parallelism:2});await makeScheduled();const order:string[]=[];
    const run=vi.fn(async(account)=>{order.push(account.username);return account.username==="a"?{status:"error",message:"timeout",retryable:true}:{status:"success",message:"ok"};});
    let clock=Date.now();const now=vi.spyOn(Date,"now").mockImplementation(()=>clock);
    try{
      for(let round=1;round<=6;round++){
        const before=await e.DB.prepare("SELECT round_due FROM batches").first<{round_due:number}>();clock=Math.max(clock,before!.round_due);
        for(let step=0;step<3;step++){
          await deliver(run);
          const batch=await e.DB.prepare("SELECT round,finished_at FROM batches").first<any>();
          if(batch.finished_at||batch.round>round)break;
        }
        const a=await e.DB.prepare("SELECT * FROM jobs WHERE account='a'").first<Job>();expect(a!.attempts).toBe(round);
        if(round<6){expect(a!.status).toBe("pending");expect((await jobView(e,[a!.id]))[0]).toHaveProperty("remainingAttempts",6-round);}
      }
    }finally{now.mockRestore();}
    expect(order.slice(0,3).sort()).toEqual(["a","b","c"]);expect(order.filter(name=>name==="a")).toHaveLength(6);expect(order.filter(name=>name==="b")).toHaveLength(1);
    const a=await e.DB.prepare("SELECT result FROM jobs WHERE account='a'").first<{result:string}>();expect(JSON.parse(a!.result).status).toBe("error");
    expect((await e.DB.prepare("SELECT summary FROM batches").first<any>()).summary).toContain("执行异常");
  });
  it("reduces only the retry round to serial after upstream timeouts",async()=>{
    await updateExecution(e,{parallelism:2});const ids=await makeScheduled();
    const fail=vi.fn().mockResolvedValue({status:"error",message:"timeout",retryable:true,transientFailure:true});
    await Promise.all(ids.slice(0,2).map(id=>processJob(e,id,fail)));await processJob(e,ids[2],vi.fn().mockResolvedValue({status:"success",message:"ok"}));
    const batch=await e.DB.prepare("SELECT * FROM batches").first<any>();expect(batch.round).toBe(2);expect(batch.concurrency_limit).toBe(1);
    expect(await e.DB.prepare("SELECT parallelism FROM execution_settings").first("parallelism")).toBe(2);
  });
  it("defers an early queue message without consuming attempts or losing its reservation",async()=>{
    await users();const [id]=await enqueue(e,["a"],"dry");await e.DB.prepare("UPDATE jobs SET next_at=? WHERE id=?").bind(Date.now()+30000,id).run();await dispatch(e);
    const body=(e.JOBS.send as any).mock.calls[0][0],run=vi.fn();const deferred=await processJob(e,id,run,body.deliveryToken);expect(run).not.toHaveBeenCalled();expect(deferred?.retryAfter).toBeGreaterThan(0);
    expect(await e.DB.prepare("SELECT attempts FROM jobs WHERE id=?").bind(id).first("attempts")).toBe(0);
    const message=createMessageBatch("test",[{id:"early",timestamp:Date.now(),attempts:1,body}]);await worker.queue(message,e);
    const queue=await getQueueResult(message,createExecutionContext());expect(queue.explicitAcks).not.toContain("early");
    await e.DB.prepare("UPDATE jobs SET next_at=0 WHERE id=?").bind(id).run();run.mockResolvedValue({status:"dry",message:"ok"});await processJob(e,id,run,body.deliveryToken);expect(run).toHaveBeenCalledTimes(1);
  });
});
