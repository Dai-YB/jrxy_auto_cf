import {beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {reset,applyD1Migrations} from "cloudflare:test";
import fixture from "./fixtures/original-scheduler.json";
import {saveAccount} from "../src/storage";
import {enqueue,dispatch,processJob} from "../src/jobs";
import type {Env,Result} from "../src/types";
const bindings=env as unknown as Env&{TEST_MIGRATIONS:any[]};let e:Env;
beforeEach(async()=>{await reset();await applyD1Migrations(bindings.DB,bindings.TEST_MIGRATIONS);});
describe("original Python _fire round and delay parity",()=>{
  it.each(fixture.scenarios)("matches original serial trace: $name",async scenario=>{
    const start=Date.now();let clock=start;const deliveries:Array<{body:any;due:number}>=[],events:any[]=[],attempts:Record<string,number>={};
    e={...bindings,MAX_RETRIES:"5",RETRY_DELAY_MINUTES:"5",RETRY_DELAY_SECONDS:undefined,JRXY_INTERVAL:"10",JOBS:{send:vi.fn(async(body,options)=>{deliveries.push({body,due:clock+(options?.delaySeconds??0)*1000});})} as any};
    for(const name of Object.keys(scenario.outcomes))await saveAccount(e,name,{schoolName:"原调度模拟",username:name,password:"synthetic",type:2},true);
    const now=vi.spyOn(Date,"now").mockImplementation(()=>clock);
    try{
      await enqueue(e,Object.keys(scenario.outcomes),"submit","定时");await e.DB.prepare("UPDATE jobs SET trigger='schedule',max_attempts=6").run();await e.DB.prepare("UPDATE batches SET trigger='schedule'").run();
      for(let step=0;step<50;step++){
        const before=await e.DB.prepare("SELECT * FROM batches").first<any>();if(before.finished_at)break;
        if(!deliveries.length)await dispatch(e);
        if(!deliveries.length){clock=Math.max(clock,before.round_due);await dispatch(e);}
        expect(deliveries.length).toBe(1);const next=deliveries.shift()!;clock=Math.max(clock,next.due);
        await processJob(e,next.body.id,async account=>{
          const name=account.username,n=attempts[name]=(attempts[name]??0)+1;events.push({kind:"run",account:name,attempt:n,at:(clock-start)/1000});
          const outcomes=(scenario.outcomes as Record<string,string[]>)[name],label=outcomes[Math.min(n-1,outcomes.length-1)];
          const status:Result["status"]=label==="执行异常"?"error":label==="签到成功"?"success":label==="今日已签到"?"already":label==="暂无待签任务"?"no_task":"fail";
          return {status,message:label,retryable:status==="error"};
        },next.body.deliveryToken);
        const after=await e.DB.prepare("SELECT * FROM batches").first<any>();
        if(after.round>before.round)events.push({kind:"wait",at:(clock-start)/1000,due:(after.round_due-start)/1000});
      }
      expect(events).toEqual(scenario.events);expect(attempts).toEqual(scenario.attempts);
      expect(await e.DB.prepare("SELECT summary FROM batches").first("summary")).toBe(scenario.summary);
      expect(fixture.originalDefaultRetries).toBe(2);expect(fixture.requestedRetries).toBe(5);
    }finally{now.mockRestore();}
  },15000);
});
