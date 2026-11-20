import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { des } from "../src/engine/crypto";
import { extractDeviceId, requireDeviceId } from "../src/engine/device";
import { execute } from "../src/engine/sign";
import { saveAccount } from "../src/storage";
import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { Account, Env } from "../src/types";

const phone = "phone-original-id-123";
describe("real device ID required", () => {
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
  it("blocks every execution mode before login without the original device ID", async () => {
    const loginFn=vi.fn();
    for(const mode of ["dry","submit","login","range"] as const) {
      const result=await execute({} as Account,"",mode,{loginFn});
      expect(result.status).toBe("fail");expect(result.message).toContain("deviceId");
    }
    expect(loginFn).not.toHaveBeenCalled();
  });
  it("rejects creation without the device ID and does not create any account", async () => {
    const e=env as unknown as Env & {TEST_MIGRATIONS:any[]};
    await reset();await applyD1Migrations(e.DB,e.TEST_MIGRATIONS);
    await expect(saveAccount(e,"missing",{schoolName:"test",username:"u",password:"p",type:2},true)).rejects.toThrow("必须提供");
    expect((await e.DB.prepare("SELECT count(*) AS n FROM accounts").first<any>()).n).toBe(0);
  });
});
