import { describe, expect, it, vi } from "vitest";
import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import { Buffer } from "node:buffer";
import { Session, CookieJar, publicUrl } from "../src/engine/http";
import { aes, des, interleave, signedBody, pythonStr, fetchSecret } from "../src/engine/crypto";
import { PROTOCOL_PRIVATE_KEY } from "../src/engine/constants";
import { parseForm } from "../src/engine/login";
import { buildForm, execute, selectTask } from "../src/engine/sign";
import type { Account } from "../src/types";

const user: Account = { schoolName:"测试大学",username:"u",password:"p",type:2,lon:116.123,lat:39.456,address:"实际位置",abnormalReason:"",notifyKey:"" };
const task = { signInstanceWid:"instance",signWid:"sign",isPhoto:0,isNeedExtra:0,isMalposition:0 };
function fakeLogin(responder: (url:string,body?:any)=>any) {
  const json = vi.fn().mockImplementation(async (url,body) => responder(url,body));
  const session = { json, request:vi.fn().mockResolvedValue({status:200,text:"{}"}), jar:{ get:()=>"auth-cookie",names:()=>["MOD_AUTH_CAS"] } } as any;
  return { json, fn: vi.fn().mockResolvedValue({ session,host:"https://school.campusphere.net/",tenantId:"school",sessionToken:"token" }) };
}
function secretResponse() {
  return { data:publicEncrypt({key:createPublicKey(PROTOCOL_PRIVATE_KEY),padding:constants.RSA_PKCS1_PADDING},Buffer.from("random|loginraw|9hriwfra")).toString("base64") };
}

describe("HTTP isolation", () => {
  it("scopes cookies to origin and path, expires deleted cookies", () => {
    const jar = new CookieJar(); const url = new URL("https://cas.example.edu/auth/login");
    jar.set("session=abc; Path=/auth; Secure",url);
    jar.set("danger=x; Domain=edu; Path=/",url);
    expect(jar.header(new URL("https://cas.example.edu/auth/test"))).toBe("session=abc");
    expect(jar.header(new URL("https://cas.example.edu/authenticate"))).toBe("");
    expect(jar.header(new URL("https://other.example.edu/auth/test"))).toBe("");
    jar.set("session=gone; Path=/auth; Max-Age=0",url);
    expect(jar.header(url)).toBe("");
  });
  it("does not leak cookies or POST credentials across redirects", async () => {
    const calls: any[]=[];
    const transport = vi.fn(async (url,init) => {
      calls.push({url,init});
      return calls.length===1 ? new Response(null,{status:302,headers:{Location:"https://other.example.edu/welcome","Set-Cookie":"sid=secret; Path=/"}}) : new Response("ok");
    });
    await new Session(transport as any).request("https://cas.example.edu/login",{method:"POST",body:"password=secret"});
    expect(calls[1].init.method).toBe("GET");expect(calls[1].init.body).toBeUndefined();
    expect(calls[1].init.headers.has("cookie")).toBe(false);
    const cross = new Session(vi.fn(async()=>new Response(null,{status:307,headers:{Location:"https://other.example.edu/"}})) as any);
    await expect(cross.request("https://cas.example.edu/login",{method:"POST",body:"secret"})).rejects.toThrow("拒绝");
  });
  it("blocks private/IP/non-HTTPS targets and limits redirects", async () => {
    for(const url of ["http://example.com","https://127.0.0.1","https://[::1]","https://localhost","https://host.internal","https://name:pass@example.com"]) expect(()=>publicUrl(url)).toThrow();
    const s = new Session(vi.fn(async()=>new Response(null,{status:302,headers:{Location:"/loop"}})) as any);
    await expect(s.request("https://cas.example.edu/")).rejects.toThrow("次数过多");
  });
});

describe("protocol and HTML", () => {
  it("parses scoped forms with HTMLRewriter and decodes entities", async () => {
    const result = await parseForm(`<input name="unrelated" value="bad"><form id="pwdFromId"><input name="execution" value="a&amp;b"><input id="pwdEncryptSalt" value="1234567890123456"><input name="username"></form>`);
    expect(result.form).toBe("pwdFromId");
    expect(result.inputs.find(i=>i.name==="execution")?.value).toBe("a&b");
    expect(result.inputs.some(i=>i.name==="unrelated")).toBe(false);
    await expect(parseForm("<html>unknown</html>")).rejects.toThrow("未识别");
  });
  it("derives keys and preserves Python boolean signature representation", async () => {
    expect(interleave("h8r7uN8t9hriwfra")).toBe("hru89rwr87Nthifa");
    expect(pythonStr(true)).toBe("True");
    expect(pythonStr(false)).toBe("False");
    // 独立 OpenSSL AES-128-CBC / DES-CBC 的固定输入测试向量。
    expect(aes("hello","1234567890123456")).toBe("x/ZCFBORa5sAxIJm39opjg==");
    expect(des("hello")).toBe("GLSw7YZiPE4=");
    const s = {json:vi.fn().mockResolvedValue(secretResponse())} as any;
    expect(await fetchSecret(s,"tenant","device")).toBe("hru89rwr87Nthifa");
    expect(signedBody({x:true,y:"中文"},"1234567890123456").sign).toHaveLength(32);
  });
});

describe("only attendance and sign", () => {
  it("rejects photos but preserves configured extra forms and title checks", () => {
    expect(()=>buildForm(user,{...task,isPhoto:1})).toThrow("照片");
    expect(()=>buildForm(user,{...task,isNeedExtra:1})).toThrow("forms");
    expect(()=>buildForm({...user,lon:null},task)).toThrow("位置");
    const detail={...task,isNeedExtra:1,extraField:[{title:"状态",extraFieldItems:[{content:"正常",wid:"option1",isOtherItems:0}]}]};
    const account={...user,checkTitle:1,forms:[{form:{title:"状态",value:"正常"}}]};
    expect(buildForm(account,detail).extraFieldItems).toEqual([{extraFieldItemValue:"正常",extraFieldItemWid:"option1"}]);
    expect(()=>buildForm({...account,forms:[{form:{title:"错误标题",value:"正常"}}]},detail)).toThrow("标题不匹配");
    expect(pythonStr([{extraFieldItemValue:"正常",extraFieldItemWid:"option1"}])).toBe("[{'extraFieldItemValue': '正常', 'extraFieldItemWid': 'option1'}]");
  });
  it("preserves leave fallback and last matching title selection",()=>{
    const leave={...task,taskName:"请假"};
    expect(selectTask({unSignedTasks:[],leaveTasks:[leave]},user,"submit")).toBe(leave);
    const first={...task,taskName:"晚间查寝1"};const last={...task,taskName:"晚间查寝2"};
    expect(selectTask({unSignedTasks:[first,last],leaveTasks:[]},{...user,formTitle:"晚间"},"dry")).toBe(last);
  });
  it("login test does not request tasks",async()=>{
    const fake=fakeLogin(()=>{throw new Error("must not query");});
    const result=await execute(user,"device","login",{loginFn:fake.fn});
    expect(result.status).toBe("success");expect(result.data?.cookies).toEqual(["MOD_AUTH_CAS"]);expect(fake.json).not.toHaveBeenCalled();
  });
  it("dry run never submits or uploads and protects secrets", async () => {
    const fake=fakeLogin(url=>url.includes("getStu")?{datas:{unSignedTasks:[task],leaveTasks:[],signedTasks:[]}}:url.includes("detailSign")?{datas:task}:secretResponse());
    const beforeSubmit=vi.fn();
    const result=await execute(user,"device","dry",{loginFn:fake.fn,beforeSubmit});
    expect(result.status).toBe("dry"); expect(beforeSubmit).not.toHaveBeenCalled();
    expect(fake.json.mock.calls.some(([url])=>/submit|upload|previewAttachment/i.test(url))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("auth-cookie");
  });
  it("handles no task and already signed without requesting keys", async () => {
    const fake=fakeLogin(()=>({datas:{unSignedTasks:[],leaveTasks:[],signedTasks:[]}}));
    expect((await execute(user,"device","dry",{loginFn:fake.fn})).status).toBe("no_task");
    expect(fake.json).toHaveBeenCalledTimes(1);
    const done=fakeLogin(()=>({datas:{unSignedTasks:[],leaveTasks:[],signedTasks:[task]}}));
    expect((await execute(user,"device","submit",{loginFn:done.fn})).status).toBe("already");
  });
  it("returns a clear range error for no tasks and refuses malformed lists",async()=>{
    const empty=fakeLogin(()=>({datas:{unSignedTasks:[],leaveTasks:[],signedTasks:[]}}));
    expect((await execute(user,"device","range",{loginFn:empty.fn})).status).toBe("fail");
    const malformed=fakeLogin(()=>({datas:{unSignedTasks:[],leaveTasks:[],signedTasks:"unexpected"}}));
    const result=await execute(user,"device","submit",{loginFn:malformed.fn});
    expect(result.status).toBe("error");expect(result.retryable).toBe(true);expect(result.message).toContain("结构异常");
    expect(malformed.json).toHaveBeenCalledTimes(1);
  });
  it("persists checkpoint before submission and confirms timeout using task state", async () => {
    let queried=0; let saved=false;
    const fake=fakeLogin(url=>{
      if(url.includes("getStu")) return {datas:++queried===1?{unSignedTasks:[task],leaveTasks:[],signedTasks:[]}:{unSignedTasks:[],leaveTasks:[],signedTasks:[task]}};
      if(url.includes("detailSign"))return{datas:task};
      if(url.includes("submitSign")){expect(saved).toBe(true);throw new Error("timeout");}
      return secretResponse();
    });
    const result=await execute(user,"device","submit",{loginFn:fake.fn,beforeSubmit:async()=>{saved=true;},confirmDelayMs:0});
    expect(result.status).toBe("success");expect(result.message).toContain("复查");
    expect(fake.json.mock.calls.filter(([url])=>url.includes("submitSign"))).toHaveLength(1);
  });
  it("allows scheduled retry only after confirming the same task is still unsigned",async()=>{
    const fake=fakeLogin(()=>({datas:{unSignedTasks:[task],leaveTasks:[],signedTasks:[]}}));
    const result=await execute(user,"device","submit",{loginFn:fake.fn,checkpoint:{signInstanceWid:"instance",signWid:"sign"}});
    expect(result.status).toBe("error");expect(result.retryable).toBe(true);
    expect(fake.json.mock.calls.some(([url])=>url.includes("submitSign"))).toBe(false);
  });
  it("never resubmits a resumed job with unknown state",async()=>{
    const fake=fakeLogin(()=>({datas:{unSignedTasks:[],leaveTasks:[],signedTasks:[]}}));
    const result=await execute(user,"device","submit",{loginFn:fake.fn,checkpoint:{signInstanceWid:"instance",signWid:"sign"}});
    expect(result.status).toBe("uncertain");expect(result.retryable).toBe(true);expect(result.retryAction).toBe("verify");expect(fake.json).toHaveBeenCalledTimes(1);
    expect(fake.json.mock.calls.some(([url])=>url.includes("submitSign"))).toBe(false);
  });
});
