import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { des } from "../src/engine/crypto";
import { extractDeviceId, requireDeviceId, initializeDeviceId } from "../src/engine/device";
import { execute } from "../src/engine/sign";
import { saveAccount } from "../src/storage";
import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { Account, Env } from "../src/types";

const phone = "phone-original-id-123";
describe("fixed device ID lifecycle", () => {
  it("extracts the original ID from both original protocol headers and encodings", () => {
    const plain = JSON.stringify({ deviceId: phone, userId:"private-user",lon:123.45,lat:30.12 });
    for (const [kind,key] of [["info","ST83=@XV"],["ext","b3L26XNL"]] as const) {
      const encrypted = des(plain,key);
      expect(extractDeviceId(encrypted,kind,"base64")).toBe(phone);
      expect(extractDeviceId(Buffer.from(encrypted,"base64").toString("hex"),kind,"hex")).toBe(phone);
    }
  });
  it("never invents an ID for empty, invalid or wrong-header input", () => {
    expect(()=>requireDeviceId("")).toThrow("必须提供");
    expect(()=>extractDeviceId("not-a-header","info","base64")).toThrow();
    expect(()=>extractDeviceId(des('{"userId":"u"}',"ST83=@XV"),"info","base64")).toThrow("无法提取");
    expect(()=>extractDeviceId(des('{"deviceId":"id"}',"ST83=@XV"),"ext","base64")).toThrow("无法提取");
  });
  it("blocks every execution mode before login without a saved device ID", async () => {
    const loginFn=vi.fn();
    for(const mode of ["dry","submit","login","range"] as const) {
      const result=await execute({} as Account,"",mode,{loginFn});
      expect(result.status).toBe("fail");expect(result.message).toContain("deviceId");
    }
    expect(loginFn).not.toHaveBeenCalled();
  });
  it("creates a fixed ID before login when a new administrator account leaves it blank", async () => {
    const e=env as unknown as Env & {TEST_MIGRATIONS:any[]};
    await reset();await applyD1Migrations(e.DB,e.TEST_MIGRATIONS);
    const created=await saveAccount(e,"automatic",{schoolName:"test",username:"u",password:"p",type:2},true);
    expect(created.deviceId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const edited=await saveAccount(e,"automatic",{deviceId:"",address:"new"},false);expect(edited.deviceId).toBe(created.deviceId);
    const loginFn=vi.fn().mockResolvedValue({host:"https://school.campusphere.net/",session:{jar:{names:()=>["MOD_AUTH_CAS"]}}});
    expect((await execute({} as Account,created.deviceId as string,"login",{loginFn})).status).toBe("success");
    expect(loginFn).toHaveBeenCalledTimes(1);
    expect((await e.DB.prepare("SELECT device_id FROM accounts WHERE name='automatic'").first<any>()).device_id).toBe(created.deviceId);
  });
  it("prefers explicit or retained IDs and never replaces malformed saved data",()=>{
    expect(initializeDeviceId(" provided ","saved")).toBe("provided");expect(initializeDeviceId("",phone)).toBe(phone);
    expect(()=>initializeDeviceId("","")).toThrow("必须提供");expect(()=>initializeDeviceId("invalid id",phone)).toThrow("格式无效");
  });
});
