import {beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {applyD1Migrations,reset} from "cloudflare:test";
import {randomBytes} from "node:crypto";
import {createCodeBatch,publicRedemption,processEnrollment} from "../src/redemption";
import {saveAccount} from "../src/storage";
import {tick} from "../src/scheduler";
import {enqueue,processJob} from "../src/jobs";
import type {Env} from "../src/types";
const bindings=env as unknown as Env&{TEST_MIGRATIONS:any[]};let e:Env;
beforeEach(async()=>{await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);e={...bindings,JOBS:{send:vi.fn().mockResolvedValue(undefined)} as any};});
async function enroll(){
  const batch=await createCodeBatch(e,{quantity:1,schoolName:"模拟学校",type:2,lon:120,lat:30,address:"合成位置",durationValue:1,durationUnit:"hours"}) as any;
  const path="/api/public/redemption/start";
  await publicRedemption(new Request("https://manager.example"+path,{method:"POST",headers:{Origin:"https://manager.example","Content-Type":"application/json"},body:JSON.stringify({code:batch.codes[0],username:"student",password:"private-password",receipt:randomBytes(32).toString("base64url"),consent:true})}),e,path);
  const attempt=await e.DB.prepare("SELECT id FROM enrollment_attempts").first<any>();await processEnrollment(e,attempt.id,vi.fn().mockResolvedValue({}));
  return (await e.DB.prepare("SELECT name FROM accounts WHERE grant_code_id IS NOT NULL").first<any>()).name as string;
}
describe("expiry at all execution gates",()=>{
  it("cron removes expired grants but keeps manually created accounts and schedules them",async()=>{
    const name=await enroll();await e.DB.prepare("UPDATE accounts SET authorization_until=? WHERE name=?").bind(Date.now()-1,name).run();
    await saveAccount(e,"manual",{schoolName:"其他学校",username:"other",password:"other-password",deviceId:"fixed-device",type:2},true);
    const now=Date.now(),time=new Date(now+8*3600_000).toISOString().slice(11,16);
    await e.DB.prepare("UPDATE schedule SET enabled=1,time=?,initialized=1,effective_after=0").bind(time).run();await tick(e,now);
    const jobs=await e.DB.prepare("SELECT account FROM jobs").all<any>();expect(jobs.results).toEqual([{account:"manual"}]);
    expect(await e.DB.prepare("SELECT name FROM accounts WHERE name=?").bind(name).first()).toBeNull();
  });
  it("expired account is blocked before enqueue without waiting for cron cleanup",async()=>{
    const name=await enroll();await e.DB.prepare("UPDATE accounts SET authorization_until=? WHERE name=?").bind(Date.now()-1,name).run();
    await expect(enqueue(e,[name],"submit")).rejects.toMatchObject({code:410});
    expect((await e.DB.prepare("SELECT count(*) AS n FROM jobs").first<any>()).n).toBe(0);
  });
  it("expiry during a failed scheduled attempt never starts another retry",async()=>{
    const name=await enroll();const [id]=await enqueue(e,[name],"submit");await e.DB.prepare("UPDATE jobs SET trigger='schedule',max_attempts=3 WHERE id=?").bind(id).run();
    const run=vi.fn(async()=>{await e.DB.prepare("UPDATE accounts SET authorization_until=? WHERE name=?").bind(Date.now()-1,name).run();return{status:"error",message:"network",retryable:true} as const;});
    await processJob(e,id,run);expect(run).toHaveBeenCalledTimes(1);expect(await e.DB.prepare("SELECT id FROM jobs WHERE id=?").bind(id).first()).toBeNull();
    await processJob(e,id,run);expect(run).toHaveBeenCalledTimes(1);
  });
});
