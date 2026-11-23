import {describe,expect,it,vi} from "vitest";
import {createPublicKey,publicEncrypt,constants} from "node:crypto";
import {Buffer} from "node:buffer";
import {execute} from "../src/engine/sign";
import {PROTOCOL_PRIVATE_KEY} from "../src/engine/constants";
import {EngineError,type Account} from "../src/types";
const account:Account={schoolName:"模拟学校",username:"student",password:"synthetic",type:2,lon:120,lat:30,address:"合成位置",abnormalReason:"",notifyKey:""};
const target={signInstanceWid:"target",signWid:"sign"};
const unsigned={unSignedTasks:[target],leaveTasks:[],signedTasks:[]};
function mock(responder:(url:string,body?:unknown)=>unknown){
  const json=vi.fn(async(url:string,body?:unknown)=>responder(url,body));
  const session={json,request:vi.fn().mockResolvedValue({status:200,text:"{}"}),jar:{get:()=>"synthetic-cookie",names:()=>["MOD_AUTH_CAS"]}} as any;
  return {json,loginFn:vi.fn().mockResolvedValue({session,host:"https://school.campusphere.net/",tenantId:"tenant",sessionToken:"synthetic-token"})};
}
function secret(){return {data:publicEncrypt({key:createPublicKey(PROTOCOL_PRIVATE_KEY),padding:constants.RSA_PKCS1_PADDING},Buffer.from("random|loginraw|9hriwfra")).toString("base64")};}
function beforeSubmit(){return Promise.resolve();}
describe("sign result evidence and bounded verification",()=>{
  it("does not turn a missing leaveTasks field into no_task",async()=>{
    const upstream=mock(()=>({datas:{unSignedTasks:[],signedTasks:[]}}));
    const result=await execute(account,"fixed-device","submit",{loginFn:upstream.loginFn,beforeSubmit});
    expect(result.status).toBe("error");expect(result.retryable).toBe(true);expect(result.message).toContain("列表");
  });
  it("does not accept an upstream failure envelope carrying empty task arrays",async()=>{
    const upstream=mock(()=>({code:500,success:false,message:"temporary",datas:{unSignedTasks:[],leaveTasks:[],signedTasks:[]}}));
    expect((await execute(account,"fixed-device","submit",{loginFn:upstream.loginFn,beforeSubmit})).status).toBe("error");
  });
  it("retains uncertain submission for later verification when both submit and confirmation time out",async()=>{
    let queried=0;
    const upstream=mock(url=>{
      if(url.includes("getStu")){if(++queried>1)throw new EngineError("read timeout","error",true,{stage:"request",kind:"timeout"});return{datas:unsigned};}
      if(url.includes("detailSign"))return{datas:{...target,isPhoto:0,isMalposition:0}};
      if(url.includes("getSecretKey"))return secret();
      throw new EngineError("submit timeout","error",true,{stage:"request",kind:"timeout"});
    });
    const result=await execute(account,"fixed-device","submit",{loginFn:upstream.loginFn,beforeSubmit,confirmDelayMs:0});
    expect(result).toMatchObject({status:"uncertain",retryable:true,retryAction:"verify"});
    expect(upstream.json.mock.calls.filter(([url])=>url.includes("submitSign"))).toHaveLength(1);
  });
  it.each(["尚未签到，请先签到","重复请求，请稍后再试","已签到失败，请重试"])("does not treat ambiguous text as signed: %s",async message=>{
    const upstream=mock(url=>url.includes("getStu")?{datas:unsigned}:url.includes("detailSign")?{datas:{...target,isPhoto:0,isMalposition:0}}:url.includes("getSecretKey")?secret():{message});
    const result=await execute(account,"fixed-device","submit",{loginFn:upstream.loginFn,beforeSubmit,confirmDelayMs:0});
    expect(["success","already"]).not.toContain(result.status);
  });
  it("keeps processing or failure text unresolved when the original target disappears",async()=>{
    let queried=0;
    const upstream=mock(url=>url.includes("getStu")?{datas:++queried===1?unsigned:{unSignedTasks:[],leaveTasks:[],signedTasks:[]}}:url.includes("detailSign")?{datas:{...target,isPhoto:0,isMalposition:0}}:url.includes("getSecretKey")?secret():{message:"正在处理，请稍后查看"});
    const result=await execute(account,"fixed-device","submit",{loginFn:upstream.loginFn,beforeSubmit,confirmDelayMs:0});
    expect(result).toMatchObject({status:"uncertain",submissionState:"unknown",retryAction:"verify"});
  });
  it.each([418,429])("stops immediately when submission is rate limited: %s",async httpStatus=>{
    const upstream=mock(url=>{
      if(url.includes("getStu"))return {datas:unsigned};
      if(url.includes("detailSign"))return {datas:{...target,isPhoto:0,isMalposition:0}};
      if(url.includes("getSecretKey"))return secret();
      throw new EngineError("上游限制访问","fail",false,{stage:"submit",kind:"http",httpStatus});
    });
    const result=await execute(account,"fixed-device","submit",{loginFn:upstream.loginFn,beforeSubmit,confirmDelayMs:0});
    expect(result).toMatchObject({status:"uncertain",retryable:false,submissionState:"unknown"});expect(upstream.json.mock.calls.filter(([url])=>url.includes("getStu"))).toHaveLength(1);
  });
  it("a previously discovered target cannot become generic no_task or another task's success",async()=>{
    const upstream=mock(()=>({datas:{unSignedTasks:[],leaveTasks:[],signedTasks:[{signInstanceWid:"other"}]}}));
    const result=await execute(account,"fixed-device","submit",{loginFn:upstream.loginFn,target,beforeSubmit});expect(result).toMatchObject({status:"error",retryable:true,retryAction:"execute"});
  });
  it("a verification-only attempt never submits and remains retryable if lookup times out",async()=>{
    const upstream=mock(()=>{throw new EngineError("timeout","error",true,{stage:"request",kind:"timeout"});});
    const result=await execute(account,"fixed-device","submit",{loginFn:upstream.loginFn,checkpoint:target,beforeSubmit,confirmDelayMs:0});
    expect(result).toMatchObject({status:"uncertain",retryable:true,retryAction:"verify"});
    expect(upstream.json.mock.calls.some(([url])=>url.includes("submitSign"))).toBe(false);
  });
});
