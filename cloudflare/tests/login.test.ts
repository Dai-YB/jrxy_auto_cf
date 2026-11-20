import { beforeEach, describe, expect, it, vi } from "vitest";
import { reset } from "cloudflare:test";
import { login, parseForm } from "../src/engine/login";
import { CookieJar, Session } from "../src/engine/http";
import type { Account } from "../src/types";

const user: Account = { schoolName:"模拟大学",username:"student",password:"test-password",type:2,lon:1,lat:2,address:"地址",abnormalReason:"",notifyKey:"" };
beforeEach(async()=>{await reset();});
function mockSchool(joinType: string, handler:(url:URL,init:RequestInit)=>Response) {
  return vi.fn(async(input:string,init:RequestInit)=>{
    const url=new URL(input);
    if(url.pathname==="/v6/config/guest/tenant/list")return Response.json({data:[{id:"school",name:user.schoolName,joinType}]});
    if(url.pathname==="/v6/config/guest/tenant/info")return Response.json({data:[{joinType,ampUrl:"https://school.campusphere.net/portal",ampUrl2:""}]});
    if(url.href==="https://school.campusphere.net/portal")return new Response(null,{status:302,headers:{Location:"https://cas.example.edu/authserver/login?service="+encodeURIComponent("https://school.campusphere.net/callback?sessionToken=synthetic-token")}});
    return handler(url,init);
  });
}
describe("CAS/IAP without OCR",()=>{
  it("preserves the original second loginFromId form without mixing hidden tokens",async()=>{
    const parsed=await parseForm('<form id="loginFromId"><input name="execution" value="first"></form><form id="loginFromId"><input name="execution" value="second"><input name="username"></form>');
    expect(parsed.inputs.filter(input=>input.name==="execution")).toEqual([{name:"execution",id:"",value:"second"}]);
  });
  it("rejects an IAP redirect that returns to the login portal instead of the campus",async()=>{
    const transport=mockSchool("CLOUD",(url)=>{
      if(url.pathname==="/authserver/login")return new Response("login",{headers:{"Set-Cookie":"pre=only; Path=/"}});
      if(url.pathname==="/iap/security/lt")return Response.json({result:{_lt:"lt"}});
      if(url.pathname==="/iap/checkNeedCaptcha")return Response.json({needCaptcha:false});
      if(url.pathname==="/iap/doLogin")return new Response(null,{status:302,headers:{Location:"https://cas.example.edu/authserver/login"}});
      throw new Error("unexpected");
    });
    await expect(login(user,new Session(transport as any))).rejects.toThrow("IAP登录未完成");
  });
  it("keeps valid parent-domain cookies without leaking public-suffix or foreign cookies",()=>{
    const jar=new CookieJar();const origin=new URL("https://login.example.edu/authserver/login");
    jar.set("CASTGC=valid; Domain=.example.edu; Path=/; Secure",origin);
    jar.set("bad=x; Domain=edu; Path=/",origin);
    jar.set("foreign=x; Domain=other.edu; Path=/",origin);
    jar.set("defaultPath=y",origin);
    expect(jar.header(new URL("https://service.example.edu/"))).toBe("CASTGC=valid");
    expect(jar.header(new URL("https://evil-example.edu/"))).toBe("");
    expect(jar.header(new URL("https://login.example.edu/authserver"))).toContain("defaultPath=y");
  });
  it.each(["casLoginForm","pwdFromId","loginFromId"])("logs in through %s and preserves hidden tokens",async(form)=>{
    const transport=mockSchool("CAS",(url,init)=>{
      if(url.pathname==="/authserver/login"&&init.method==="GET")return new Response((form==="loginFromId"?'<form id="loginFromId"><input name="execution" value="wrong"></form>':'')+`<form id="${form}"><input name="execution" value="a&amp;b"><input name="username"><input name="password"></form>`,{headers:{"Set-Cookie":"pre=session; Domain=.example.edu; Path=/"}});
      if(url.pathname.includes("needCaptcha"))return new Response("false");
      if(url.pathname.includes("checkNeedCaptcha"))return Response.json({isNeed:false});
      if(url.pathname==="/authserver/login"&&init.method==="POST"){
        const body=new URLSearchParams(String(init.body));expect(body.get("execution")).toBe("a&b");expect(body.get("username")).toBe("student");
        expect(new Headers(init.headers).get("cookie")).toContain("pre=session");
        return new Response(null,{status:302,headers:{Location:"https://school.campusphere.net/callback"}});
      }
      if(url.pathname==="/callback"){
        expect(init.method).toBe("POST");
        return new Response("logged in",{headers:{"Set-Cookie":"MOD_AUTH_CAS=auth; Path=/; Secure"}});
      }
      throw new Error("unexpected request");
    });
    const result=await login(user,new Session(transport as any));
    expect(result.host).toBe("https://school.campusphere.net/");expect(result.sessionToken).toBe("synthetic-token");
    expect(result.session.jar.get("MOD_AUTH_CAS",result.host)).toBe("auth");
    expect(transport.mock.calls.some(([url])=>/generateCaptcha|getCaptcha|captcha\.html/.test(url))).toBe(false);
  });
  it("refreshes the CAS page and submits only the new token and cookie",async()=>{
    let pages=0;
    const transport=mockSchool("CAS",(url,init)=>{
      if(url.pathname==="/authserver/login"&&init.method==="GET")return new Response(`<form id="pwdFromId"><input name="execution" value="token-${++pages}"><input name="username"><input name="password"></form>`,{headers:{"Set-Cookie":`flow=${pages}; Path=/; Secure`}});
      if(url.pathname.includes("checkNeedCaptcha"))return Response.json({isNeed:false});
      if(url.pathname==="/authserver/login"&&init.method==="POST"){
        expect(new URLSearchParams(String(init.body)).get("execution")).toBe("token-2");expect(new Headers(init.headers).get("cookie")).toBe("flow=2");
        return new Response(null,{status:302,headers:{Location:"https://school.campusphere.net/callback"}});
      }
      return new Response("ok",{headers:{"Set-Cookie":"MOD_AUTH_CAS=auth; Path=/"}});
    });
    await login(user,new Session(transport as any));expect(pages).toBe(2);
    expect(transport.mock.calls.filter(([,init])=>init.method==="POST")).toHaveLength(2);
  });
  it("rejects a missing second loginFromId form instead of silently choosing another form",async()=>{
    await expect(parseForm('<form id="loginFromId"><input name="execution" value="wrong"></form>')).rejects.toMatchObject({status:"unsupported"});
  });
  it("stops before password submission when CAPTCHA is requested",async()=>{
    const transport=mockSchool("CAS",url=>{
      if(url.pathname==="/authserver/login")return new Response('<form id="pwdFromId"><input name="username"></form>');
      return Response.json({isNeed:true});
    });
    await expect(login(user,new Session(transport as any))).rejects.toMatchObject({status:"captcha"});
    expect(transport.mock.calls.some(([,init])=>init.method==="POST")).toBe(false);
  });
  it("preserves login error messages without retrying bad passwords",async()=>{
    const transport=mockSchool("CAS",(url,init)=>{
      if(url.pathname==="/authserver/checkNeedCaptcha.htl")return Response.json({isNeed:false});
      if(init.method==="POST")return new Response('<span id="errorMsg">用户名或密码错误</span>',{status:401});
      return new Response('<form id="pwdFromId"><input name="username"></form>');
    });
    await expect(login(user,new Session(transport as any))).rejects.toThrow("用户名或密码错误");
    expect(transport.mock.calls.filter(([,init])=>init.method==="POST")).toHaveLength(1);
  });
  it("logs in through IAP with the original query-parameter contract",async()=>{
    const transport=mockSchool("CLOUD",(url,init)=>{
      if(url.pathname==="/authserver/login")return new Response("IAP portal");
      if(url.pathname==="/iap/security/lt")return Response.json({result:{_lt:"lt-123"}});
      if(url.pathname==="/iap/checkNeedCaptcha")return Response.json({needCaptcha:false});
      if(url.pathname==="/iap/doLogin"){
        expect(init.method).toBe("POST");expect(url.searchParams.get("lt")).toBe("lt-123");expect(url.searchParams.get("captcha")).toBe("");
        return new Response(null,{status:302,headers:{Location:"https://school.campusphere.net/callback"}});
      }
      return new Response("ok",{headers:{"Set-Cookie":"MOD_AUTH_CAS=auth; Path=/"}});
    });
    expect((await login(user,new Session(transport as any))).session.jar.names()).toContain("MOD_AUTH_CAS");
  });
});
