import { beforeEach,describe,expect,it,vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations,reset,createExecutionContext,waitOnExecutionContext } from "cloudflare:test";
import { saveAccount,setPaused,getAccount } from "../src/storage";
import { enqueue,processJob,dispatch } from "../src/jobs";
import { tick } from "../src/scheduler";
import { EngineError,type Env } from "../src/types";
import { adminHeaders } from "./helpers";
import worker from "../src/index";
const bindings=env as unknown as Env & {TEST_MIGRATIONS:any[]};
let e:Env;
const user={schoolName:"模拟学校",username:"student",password:"private-password",type:2,deviceId:"phone-device",notifyMethod:2,notifyRcv:"SCTtest"};
beforeEach(async()=>{await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);e={...bindings,JOBS:{send:vi.fn().mockResolvedValue(undefined)} as any};await saveAccount(e,"a",user,true);});
async function state(id:string){return e.DB.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first<any>();}
describe("account pause execution barriers",()=>{
  it("blocks submit but preserves read-only operations and account configuration",async()=>{
    await setPaused(e,"a",true);await expect(enqueue(e,["a"],"submit")).rejects.toThrow("已暂停");
    const before=(await getAccount(e,"a"));expect(before.account.password).toBe(user.password);expect(before.row.device_id).toBe(user.deviceId);
    const [id]=await enqueue(e,["a"],"dry");const run=vi.fn().mockResolvedValue({status:"dry",message:"探测通过"});
    await processJob(e,id,run);expect(run).toHaveBeenCalledTimes(1);
    await setPaused(e,"a",false);expect((await getAccount(e,"a")).row.paused).toBe(0);expect(await enqueue(e,["a"],"submit")).toHaveLength(1);
  });
  it("cancels queued jobs permanently even if resumed before delivery",async()=>{
    const [id]=await enqueue(e,["a"],"submit");await setPaused(e,"a",true);await setPaused(e,"a",false);
    const run=vi.fn();await processJob(e,id,run);expect(run).not.toHaveBeenCalled();
    expect(JSON.parse((await state(id)).result).status).toBe("paused");
  });
  it("cancels scheduled retries and does not send a failure notification",async()=>{
    const transport=vi.spyOn(globalThis,"fetch");
    try{
      const [id]=await enqueue(e,["a"],"submit");await e.DB.prepare("UPDATE jobs SET trigger='schedule',max_attempts=3 WHERE id=?").bind(id).run();
      const run=vi.fn().mockResolvedValue({status:"error",message:"网络异常",retryable:true});await processJob(e,id,run);
      expect((await state(id)).status).toBe("pending");await setPaused(e,"a",true);expect((await state(id)).status).toBe("done");expect(transport).not.toHaveBeenCalled();
    }finally{transport.mockRestore();}
  });
  it("guards the final submission checkpoint during pause/resume races",async()=>{
    const [id]=await enqueue(e,["a"],"submit");let submitted=false;
    const run=vi.fn(async(_a,_d,_m,options)=>{
      await setPaused(e,"a",true);await setPaused(e,"a",false);
      try{await options.beforeSubmit({signInstanceWid:"task",signWid:"sign"});submitted=true;return{status:"success",message:"unexpected"} as const;}
      catch(error){expect(error).toBeInstanceOf(EngineError);return{status:"paused",message:"未提交"} as const;}
    });
    await processJob(e,id,run);expect(submitted).toBe(false);expect(JSON.parse((await state(id)).result).status).toBe("paused");
  });
  it("cancels an intermediate retry report if pause/resume happens before reporting recovers",async()=>{
    const [id]=await enqueue(e,["a"],"submit");
    await e.DB.prepare(`UPDATE jobs SET trigger='schedule',max_attempts=3,attempts=1,report_pending=1,result=? WHERE id=?`)
      .bind(JSON.stringify({status:"error",message:"网络错误",retryable:true}),id).run();
    await setPaused(e,"a",true);await setPaused(e,"a",false);
    const run=vi.fn();const transport=vi.spyOn(globalThis,"fetch");
    try{await processJob(e,id,run);expect(run).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
      const job=await state(id);expect(job.status).toBe("done");expect(job.report_pending).toBe(0);expect(JSON.parse(job.result).status).toBe("paused");
    }finally{transport.mockRestore();}
  });
  it("reports an already-issued submission and still sends its outcome",async()=>{
    const [id]=await enqueue(e,["a"],"submit");const transport=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({code:0}));
    try{
      const run=vi.fn(async(_a,_d,_m,options)=>{await options.beforeSubmit({signInstanceWid:"task",signWid:"sign"});const paused=await setPaused(e,"a",true);expect(paused.inFlight).toBe(true);return{status:"success",message:"已提交成功"} as const;});
      await processJob(e,id,run);expect(JSON.parse((await state(id)).result).status).toBe("success");expect(transport).toHaveBeenCalledTimes(1);
    }finally{transport.mockRestore();}
  });
  it("does not catch up a past slot when resumed",async()=>{
    const now=Date.now();const time=new Date(now+8*3600_000).toISOString().slice(11,16);
    await e.DB.prepare("UPDATE schedule SET enabled=1,time=?,effective_after=0,initialized=1").bind(time).run();
    await setPaused(e,"a",true);await setPaused(e,"a",false);await tick(e,now);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM jobs").first<any>()).n).toBe(0);
  });
  it("filters paused accounts from batch submit and tests push without school calls",async()=>{
    const headers=await adminHeaders(e);await setPaused(e,"a",true);
    let ctx=createExecutionContext();let response=await worker.fetch(new Request("https://manager.example/api/batch-run",{method:"POST",headers,body:'{"mode":"submit"}'}),e,ctx);await waitOnExecutionContext(ctx);
    expect((await response.json() as any).ids).toEqual([]);
    const transport=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({code:0}));
    try{
      ctx=createExecutionContext();response=await worker.fetch(new Request("https://manager.example/api/accounts/a/test-notify",{method:"POST",headers,body:"{}"}),e,ctx);
      expect(response.status).toBe(200);expect((await response.json() as any).result).toContain("已接收");
      expect(transport).toHaveBeenCalledTimes(1);expect(String(transport.mock.calls[0][0])).toContain("sctapi.ftqq.com");
      response=await worker.fetch(new Request("https://manager.example/api/accounts/a/test-notify",{method:"POST",headers,body:"{}"}),e,createExecutionContext());expect(response.status).toBe(429);
    }finally{transport.mockRestore();}
  });
});
