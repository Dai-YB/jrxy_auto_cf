import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { reset, applyD1Migrations, createExecutionContext, waitOnExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { createPublicKey, publicEncrypt, constants } from "node:crypto";
import { Buffer } from "node:buffer";
import worker from "../src/index";
import { PROTOCOL_PRIVATE_KEY } from "../src/engine/constants";
import type { Env } from "../src/types";
import { adminHeaders } from "./helpers";
let authHeaders: Record<string,string>;

const bindings = env as unknown as Env & {TEST_MIGRATIONS: any[]};
let e: Env;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  e = {...bindings, JOBS:{send:vi.fn().mockResolvedValue(undefined)} as any};
  authHeaders=await adminHeaders(e);
});
async function api(path: string, method = "GET", data?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://manager.example"+path, {
    method, headers:authHeaders, body:data === undefined ? undefined : JSON.stringify(data)
  }),e,ctx);
  await waitOnExecutionContext(ctx);
  return {status:response.status,body:await response.json() as any};
}
function upstream(captcha = false) {
  const task={signInstanceWid:"task-1",signWid:"sign-1",isPhoto:0,isNeedExtra:0,isMalposition:0};
  let submitted=false;
  return vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
    const url=new URL(String(input));
    if(url.pathname==="/v6/config/guest/tenant/list")return Response.json({data:[{id:"mock",name:"端到端模拟学校",joinType:"CLOUD"}]});
    if(url.pathname==="/v6/config/guest/tenant/info")return Response.json({data:[{joinType:"CLOUD",ampUrl:"https://mock.campusphere.net/portal"}]});
    if(url.pathname==="/portal")return new Response(null,{status:302,headers:{location:"https://login.example.edu/iap/login"}});
    if(url.pathname==="/iap/login")return new Response("IAP login");
    if(url.pathname==="/iap/security/lt")return Response.json({result:{_lt:"lt"}});
    if(url.pathname==="/iap/checkNeedCaptcha")return Response.json({needCaptcha:captcha});
    if(url.pathname==="/iap/doLogin")return new Response(null,{status:302,headers:{location:"https://mock.campusphere.net/callback"}});
    if(url.pathname==="/callback")return new Response("ok",{headers:{"set-cookie":"MOD_AUTH_CAS=mock-cookie; Path=/"}});
    if(url.pathname.endsWith("getStuAttendacesInOneDay"))return Response.json({datas:{unSignedTasks:submitted?[]:[task],signedTasks:submitted?[task]:[],leaveTasks:[]}});
    if(url.pathname.endsWith("detailSignInstance"))return Response.json({datas:task});
    if(url.pathname.endsWith("getSecretKey/v-920"))return Response.json({data:publicEncrypt({key:createPublicKey(PROTOCOL_PRIVATE_KEY),padding:constants.RSA_PKCS1_PADDING},Buffer.from("random|loginraw|9hriwfra")).toString("base64")});
    if(url.pathname.endsWith("submitSign")) {
      const body=JSON.parse(String(init?.body));
      expect(body.deviceId).toBe("original-device");expect(body.version).toBe("first_v4");expect(body.sign).toMatch(/^[a-f0-9]{32}$/);
      submitted=true;return Response.json({message:"SUCCESS"});
    }
    if(url.hostname==="sctapi.ftqq.com")return Response.json({code:0});
    throw new Error("unexpected mock upstream: "+url.pathname);
  });
}
async function runQueue(id:string) {
  const batch=createMessageBatch("jrxy-auto-cf-jobs",[{id:"message-"+id,timestamp:Date.now(),attempts:1,body:{id}}]);
  await worker.queue(batch,e);
  const result=await getQueueResult(batch,createExecutionContext());
  expect(result.explicitAcks).toContain("message-"+id);
}
const account={name:"e2e",schoolName:"端到端模拟学校",username:"mock-student",password:"mock-pass",type:2,
  lon:120,lat:30,address:"合成测试位置",deviceId:"original-device",notifyMethod:2,notifyRcv:"SCTmockonly"};

describe("API → Queue → original protocol → log and notification",()=>{
  it.each(["dry","submit"])("completes %s without any real outbound traffic",async(mode)=>{
    const transport=upstream();
    try {
      const created=await api("/api/accounts","POST",account);expect(created.status).toBe(201);
      expect(created.body.account).not.toHaveProperty("password");
      const admitted=await api("/api/accounts/e2e/run","POST",{mode});expect(admitted.status).toBe(202);
      const id=admitted.body.ids[0];expect(e.JOBS.send).toHaveBeenCalledWith({id});
      await runQueue(id);
      const polled=await api("/api/jobs?ids="+encodeURIComponent(id));
      expect(polled.body.jobs[0].status).toBe("done");expect(polled.body.jobs[0].result.status).toBe(mode==="dry"?"dry":"success");
      const logs=await api("/api/logs");
      expect(logs.body.logs.some((log:any)=>log.kind.includes(mode==="dry"?"手动探测":"手动签到"))).toBe(true);
      expect(JSON.stringify(logs.body)).not.toContain(account.password);expect(JSON.stringify(logs.body)).not.toContain("mock-cookie");
      const submitted=transport.mock.calls.filter(([url])=>String(url).includes("/submitSign"));
      const notifications=transport.mock.calls.filter(([url])=>String(url).includes("sctapi.ftqq.com"));
      expect(submitted).toHaveLength(mode==="dry"?0:1);expect(notifications).toHaveLength(mode==="dry"?0:1);
      await runQueue(id);expect(transport.mock.calls.filter(([url])=>String(url).includes("/submitSign"))).toHaveLength(mode==="dry"?0:1);
    } finally {transport.mockRestore();}
  });
  it("records and notifies CAPTCHA without running OCR or submitting",async()=>{
    const transport=upstream(true);
    try{
      await api("/api/accounts","POST",account);
      const admitted=await api("/api/accounts/e2e/run","POST",{mode:"submit"});
      await runQueue(admitted.body.ids[0]);
      const jobs=await api("/api/jobs?ids="+encodeURIComponent(admitted.body.ids[0]));
      expect(jobs.body.jobs[0].result.status).toBe("captcha");
      expect(transport.mock.calls.some(([url])=>String(url).includes("submitSign"))).toBe(false);
      expect(transport.mock.calls.some(([url])=>String(url).includes("generateCaptcha"))).toBe(false);
      const call=transport.mock.calls.find(([url])=>String(url).includes("sctapi.ftqq.com"));expect(call).toBeDefined();
      expect(new URLSearchParams(String(call![1]?.body)).get("title")).toContain("需要人工验证");
    }finally{transport.mockRestore();}
  });
});
