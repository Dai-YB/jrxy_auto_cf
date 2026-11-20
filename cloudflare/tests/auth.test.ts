import { beforeEach,describe,expect,it } from "vitest";
import { env } from "cloudflare:workers";
import { reset,applyD1Migrations,createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { authorize,signIn,signOut } from "../src/auth";
import { adminHeaders } from "./helpers";
import type { Env } from "../src/types";
const e=env as unknown as Env & {TEST_MIGRATIONS:any[]};
const origin="https://manager.example";
beforeEach(async()=>{await reset();await applyD1Migrations(e.DB,e.TEST_MIGRATIONS);});
function loginRequest(password=e.ADMIN_PASSWORD,username=e.ADMIN_USERNAME){return new Request(origin+"/api/auth/login",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({username,password})});}
describe("administrator password sessions",()=>{
  it("sets a secure HttpOnly cookie and stores only its digest",async()=>{
    const response=await signIn(loginRequest(),e);const cookie=response.headers.get("Set-Cookie")!;
    expect(cookie).toContain("__Host-jrxy_session=");expect(cookie).toContain("HttpOnly");expect(cookie).toContain("Secure");expect(cookie).toContain("SameSite=Strict");expect(cookie).not.toContain("Domain=");
    const row=await e.DB.prepare("SELECT * FROM admin_sessions").first<any>();
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(row)).not.toContain(e.ADMIN_PASSWORD);
    expect(JSON.stringify(row)).not.toContain(cookie.split(";")[0].split("=")[1]);
    const body=await response.json() as any;expect(body.csrfToken).toHaveLength(64);expect(body).not.toHaveProperty("password");
  });
  it("uses the same error for incorrect user or password and rate limits attempts",async()=>{
    await expect(signIn(loginRequest("wrong"),e)).rejects.toThrow("账号或密码错误");
    await expect(signIn(loginRequest(e.ADMIN_PASSWORD,"wrong"),e)).rejects.toThrow("账号或密码错误");
    for(let i=0;i<8;i++)await expect(signIn(loginRequest("wrong"),e)).rejects.toMatchObject({code:401});
    await expect(signIn(loginRequest(),e)).rejects.toMatchObject({code:429});
    expect((await e.DB.prepare("SELECT count(*) AS n FROM admin_sessions").first<any>()).n).toBe(0);
  });
  it("requires same origin and CSRF for mutations",async()=>{
    const headers=await adminHeaders(e);
    const good=new Request(origin+"/api/schedule",{method:"POST",headers});expect((await authorize(good,e)).username).toBe(e.ADMIN_USERNAME);
    await expect(authorize(new Request(origin+"/api/schedule",{method:"POST",headers:{...headers,"X-CSRF-Token":""}}),e)).rejects.toMatchObject({code:403});
    await expect(authorize(new Request(origin+"/api/schedule",{method:"POST",headers:{...headers,Origin:"https://other.example"}}),e)).rejects.toMatchObject({code:403});
    await expect(signIn(new Request(origin+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}),e)).rejects.toMatchObject({code:403});
  });
  it("expires, logs out, and invalidates sessions after credential rotation",async()=>{
    let headers=await adminHeaders(e);let request=new Request(origin+"/api/auth/session",{headers});
    await expect(authorize(request,{...e,ADMIN_PASSWORD:"changed-password-12345"})).rejects.toMatchObject({code:401});
    await e.DB.prepare("UPDATE admin_sessions SET expires_at=?").bind(Date.now()-1).run();
    await expect(authorize(request,e)).rejects.toMatchObject({code:401});
    headers=await adminHeaders(e);request=new Request(origin+"/api/auth/session",{headers});
    const response=await signOut(new Request(origin+"/api/auth/logout",{method:"POST",headers}),e);expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    await expect(authorize(request,e)).rejects.toMatchObject({code:401});
  });
  it("does not accept old WEB_TOKEN headers or missing secrets",async()=>{
    const response=await worker.fetch(new Request(origin+"/api/status",{headers:{"X-Web-Token":"old-secret-token"}}),e,createExecutionContext());expect(response.status).toBe(401);
    await expect(signIn(loginRequest(),{...e,ADMIN_PASSWORD:"short"})).rejects.toMatchObject({code:503});
  });
  it("uses a separate development cookie only for localhost HTTP",async()=>{
    const response=await signIn(new Request("http://127.0.0.1:8787/api/auth/login",{method:"POST",headers:{Origin:"http://127.0.0.1:8787","Content-Type":"application/json"},body:JSON.stringify({username:e.ADMIN_USERNAME,password:e.ADMIN_PASSWORD})}),e);
    expect(response.headers.get("Set-Cookie")).toContain("jrxy_dev_session=");
    await expect(signIn(new Request("http://manager.example/api/auth/login",{method:"POST"}),e)).rejects.toMatchObject({code:400});
  });
});
