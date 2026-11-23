import { describe,it,expect } from "vitest";
import { env } from "cloudflare:workers";
import { reset,applyD1Migrations } from "cloudflare:test";
import { seal } from "../src/security";
import {listEnrollments} from "../src/redemption";
import { getAccount } from "../src/storage";
import type { Env } from "../src/types";
const e=env as unknown as Env & {TEST_MIGRATIONS:any[]};
describe("non-destructive administrator upgrade",()=>{
  it("adds diagnostics without rewriting existing enrollment data",async()=>{
    await reset();await applyD1Migrations(e.DB,e.TEST_MIGRATIONS.slice(0,5));
    await e.DB.batch([
      e.DB.prepare("INSERT INTO redemption_batches(id,note,school_name,task_type,longitude,latitude,address,duration_seconds,created_at) VALUES('batch','','模拟学校',2,120,30,'合成位置',86400,?)").bind(Date.now()),
      e.DB.prepare("INSERT INTO redemption_codes(id,batch_id,code_hash,suffix,status,attempt_id) VALUES('code','batch','synthetic-hash','123456','reserved','attempt')"),
      e.DB.prepare("INSERT INTO enrollment_attempts(id,code_id,receipt_hash,request_hash,credentials,created_at,expires_at) VALUES('attempt','code','receipt','request',?,?,?)")
        .bind(await seal({username:"student",password:"synthetic"},e.ENCRYPTION_KEY,"enrollment:attempt"),Date.now(),Date.now()+600000)
    ]);
    const before=await e.DB.prepare("SELECT * FROM enrollment_attempts").first<any>();
    await applyD1Migrations(e.DB,e.TEST_MIGRATIONS);
    const after=await e.DB.prepare("SELECT * FROM enrollment_attempts").first<any>();expect(after).toEqual({...before,diagnostic:null});
    expect((await listEnrollments(e) as any[])[0].diagnostic).toBeNull();
  });
  it("preserves old code digests, durations and in-flight serial jobs while adding defaults",async()=>{
    await reset();await applyD1Migrations(e.DB,e.TEST_MIGRATIONS.slice(0,6));
    await e.DB.batch([
      e.DB.prepare("INSERT INTO redemption_batches(id,note,school_name,task_type,longitude,latitude,address,duration_seconds,created_at) VALUES('b','','模拟学校',2,120,30,'位置',604800,1)"),
      e.DB.prepare("INSERT INTO redemption_codes(id,batch_id,code_hash,suffix,status) VALUES('c','b','original-hash','123456','used')"),
      e.DB.prepare("INSERT INTO accounts(name,config,device_id,created_at) VALUES('a','','old-device',1)"),
      e.DB.prepare("INSERT INTO batches(id,trigger,mode,label,created_at,round_due) VALUES('job-b','manual','dry','批量',1,1)"),
      e.DB.prepare("INSERT INTO jobs(id,account,mode,trigger,status,next_at,created_at,batch_id,sequence_no) VALUES('j','a','dry','manual','pending',1,1,'job-b',4)"),
      e.DB.prepare("UPDATE execution_gate SET owner='old-owner',lease_until=12345 WHERE id=1")
    ]);
    await applyD1Migrations(e.DB,e.TEST_MIGRATIONS);
    expect(await e.DB.prepare("SELECT code_hash,code_cipher,status FROM redemption_codes").first()).toEqual({code_hash:"original-hash",code_cipher:null,status:"used"});
    expect((await e.DB.prepare("SELECT duration_seconds FROM redemption_batches").first<any>()).duration_seconds).toBe(604800);
    expect(await e.DB.prepare("SELECT priority,wave_no,sequence_no FROM jobs").first()).toEqual({priority:0,wave_no:4,sequence_no:4});
    expect((await e.DB.prepare("SELECT concurrency_limit FROM batches").first<any>()).concurrency_limit).toBe(1);
    expect((await e.DB.prepare("SELECT parallelism FROM execution_settings").first<any>()).parallelism).toBe(1);
    expect(await e.DB.prepare("SELECT owner,lease_until FROM execution_gate").first()).toEqual({owner:"old-owner",lease_until:12345});
  });
  it("migrates only the latest unresolved submit and keeps old retry budgets",async()=>{
    await reset();await applyD1Migrations(e.DB,e.TEST_MIGRATIONS.slice(0,8));
    const checkpoint=JSON.stringify({signInstanceWid:"old-target",signWid:"old-sign"});
    for(const name of ["unresolved","resolved","queued","empty-list"]){
      await e.DB.prepare("INSERT INTO accounts(name,config,device_id,created_at) VALUES(?,'','fixed-device',1)").bind(name).run();
      await e.DB.prepare("INSERT INTO jobs(id,account,mode,trigger,status,next_at,created_at,checkpoint,result,max_attempts) VALUES(?,?,'submit','schedule','done',1,1,?,?,3)")
        .bind(name+"-old",name,checkpoint,JSON.stringify({status:"uncertain",message:"unknown"})).run();
    }
    await e.DB.prepare("INSERT INTO jobs(id,account,mode,trigger,status,next_at,created_at,result) VALUES('resolved-new','resolved','submit','manual','done',2,2,?)")
      .bind(JSON.stringify({status:"success",message:"confirmed"})).run();
    await e.DB.prepare("INSERT INTO jobs(id,account,mode,trigger,status,next_at,created_at) VALUES('queued-new','queued','submit','schedule','pending',2,2)").run();
    await e.DB.prepare("INSERT INTO jobs(id,account,mode,trigger,status,next_at,created_at,result) VALUES('empty-new','empty-list','submit','manual','done',2,2,?)")
      .bind(JSON.stringify({status:"no_task",message:"no evidence"})).run();
    await applyD1Migrations(e.DB,e.TEST_MIGRATIONS);
    for(const name of ["queued","empty-list"])expect(await e.DB.prepare("SELECT submission_checkpoint FROM accounts WHERE name=?").bind(name).first("submission_checkpoint")).toBe(checkpoint);
    expect(await e.DB.prepare("SELECT submission_checkpoint FROM accounts WHERE name='unresolved'").first("submission_checkpoint")).toBe(checkpoint);
    expect(await e.DB.prepare("SELECT submission_checkpoint FROM accounts WHERE name='resolved'").first("submission_checkpoint")).toBeNull();
    expect(await e.DB.prepare("SELECT max_attempts FROM jobs WHERE id='unresolved-old'").first("max_attempts")).toBe(3);
  });
  it("adds nullable execution reports without changing old logs or task results",async()=>{
    await reset();await applyD1Migrations(e.DB,e.TEST_MIGRATIONS.slice(0,9));
    await e.DB.prepare("INSERT INTO sign_log(ts,kind,result,detail) VALUES(1,'历史','执行异常','旧详情')").run();
    const before=await e.DB.prepare("SELECT * FROM sign_log").first<any>();
    await applyD1Migrations(e.DB,e.TEST_MIGRATIONS);expect(await e.DB.prepare("SELECT * FROM sign_log").first()).toEqual({...before,diagnostic:null});
  });
  it("preserves old encrypted accounts, device IDs, plans and logs",async()=>{
    await reset();await applyD1Migrations(e.DB,e.TEST_MIGRATIONS.slice(0,3));
    const config=await seal({schoolName:"旧学校",username:"old-user",password:"original-password",type:2,lon:1,lat:2,address:"地址",abnormalReason:"",notifyKey:"SCTold"},e.ENCRYPTION_KEY,"account:old");
    await e.DB.batch([
      e.DB.prepare("INSERT INTO accounts(name,config,device_id,created_at) VALUES('old',?,'original-device',1)").bind(config),
      e.DB.prepare("UPDATE schedule SET enabled=1,time='21:35',initialized=1,effective_after=1"),
      e.DB.prepare("INSERT INTO sign_log(ts,account,kind,result,detail) VALUES(1,'old','历史','签到成功','旧日志')")
    ]);
    await applyD1Migrations(e.DB,e.TEST_MIGRATIONS);
    const {row,account}=await getAccount(e,"old");expect(row.config).toBe(config);expect(row.device_id).toBe("original-device");expect(row.paused).toBe(0);expect(account.password).toBe("original-password");
    expect(await e.DB.prepare("SELECT enabled,time FROM schedule").first()).toEqual({enabled:1,time:"21:35"});
    expect((await e.DB.prepare("SELECT detail FROM sign_log").first<any>()).detail).toBe("旧日志");
    expect((await e.DB.prepare("SELECT count(*) AS n FROM admin_sessions").first<any>()).n).toBe(0);
  });
});
