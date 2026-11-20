import { describe,it,expect } from "vitest";
import { env } from "cloudflare:workers";
import { reset,applyD1Migrations } from "cloudflare:test";
import { seal } from "../src/security";
import { getAccount } from "../src/storage";
import type { Env } from "../src/types";
const e=env as unknown as Env & {TEST_MIGRATIONS:any[]};
describe("non-destructive administrator upgrade",()=>{
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
