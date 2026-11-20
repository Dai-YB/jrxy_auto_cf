// 登录流程适配自 jrxy-engine/actions/{wiseLoginService,casLogin,iapLogin}.py（MPL-2.0）。
import { type Account, type Mode, EngineError } from "../types";
import { aes, randomLoginPrefix } from "./crypto";
import { publicUrl, Session } from "./http";
import { formEncode } from "./encoding";

interface Tenant { id: string; joinType: string; campus: string; }
function campusHost(host: string): boolean { return ["campusphere.net","campushoy.com"].some(domain=>host===domain||host.endsWith("."+domain)); }
interface Input { name: string; id: string; value: string; }
function decodeAttribute(value: string): string {
  const names: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: "\u00a0" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (raw, name: string) => {
    if (!name.startsWith("#")) return names[name.toLowerCase()] ?? raw;
    const n = name[1].toLowerCase() === "x" ? parseInt(name.slice(2),16) : parseInt(name.slice(1),10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "\ufffd";
  });
}
export async function parseForm(html: string): Promise<{ form: string; inputs: Input[] }> {
  let form = "";
  const inputs: Input[] = [];
  const known = ["casLoginForm", "pwdFromId", "loginFromId", "fm1"];
  const counts = new Map<string,number>();
  const scan = new HTMLRewriter().on("[id]", { element(el) {
    const id = el.getAttribute("id") ?? "";
    if (known.includes(id)) counts.set(id,(counts.get(id)??0)+1);
  } });
  await scan.transform(new Response(html)).text();
  form = known.find(id => counts.has(id)) ?? "";
  if (!form) throw new EngineError("未识别学校登录表单，可能需要人工验证或专用适配", "unsupported");
  // 原casLoginForm收集整页输入，另外两种模板限制在指定表单内。
  const selected=form==="loginFromId"?1:0;
  if(form==="loginFromId"&&counts.get(form)!<2)throw new EngineError("学校登录页缺少原版要求的第二个loginFromId表单","unsupported");
  let current=-1;
  const parser=new HTMLRewriter().on(`[id="${form}"]`,{element(){current++;}})
    .on(form==="casLoginForm"?"input":`[id="${form}"] input`,{element(el){
      if(form==="casLoginForm"||current===selected)inputs.push({name:el.getAttribute("name")??"",id:el.getAttribute("id")??"",value:decodeAttribute(el.getAttribute("value")??"")});
    }});
  await parser.transform(new Response(html)).text();
  return { form, inputs };
}
async function tenantItem(session: Session, name: string): Promise<{id:string;joinType:string}> {
  const list=await session.at("tenant_list").json("https://mobile.campushoy.com/v6/config/guest/tenant/list");
  const item=Array.isArray(list.data)?list.data.find((school:any)=>school.name===name):null;
  if(!item||item.joinType==="NONE")throw new EngineError("学校不存在或未接入jrxy");
  return item;
}
async function discover(session: Session, name: string) {
  const tenant=await tenantFor(session,name);
  const landing=await session.at("portal").request(tenant.campus);
  return {tenant,landing};
}
async function tenantFor(session: Session, name: string): Promise<Tenant> {
  const item=await tenantItem(session,name);
  const info = await session.at("tenant_info").json("https://mobile.campushoy.com/v6/config/guest/tenant/info?" + formEncode([["ids",String(item.id)]]));
  const school = info.data?.[0];
  const campus = [school?.ampUrl, school?.ampUrl2].find(v => {
    if (typeof v !== "string") return false;
    try { const u = publicUrl(v); return campusHost(u.hostname); } catch { return false; }
  });
  if (!campus) throw new EngineError("没有找到受支持的学校客户端地址", "unsupported");
  return { id: String(item.id), joinType: String(school.joinType), campus };
}
async function loginError(html: string): Promise<string> {
  const messages: Record<string,string> = {};
  const parser = new HTMLRewriter();
  for (const id of ["errorMsg","formErrorTip2","msg"]) parser.on(`#${id}`,{text(chunk){messages[id]=(messages[id]??"")+chunk.text;}});
  await parser.transform(new Response(html)).text();
  return ["errorMsg","formErrorTip2","msg"].map(id => decodeAttribute(messages[id]??"").trim()).find(Boolean)?.slice(0,200) || "学校登录失败，请检查密码或人工验证状态";
}
async function cas(session: Session, account: Account, url: string): Promise<void> {
  const page=await session.at("login_form").request(url);
  const html=page.text;
  const { form, inputs } = await parseForm(html);
  if (form === "fm1") throw new EngineError("此学校 RSA 登录分支要求验证码，请人工登录", "captcha");
  const params = new URLSearchParams();
  for (const input of inputs) if (input.name && input.name !== "rememberMe") params.set(input.name, input.value);
  params.set("username", account.username);
  const saltId = form === "casLoginForm" ? "pwdDefaultEncryptSalt" : "pwdEncryptSalt";
  let salt = inputs.find(i => i.id === saltId)?.value;
  if (!salt) { const matches = [...html.matchAll(/"(\w{16})"/g)]; if (matches.length === 1) salt = matches[0][1]; }
  params.set("password", salt ? aes(randomLoginPrefix() + account.password, salt).match(/.{1,76}/g)!.join("\n") : account.password);
  const root = new URL(url).origin + "/";
  const path = form === "casLoginForm" ? "authserver/needCaptcha.html" : "authserver/checkNeedCaptcha.htl";
  const need = await session.at("captcha_check").request(root + path + "?username=" + encodeURIComponent(account.username));
  if(need.status!==200)throw new EngineError("验证码状态接口异常，未提交登录", "error", need.status>=500,session.diagnostic("http"));
  let captcha: boolean;
  if (form === "casLoginForm") captcha = !/^false/i.test(need.text.trim());
  else {
    try { captcha = JSON.parse(need.text).isNeed !== false; }
    catch { throw new EngineError("无法判断验证码状态，请人工检查登录页", "captcha"); }
  }
  if (captcha) throw new EngineError("登录需要验证码，自动任务已停止，请人工处理", "captcha");
  const response = await session.at("login_submit").request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: formEncode(params) }, false);
  if (response.status !== 302 || !response.headers.get("location")) throw new EngineError(await loginError(response.text));
  const landed = await session.at("login_callback").request(new URL(response.headers.get("location")!, url).href, {method:"POST"});
  if (landed.status<200 || landed.status>=300 || !campusHost(new URL(landed.url).hostname))
    throw new EngineError("CAS登陆失败，未能成功跳转jrxy");
}
async function iap(session: Session, account: Account, url: string): Promise<void> {
  const root = new URL(url).origin + "/";
  const lt = session.parseJson(await session.at("login_ticket").request(root + "iap/security/lt", {method:"POST",body:"{}"}));
  if (!lt.result?._lt) throw new EngineError("未取得 IAP 登录票据", "unsupported");
  const need = session.parseJson(await session.at("captcha_check").request(root + "iap/checkNeedCaptcha?username=" + encodeURIComponent(account.username), {method:"POST",body:"{}"}));
  if (need.needCaptcha !== false) throw new EngineError("登录需要验证码，自动任务已停止，请人工处理", "captcha");
  const params = new URLSearchParams({ lt: lt.result._lt, rememberMe: "false", dllt: "", mobile: "", username: account.username, password: account.password, captcha: "" });
  const response = await session.at("login_submit").request(root + "iap/doLogin?" + formEncode(params), { method: "POST" }, false);
  if (response.status !== 302 || !response.headers.get("location")) {
    let code = "";
    try { code = String(JSON.parse(response.text).resultCode ?? ""); } catch {}
    if (code === "CAPTCHA_NOTMATCH") throw new EngineError("登录需要验证码，本版本不使用 OCR，请人工验证", "captcha");
    throw new EngineError(code === "FAIL_UPNOTMATCH" ? "用户名密码不匹配，请检查" : "IAP 登录失败，请检查密码或人工验证状态");
  }
  const landed = await session.at("login_callback").request(new URL(response.headers.get("location")!, root).href, {method:"POST"});
  if(landed.status<200 || landed.status>=300 || !campusHost(new URL(landed.url).hostname))
    throw new EngineError("IAP登录未完成，尚未返回受支持的校园门户");
}
export interface Login { session: Session; host: string; tenantId: string; sessionToken: string; }
export async function login(account: Account, session = new Session(), mode: Mode = "login"): Promise<Login> {
  try {
    if (account.httpProxy) throw new EngineError("已保留原 HTTP 代理配置，但纯 Workers 尚无等价 requests 代理适配；不会忽略代理直连，请先确认部署架构", "unsupported");
    const submission=mode==="dry"||mode==="submit";
    if(submission)await discover(session,account.schoolName);
    const {tenant,landing}=await discover(session,account.schoolName);
    const host = new URL(tenant.campus).origin + "/";
    const service = new URL(landing.url).searchParams.get("service");
    let sessionToken = "";
    if (service) { try { sessionToken = new URL(service).searchParams.get("sessionToken") ?? ""; } catch {} }
    if (tenant.joinType === "CLOUD") await iap(session, account, landing.url);
    else await cas(session, account, landing.url);
    if (!session.jar.names().length) throw new EngineError("登录跳转未获得会话 Cookie，无法确认登录成功");
    const tenantId=submission?String((await tenantItem(session,account.schoolName)).id):tenant.id;
    session.at("request");
    return { session, host, tenantId, sessionToken: sessionToken || session.jar.get("sessionToken", host) };
  } catch (error) {
    if(error instanceof EngineError){error.diagnostic??=session.diagnostic("response");throw error;}
    throw new EngineError("登录处理异常，请检查协议兼容性","error",false,session.diagnostic("internal"));
  }
}
