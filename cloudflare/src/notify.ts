// 对齐 web-server/app.py: classify / notify_head / send_notify / run_and_report。
import { type Account, type Result, LABELS } from "./types";
import { redact } from "./security";

export function notifyOption(account: Account): { method: number; rcvOption: string } {
  return account.notifyOption ?? { method: account.notifyKey ? 2 : 0, rcvOption: account.notifyKey || "" };
}
export function classify(result: Result): string {
  const label = LABELS[result.status];
  const msg = result.message.trim();
  if (["already","fail","error"].includes(result.status) && msg) return msg.startsWith(label) ? msg.slice(0,100) : `${label}：${msg.slice(0,80)}`;
  return label;
}
export function notifyHead(result: string): string { return result.split("：")[0].split("（")[0].trim(); }
export function notifyUrl(rcv: string): string {
  const key = rcv.trim();
  const match = /^sctp(\d+)t/i.exec(key);
  if (match) return `https://${match[1]}.push.ft07.com/send/${key}.send`;
  if (key.startsWith("SCT")) return `https://sctapi.ftqq.com/${key}.send`;
  const url = new URL(key);
  if (!["http:","https:"].includes(url.protocol)) throw new Error("推送地址仅支持HTTP/HTTPS");
  return url.href;
}
function formatTime(time: number, offset = 8): string {
  return new Date(time + offset*3600_000).toISOString().slice(0,19).replace("T"," ");
}
export function notification(name: string, result: Result, trigger: string, dry: boolean, started: number, ended: number, offset = 8): { title: string; message: string } {
  const label = classify(result);
  const output = result.detail?.trim() || result.message.trim() || "(无输出)";
  return {
    title: `【${notifyHead(label)}】${name}`,
    message: [`**${label}**`, `- 账号：${name}`, `- 触发：${trigger}${dry ? "探测" : "签到"}`,
      `- 开始：${formatTime(started,offset)}`, `- 结束：${formatTime(ended,offset)}`, "```\n" + output.slice(-1200) + "\n```"].join("\n\n")
  };
}
export async function sendNotify(account: Account, title: string, message: string, transport: typeof fetch = fetch): Promise<string> {
  const option = notifyOption(account);
  if (Number(option.method) !== 2 || !option.rcvOption.trim()) return "推送未启用（账号未配置 Server酱）";
  const redactResponse = (s: string) => redact(s,[account.password, option.rcvOption, account.username]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await transport(notifyUrl(option.rcvOption), { method:"POST", redirect:"follow", signal:controller.signal,
      headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({ title:[...title].slice(0,32).join(""), desp:message }).toString() });
    const reader = response.body?.getReader(); let body=""; let total=0; const decoder=new TextDecoder();
    if(reader)for(;;){const {value,done}=await reader.read();if(done)break;total+=value.length;
      if(total>32768){await reader.cancel();return "推送失败：响应内容过大";} body+=decoder.decode(value,{stream:true});}
    body+=decoder.decode();
    if(!response.ok)return `推送失败：HTTP ${response.status} ${redactResponse(body.slice(0,200))}`;
    let data:any;
    try{data=JSON.parse(body);}catch{return "推送已发送（非 JSON 响应）";}
    const code=data?.code??0;
    if(code===0||code==="0")return "推送成功（Server酱已接收）";
    return `推送失败：code=${String(code)} ${redactResponse(String(data?.message||data?.info||"").slice(0,200))}`;
  } catch { return "推送失败：网络请求异常、超时或推送地址无效"; }
  finally { clearTimeout(timer); }
}
