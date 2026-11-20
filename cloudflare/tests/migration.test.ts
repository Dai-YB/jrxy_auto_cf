import { describe,it,expect } from "vitest";
import { env } from "cloudflare:workers";
import { reset,applyD1Migrations } from "cloudflare:test";
import { seal } from "../src/security";
import {createCodeBatch,publicRedemption,listEnrollments} from "../src/redemption";
import {randomBytes} from "node:crypto";
import { getAccount } from "../src/storage";
import type { Env } from "../src/types";
const e=env as unknown as Env & {TEST_MIGRATIONS:any[]};
describe("non-destructive administrator upgrade",()=>{
  it("adds diagnostics without rewriting existing enrollment data",async()=>{
    await reset();await applyD1Migrations(e.DB,e.TEST_MIGRATIONS.slice(0,5));
    const testEnv={...e,JOBS:{send:async()=>{}} as any};
    const batch=await createCodeBatch(testEnv,{quantity:1,schoolName:"模拟学校",type:2,lon:120,lat:30,address:"合成位置",durationValue:1,durationUnit:"days"}) as any;
    const path="/api/public/redemption/start";
    await publicRedemption(new Request("https://manager.example"+path,{method:"POST",headers:{Origin:"https://manager.example","Content-Type":"application/json"},body:JSON.stringify({code:batch.codes[0],displayName:"模拟姓名",username:"student",password:"synthetic",receipt:randomBytes(32).toString("base64url"),consent:true})}),testEnv,path);
    const before=await e.DB.prepare("SELECT * FROM enrollment_attempts").first<any>();
    await applyD1Migrations(e.DB,e.TEST_MIGRATIONS);
    const after=await e.DB.prepare("SELECT * FROM enrollment_attempts").first<any>();expect(after).toEqual({...before,diagnostic:null});
    expect((await listEnrollments(e) as any[])[0].diagnostic).toBeNull();
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
