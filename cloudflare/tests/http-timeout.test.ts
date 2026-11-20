import {describe,expect,it,vi} from "vitest";
import {Session} from "../src/engine/http";

function streamTransport(delays:number[],options:{headDelay?:number;ignoreAbort?:boolean;empty?:boolean}={}){
  let cancelled=0,aborted=0;
  const transport=vi.fn(async(_input:string,init:RequestInit)=>{
    if(options.headDelay)await new Promise(resolve=>setTimeout(resolve,options.headDelay));
    let timer:ReturnType<typeof setTimeout>|undefined,closed=false;
    const signal=init.signal!;
    let detach=()=>{};
    const body=new ReadableStream<Uint8Array>({
      start(controller){
        const stop=()=>{aborted++;if(timer)clearTimeout(timer);if(!closed){closed=true;controller.error(new DOMException("synthetic abort","AbortError"));}};
        if(!options.ignoreAbort){signal.addEventListener("abort",stop,{once:true});detach=()=>signal.removeEventListener("abort",stop);}
        let index=0;
        function next(){
          if(closed)return;
          if(index===delays.length){closed=true;detach();controller.close();return;}
          timer=setTimeout(()=>{if(closed)return;controller.enqueue(options.empty?new Uint8Array():new TextEncoder().encode("x"));index++;next();},delays[index]);
        }
        if(signal.aborted&&!options.ignoreAbort)stop();else next();
      },
      cancel(){cancelled++;closed=true;if(timer)clearTimeout(timer);detach();}
    });
    return new Response(body,{headers:{"Set-Cookie":"isolated=synthetic; Path=/; Secure"}});
  });
  return {transport,cancelled:()=>cancelled,aborted:()=>aborted};
}

describe("per-account read inactivity budgets",()=>{
  it("accepts continuous nonempty chunks beyond the former wall-clock request timeout",async()=>{
    const mock=streamTransport([30,30,30,30,30],{headDelay:20});
    const response=await new Session(mock.transport as any,90,1000).at("login_form").request("https://login.example.edu/page");
    expect(response.text).toBe("xxxxx");expect(mock.transport).toHaveBeenCalledTimes(1);expect(mock.aborted()).toBe(0);
  });
  it("separates first-response timeout from a stalled body and never replays a POST",async()=>{
    const pending=vi.fn(async(_url:string,init:RequestInit)=>new Promise<Response>((_resolve,reject)=>init.signal!.addEventListener("abort",()=>reject(new DOMException("abort","AbortError")),{once:true})));
    const head=await new Session(pending as any,35,1000).at("login_submit").request("https://login.example.edu/login",{method:"POST",body:"synthetic"}).catch(error=>error);
    expect(head.diagnostic).toMatchObject({kind:"timeout",phase:"send",requestIndex:1,redirectCount:0,timeoutMs:35,receivedBytes:0});expect(pending).toHaveBeenCalledTimes(1);
    const slow=streamTransport([10,250]);
    const body=await new Session(slow.transport as any,60,1000).at("login_callback").request("https://login.example.edu/callback",{method:"POST"}).catch(error=>error);
    expect(body.diagnostic).toMatchObject({kind:"timeout",phase:"body",httpStatus:200,receivedBytes:1,timeoutMs:60});
    expect(body.diagnostic.idleMs).toBeGreaterThanOrEqual(50);expect(slow.transport).toHaveBeenCalledTimes(1);
  });
  it("enforces the total deadline even while data keeps arriving",async()=>{
    const mock=streamTransport(Array(12).fill(20));
    const error=await new Session(mock.transport as any,90,105).at("portal").request("https://login.example.edu/").catch(value=>value);
    expect(error.diagnostic.kind).toBe("total_timeout");expect(error.diagnostic.phase).toBe("body");expect(error.diagnostic.receivedBytes).toBeGreaterThan(0);
    expect(error.diagnostic.sessionElapsedMs).toBeGreaterThanOrEqual(95);
  });
  it("cancels a stalled body even when the source ignores the abort signal",async()=>{
    const mock=streamTransport([10,500],{ignoreAbort:true});
    const error=await new Session(mock.transport as any,40,200).request("https://login.example.edu/").catch(value=>value);
    expect(error.diagnostic).toMatchObject({kind:"timeout",phase:"body",receivedBytes:1});expect(mock.cancelled()).toBe(1);
  });
  it("discards a late response without adding its cookies when the transport ignores abort",async()=>{
    const late=Promise.withResolvers<Response>(),discarded=Promise.withResolvers<void>();
    const session=new Session(vi.fn(()=>late.promise) as any,40,500);
    await expect(session.request("https://login.example.edu/")).rejects.toMatchObject({diagnostic:{kind:"timeout",phase:"send",receivedBytes:0}});
    late.resolve(new Response(new ReadableStream({cancel(){discarded.resolve();}}),{headers:{"Set-Cookie":"late=synthetic; Path=/; Secure"}}));
    await discarded.promise;
    expect(session.jar.names()).toEqual([]);
  });
  it("does not reset inactivity for empty chunks",async()=>{
    const mock=streamTransport(Array(20).fill(10),{empty:true,ignoreAbort:true});
    const error=await new Session(mock.transport as any,45,500).request("https://login.example.edu/").catch(value=>value);
    expect(error.diagnostic).toMatchObject({kind:"timeout",phase:"body",receivedBytes:0});expect(mock.cancelled()).toBe(1);
  });
  it("preserves the remaining total deadline and tracks the redirected request",async()=>{
    const slow=streamTransport([10,250]);
    const transport=vi.fn(async(input:string,init:RequestInit)=>input.endsWith("/start")?new Response(null,{status:302,headers:{Location:"https://login.example.edu/next"}}):slow.transport(input,init));
    const error=await new Session(transport as any,40,500).at("portal").request("https://campus.example.edu/start").catch(value=>value);
    expect(error.diagnostic).toMatchObject({host:"login.example.edu",requestIndex:2,redirectCount:1,phase:"body",kind:"timeout"});expect(transport).toHaveBeenCalledTimes(2);
  });
  it("isolates cookies and cancellation across successful, timed-out and later accounts",async()=>{
    const signals:AbortSignal[]=[],cookies:string[]=[];
    const slow=streamTransport([10,250]);
    const transport=vi.fn(async(input:string,init:RequestInit)=>{
      signals.push(init.signal!);cookies.push(new Headers(init.headers).get("Cookie")??"");
      if(input.endsWith("/slow"))return slow.transport(input,init);
      return new Response("ok",{headers:{"Set-Cookie":"account=synthetic; Path=/; Secure"}});
    });
    const first=new Session(transport as any,40,500),second=new Session(transport as any,40,500),third=new Session(transport as any,40,500);
    expect((await first.request("https://login.example.edu/first")).text).toBe("ok");
    await expect(second.request("https://login.example.edu/slow")).rejects.toMatchObject({diagnostic:{kind:"timeout"}});
    expect((await third.request("https://login.example.edu/third")).text).toBe("ok");
    await new Promise(resolve=>setTimeout(resolve,70));
    expect(cookies).toEqual(["","",""]);expect(signals.map(signal=>signal.aborted)).toEqual([false,true,false]);expect(first.jar.names()).toEqual(["account"]);expect(third.jar.names()).toEqual(["account"]);
  });
});
