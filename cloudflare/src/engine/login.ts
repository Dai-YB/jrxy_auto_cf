// 登录流程适配自 jrxy-engine/actions/{wiseLoginService,casLogin,iapLogin}.py（MPL-2.0）。
import { type Account, EngineError } from "../types";
import { aes, randomLoginPrefix } from "./crypto";
import { publicUrl, Session } from "./http";

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
  const scan = new HTMLRewriter().on("form", { element(el) {
    const id = el.getAttribute("id") ?? "";
    if (known.includes(id)) counts.set(id,(counts.get(id)??0)+1);
  } });
  await scan.transform(new Response(html)).text();
  form = known.find(id => counts.has(id)) ?? "";
  if (!form) throw new EngineError("未识别学校登录表单，可能需要人工验证或专用适配", "unsupported");
  // 原loginFromId模板取第二个同名表单；其他模板只取第一个，不能混合各表单的令牌。
  const selected = form === "loginFromId" && counts.get(form)! > 1 ? 1 : 0;
  let current = -1;
  await new HTMLRewriter().on(`form[id="${form}"]`,{element(){current++;}})
    .on(`form[id="${form}"] input`, { element(el) {
      if(current===selected)inputs.push({ name: el.getAttribute("name") ?? "", id: el.getAttribute("id") ?? "", value: decodeAttribute(el.getAttribute("value") ?? "") });
    } }).transform(new Response(html)).text();
  // 少数模板将盐放在表单外。
  await new HTMLRewriter().on("input[id=\"pwdEncryptSalt\"], input[id=\"pwdDefaultEncryptSalt\"]", { element(el) {
    if (!inputs.some(i => i.id === el.getAttribute("id"))) inputs.push({ name: "", id: el.getAttribute("id")!, value: decodeAttribute(el.getAttribute("value") ?? "") });
  } }).transform(new Response(html)).text();
  return { form, inputs };
}
async function tenantFor(session: Session, name: string): Promise<Tenant> {
  const cacheUrl = "https://jrxy-metadata.invalid/tenant/" + encodeURIComponent(name);
  const cached = await caches.default.match(cacheUrl);
  if (cached) return cached.json<Tenant>();
  const listUrl = "https://mobile.campushoy.com/v6/config/guest/tenant/list";
  const cachedList = await caches.default.match(listUrl);
  const list = cachedList ? await cachedList.json<any>() : await session.json(listUrl);
  if (!cachedList) await caches.default.put(listUrl,Response.json(list,{headers:{"Cache-Control":"max-age=3600"}}));
  const item = list.data?.find((s: any) => s.name === name);
  if (!item || item.joinType === "NONE") throw new EngineError("学校不存在或未接入jrxy");
  const info = await session.json("https://mobile.campushoy.com/v6/config/guest/tenant/info?ids=" + encodeURIComponent(item.id));
  const school = info.data?.[0];
  const campus = [school?.ampUrl, school?.ampUrl2].find(v => {
    if (typeof v !== "string") return false;
    try { const u = publicUrl(v); return campusHost(u.hostname); } catch { return false; }
  });
  if (!campus) throw new EngineError("没有找到受支持的学校客户端地址", "unsupported");
  const tenant = { id: String(item.id), joinType: String(school.joinType), campus };
  await caches.default.put(cacheUrl, Response.json(tenant, { headers: { "Cache-Control": "max-age=3600" } }));
  return tenant;
}
async function loginError(html: string): Promise<string> {
  const messages: Record<string,string> = {};
  const parser = new HTMLRewriter();
  for (const id of ["errorMsg","formErrorTip2","msg"]) parser.on(`#${id}`,{text(chunk){messages[id]=(messages[id]??"")+chunk.text;}});
  await parser.transform(new Response(html)).text();
  return ["errorMsg","formErrorTip2","msg"].map(id => decodeAttribute(messages[id]??"").trim()).find(Boolean)?.slice(0,200) || "学校登录失败，请检查密码或人工验证状态";
}
async function cas(session: Session, account: Account, url: string, html: string): Promise<void> {
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
  const need = await session.request(root + path + "?username=" + encodeURIComponent(account.username));
  if(need.status!==200)throw new EngineError("验证码状态接口异常，未提交登录", "error", need.status>=500);
  let captcha: boolean;
  if (form === "casLoginForm") captcha = !/^false/i.test(need.text.trim());
  else {
    try { captcha = JSON.parse(need.text).isNeed !== false; }
    catch { throw new EngineError("无法判断验证码状态，请人工检查登录页", "captcha"); }
  }
  if (captcha) throw new EngineError("登录需要验证码，自动任务已停止，请人工处理", "captcha");
  const response = await session.request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() }, false);
  if (response.status !== 302 || !response.headers.get("location")) throw new EngineError(await loginError(response.text));
  const landed = await session.request(new URL(response.headers.get("location")!, url).href, {method:"POST"});
  if (landed.status<200 || landed.status>=300 || !campusHost(new URL(landed.url).hostname))
    throw new EngineError("CAS登陆失败，未能成功跳转jrxy");
}
async function iap(session: Session, account: Account, url: string): Promise<void> {
  const root = new URL(url).origin + "/";
  const lt = await session.json(root + "iap/security/lt", {});
  if (!lt.result?._lt) throw new EngineError("未取得 IAP 登录票据", "unsupported");
  const need = await session.json(root + "iap/checkNeedCaptcha?username=" + encodeURIComponent(account.username), {});
  if (need.needCaptcha !== false) throw new EngineError("登录需要验证码，自动任务已停止，请人工处理", "captcha");
  const params = new URLSearchParams({ lt: lt.result._lt, rememberMe: "false", dllt: "", mobile: "", username: account.username, password: account.password, captcha: "" });
  const response = await session.request(root + "iap/doLogin?" + params, { method: "POST" }, false);
  if (response.status !== 302 || !response.headers.get("location")) {
    let code = "";
    try { code = String(JSON.parse(response.text).resultCode ?? ""); } catch {}
    if (code === "CAPTCHA_NOTMATCH") throw new EngineError("登录需要验证码，本版本不使用 OCR，请人工验证", "captcha");
    throw new EngineError(code === "FAIL_UPNOTMATCH" ? "用户名密码不匹配，请检查" : "IAP 登录失败，请检查密码或人工验证状态");
  }
  const landed = await session.request(new URL(response.headers.get("location")!, root).href, {method:"POST"});
  if(landed.status<200 || landed.status>=300 || !campusHost(new URL(landed.url).hostname))
    throw new EngineError("IAP登录未完成，尚未返回受支持的校园门户");
}
export interface Login { session: Session; host: string; tenantId: string; sessionToken: string; }
export async function login(account: Account, session = new Session()): Promise<Login> {
  if (account.httpProxy) throw new EngineError("已保留原 HTTP 代理配置，但纯 Workers 尚无等价 requests 代理适配；不会忽略代理直连，请先确认部署架构", "unsupported");
  const tenant = await tenantFor(session, account.schoolName);
  const host = new URL(tenant.campus).origin + "/";
  const landing = await session.request(tenant.campus);
  const service = new URL(landing.url).searchParams.get("service");
  let sessionToken = "";
  if (service) { try { sessionToken = new URL(service).searchParams.get("sessionToken") ?? ""; } catch {} }
  if (!session.jar.get("MOD_AUTH_CAS", host)) {
    if (tenant.joinType === "CLOUD") await iap(session, account, landing.url);
    else await cas(session, account, landing.url, landing.text);
  }
  if (!session.jar.names().length) throw new EngineError("登录跳转未获得会话 Cookie，无法确认登录成功");
  return { session, host, tenantId: tenant.id, sessionToken: sessionToken || session.jar.get("sessionToken", host) };
}
