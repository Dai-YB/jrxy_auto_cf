import {beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {reset,applyD1Migrations,createExecutionContext} from "cloudflare:test";
import {randomBytes} from "node:crypto";
import {createCodeBatch,listCodeBatches,copyCodes,revokeCodes,revokeCode,publicRedemption,processEnrollment,cleanupEnrollments,enrollmentStatus} from "../src/redemption";
import {getAccount} from "../src/storage";
import {cleanupExpiredAccounts} from "../src/expiry";
import {enqueue,processJob} from "../src/jobs";
import {unseal} from "../src/security";
import {adminHeaders} from "./helpers";
import worker from "../src/index";
import type {Env} from "../src/types";
const bindings=env as unknown as Env&{TEST_MIGRATIONS:any[]};let e:Env;
const preset={quantity:3,note:"合成批次",schoolName:"模拟学校",type:2,lon:120,lat:30,address:"合成位置"};
const key="SCT"+"syntheticKey0123456789";
beforeEach(async()=>{await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);e={...bindings,JRXY_INTERVAL:"0",JOBS:{send:vi.fn().mockResolvedValue(undefined)} as any};});
async function start(code:string,extra:Record<string,unknown>={}){
  const receipt=randomBytes(32).toString("base64url"),body={code,displayName:"合成姓名",username:"student",password:"synthetic-password",receipt,consent:true,...extra},path="/api/public/redemption/start";
  await publicRedemption(new Request("https://manager.example"+path,{method:"POST",headers:{Origin:"https://manager.example","Content-Type":"application/json"},body:JSON.stringify(body)}),e,path);
  const row=await e.DB.prepare("SELECT * FROM enrollment_attempts ORDER BY rowid DESC LIMIT 1").first<any>();return{row,receipt:body.receipt,body};
}
async function activate(code:string,extra:Record<string,unknown>={}){const started=await start(code,extra);await processEnrollment(e,started.row.id,vi.fn().mockResolvedValue({}));const row=await e.DB.prepare("SELECT * FROM accounts WHERE grant_code_id=?").bind(started.row.code_id).first<any>();return {...started,account:row};}
describe("authorization code management and opt-in notifications",()=>{
  it("defaults to 24 hours, stores recoverable codes encrypted and excludes plaintext from listings",async()=>{
    const batch=await createCodeBatch(e,preset) as any;expect(batch.durationSeconds).toBe(86400);
    const row=await e.DB.prepare("SELECT * FROM redemption_codes ORDER BY rowid LIMIT 1").first<any>();expect(row.code_cipher).toMatch(/^v1\./);expect(JSON.stringify(row)).not.toContain(batch.codes[0]);
    expect(await unseal(row.code_cipher,e.ENCRYPTION_KEY,`authorization-code:${row.id}`)).toBe(batch.codes[0]);
    const list=await listCodeBatches(e) as any;expect(list.batches[0].codes.every((code:any)=>code.copyable)).toBe(true);expect(JSON.stringify(list)).not.toContain(batch.codes[0]);expect(JSON.stringify(list)).not.toContain("v1.");
    const recovered=await copyCodes(e,batch.id,true) as any;expect(recovered.codes).toEqual(batch.codes);expect(recovered.text.split("\n")).toHaveLength(3);
    const opened=await activate(batch.codes[0]);expect(opened.account.authorization_until-opened.account.authorization_from).toBe(86400000);
    expect((await e.DB.prepare("SELECT code_cipher FROM redemption_codes WHERE id=?").bind(opened.row.code_id).first<any>()).code_cipher).toBeNull();
    await expect(copyCodes(e,opened.row.code_id)).rejects.toMatchObject({code:409});
  });
  it("pages exactly ten codes with stable cursors and does not invalidate older batches",async()=>{
    for(let i=0;i<3;i++)await createCodeBatch(e,{...preset,quantity:7});
    const pages:any[]=[];let cursor:string|null=null;
    do{const page=await listCodeBatches(e,cursor) as any;pages.push(page);cursor=page.nextCursor;}while(cursor);
    expect(pages.map(page=>page.batches.flatMap((batch:any)=>batch.codes).length)).toEqual([10,10,1]);
    const ids=pages.flatMap(page=>page.batches.flatMap((batch:any)=>batch.codes.map((code:any)=>code.id)));expect(new Set(ids).size).toBe(21);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM redemption_codes WHERE status='unused'").first<any>()).n).toBe(21);
    await expect(listCodeBatches(e,"bad")).rejects.toThrow("游标");
  });
  it("revokes an entire batch including reservations without touching used accounts",async()=>{
    const batch=await createCodeBatch(e,preset) as any,used=await activate(batch.codes[0]);
    const held=await start(batch.codes[1],{username:"other"});
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    const pending=processEnrollment(e,held.row.id,vi.fn(async()=>{entered.resolve();await release.promise;return{} as any;}));await entered.promise;
    expect(await revokeCodes(e,batch.id,true)).toEqual({revoked:2});release.resolve();await pending;
    expect((await getAccount(e,used.account.name)).row.name).toBe(used.account.name);
    const attempt=await e.DB.prepare("SELECT credentials,account_config,device_id,error_code FROM enrollment_attempts WHERE id=?").bind(held.row.id).first<any>();expect(attempt).toEqual({credentials:"",account_config:"",device_id:"",error_code:"revoked"});
    expect(await revokeCodes(e,batch.id,true)).toEqual({revoked:0});await expect(copyCodes(e,batch.id,true)).rejects.toMatchObject({code:409});
    expect((await e.DB.prepare("SELECT count(*) AS n FROM accounts").first<any>()).n).toBe(1);
  });
  it("legacy codes cannot be reconstructed and expired ciphertext is cleared",async()=>{
    const batch=await createCodeBatch(e,{...preset,redeemBefore:Date.now()+60000}) as any;
    const rows=(await e.DB.prepare("SELECT id FROM redemption_codes ORDER BY rowid").all<any>()).results;
    await e.DB.prepare("UPDATE redemption_codes SET code_cipher=NULL WHERE id=?").bind(rows[0].id).run();
    await expect(copyCodes(e,rows[0].id)).rejects.toThrow("旧版");
    await e.DB.prepare("UPDATE redemption_batches SET redeem_before=? WHERE id=?").bind(Date.now()-1,batch.id).run();
    await expect(copyCodes(e,batch.id,true)).rejects.toMatchObject({code:409});await cleanupEnrollments(e);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM redemption_codes WHERE code_cipher IS NOT NULL").first<any>()).n).toBe(0);
  });
  it("requires administrator and CSRF for copying or batch revocation",async()=>{
    const batch=await createCodeBatch(e,preset) as any,path=`/api/redemption/batches/${batch.id}/copy`,origin="https://manager.example";
    const request=(headers:Record<string,string>)=>new Request(origin+path,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json",...headers},body:"{}"});
    expect((await worker.fetch(request({}),e,createExecutionContext())).status).toBe(401);
    const headers=await adminHeaders(e);const missing={...headers};delete missing["X-CSRF-Token"];expect((await worker.fetch(request(missing),e,createExecutionContext())).status).toBe(403);
    const response=await worker.fetch(request(headers),e,createExecutionContext());expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json() as any).quantity).toBe(3);
  });
  it("keeps opt-in SendKey encrypted and sends only when a later sign job finishes",async()=>{
    const batch=await createCodeBatch(e,preset) as any;
    const before=await start(batch.codes[0],{notifyEnabled:true,sendKey:key,priority:100,notifyOption:{method:2,rcvOption:"https://evil.example"}});
    expect(before.row.credentials).not.toContain(key);
    const mock=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({code:0}));
    try{
      await processEnrollment(e,before.row.id,vi.fn().mockResolvedValue({}));expect(mock).not.toHaveBeenCalled();
      const row=await e.DB.prepare("SELECT * FROM accounts").first<any>(),stored=await getAccount(e,row.name);expect(stored.account.notifyOption).toEqual({method:2,rcvOption:key});expect(row.priority).toBe(0);expect(row.config).not.toContain(key);
      const status=await enrollmentStatus(e,before.receipt) as any;expect(status.notifyEnabled).toBe(true);expect(JSON.stringify(status)).not.toContain(key);
      const [id]=await enqueue(e,[row.name],"submit");await processJob(e,id,vi.fn().mockResolvedValue({status:"success",message:"ok"}));expect(mock).toHaveBeenCalledTimes(1);expect(String(mock.mock.calls[0][0])).toBe(`https://sctapi.ftqq.com/${key}.send`);
      expect(JSON.stringify(await e.DB.prepare("SELECT * FROM sign_log").all())).not.toContain(key);
      await e.DB.prepare("UPDATE accounts SET authorization_until=? WHERE name=?").bind(Date.now()-1,row.name).run();await cleanupExpiredAccounts(e);
      expect((await e.DB.prepare("SELECT count(*) AS n FROM accounts").first<any>()).n).toBe(0);expect((await e.DB.prepare("SELECT status FROM redemption_codes WHERE id=?").bind(before.row.code_id).first<any>()).status).toBe("used");
    }finally{mock.mockRestore();}
  });
  it("requires a valid SendKey only when enabled and includes it in idempotency",async()=>{
    const batch=await createCodeBatch(e,preset) as any;
    for(const sendKey of ["", "https://evil.example/path","SCTbad\nkey","sctp123tabc","SCT/invalid"]){await expect(start(batch.codes[0],{notifyEnabled:true,sendKey})).rejects.toThrow("SendKey");}
    const first=await start(batch.codes[0],{notifyEnabled:true,sendKey:key});
    await expect(start(batch.codes[0],{receipt:first.receipt,notifyEnabled:true,sendKey:key+"x"})).rejects.toThrow("当前操作已提交");
    await processEnrollment(e,first.row.id,vi.fn().mockRejectedValue(new Error("private")));
    expect((await e.DB.prepare("SELECT credentials FROM enrollment_attempts WHERE id=?").bind(first.row.id).first<any>()).credentials).toBe("");
    const disabled=await activate(batch.codes[1],{username:"disabled",notifyEnabled:false,sendKey:"https://ignored.example"});expect((await getAccount(e,disabled.account.name)).account.notifyOption).toEqual({method:0,rcvOption:""});
  });
});
