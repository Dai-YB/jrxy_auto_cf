import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import worker from "../src/index";
import { buildAccount, saveAccount, getAccount, listAccounts, deleteAccount } from "../src/storage";
import { enqueue, dispatch, processJob } from "../src/jobs";
import { tick, dueSlot, todaySlot, updateSchedule } from "../src/scheduler";
import { seal, unseal, redact } from "../src/security";
import { authorize } from "../src/auth";
import { adminHeaders } from "./helpers";
import type { Env, Schedule } from "../src/types";

const bindings = env as unknown as Env & { TEST_MIGRATIONS: any[] };
let testEnv: Env;
const user = { schoolName: "测试大学", username: "20260001", password: "secret-password-123", type: 2,
  lon: 116.123, lat: 39.456, address: "本人实际位置", deviceId: "fixed-device-id" };
beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  testEnv = { ...bindings, JOBS: { send: vi.fn().mockResolvedValue(undefined) } as any };
});

describe("storage and access", () => {
  it("encrypts accounts and never returns stored secrets", async () => {
    const created = await saveAccount(testEnv, "alice", { ...user, notifyKey: "SCTtestkey" }, true);
    expect(created).not.toHaveProperty("password"); expect(created).not.toHaveProperty("notifyKey");
    const raw = await bindings.DB.prepare("SELECT config FROM accounts").first<{config:string}>();
    expect(raw!.config).not.toContain(user.password); expect(raw!.config).not.toContain(user.username);
    expect((await getAccount(testEnv, "alice")).account.password).toBe(user.password);
    expect((await listAccounts(testEnv))[0].notify_set).toBe(true);
    await saveAccount(testEnv, "alice", { address: "新地址", password: "" }, false);
    expect((await getAccount(testEnv, "alice")).account.password).toBe(user.password);
  });
  it("protects fixed device binding, rejects unsupported task types and invalid coordinates", async () => {
    for (const type of [0,3,4]) expect(() => buildAccount({ ...user, type })).toThrow("仅支持");
    expect(() => buildAccount({ ...user, lon: "NaN" })).toThrow();
    expect(() => buildAccount({ ...user, lon: true })).toThrow();
    await saveAccount(testEnv, "alice", user, true);
    await saveAccount(testEnv, "alice", { deviceId: "corrected-real-device", username: "another" }, false);
    expect((await getAccount(testEnv,"alice")).row.device_id).toBe("corrected-real-device");
    await saveAccount(testEnv, "alice", { deviceId: user.deviceId, username: user.username }, false);
    await deleteAccount(testEnv, "alice");
    expect(await listAccounts(testEnv)).toEqual([]);
    const raw = await bindings.DB.prepare("SELECT config,device_id FROM accounts").first<any>();
    expect(raw.config).toBe(""); expect(raw.device_id).toBe(user.deviceId);
    const restored = await saveAccount(testEnv, "alice", { ...user, deviceId: "" }, true);
    expect(restored.deviceId).toBe(user.deviceId);
  });
  it("fails closed without secrets, rejects unauthorized and cross-origin requests", async () => {
    const ctx = createExecutionContext();
    expect((await worker.fetch(new Request("https://example.com/api/status"), testEnv, ctx)).status).toBe(401);
    expect((await worker.fetch(new Request("https://example.com/api/status"), { ...testEnv, ADMIN_PASSWORD: "" }, ctx)).status).toBe(503);
    const headers=await adminHeaders(testEnv,"https://example.com");
    await expect(authorize(new Request("https://example.com/api/status", { headers: {...headers,Origin:"https://evil.example"} }), testEnv)).rejects.toThrow("跨站");
    const status = await worker.fetch(new Request("https://example.com/api/status", { headers }), testEnv, ctx);
    expect(status.status).toBe(200); expect((await status.json() as any).scheduler.enabled).toBe(false);
  });
  it("binds ciphertext to account identity and rejects tampering", async () => {
    const cipher = await seal({ password: "private" }, testEnv.ENCRYPTION_KEY, "account:a");
    expect(await unseal(cipher, testEnv.ENCRYPTION_KEY, "account:a")).toEqual({ password: "private" });
    await expect(unseal(cipher, testEnv.ENCRYPTION_KEY, "account:b")).rejects.toThrow("解密失败");
    expect(redact("password=hello sessionToken=abc https://example.com/?secret=bad", ["hello"])).not.toContain("abc");
  });
});

describe("durable queue", () => {
  it("ignores duplicate deliveries and prevents edits while pending", async () => {
    await saveAccount(testEnv, "alice", user, true);
    const [id] = await enqueue(testEnv, ["alice"], "dry");
    await expect(enqueue(testEnv, ["alice"], "dry")).rejects.toThrow("已有待执行");
    await expect(saveAccount(testEnv, "alice", { address: "edited" }, false)).rejects.toThrow("待执行");
    const run = vi.fn().mockResolvedValue({ status: "dry", message: "检查通过" });
    await Promise.all([processJob(testEnv, id, run), processJob(testEnv, id, run)]);
    await processJob(testEnv, id, run);
    expect(run).toHaveBeenCalledTimes(1);
    const job = await bindings.DB.prepare("SELECT status,attempts FROM jobs WHERE id=?").bind(id).first<any>();
    expect(job).toEqual({ status: "done", attempts: 1 });
  });
  it("recovers expired leases with submission checkpoints intact", async () => {
    await saveAccount(testEnv, "alice", user, true);
    const [id] = await enqueue(testEnv, ["alice"], "submit");
    const checkpoint = { signInstanceWid: "task-123", signWid: "sign-123" };
    await bindings.DB.prepare("UPDATE jobs SET status='running',lease_until=?,checkpoint=?,attempts=1 WHERE id=?")
      .bind(Date.now()-1000, JSON.stringify(checkpoint), id).run();
    await dispatch(testEnv);
    expect(testEnv.JOBS.send).toHaveBeenCalledWith({id});
    const run = vi.fn().mockResolvedValue({ status: "uncertain", message: "需人工核实" });
    await processJob(testEnv, id, run);
    expect(run.mock.calls[0][3].checkpoint).toEqual(checkpoint);
  });
  it("retries only temporary errors for scheduled jobs", async () => {
    await saveAccount(testEnv, "alice", user, true);
    const [id] = await enqueue(testEnv, ["alice"], "submit");
    await bindings.DB.prepare("UPDATE jobs SET trigger='schedule',max_attempts=3 WHERE id=?").bind(id).run();
    const run = vi.fn().mockResolvedValue({ status: "error", message: "暂时网络错误", retryable: true });
    await processJob(testEnv, id, run);
    const pending = await bindings.DB.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first<any>();
    expect(pending.status).toBe("pending"); expect(pending.attempts).toBe(1);
    expect(pending.next_at).toBeGreaterThan(Date.now());
    await bindings.DB.prepare("UPDATE jobs SET next_at=? WHERE id=?").bind(Date.now()-1,id).run();
    await bindings.DB.prepare("UPDATE batches SET round_due=? WHERE id=(SELECT batch_id FROM jobs WHERE id=?)").bind(Date.now()-1,id).run();
    run.mockResolvedValue({ status: "captcha", message: "需要验证码" });
    await processJob(testEnv, id, run);
    expect((await bindings.DB.prepare("SELECT status FROM jobs WHERE id=?").bind(id).first<any>()).status).toBe("done");
  });
  it("applies the queried range and preserves notifications and proxy config", async()=>{
    await saveAccount(testEnv,"alice",{...user,notifyMethod:2,notifyRcv:"https://notify.example.com/hook",httpProxy:"http://proxy.example.com:8080"},true);
    const [id]=await enqueue(testEnv,["alice"],"range");
    await processJob(testEnv,id,vi.fn().mockResolvedValue({status:"success",message:"范围",data:{lon:120,lat:30,address:"范围中心",radius:300}}));
    const {account}=await getAccount(testEnv,"alice");
    expect(account.lon).toBe(120);expect(account.lat).toBe(30);expect(account.address).toBe("范围中心");
    expect(account.notifyOption?.rcvOption).toBe("https://notify.example.com/hook");
    expect(account.httpProxy).toBe("http://proxy.example.com:8080");
  });
  it("keeps original notification timing for dry/manual/final retry",async()=>{
    await saveAccount(testEnv,"alice",{...user,notifyMethod:2,notifyRcv:"SCTexample"},true);
    const transport=vi.spyOn(globalThis,"fetch").mockImplementation(async()=>new Response('{"code":0}'));
    try{
      const run=vi.fn().mockResolvedValue({status:"dry",message:"通过"});
      let [id]=await enqueue(testEnv,["alice"],"dry");await processJob(testEnv,id,run);expect(transport).not.toHaveBeenCalled();
      [id]=await enqueue(testEnv,["alice"],"dry");await processJob({...testEnv,NOTIFY_ON_DRY:"1"},id,run);expect(transport).toHaveBeenCalledTimes(1);
      transport.mockClear();
      [id]=await enqueue(testEnv,["alice"],"submit");
      await bindings.DB.prepare("UPDATE jobs SET trigger='schedule',trigger_label='定时',max_attempts=2 WHERE id=?").bind(id).run();
      run.mockResolvedValue({status:"error",message:"暂时连接失败",retryable:true});
      await processJob(testEnv,id,run);expect(transport).not.toHaveBeenCalled();
      await bindings.DB.prepare("UPDATE jobs SET next_at=? WHERE id=?").bind(Date.now()-1,id).run();
    await bindings.DB.prepare("UPDATE batches SET round_due=? WHERE id=(SELECT batch_id FROM jobs WHERE id=?)").bind(Date.now()-1,id).run();
      await processJob(testEnv,id,run);expect(transport).toHaveBeenCalledTimes(1);
      const body=new URLSearchParams(String(transport.mock.calls[0][1]?.body));
      expect(body.get("desp")).toContain("定时重试1签到");
    }finally{transport.mockRestore();}
  });
  it("safely acknowledges malformed queue messages", async () => {
    const batch = createMessageBatch("jrxy-auto-cf-jobs", [{ id: "message", timestamp: Date.now(), attempts: 1, body: { id: 42 } }]);
    await worker.queue(batch as any, testEnv);
    const result = await getQueueResult(batch, createExecutionContext());
    expect(result.explicitAcks).toContain("message");
  });
});

describe("mandatory daily schedule", () => {
  it("computes UTC+8 slots and catches up across midnight", () => {
    const now = Date.parse("2026-11-11T16:10:00Z"); // 次日北京时间00:10
    const s = { enabled:1, time:"23:55", effective_after:0 } as Schedule;
    expect(dueSlot(s,now,120)).toBe(Date.parse("2026-11-11T15:55:00Z"));
    expect(todaySlot("22:05", Date.parse("2026-11-10T01:00:00Z"))).toBe(Date.parse("2026-11-10T14:05:00Z"));
    expect(dueSlot({ ...s, enabled:0 },now,120)).toBeNull();
    expect(dueSlot({ ...s, effective_after:now },now,120)).toBeNull();
    expect(dueSlot(s,now,5)).toBeNull();
  });
  it("creates each daily job once even when cron overlaps", async () => {
    await saveAccount(testEnv, "alice", user, true);
    await saveAccount(testEnv, "bob", { ...user, username: "20260002", deviceId: "device-b" }, true);
    const now = Date.now(); const beijing = new Date(now+8*3600_000).toISOString().slice(11,16);
    await bindings.DB.prepare("UPDATE schedule SET enabled=1,time=?,effective_after=0,initialized=1").bind(beijing).run();
    await Promise.all([tick(testEnv,now),tick(testEnv,now)]); await tick(testEnv,now+30_000);
    const rows = await bindings.DB.prepare("SELECT * FROM jobs").all<any>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every(j => j.trigger === "schedule")).toBe(true);
    expect(rows.results[1].sequence_no - rows.results[0].sequence_no).toBe(1);
    expect(testEnv.JOBS.send).toHaveBeenCalledTimes(1);
  });
  it("saving never immediately catches up and disabling preserves an already-created batch", async () => {
    await saveAccount(testEnv, "alice", user, true);
    const now=Date.now();
    await updateSchedule(testEnv, { enabled:true, time:"00:00" });
    await tick(testEnv,now);
    expect((await bindings.DB.prepare("SELECT count(*) AS n FROM jobs").first<any>()).n).toBe(0);
    const [id]=await enqueue(testEnv,["alice"],"submit");
    await bindings.DB.prepare("UPDATE jobs SET trigger='schedule' WHERE id=?").bind(id).run();
    await updateSchedule(testEnv,{enabled:false,time:"00:00"});
    expect((await bindings.DB.prepare("SELECT status FROM jobs WHERE id=?").bind(id).first<any>()).status).toBe("pending");
  });
});
