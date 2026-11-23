import { describe,expect,it,vi } from "vitest";
import { classify,notification,notifyUrl,sendNotify } from "../src/notify";
import type { Account } from "../src/types";
const account={password:"private-password",username:"user123",notifyKey:"",notifyOption:{method:2,rcvOption:"SCTexample"}} as Account;
describe("original notification behavior",()=>{
  it("supports both ServerChan generations and full Webhook URLs",()=>{
    expect(notifyUrl("SCTexample")).toBe("https://sctapi.ftqq.com/SCTexample.send");
    expect(notifyUrl("sctp123tabc")).toBe("https://123.push.ft07.com/send/sctp123tabc.send");
    expect(notifyUrl("https://notify.example.com/hook?token=abc")).toBe("https://notify.example.com/hook?token=abc");
    expect(notifyUrl("http://notify.example.com/hook")).toBe("http://notify.example.com/hook");
  });
  it("retains title labels and trigger/time/detail formatting",()=>{
    const result={status:"success",message:"SUCCESS",detail:"签到过程\nSUCCESS"} as const;
    const start=Date.parse("2026-11-10T14:05:00Z");
    const content=notification("alice",result,"批量",false,start,start+1000);
    expect(content.title).toBe("【签到成功】alice");
    expect(content.message).toContain("- 触发：批量签到");
    expect(content.message).toContain("- 开始：2026-11-10 22:05:00");
    expect(content.message).toContain("- 结束：2026-11-10 22:05:01");
    expect(content.message).toContain("```\n签到过程\nSUCCESS\n```");
    expect(classify({status:"fail",message:"坐标不在范围"})).toBe("签到失败：坐标不在范围");
  });
  it("uses title/desp form fields and original response classifications",async()=>{
    const transport=vi.fn().mockResolvedValue(new Response('{"code":0}'));
    expect(await sendNotify(account,"标题","正文",transport)).toBe("推送成功（Server酱已接收）");
    const form=new URLSearchParams(transport.mock.calls[0][1].body);
    expect(form.get("title")).toBe("标题");expect(form.get("desp")).toBe("正文");
    transport.mockResolvedValue(new Response("ok"));
    expect(await sendNotify(account,"标题","正文",transport)).toBe("推送已发送（非 JSON 响应）");
    transport.mockResolvedValue(new Response('{}'));
    expect(await sendNotify(account,"标题","正文",transport)).toBe("推送成功（Server酱已接收）");
    transport.mockResolvedValue(new Response('{"code":400,"message":"额度用完"}'));
    expect(await sendNotify(account,"标题","正文",transport)).toContain("code=400 额度用完");
    transport.mockResolvedValue(new Response('unavailable',{status:503}));
    expect(await sendNotify(account,"标题","正文",transport)).toContain("HTTP 503 unavailable");
  });
  it.each(["headers","body","cancel"])("bounds a notification that ignores abort during %s",async phase=>{
    vi.useFakeTimers();
    const late=Promise.withResolvers<Response>();let control:ReadableStreamDefaultController<Uint8Array>|undefined;
    const cancelled=vi.fn(()=>phase==="cancel"?new Promise<void>(()=>{}):undefined);
    const response=new Response(new ReadableStream<Uint8Array>({start(controller){control=controller;if(phase==="cancel")controller.enqueue(new Uint8Array(32769));},cancel:cancelled}));
    const transport=vi.fn(async()=>phase==="headers"?late.promise:response);
    let outcome:string|undefined;
    const pending=sendNotify(account,"标题","正文",transport).then(value=>{outcome=value;});
    try{
      await vi.advanceTimersByTimeAsync(15001);
      expect(outcome).toContain("推送失败");expect(transport).toHaveBeenCalledTimes(1);
      if(phase==="headers"){late.resolve(response);await vi.advanceTimersByTimeAsync(0);}
      expect(cancelled).toHaveBeenCalledTimes(1);
      await pending;
    }finally{
      late.resolve(response);try{control?.close();}catch{}vi.useRealTimers();
    }
  });
  it("disabled methods do not send and responses redact secrets",async()=>{
    const transport=vi.fn();
    expect(await sendNotify({...account,notifyOption:{method:0,rcvOption:"SCTexample"}},"t","m",transport)).toContain("推送未启用");
    expect(transport).not.toHaveBeenCalled();
    transport.mockResolvedValue(new Response('{"code":1,"message":"SCTexample private-password 合成姓名"}'));
    const output=await sendNotify({...account,displayName:"合成姓名"},"t","m",transport);
    expect(output).not.toContain("SCTexample");expect(output).not.toContain("private-password");expect(output).not.toContain("合成姓名");
  });
});
