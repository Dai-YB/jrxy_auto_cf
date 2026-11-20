import {beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {reset,applyD1Migrations} from "cloudflare:test";
import {randomBytes} from "node:crypto";
import {createCodeBatch,publicRedemption,processEnrollment,cleanupEnrollments,enrollmentStatus,revokeCode} from "../src/redemption";
import {cleanupExpiredAccounts} from "../src/expiry";
import {getAccount,saveAccount,deleteAccount} from "../src/storage";
import {enqueue,processJob} from "../src/jobs";
import {EngineError,type Env} from "../src/types";
import {identityKey} from "../src/identity";
const bindings=env as unknown as Env & {TEST_MIGRATIONS:any[]};
let e:Env;
const preset={quantity:1,note:"合成批次",schoolName:"模拟学校",type:2,lon:120,lat:30,address:"合成地址",durationValue:2,durationUnit:"hours"};
beforeEach(async()=>{await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);e={...bindings,JOBS:{send:vi.fn().mockResolvedValue(undefined)} as any};});
const receipt=()=>randomBytes(32).toString("base64url");
function request(path:string,body:unknown){return new Request("https://manager.example"+path,{method:"POST",headers:{Origin:"https://manager.example","Content-Type":"application/json"},body:JSON.stringify(body)});}
async function start(code:string,token=receipt(),extra:Record<string,unknown>={}){
  const path="/api/public/redemption/start";
  const body={code,username:"student",password:"private-password",receipt:token,consent:true,...extra};
  const response=await publicRedemption(request(path,body),e,path);
  const row=await e.DB.prepare("SELECT * FROM enrollment_attempts ORDER BY created_at DESC LIMIT 1").first<any>();
  return {row,token,body,response};
}
const loggedIn=()=>vi.fn().mockResolvedValue({session:{jar:{names:()=>["MOD_AUTH_CAS"]}},host:"https://school.campusphere.net/",tenantId:"test",sessionToken:"secret"});
describe("one-time redemption enrollment",()=>{
  it("generates one to ten unique codes with exactly one per line and stores only hashes",async()=>{
    for(const quantity of [0,-1,1.5,11,"2"])await expect(createCodeBatch(e,{...preset,quantity})).rejects.toThrow("1～10");
    const batch=await createCodeBatch(e,{...preset,quantity:10}) as any;
    expect(batch.codes).toHaveLength(10);expect(new Set(batch.codes).size).toBe(10);expect(batch.text.split("\n")).toEqual(batch.codes);
    const stored=await e.DB.prepare("SELECT * FROM redemption_codes").all();
    expect(JSON.stringify(stored)).not.toContain(batch.codes[0]);expect((await e.DB.prepare("SELECT count(*) AS n FROM redemption_batches").first<any>()).n).toBe(1);
  });
  it("does not activate before verified and ignores user overrides of batch preset and notifications",async()=>{
    const batch=await createCodeBatch(e,preset) as any;const {row,token}=await start(batch.codes[0],receipt(),{schoolName:"tampered",type:1,lon:0,address:"wrong",notifyOption:{method:2,rcvOption:"SCTwrong"}});
    expect((await e.DB.prepare("SELECT count(*) AS n FROM accounts").first<any>()).n).toBe(0);
    expect(row.credentials).not.toContain("private-password");expect(e.JOBS.send).toHaveBeenCalledWith({kind:"enrollment",id:row.id});
    const login=loggedIn();await processEnrollment(e,row.id,login);
    expect(login.mock.calls[0][0]).toMatchObject({schoolName:preset.schoolName,type:2,lon:120,lat:30,address:preset.address,notifyOption:{method:0,rcvOption:""}});
    const stored=await e.DB.prepare("SELECT * FROM accounts").first<any>();
    expect(stored.device_id).toMatch(/^[a-f0-9-]{36}$/);expect(stored.authorization_until-stored.authorization_from).toBe(7200000);
    const status=await enrollmentStatus(e,token) as any;expect(status.status).toBe("succeeded");expect(status.message).toBe("签到设置成功");
    const attempt=await e.DB.prepare("SELECT * FROM enrollment_attempts WHERE id=?").bind(row.id).first<any>();
    expect(attempt.credentials).toBe("");expect(attempt.account_config).toBe("");expect(attempt.device_id).toBe("");expect(attempt.identity_key).toBeNull();
    await processEnrollment(e,row.id,login);expect(login).toHaveBeenCalledTimes(1);
    expect((await e.DB.prepare("SELECT device_id FROM accounts").first<any>()).device_id).toBe(stored.device_id);
    await expect(start(batch.codes[0])).rejects.toThrow("已使用");
  });
  it("allows only one concurrent reservation and treats the same receipt idempotently",async()=>{
    const batch=await createCodeBatch(e,preset) as any;
    const results=await Promise.allSettled([start(batch.codes[0]),start(batch.codes[0])]);expect(results.filter(x=>x.status==="fulfilled")).toHaveLength(1);
    const first=(results.find(x=>x.status==="fulfilled") as PromiseFulfilledResult<any>).value;
    const repeated=await publicRedemption(request("/api/public/redemption/start",first.body),e,"/api/public/redemption/start");expect(repeated.status).toBe(202);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM enrollment_attempts").first<any>()).n).toBe(1);
    let release!:()=>void;const entered=Promise.withResolvers<void>();
    const login=vi.fn(async()=>{entered.resolve();await new Promise<void>(resolve=>release=resolve);return {} as any;});
    const pending=processEnrollment(e,first.row.id,login);await entered.promise;await processEnrollment(e,first.row.id,login);expect(login).toHaveBeenCalledTimes(1);release();await pending;
    expect((await enrollmentStatus(e,first.token) as any).status).toBe("succeeded");
  });
  it("concurrent duplicate save with the same receipt returns the same operation",async()=>{
    const batch=await createCodeBatch(e,preset) as any;const token=receipt();
    const results=await Promise.all([start(batch.codes[0],token),start(batch.codes[0],token)]);
    expect(results.every(result=>result.response.status===202)).toBe(true);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM enrollment_attempts").first<any>()).n).toBe(1);
  });
  it.each([new EngineError("用户名密码错误"),new EngineError("验证码","captcha"),new EngineError("timeout","error",true)])("failed login does not consume the code or keep passwords",async(error)=>{
    const batch=await createCodeBatch(e,preset) as any;const {row,token}=await start(batch.codes[0]);
    await processEnrollment(e,row.id,vi.fn().mockRejectedValue(error));
    expect((await enrollmentStatus(e,token) as any).status).toBe("failed");
    expect((await e.DB.prepare("SELECT status FROM redemption_codes").first<any>()).status).toBe("unused");
    const stored=await e.DB.prepare("SELECT credentials,identity_key FROM enrollment_attempts").first<any>();expect(stored.credentials).toBe("");expect(stored.identity_key).toBeNull();
    expect((await e.DB.prepare("SELECT count(*) AS n FROM accounts").first<any>()).n).toBe(0);
  });
  it("reuses a safely retained original device binding and never replaces an active account",async()=>{
    await saveAccount(e,"legacy",{schoolName:preset.schoolName,username:"student",password:"old-password",deviceId:"original-real-device",type:2},true);
    const batch=await createCodeBatch(e,preset) as any;await expect(start(batch.codes[0])).rejects.toThrow("已配置");
    await deleteAccount(e,"legacy");const {row}=await start(batch.codes[0]);await processEnrollment(e,row.id,loggedIn());
    expect((await e.DB.prepare("SELECT device_id FROM accounts WHERE deleted=0").first<any>()).device_id).toBe("original-real-device");
  });
  it("revocation while verifying prevents activation and wipes temporary data",async()=>{
    const batch=await createCodeBatch(e,preset) as any;const {row,token}=await start(batch.codes[0]);
    const login=vi.fn(async()=>{await revokeCode(e,row.code_id);return {} as any;});await processEnrollment(e,row.id,login);
    expect((await enrollmentStatus(e,token) as any).status).toBe("failed");expect((await e.DB.prepare("SELECT status FROM redemption_codes").first<any>()).status).toBe("revoked");
    expect((await e.DB.prepare("SELECT count(*) AS n FROM accounts").first<any>()).n).toBe(0);
  });
  it("expired or interrupted reservations are released without automatically repeating login",async()=>{
    const batch=await createCodeBatch(e,preset) as any;const {row}=await start(batch.codes[0]);
    await e.DB.prepare("UPDATE enrollment_attempts SET status='verifying',lease_until=? WHERE id=?").bind(Date.now()-1,row.id).run();
    await cleanupEnrollments(e);
    const login=loggedIn();await processEnrollment(e,row.id,login);expect(login).not.toHaveBeenCalled();
    expect((await e.DB.prepare("SELECT status FROM redemption_codes").first<any>()).status).toBe("unused");
  });
  it("enforces expiry before submit and deletes account/device/tasks/logs without reviving the code",async()=>{
    const batch=await createCodeBatch(e,preset) as any;const {row,token}=await start(batch.codes[0]);await processEnrollment(e,row.id,loggedIn());
    const account=await e.DB.prepare("SELECT * FROM accounts").first<any>();
    const [id]=await enqueue(e,[account.name],"submit");
    await e.DB.prepare("UPDATE accounts SET authorization_until=? WHERE name=?").bind(Date.now()-1,account.name).run();
    const run=vi.fn();await processJob(e,id,run);expect(run).not.toHaveBeenCalled();
    await cleanupExpiredAccounts(e);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM accounts").first<any>()).n).toBe(0);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM jobs").first<any>()).n).toBe(0);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM enrollment_attempts").first<any>()).n).toBe(0);
    expect((await e.DB.prepare("SELECT status FROM redemption_codes").first<any>()).status).toBe("used");
    await expect(enrollmentStatus(e,token)).rejects.toThrow("回执已失效");await expect(start(batch.codes[0])).rejects.toThrow("已使用");
  });
  it("rejects expired codes and requires a private status receipt and same-origin HTTPS",async()=>{
    const batch=await createCodeBatch(e,{...preset,redeemBefore:Date.now()+60_000}) as any;
    await e.DB.prepare("UPDATE redemption_batches SET redeem_before=? WHERE id=?").bind(Date.now()-1,batch.id).run();
    await expect(start(batch.codes[0])).rejects.toThrow("最晚兑换时间");
    await expect(enrollmentStatus(e,receipt())).rejects.toMatchObject({code:404});
    const path="/api/public/redemption/check";
    await expect(publicRedemption(new Request("https://manager.example"+path,{method:"POST",headers:{Origin:"https://other.example","Content-Type":"application/json"},body:JSON.stringify({code:batch.codes[0]})}),e,path)).rejects.toMatchObject({code:403});
  });
  it("never overwrites an account created while enrollment login is running",async()=>{
    const batch=await createCodeBatch(e,preset) as any;const {row,token}=await start(batch.codes[0]);
    const login=vi.fn(async()=>{await saveAccount(e,"admin-added",{schoolName:preset.schoolName,username:"student",password:"original-pass",deviceId:"unchanged-device",type:2},true);return {} as any;});
    await processEnrollment(e,row.id,login);
    expect((await enrollmentStatus(e,token) as any).status).toBe("failed");
    expect((await getAccount(e,"admin-added")).row.device_id).toBe("unchanged-device");
    expect((await e.DB.prepare("SELECT status FROM redemption_codes").first<any>()).status).toBe("unused");
  });
  it("expiry during execution cannot submit or recreate deleted personal data",async()=>{
    const batch=await createCodeBatch(e,preset) as any;const {row}=await start(batch.codes[0]);await processEnrollment(e,row.id,loggedIn());
    const account=await e.DB.prepare("SELECT name FROM accounts").first<any>();const [id]=await enqueue(e,[account.name],"submit");
    const run=vi.fn(async(_account,_device,_mode,options)=>{
      await e.DB.prepare("UPDATE accounts SET authorization_until=? WHERE name=?").bind(Date.now()-1,account.name).run();
      await cleanupExpiredAccounts(e);
      await expect(options.beforeSubmit({signInstanceWid:"task",signWid:"sign"})).rejects.toMatchObject({status:"expired"});
      return {status:"success",message:"stale result must not be stored"} as const;
    });
    await processJob(e,id,run);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM accounts").first<any>()).n).toBe(0);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM sign_log WHERE account=?").bind(account.name).first<any>()).n).toBe(0);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM jobs").first<any>()).n).toBe(0);
  });
  it("purges personal batch summaries while preserving unrelated account logs",async()=>{
    const batch=await createCodeBatch(e,preset) as any;const {row}=await start(batch.codes[0]);await processEnrollment(e,row.id,loggedIn());
    const account=await e.DB.prepare("SELECT name FROM accounts").first<any>();
    await saveAccount(e,"other",{schoolName:"另一学校",username:"other-user",password:"other-pass",deviceId:"other-device",type:2},true);
    const [id]=await enqueue(e,[account.name],"dry");const job=await e.DB.prepare("SELECT batch_id FROM jobs WHERE id=?").bind(id).first<any>();
    await e.DB.batch([
      e.DB.prepare("INSERT INTO sign_log(ts,account,kind,result,detail,batch_id) VALUES(1,?,'个人','ok','personal',?)").bind(account.name,job.batch_id),
      e.DB.prepare("INSERT INTO sign_log(ts,account,kind,result,detail,batch_id) VALUES(1,'other','个人','ok','unrelated',?)").bind(job.batch_id),
      e.DB.prepare("INSERT INTO sign_log(ts,kind,result,detail,batch_id) VALUES(1,'汇总','ok','personal summary',?)").bind(job.batch_id),
      e.DB.prepare("UPDATE batches SET summary='personal summary',detail='private detail' WHERE id=?").bind(job.batch_id),
      e.DB.prepare("UPDATE accounts SET authorization_until=? WHERE name=?").bind(Date.now()-1,account.name)
    ]);
    await cleanupExpiredAccounts(e);await cleanupExpiredAccounts(e);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM sign_log WHERE detail LIKE '%personal%'").first<any>()).n).toBe(0);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM sign_log WHERE detail='unrelated'").first<any>()).n).toBe(1);
    expect((await e.DB.prepare("SELECT detail FROM batches WHERE id=?").bind(job.batch_id).first<any>()).detail).toBeNull();
  });
  it("rollback on transaction failure cannot create a half-activated account",async()=>{
    const batch=await createCodeBatch(e,preset) as any;const {row}=await start(batch.codes[0]);
    await e.DB.exec("CREATE TRIGGER reject_code_use BEFORE UPDATE OF status ON redemption_codes WHEN NEW.status='used' BEGIN SELECT RAISE(ABORT,'simulated commit failure'); END;");
    await expect(processEnrollment(e,row.id,loggedIn())).rejects.toThrow();
    expect((await e.DB.prepare("SELECT count(*) AS n FROM accounts").first<any>()).n).toBe(0);
    const ready=await e.DB.prepare("SELECT status,device_id FROM enrollment_attempts WHERE id=?").bind(row.id).first<any>();expect(ready.status).toBe("ready");
    await e.DB.exec("DROP TRIGGER reject_code_use;");const login=loggedIn();await processEnrollment(e,row.id,login);expect(login).not.toHaveBeenCalled();
    expect((await e.DB.prepare("SELECT device_id FROM accounts").first<any>()).device_id).toBe(ready.device_id);
  });
});
