import { beforeEach,describe,expect,it,vi } from "vitest";
import { env } from "cloudflare:workers";
import { reset,applyD1Migrations } from "cloudflare:test";
import { saveAccount } from "../src/storage";
import { enqueue,processJob,dispatch,advanceBatch } from "../src/jobs";
import { getSchedule,tick,scheduleView } from "../src/scheduler";
import type {Env} from "../src/types";
const bindings=env as unknown as Env & {TEST_MIGRATIONS:any[]};
let e:Env;
beforeEach(async()=>{
  await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);
  e={...bindings,JOBS:{send:vi.fn().mockResolvedValue(undefined)} as any,JRXY_INTERVAL:"10"};
  for(const name of ["a","b"])await saveAccount(e,name,{schoolName:"模拟学校",username:name,password:"private",deviceId:"device-"+name,type:2},true);
});
async function ready(id:string){
  await e.DB.prepare("UPDATE jobs SET next_at=? WHERE id=?").bind(Date.now()-1,id).run();
  await e.DB.prepare("UPDATE batches SET round_due=? WHERE id=(SELECT batch_id FROM jobs WHERE id=?)").bind(Date.now()-1,id).run();
}
describe("durable batches",()=>{
  it("enforces sequence even if messages arrive out of order and preserves completion-based interval",async()=>{
    const [a,b]=await enqueue(e,["a","b"],"dry","批量");
    const run=vi.fn().mockResolvedValue({status:"dry",message:"探测通过"});
    await processJob(e,b,run);expect(run).not.toHaveBeenCalled();
    await processJob(e,a,run);expect(run).toHaveBeenCalledTimes(1);
    await processJob(e,b,run);expect(run).toHaveBeenCalledTimes(1);
    const next=await e.DB.prepare("SELECT next_at FROM jobs WHERE id=?").bind(b).first<any>();
    expect(next.next_at).toBeGreaterThan(Date.now()+8000);
    await ready(b);await processJob(e,b,run);expect(run).toHaveBeenCalledTimes(2);
    const batch=await e.DB.prepare("SELECT * FROM batches").first<any>();
    expect(batch.finished_at).toBeTruthy();expect(batch.summary).toBe("探测通过 2");
    expect((await e.DB.prepare("SELECT count(*) AS n FROM sign_log WHERE kind='批量汇总'").first<any>()).n).toBe(1);
    await advanceBatch(e,batch.id);expect((await e.DB.prepare("SELECT count(*) AS n FROM sign_log WHERE kind='批量汇总'").first<any>()).n).toBe(1);
  });
  it("does not run the next account while the prior job is awaiting recovery",async()=>{
    const [a,b]=await enqueue(e,["a","b"],"dry","批量");
    await e.DB.prepare("UPDATE jobs SET status='running',attempts=1,lease_until=? WHERE id=?").bind(Date.now()+60_000,a).run();
    const run=vi.fn();await processJob(e,b,run);expect(run).not.toHaveBeenCalled();
  });
  it("uses a delayed queue message for the account interval",async()=>{
    const [a,b]=await enqueue(e,["a","b"],"dry","批量");
    const run=vi.fn().mockResolvedValue({status:"dry",message:"ok"});await processJob(e,a,run);
    await dispatch(e);
    expect(e.JOBS.send).toHaveBeenCalledWith({id:b,deliveryToken:expect.any(String)},{delaySeconds:expect.any(Number)});
    const delay=(e.JOBS.send as any).mock.calls[0][1].delaySeconds;
    expect(delay).toBeGreaterThan(0);expect(delay).toBeLessThanOrEqual(10);
  });
  it("waits for the first round to end before starting retry delay",async()=>{
    const [a,b]=await enqueue(e,["a","b"],"submit","定时");
    await e.DB.prepare("UPDATE jobs SET trigger='schedule',max_attempts=2").run();
    await e.DB.prepare("UPDATE batches SET trigger='schedule'").run();
    const run=vi.fn().mockResolvedValue({status:"error",message:"暂时网络故障",retryable:true});
    await processJob(e,a,run);
    await ready(a);await processJob(e,a,run);expect(run).toHaveBeenCalledTimes(1);
    await ready(b);run.mockResolvedValue({status:"success",message:"成功"});await processJob(e,b,run);
    const batch=await e.DB.prepare("SELECT * FROM batches").first<any>();expect(batch.round).toBe(2);
    expect(batch.round_due).toBeGreaterThan(Date.now()+290000);
    await processJob(e,a,run);expect(run).toHaveBeenCalledTimes(2);
    await ready(a);await processJob(e,a,run);expect(run).toHaveBeenCalledTimes(3);
    const schedule=await scheduleView(e);expect(schedule.last_result).toBe("签到成功 2");
  });
  it("resumes a saved result without running the engine again",async()=>{
    const [id]=await enqueue(e,["a"],"submit");
    await e.DB.prepare(`UPDATE jobs SET status='done',result=?,report_pending=1,attempts=1,finished_at=?,attempt_started_at=?,notified=1 WHERE id=?`)
      .bind(JSON.stringify({status:"success",message:"已签到"}),Date.now(),Date.now()-5000,id).run();
    const run=vi.fn();await processJob(e,id,run);expect(run).not.toHaveBeenCalled();
    const log=await e.DB.prepare("SELECT * FROM sign_log WHERE kind='手动签到[a]'").first<any>();
    expect(log.detail).toContain("推送状态未知");
    await processJob(e,id,run);expect((await e.DB.prepare("SELECT count(*) AS n FROM sign_log WHERE kind='手动签到[a]'").first<any>()).n).toBe(1);
  });
  it("keeps an execution fence across accounts",async()=>{
    const [a]=await enqueue(e,["a"],"dry");const [b]=await enqueue(e,["b"],"dry");
    let release!:()=>void;const started=Promise.withResolvers<void>();
    const runA=vi.fn(async()=>{started.resolve();await new Promise<void>(resolve=>release=resolve);return{status:"dry",message:"ok"} as const;});
    const runB=vi.fn().mockResolvedValue({status:"dry",message:"ok"});
    const pending=processJob(e,a,runA);await started.promise;await processJob(e,b,runB);expect(runB).not.toHaveBeenCalled();
    release();await pending;await processJob(e,b,runB);expect(runB).toHaveBeenCalledTimes(1);
  });
  it("initializes schedule from settings but never immediately runs a past slot",async()=>{
    const now=Date.now();const local=new Date(now+8*3600_000).toISOString().slice(11,16);
    const s=await getSchedule({...e,AUTO_SIGN:"1",SIGN_TIME:local},now);
    expect(s.enabled).toBe(1);expect(s.time).toBe(local);
    await tick({...e,AUTO_SIGN:"1",SIGN_TIME:local},now);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM jobs").first<any>()).n).toBe(0);
  });
});
