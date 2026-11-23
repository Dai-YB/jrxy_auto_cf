import {beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {reset,applyD1Migrations} from "cloudflare:test";
import {saveAccount,deleteAccount} from "../src/storage";
import {enqueue,processJob,dispatch,advanceBatch} from "../src/jobs";
import {releaseSlot} from "../src/execution";
import {tick} from "../src/scheduler";
import {execute} from "../src/engine/sign";
import type {Env,Job} from "../src/types";
const bindings=env as unknown as Env&{TEST_MIGRATIONS:any[]};let e:Env;
const checkpoint={signInstanceWid:"target",signWid:"sign"};
beforeEach(async()=>{await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);e={...bindings,JRXY_INTERVAL:"0",JOBS:{send:vi.fn().mockResolvedValue(undefined)} as any};await saveAccount(e,"a",{schoolName:"模拟学校",username:"student",password:"synthetic",type:2},true);});
async function row(id:string){return (await e.DB.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first<Job>())!;}
async function unknown(id:string){await processJob(e,id,async(_a,_d,_m,options)=>{await options!.beforeSubmit!(checkpoint);return {status:"uncertain",message:"unknown",retryable:true,retryAction:"verify"};});}
function interceptBatch(test:(sql:string)=>boolean,hook:()=>Promise<void>):Env {
  const raw=e.DB;
  const wrap=(statement:any,sql:string):any=>({raw:statement,sql,bind:(...v:any[])=>wrap(statement.bind(...v),sql),first:(...v:any[])=>statement.first(...v),all:()=>statement.all(),run:()=>statement.run()});
  return {...e,DB:{prepare:(sql:string)=>wrap(raw.prepare(sql),sql),batch:async(statements:any[])=>{if(statements.some(s=>test(s.sql)))await hook();return raw.batch(statements.map(s=>s.raw));}} as any};
}
describe("queue ownership and cross-attempt recovery",()=>{
  it("an old delivery cannot release or run a replacement reservation",async()=>{
    const [id]=await enqueue(e,["a"],"dry");await dispatch(e);const old=(e.JOBS.send as any).mock.calls[0][0];
    await releaseSlot(e,"job",id,null,old.deliveryToken);await e.DB.prepare("UPDATE jobs SET dispatched_at=0 WHERE id=?").bind(id).run();await dispatch(e);
    const fresh=(e.JOBS.send as any).mock.calls[1][0],run=vi.fn().mockResolvedValue({status:"dry",message:"ok"});
    await processJob(e,id,run,old.deliveryToken);expect(run).not.toHaveBeenCalled();
    expect(await e.DB.prepare("SELECT delivery_token FROM execution_slots WHERE task_id=?").bind(id).first("delivery_token")).toBe(fresh.deliveryToken);
    await Promise.all([processJob(e,id,run,fresh.deliveryToken),processJob(e,id,run,fresh.deliveryToken)]);expect(run).toHaveBeenCalledTimes(1);
  });
  it("a late send failure cannot reset a newer dispatch",async()=>{
    const [id]=await enqueue(e,["a"],"dry"),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    (e.JOBS.send as any).mockImplementationOnce(async()=>{entered.resolve();await release.promise;throw new Error("late send failure");});
    const pending=dispatch(e);await entered.promise;
    const old=(e.JOBS.send as any).mock.calls[0][0];await releaseSlot(e,"job",id,null,old.deliveryToken);
    await e.DB.prepare("UPDATE jobs SET dispatched_at=0 WHERE id=?").bind(id).run();await dispatch(e);
    const fresh=(e.JOBS.send as any).mock.calls[1][0];release.resolve();await pending;
    expect((await row(id)).dispatched_at).toBeGreaterThan(0);
    expect(await e.DB.prepare("SELECT delivery_token FROM execution_slots WHERE task_id=?").bind(id).first("delivery_token")).toBe(fresh.deliveryToken);
  });
  it("a competing account lock does not consume an attempt or strand the outbox",async()=>{
    const [id]=await enqueue(e,["a"],"dry");await dispatch(e);const body=(e.JOBS.send as any).mock.calls[0][0];
    await e.DB.prepare("INSERT INTO account_locks(account,job_id,owner,lease_until) VALUES('a','other','other',?)").bind(Date.now()+60000).run();
    const run=vi.fn();await processJob(e,id,run,body.deliveryToken);expect(run).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({attempts:0,dispatched_at:0,status:"pending"});
    await e.DB.prepare("DELETE FROM account_locks").run();await dispatch(e);expect(e.JOBS.send).toHaveBeenCalledTimes(2);
  });
  it("refreshes account evidence when a scheduled job was queued before a manual submission",async()=>{
    const [manual]=await enqueue(e,["a"],"submit");
    await e.DB.prepare("UPDATE schedule SET enabled=1,initialized=1,effective_after=0,time=?").bind(new Date(Date.now()+8*3600000).toISOString().slice(11,16)).run();
    await tick(e);const scheduled=await e.DB.prepare("SELECT id FROM jobs WHERE trigger='schedule'").first<{id:string}>();expect(scheduled).not.toBeNull();
    await unknown(manual);
    const verify=vi.fn(async()=>({status:"uncertain",message:"verify only",retryable:true,retryAction:"verify"} as const));
    await processJob(e,scheduled!.id,verify);expect(verify).toHaveBeenCalledTimes(1);expect(verify.mock.calls[0][3].checkpoint).toEqual(checkpoint);expect(JSON.parse((await row(scheduled!.id)).checkpoint!)).toEqual(checkpoint);
  });
  it("promotes a checkpoint written by an old in-flight worker into account evidence",async()=>{
    const [id]=await enqueue(e,["a"],"submit");await e.DB.prepare("UPDATE jobs SET checkpoint=? WHERE id=?").bind(JSON.stringify(checkpoint),id).run();
    await processJob(e,id,async()=>({status:"uncertain",message:"legacy still unknown",retryAction:"verify"}));
    const [next]=await enqueue(e,["a"],"submit");expect(JSON.parse((await row(next)).checkpoint!)).toEqual(checkpoint);
  });
  it("retires historical unknown evidence once verification confirms unsigned",async()=>{
    const [first]=await enqueue(e,["a"],"submit");await unknown(first);
    const [second]=await enqueue(e,["a"],"submit");await processJob(e,second,async()=>({status:"error",message:"unsigned",retryable:true,submissionState:"unsigned",retryAction:"execute"}));
    const [third]=await enqueue(e,["a"],"submit");expect((await row(third)).checkpoint).toBeNull();
    expect(await e.DB.prepare("SELECT submission_checkpoint FROM accounts WHERE name='a'").first("submission_checkpoint")).toBeNull();
  });
  it("does not resurrect evidence after deleting and replacing an admin identity",async()=>{
    const [id]=await enqueue(e,["a"],"submit");await unknown(id);await deleteAccount(e,"a");
    await saveAccount(e,"a",{schoolName:"另一模拟学校",username:"replacement",password:"synthetic",type:2},true);
    const [next]=await enqueue(e,["a"],"submit");expect((await row(next)).checkpoint).toBeNull();
  });
  it("a stale reporting lease cannot clear a result that still needs reporting",async()=>{
    const [id]=await enqueue(e,["a"],"submit");
    await e.DB.prepare("UPDATE jobs SET status='done',result=?,report_pending=1,attempts=1,notification_result='disabled' WHERE id=?").bind(JSON.stringify({status:"success",message:"ok"}),id).run();
    let expire=true;
    const fenced=interceptBatch(sql=>sql.startsWith("INSERT INTO sign_log(ts,account,kind,result,detail,batch_id,"),async()=>{if(!expire)return;expire=false;await e.DB.prepare("UPDATE jobs SET lease_until=0 WHERE id=?").bind(id).run();await e.DB.prepare("UPDATE execution_slots SET lease_until=0 WHERE task_id=?").bind(id).run();});
    const run=vi.fn();await processJob(fenced,id,run);expect((await row(id)).report_pending).toBe(1);
    expect(await e.DB.prepare("SELECT count(*) FROM sign_log WHERE kind='手动签到[a]'").first("count(*)")).toBe(0);
    await processJob(e,id,run);expect(run).not.toHaveBeenCalled();expect((await row(id)).report_pending).toBe(0);
    expect(await e.DB.prepare("SELECT count(*) FROM sign_log WHERE kind='手动签到[a]'").first("count(*)")).toBe(1);
  });
  it("a report transaction failure recovers without replaying the engine",async()=>{
    const [id]=await enqueue(e,["a"],"submit");let fail=true;
    const broken=interceptBatch(sql=>sql.startsWith("INSERT INTO sign_log(ts,account,kind,result,detail,batch_id,"),async()=>{if(fail){fail=false;throw new Error("synthetic D1 interruption");}});
    const run=vi.fn().mockResolvedValue({status:"success",message:"ok"});await expect(processJob(broken,id,run)).rejects.toThrow("恢复");
    expect((await row(id)).report_pending).toBe(1);const report=JSON.parse((await row(id)).result!).executionReport;
    await processJob(e,id,run);expect(run).toHaveBeenCalledTimes(1);expect((await row(id)).report_pending).toBe(0);
    const reports=(await e.DB.prepare("SELECT diagnostic FROM sign_log WHERE kind='手动签到[a]'").all<{diagnostic:string}>()).results;
    expect(reports).toHaveLength(1);expect(JSON.parse(reports[0].diagnostic).id).toBe(report.id);
  });
  it("recovers a lost result transaction by checking the submitted target, not resubmitting",async()=>{
    const [id]=await enqueue(e,["a"],"submit");let fail=true;
    const broken=interceptBatch(sql=>sql.startsWith("UPDATE jobs SET status=?,result=?"),async()=>{if(fail){fail=false;throw new Error("synthetic result persistence failure");}});
    let submissions=0;
    const run=vi.fn(async(_a,_d,_m,options)=>{
      if(!options.checkpoint){await options.beforeSubmit(checkpoint);submissions++;}
      return {status:"success",message:"confirmed",submissionState:"signed"} as const;
    });
    await expect(processJob(broken,id,run)).rejects.toThrow("恢复");expect(submissions).toBe(1);
    expect(JSON.parse((await row(id)).checkpoint!)).toEqual(checkpoint);
    await e.DB.prepare("UPDATE jobs SET lease_until=0 WHERE id=?").bind(id).run();await dispatch(e);
    const body=(e.JOBS.send as any).mock.calls.at(-1)[0];await processJob(e,id,run,body.deliveryToken);
    expect(run).toHaveBeenCalledTimes(2);expect(run.mock.calls[1][3].checkpoint).toEqual(checkpoint);expect(submissions).toBe(1);
    expect(await row(id)).toMatchObject({status:"done",report_pending:0,checkpoint:null});
    await dispatch(e);await processJob(e,id,run,body.deliveryToken);expect(run).toHaveBeenCalledTimes(2);
  });
  it("does not turn a temporary target-save error into a final school failure",async()=>{
    const [id]=await enqueue(e,["a"],"submit"),raw=e.DB;
    const wrap=(statement:any,sql:string):any=>({raw:statement,bind:(...v:any[])=>wrap(statement.bind(...v),sql),first:(...v:any[])=>{if(sql.startsWith("UPDATE jobs SET target=?"))throw new Error("synthetic D1 unavailable");return statement.first(...v);},all:()=>statement.all(),run:()=>statement.run()});
    const broken={...e,DB:{prepare:(sql:string)=>wrap(raw.prepare(sql),sql),batch:(statements:any[])=>raw.batch(statements.map(s=>s.raw))}} as any;
    const json=vi.fn().mockResolvedValue({datas:{unSignedTasks:[checkpoint],leaveTasks:[],signedTasks:[]}});
    const loginFn=vi.fn().mockResolvedValue({session:{json,request:vi.fn().mockResolvedValue({}),jar:{get:()=>"",names:()=>[]}},host:"https://mock.campusphere.net/",tenantId:"mock",sessionToken:"mock"});
    await expect(processJob(broken,id,(account,device,mode,options)=>execute(account,device,mode,{...options,loginFn}))).rejects.toThrow("恢复");
    expect(await row(id)).toMatchObject({status:"running",result:null});expect(json).toHaveBeenCalledTimes(1);
  });
  it("a checkpoint transaction outage is recovered instead of consuming the job as a final failure",async()=>{
    const [id]=await enqueue(e,["a"],"submit");
    const broken=interceptBatch(sql=>sql.startsWith("UPDATE jobs SET checkpoint=?,target=?"),async()=>{throw new Error("synthetic checkpoint failure");});
    await expect(processJob(broken,id,async(_a,_d,_m,options)=>{
      try{await options!.beforeSubmit!(checkpoint);}catch{return{status:"error",message:"engine stopped before sending"};}
      return {status:"success",message:"should not reach"};
    })).rejects.toThrow("恢复");
    expect(await row(id)).toMatchObject({status:"running",result:null,checkpoint:null});
  });
  it("counts consecutive interruptions separately from completed business attempts",async()=>{
    const [id]=await enqueue(e,["a"],"submit");await e.DB.prepare("UPDATE jobs SET trigger='schedule',max_attempts=6,recoveries=2 WHERE id=?").bind(id).run();
    await processJob(e,id,async()=>({status:"error",message:"temporary",retryable:true}));
    expect(await row(id)).toMatchObject({status:"pending",attempts:1,recoveries:0});
  });
  it("rejects changing the identity or task type while a submission is unresolved",async()=>{
    const [id]=await enqueue(e,["a"],"submit");await unknown(id);
    await expect(saveAccount(e,"a",{username:"other"},false)).rejects.toThrow("提交待确认");
    await expect(saveAccount(e,"a",{type:1},false)).rejects.toThrow("提交待确认");
    await expect(saveAccount(e,"a",{password:"corrected"},false)).resolves.toBeDefined();
  });
  it("finishes empty historical batches so they cannot block a future daily slot",async()=>{
    await e.DB.prepare("INSERT INTO batches(id,trigger,mode,label,created_at,round_due) VALUES('empty','schedule','submit','定时',1,1)").run();
    await advanceBatch(e,"empty");expect(await e.DB.prepare("SELECT finished_at FROM batches WHERE id='empty'").first("finished_at")).not.toBeNull();
  });
});
