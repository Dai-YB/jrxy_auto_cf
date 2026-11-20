import {beforeEach,describe,expect,it,vi} from "vitest";
import {reset} from "cloudflare:test";
import original from "./fixtures/original-http.json";
import {execute} from "../src/engine/sign";
import type {Account,Mode} from "../src/types";
import {login} from "../src/engine/login";
import {Session} from "../src/engine/http";

function normalizeRsa(body:string):string {
  const value=JSON.parse(body);expect(atob(value.p).length).toBe(128);
  return body.replace(value.p,"<RSA ciphertext>");
}

beforeEach(async()=>{await reset();});
describe("request traces captured from original Python entry points",()=>{
  it("does not skip discovery or share login cookies between same-school accounts",async()=>{
    const scenario=original.cases.find(value=>value.name==="iap:login")!;let index=0;
    const transport=vi.fn(async(_input,init)=>{
      const step=index++%scenario.calls.length;
      if(step===0)expect(new Headers(init.headers).has("Cookie")).toBe(false);
      const data=scenario.calls[step].response,headers=new Headers();for(const [name,value] of data.headers)headers.append(name,value);
      return new Response(data.body,{status:data.status,headers});
    });
    for(let i=0;i<2;i++)await login({...scenario.user,notifyKey:""} as Account,new Session(transport as any));
    expect(index).toBe(scenario.calls.length*2);
  });
  for(const scenario of original.cases)it(scenario.name,async()=>{
    const actual:unknown[]=[];
    const fixed=vi.spyOn(crypto,"randomUUID").mockReturnValue(original.uuid as `${string}-${string}-${string}-${string}-${string}`);
    // A为原随机前缀字母表首字符；其他随机字节固定为0，RSA填充不逐字比较。
    const random=vi.spyOn(crypto,"getRandomValues").mockImplementation((array:any)=>{array.fill(0);return array;});
    const transport=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
      const index=actual.length,url=String(input),headers=Object.fromEntries(new Headers(init?.headers));
      let body=init?.body==null?null:typeof init.body==="string"?init.body:new TextDecoder().decode(init.body as ArrayBuffer);
      if(url.includes("/getSecretKey/")&&body)body=normalizeRsa(body);
      actual.push({method:init?.method??"GET",url,headers,body});
      const expected=scenario.calls[index]?.response;
      if(!expected)throw new Error("Unexpected request after end of original trace");
      const responseHeaders=new Headers();for(const [name,value] of expected.headers)responseHeaders.append(name,value);
      return new Response(expected.body,{status:expected.status,headers:responseHeaders});
    });
    try{
      const result=await execute({...scenario.user,notifyKey:""} as Account,scenario.deviceId,scenario.mode as Mode,{beforeSubmit:async()=>{},confirmDelayMs:0});
      expect(actual).toEqual(scenario.calls.map(call=>call.request));
      expect(result.status).toBe(scenario.mode==="dry"?"dry":"success");
      expect(transport.mock.calls.filter(([url])=>String(url).endsWith("/submitSign"))).toHaveLength(scenario.mode==="submit"?1:0);
    }finally{transport.mockRestore();random.mockRestore();fixed.mockRestore();}
  });
});
