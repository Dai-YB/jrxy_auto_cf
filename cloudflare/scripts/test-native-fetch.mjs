import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root=fileURLToPath(new URL("../",import.meta.url));
const require=createRequire(import.meta.url);
const wranglerRequire=createRequire(require.resolve("wrangler/package.json"));
const {build}=wranglerRequire("esbuild");
const {Miniflare,convertV4MiniflareOptions}=wranglerRequire("miniflare");
const config=JSON.parse(readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8"));
const traces=JSON.parse(readFileSync(new URL("../tests/fixtures/original-http.json",import.meta.url),"utf8"));
const compiled=await build({absWorkingDir:root,bundle:true,write:false,format:"esm",platform:"neutral",target:"es2022",external:["node:*"],
  stdin:{resolveDir:root,sourcefile:"native-fetch-check.ts",contents:`
    import {Session} from "./src/engine/http";
    import {login} from "./src/engine/login";
    import {execute} from "./src/engine/sign";
    export default {async fetch(request){
      const input=await request.json();
      if(input.action==="request"){
        const session=input.explicit?new Session(fetch):new Session();
        try{return Response.json({ok:true,data:await session.json("https://synthetic.example/probe")});}
        catch(error){return Response.json({ok:false,message:error.message,diagnostic:error.diagnostic});}
      }
      if(input.action==="login"){
        try{const result=await login(input.user);return Response.json({status:"success",host:result.host});}
        catch(error){return Response.json({status:"error",message:error.message,diagnostic:error.diagnostic});}
      }
      return Response.json(await execute(input.user,input.deviceId,input.mode,{beforeSubmit:async()=>{},confirmDelayMs:0}));
    }};`
  }});
let active=null,index=0;
const wireErrors=[];
let requests=0,checks=0;
// 保留workerd原生globalThis.fetch；只替换网络出口，所有目标都由内存服务响应。
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,
  compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,
  outboundService:async request=>{
    requests++;
    if(active===null){assert.equal(request.url,"https://synthetic.example/probe");return Response.json({synthetic:true});}
    const expected=active.calls[index++];
    if(!expected){wireErrors.push("unexpected request after original trace");return new Response("unexpected",{status:500});}
    try{
      assert.equal(request.url,expected.request.url);
      assert.equal(request.method,expected.request.method);
      assert.equal(request.headers.get("Cookie"),expected.request.headers.cookie??null);
      assert.equal(request.headers.get("User-Agent"),expected.request.headers["user-agent"]);
      assert.equal(request.headers.get("Content-Type"),expected.request.headers["content-type"]??null);
      const body=await request.text();
      if(request.url.includes("/iap/doLogin"))assert.equal(new URL(request.url).searchParams.get("username"),active.user.username);
      if(request.url.includes("/authserver/login")&&request.method==="POST"){
        const form=new URLSearchParams(body);assert.equal(form.get("username"),active.user.username);
        assert.equal(form.get("execution"),new URLSearchParams(expected.request.body).get("execution"));
      }
      if(request.url.endsWith("/submitSign")){
        const actual=JSON.parse(body),original=JSON.parse(expected.request.body);
        assert.deepEqual(actual,original);assert.equal(actual.deviceId,active.deviceId);
      }
    }catch(error){wireErrors.push(error.message);}
    const headers=new Headers();for(const [name,value] of expected.response.headers)headers.append(name,value);
    return new Response(expected.response.body,{status:expected.response.status,headers});
  }
}));
async function run(input){
  const response=await mf.dispatchFetch("http://localhost/native-check",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
  assert.equal(response.status,200);return response.json();
}
try{
  for(const explicit of [false,true]){
    const before=requests,result=await run({action:"request",explicit});
    assert.equal(result.ok,true,"Native Session fetch failed: "+JSON.stringify(result));
    assert.equal(requests,before+1,"Native fetch must reach the local outbound service");checks++;
  }
  for(const scenario of traces.cases){
    active=scenario;index=0;wireErrors.length=0;
    const user={...scenario.user,displayName:"模拟姓名不是学号",notifyKey:""};
    const result=await run({action:"execute",user,deviceId:scenario.deviceId,mode:scenario.mode});
    assert.equal(result.status,scenario.mode==="dry"?"dry":"success",scenario.name+": "+JSON.stringify(result));
    assert.equal(index,scenario.calls.length,scenario.name+": original request count mismatch");
    assert.deepEqual(wireErrors,[],scenario.name+": native request metadata mismatch");checks++;
  }
  for(const scenario of traces.cases.filter(value=>value.mode==="login")){
    active=scenario;index=0;wireErrors.length=0;
    const result=await run({action:"login",user:{...scenario.user,displayName:"模拟姓名不是学号",notifyKey:""}});
    assert.equal(result.status,"success",scenario.name+": direct enrollment login failed");
    assert.equal(index,scenario.calls.length);assert.deepEqual(wireErrors,[]);checks++;
  }
  console.log(`Native Workers fetch checks passed: ${checks} checks, ${requests} requests intercepted locally; native fetch was never replaced, no school traffic sent.`);
}finally{await mf.dispose();}
