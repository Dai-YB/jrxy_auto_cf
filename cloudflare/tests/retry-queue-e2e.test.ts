import {beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {reset,applyD1Migrations,createMessageBatch,createExecutionContext,getQueueResult} from "cloudflare:test";
import {createPublicKey,publicEncrypt,constants} from "node:crypto";
import {Buffer} from "node:buffer";
import worker from "../src/index";
import {saveAccount} from "../src/storage";
import {enqueue,dispatch} from "../src/jobs";
import {tick} from "../src/scheduler";
import {updateExecution} from "../src/execution";
import {PROTOCOL_PRIVATE_KEY} from "../src/engine/constants";
import type {Env,Job} from "../src/types";
const bindings=env as unknown as Env&{TEST_MIGRATIONS:any[]};let e:Env,clock:number;
type Delivery={body:{id:string;deliveryToken?:string};due:number};let outbox:Delivery[];
beforeEach(async()=>{
  await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);clock=Date.now();outbox=[];
  e={...bindings,JRXY_INTERVAL:"0",RETRY_DELAY_SECONDS:"1",JOBS:{send:vi.fn(async(body,options)=>{outbox.push({body,due:clock+(options?.delaySeconds??0)*1000});})} as any};
});
async function users(names:string[]){for(const name of names)await saveAccount(e,name,{schoolName:"队列模拟学校",username:name,password:"synthetic-password",type:2,lon:120,lat:30,address:"合成位置",deviceId:"fixed-"+name,notifyMethod:2,notifyRcv:"SCTsynthetic"+name},true);}
async function schedule(){await e.DB.prepare("UPDATE schedule SET enabled=1,initialized=1,effective_after=0,time=?").bind(new Date(clock+8*3600000).toISOString().slice(11,16)).run();await tick(e,clock);}
async function consume(delivery:Delivery){
  const messageId=crypto.randomUUID(),batch=createMessageBatch("local",[{id:messageId,timestamp:clock,attempts:1,body:delivery.body}]);
  await worker.queue(batch,e);const result=await getQueueResult(batch,createExecutionContext());expect(result.explicitAcks).toContain(messageId);
}
async function drain(batchId?:string){
  for(let step=0;step<100;step++){
    const pending=await e.DB.prepare("SELECT count(*) AS n FROM jobs WHERE (status!='done' OR report_pending=1) AND (? IS NULL OR batch_id=?)").bind(batchId??null,batchId??null).first<number>("n");
    if(!pending)return;
    if(!outbox.length)await dispatch(e);
    if(!outbox.length){clock+=121000;await tick(e,clock);continue;}
    clock=Math.max(clock,Math.min(...outbox.map(item=>item.due)));
    const due=outbox.filter(item=>item.due<=clock);outbox=outbox.filter(item=>item.due>clock);
    await Promise.all(due.map(consume));
  }
  throw new Error("durable queue did not settle within the test budget");
}
type Scenario="retry"|"lost-signed"|"unsigned"|"unknown"|"throttle";
function upstream(scenario:Scenario,parallelism=1){
  const starts:string[]=[],submits:string[]=[],notifies:string[]=[],attempts=new Map<string,number>(),signed=new Set<string>();
  let submitted=false,active=0,peak=0,firstEntrants=0;
  const firstWave=Promise.withResolvers<void>();
  const transport=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
    const url=new URL(String(input)),headers=new Headers(init?.headers);
    if(url.hostname==="sctapi.ftqq.com"){notifies.push(url.pathname);return Response.json({code:0});}
    if(url.pathname==="/v6/config/guest/tenant/list")return Response.json({data:[{id:"mock",name:"队列模拟学校",joinType:"CLOUD"}]});
    if(url.pathname==="/v6/config/guest/tenant/info")return Response.json({data:[{joinType:"CLOUD",ampUrl:"https://mock.campusphere.net/portal"}]});
    if(url.pathname==="/portal")return new Response(null,{status:302,headers:{location:"https://login.example.edu/iap/login"}});
    if(url.pathname==="/iap/login")return new Response("IAP login");
    if(url.pathname==="/iap/security/lt")return Response.json({result:{_lt:"lt"}});
    if(url.pathname==="/iap/checkNeedCaptcha")return Response.json({needCaptcha:false});
    if(url.pathname==="/iap/doLogin"){
      const name=url.searchParams.get("username")!;starts.push(name);attempts.set(name,(attempts.get(name)??0)+1);
      active++;peak=Math.max(peak,active);if(++firstEntrants>=parallelism)firstWave.resolve();await firstWave.promise;active--;
      if(scenario==="retry"&&name==="c")return Response.json({resultCode:"FAIL_UPNOTMATCH"});
      return new Response(null,{status:302,headers:{location:"https://mock.campusphere.net/callback?user="+name}});
    }
    if(url.pathname==="/callback")return new Response("ok",{headers:{"set-cookie":"MOD_AUTH_CAS="+url.searchParams.get("user")+"; Path=/"}});
    const name=/MOD_AUTH_CAS=([^;]+)/.exec(headers.get("cookie")??"")?.[1];
    if(url.pathname.endsWith("getStuAttendacesInOneDay")){
      if(!name)throw new Error("missing isolated school session");
      if(scenario==="retry"&&name==="a"&&attempts.get(name)!<6)throw new TypeError("synthetic connection failure");
      if(scenario==="unknown"&&submitted)return Response.json({datas:{unSignedTasks:[],leaveTasks:[],signedTasks:[]}});
      if(scenario==="throttle")return new Response("blocked",{status:429});
      const task={signInstanceWid:"target-"+name,signWid:"sign-"+name};
      return Response.json({datas:{unSignedTasks:signed.has(name)?[]:[task],leaveTasks:[],signedTasks:signed.has(name)?[task]:[]}});
    }
    if(url.pathname.endsWith("detailSignInstance")){
      const task=JSON.parse(String(init?.body));if(!name||task.signInstanceWid!=="target-"+name)throw new Error("cross-account detail");
      return Response.json({datas:{...task,isPhoto:0,isNeedExtra:0,isMalposition:0}});
    }
    if(url.pathname.endsWith("getSecretKey/v-920"))return Response.json({data:publicEncrypt({key:createPublicKey(PROTOCOL_PRIVATE_KEY),padding:constants.RSA_PKCS1_PADDING},Buffer.from("random|loginraw|9hriwfra")).toString("base64")});
    if(url.pathname.endsWith("submitSign")){
      const body=JSON.parse(String(init?.body));if(!name||body.userId!==name||body.deviceId!=="fixed-"+name||!/[a-f0-9]{32}/.test(body.sign))throw new Error("cross-account submission");
      submits.push(name);submitted=true;
      if(scenario==="lost-signed")signed.add(name);
      if(["lost-signed","unsigned","unknown"].includes(scenario)&&submits.length===1)throw new TypeError("synthetic response lost");
      signed.add(name);return Response.json({code:0,message:"SUCCESS"});
    }
    throw new Error("unexpected synthetic route: "+url.pathname);
  });
  return {transport,starts,submits,notifies,attempts,peak:()=>peak};
}
describe("real queue consumer with isolated school protocol failures",()=>{
  it.each([1,2,3])("finishes the entire first round before five retries at concurrency %s",async parallelism=>{
    await users(["a","b","c"]);await updateExecution(e,{parallelism});const now=vi.spyOn(Date,"now").mockImplementation(()=>clock),mock=upstream("retry",parallelism);
    try{
      await schedule();await drain();
      expect(mock.starts.slice(0,3).sort()).toEqual(["a","b","c"]);expect(mock.attempts.get("a")).toBe(6);expect(mock.attempts.get("b")).toBe(1);expect(mock.attempts.get("c")).toBe(1);expect(mock.peak()).toBe(parallelism);
      expect(mock.submits.sort()).toEqual(["a","b"]);expect(mock.notifies).toHaveLength(3);
      const batch=await e.DB.prepare("SELECT round,concurrency_limit,fallback_reason,summary FROM batches").first<any>();expect(batch.round).toBe(6);expect(batch.concurrency_limit).toBe(1);expect(batch.summary).toContain("签到失败 1");
      if(parallelism>1)expect(batch.fallback_reason).toContain("串行");expect(await e.DB.prepare("SELECT parallelism FROM execution_settings").first("parallelism")).toBe(parallelism);
      const logs=await e.DB.prepare("SELECT detail FROM sign_log").all();expect(JSON.stringify(logs.results)).not.toContain("synthetic-password");
    }finally{now.mockRestore();mock.transport.mockRestore();}
  },15000);
  it.each([1,2,3])("never revisits first-round success after duplicate deliveries and Cron at concurrency %s",async parallelism=>{
    await users(["b","d","e"]);await updateExecution(e,{parallelism});const now=vi.spyOn(Date,"now").mockImplementation(()=>clock),mock=upstream("retry",parallelism);
    try{
      await schedule();const first=outbox.map(item=>({...item}));await drain();
      expect(mock.starts.sort()).toEqual(["b","d","e"]);expect(mock.submits.sort()).toEqual(["b","d","e"]);
      await Promise.all(first.flatMap(delivery=>[consume(delivery),consume(delivery)]));
      for(let n=0;n<6;n++){clock+=300000;await tick(e,clock);await dispatch(e);}
      expect(mock.starts).toHaveLength(3);expect(mock.submits).toHaveLength(3);expect(mock.notifies).toHaveLength(3);
      expect(await e.DB.prepare("SELECT count(*) FROM jobs WHERE status='done' AND attempts=1 AND report_pending=0").first("count(*)")).toBe(3);
      expect(await e.DB.prepare("SELECT round FROM batches").first("round")).toBe(1);
    }finally{now.mockRestore();mock.transport.mockRestore();}
  },15000);
  it("notification failure never converts a confirmed sign into a retry",async()=>{
    await users(["b"]);const now=vi.spyOn(Date,"now").mockImplementation(()=>clock),mock=upstream("retry");
    const original=mock.transport.getMockImplementation()!;mock.transport.mockImplementation(async(input,init)=>String(input).includes("sctapi.ftqq.com")?new Response("synthetic unavailable",{status:503}):original(input,init));
    try{
      await schedule();await drain();clock+=360000;await tick(e,clock);
      const job=await e.DB.prepare("SELECT * FROM jobs").first<Job>();expect(JSON.parse(job!.result!).status).toBe("success");expect(job).toMatchObject({status:"done",attempts:1,report_pending:0});expect(job!.notification_result).toContain("推送失败");expect(mock.submits).toEqual(["b"]);
    }finally{now.mockRestore();mock.transport.mockRestore();}
  });
  it.each(["lost-signed","unsigned","unknown"] as Scenario[])("preserves submission evidence after %s",async scenario=>{
    await users(["a"]);const now=vi.spyOn(Date,"now").mockImplementation(()=>clock),mock=upstream(scenario);
    try{
      await schedule();await drain();const job=await e.DB.prepare("SELECT * FROM jobs").first<Job>();
      expect(JSON.parse(job!.result!).status).toBe(scenario==="unknown"?"uncertain":"success");
      expect(mock.submits).toHaveLength(scenario==="unsigned"?2:1);expect(job!.attempts).toBe(scenario==="unknown"?6:scenario==="unsigned"?2:1);expect(mock.notifies).toHaveLength(1);
      expect(Boolean(job!.checkpoint)).toBe(scenario==="unknown");
      if(scenario==="unknown"){
        const [manual]=await enqueue(e,["a"],"submit");await drain();expect(mock.submits).toHaveLength(1);
        expect(JSON.parse((await e.DB.prepare("SELECT result FROM jobs WHERE id=?").bind(manual).first<string>("result"))!).status).toBe("uncertain");
        clock+=86400000;await tick(e,clock);await drain();expect(await e.DB.prepare("SELECT count(*) FROM batches WHERE trigger='schedule'").first("count(*)")).toBe(2);expect(mock.submits).toHaveLength(1);
      }
    }finally{now.mockRestore();mock.transport.mockRestore();}
  },15000);
  it("acknowledges a persisted school result even when follow-up dispatch fails",async()=>{
    await users(["a"]);const now=vi.spyOn(Date,"now").mockImplementation(()=>clock),mock=upstream("retry");
    try{
      const [id]=await enqueue(e,["a"],"dry");await dispatch(e);const delivery=outbox.shift()!,raw=e.DB;
      e={...e,DB:{prepare:(sql:string)=>{
        if(sql.startsWith("UPDATE execution_slots SET")&&sql.includes("WHERE owner IS NULL AND"))throw new Error("synthetic dispatch failure");
        return raw.prepare(sql);
      },batch:(statements:any[])=>raw.batch(statements)} as any};
      await consume(delivery);const completed=await raw.prepare("SELECT status,report_pending FROM jobs WHERE id=?").bind(id).first();expect(completed).toEqual({status:"done",report_pending:0});
      const starts=mock.starts.length;await consume(delivery);expect(mock.starts).toHaveLength(starts);
    }finally{now.mockRestore();mock.transport.mockRestore();}
  });
  it("does not retry school rate limits or classify them as success",async()=>{
    await users(["a"]);const now=vi.spyOn(Date,"now").mockImplementation(()=>clock),mock=upstream("throttle");
    try{await schedule();await drain();const job=await e.DB.prepare("SELECT * FROM jobs").first<Job>();expect(job!.attempts).toBe(1);expect(JSON.parse(job!.result!).status).not.toBe("success");expect(mock.submits).toHaveLength(0);}finally{now.mockRestore();mock.transport.mockRestore();}
  });
});
