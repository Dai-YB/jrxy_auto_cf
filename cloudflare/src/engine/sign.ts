// 签到与查寝适配自 jrxy-engine/actions/autoSign.py、scripts/merged_ios_v4_submit.py（MPL-2.0）。
import { type Account, type Mode, type Result, EngineError } from "../types";
import { fetchSecret, signedBody } from "./crypto";
import { login, type Login } from "./login";
import { requireDeviceId } from "./device";
import { IOS_UA, Session } from "./http";

export interface Checkpoint { signInstanceWid: string; signWid: string; }
export interface ExecutionOptions {
  checkpoint?: Checkpoint;
  beforeSubmit?: (checkpoint: Checkpoint) => Promise<void>;
  loginFn?: typeof login;
  httpTimeoutMs?: number;
  runTimeoutMs?: number;
  confirmDelayMs?: number;
}
export function paths(type: 1 | 2): { list: string; detail: string; submit: string } {
  return type === 1 ? {
    list: "wec-counselor-sign-apps/stu/sign/getStuSignInfosInOneDay",
    detail: "wec-counselor-sign-apps/stu/sign/detailSignInstance",
    submit: "wec-counselor-sign-apps/stu/sign/submitSign"
  } : {
    list: "wec-counselor-attendance-apps/student/attendance/getStuAttendacesInOneDay",
    detail: "wec-counselor-attendance-apps/student/attendance/detailSignInstance",
    submit: "wec-counselor-attendance-apps/student/attendance/submitSign"
  };
}
async function tasks(auth: Login, path: string, warmup = false): Promise<any> {
  if (warmup) await auth.session.request(auth.host + path,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  const response = await auth.session.json(auth.host + path, {});
  if (response?.datas && Array.isArray(response.datas.unSignedTasks)) {
    const data=response.datas;
    for(const key of ["signedTasks","leaveTasks","registerLeaveTasks"]) {
      if(data[key]!=null && !Array.isArray(data[key]))throw new EngineError("任务列表结构异常，已停止执行");
    }
    return {...data,signedTasks:data.signedTasks ?? [],leaveTasks:data.leaveTasks ?? [],registerLeaveTasks:data.registerLeaveTasks ?? []};
  }
  throw new EngineError("未能获取受保护的任务列表，登录可能失效或学校接口不兼容");
}
export function selectTask(list: any, account: Account, mode: Mode): any {
  if(mode === "range")return list.unSignedTasks?.[0] ?? list.leaveTasks?.[0] ?? list.signedTasks?.[0] ?? list.registerLeaveTasks?.[0];
  const available = list.unSignedTasks.length ? list.unSignedTasks : list.leaveTasks;
  let selected = available?.[0];
  if(account.formTitle !== undefined) for(const task of available ?? []) if(String(task.taskName ?? "").includes(account.formTitle)) selected=task;
  return selected;
}
export function buildForm(account: Account, task: any): Record<string, unknown> {
  if (Number(task.isPhoto) === 1) throw new EngineError("任务要求照片；此轻量版仅支持无照片签到与查寝", "unsupported");
  if (!task.signInstanceWid || task.isMalposition === undefined) throw new EngineError("任务详情缺少必要字段", "unsupported");
  if (typeof account.lon!=="number" || typeof account.lat!=="number" || !Number.isFinite(account.lon) || !Number.isFinite(account.lat) || Math.abs(account.lon)>180 || Math.abs(account.lat)>90 || !account.address)
    throw new EngineError("请填写真实签到位置（GCJ-02）和地址");
  const form: Record<string, unknown> = { signPhotoUrl: "" };
  if (task.isNeedExtra !== undefined) form.isNeedExtra = task.isNeedExtra;
  if (Number(task.isNeedExtra) === 1) {
    const fields = task.extraField;
    if (!Array.isArray(fields) || !Array.isArray(account.forms) || account.forms.length < fields.length) throw new EngineError("请检查 forms 配置是否完整");
    const values: Array<{extraFieldItemValue:string;extraFieldItemWid:unknown}> = [];
    fields.forEach((field:any,index:number) => {
      const configured = account.forms![index].form;
      if (account.checkTitle === 1 && configured.title !== field.title) throw new EngineError(`第${index+1}个配置标题不匹配：配置[${configured.title}]，系统[${field.title}]`);
      let matched = false;
      for (const item of field.extraFieldItems ?? []) {
        if (item.content !== configured.value) continue;
        if (item.isOtherItems === 1 && configured.extra === undefined) throw new EngineError(`第${index+1}个选项需要 extra 字段`);
        values.push({extraFieldItemValue:item.isOtherItems === 1 ? configured.extra! : configured.value,extraFieldItemWid:item.wid});
        matched = true;
      }
      if (!matched) throw new EngineError(`第${index+1}个配置的选项未在任务中找到`);
    });
    form.extraFieldItems = values;
  }
  Object.assign(form, {
    signInstanceWid: task.signInstanceWid, longitude: account.lon, latitude: account.lat,
    isMalposition: task.isMalposition, abnormalReason: account.abnormalReason, position: account.address,
    uaIsCpadaily: true, signVersion: "1.0.0"
  });
  return form;
}
function rangeResult(task: any, signWid?: unknown): Result {
  const places = task.signPlaceSelected;
  if (!Array.isArray(places) || !places.length) return { status: "unsupported", message: "任务没有提供定位范围" };
  const ranges = places.map(p => ({ lon: Number(p.longitude), lat: Number(p.latitude), radius: Number(p.radius ?? 0), address: String(p.address ?? "") }))
    .filter(p => Number.isFinite(p.lon) && Math.abs(p.lon) <= 180 && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.radius));
  if(!ranges.length)return {status:"fail",message:"任务范围坐标无效"};
  return { status: "success", message: "签到范围已获取", data: { ...ranges[0],ranges,
    signInstanceWid:task.signInstanceWid,signWid,taskName: String(task.taskName ?? ""), window_begin: task.singleTaskBeginTime ?? "", window_end: task.singleTaskEndTime ?? "" } };
}
async function runExecution(account: Account, deviceId: string, mode: Mode, options: ExecutionOptions, trace: string[]): Promise<Result> {
  let submitted = Boolean(options.checkpoint);
  try { requireDeviceId(deviceId); }
  catch { return { status: "fail", message: "缺少或无效的手机原绑定 deviceId，未发起登录；请先迁移或提取真实 ID" }; }
  try {
    trace.push("步骤 1/5 登录（使用已保存的真实设备绑定）");
    const auth = await (options.loginFn ?? login)(account,new Session(fetch,options.httpTimeoutMs,options.runTimeoutMs));
    trace.push("登录成功；Cookie 与会话令牌不写入日志");
    if(mode === "login")return {status:"success",message:"登录成功",data:{host:auth.host,cookies:auth.session.jar.names()}};
    const api = paths(account.type);
    trace.push("步骤 2/5 查询任务与表单");
    const list = await tasks(auth, api.list, mode !== "range");
    if (options.checkpoint) {
      const signed = list.signedTasks.some((t: any) => String(t.signInstanceWid) === options.checkpoint!.signInstanceWid);
      if(signed)return { status: "success", message: "中断恢复后复查确认已签到" };
      if(list.unSignedTasks.some((t:any)=>String(t.signInstanceWid)===options.checkpoint!.signInstanceWid))
        return {status:"error",message:"中断恢复后复查确认任务仍未签到",retryable:true};
      return { status: "uncertain", message: "上次任务不在已签/未签列表，无法确认；已阻止再次提交，请在官方应用核实" };
    }
    const task = selectTask(list,account,mode);
    if(!task && mode==="range")return {status:"fail",message:"当天没有查到签到任务（未签到/已签到列表均为空）"};
    if (!task) return list.signedTasks.length ? { status: "already", message: "今日任务已签到，无需重复执行" } :
      { status: "no_task", message: "当前暂时没有未签到的任务哦！" };
    const detail = await auth.session.json(auth.host + api.detail, { signInstanceWid: task.signInstanceWid, signWid: task.signWid });
    if (!detail.datas) throw new EngineError("没有获取到任务详情");
    if (mode === "range") return rangeResult(detail.datas,task.signWid);
    const form = buildForm(account, detail.datas);
    trace.push("任务与附加表单检查通过；无需照片");
    trace.push("步骤 3/5 动态密钥协商");
    const key = await fetchSecret(auth.session, auth.tenantId, deviceId);
    trace.push("步骤 4/5 构造 iOS first_v4 加密请求（不记录密钥或密文）");
    const encrypted = signedBody(form, key);
    if (mode === "dry") return { status: "dry", message: "登录、任务及加密检查通过；未上传、未提交、未修改位置" };
    if (!options.beforeSubmit) throw new EngineError("缺少持久化提交保护，拒绝执行", "error");
    const checkpoint = { signInstanceWid: String(task.signInstanceWid), signWid: String(task.signWid) };
    await options.beforeSubmit(checkpoint);
    submitted = true;
    trace.push("步骤 5/5 提交签到");
    try {
      const cookie = ["clientType=cpdaily_student", `sessionToken=${auth.sessionToken}`, "standAlone=0", `tenantId=${auth.tenantId}`];
      const mod = auth.session.jar.get("MOD_AUTH_CAS", auth.host);
      if (mod) cookie.push(`MOD_AUTH_CAS=${mod}`);
      const result = await auth.session.json(auth.host + api.submit, {
        lon: account.lon, lat: account.lat, version: "first_v4", calVersion: "firstv", deviceId, userId: account.username,
        systemName: "iOS", systemVersion: "18.2", model: "iPhone 16 Pro", appVersion: "9.9.22", ...encrypted
      }, { "User-Agent":IOS_UA, deviceType: "2", CpdailyClientType: "CPDAILY", Accept: "*/*", CacheTimeValue: "0", sessionTokenKey: auth.sessionToken,
        "Accept-Language": "zh-Hans-CN", tenantId: auth.tenantId, CpdailyStandAlone: "0", Cookie: cookie.join("; ") });
      const message = String(result.message ?? "").slice(0, 200);
      if (message === "SUCCESS") return { status: "success", message: "签到成功" };
      if (/已签|重复/.test(message)) return { status: "already", message: "上游确认已签到" };
      return { status: "fail", message: message || "上游拒绝提交（未提供原因）" };
    } catch {
      trace.push("提交响应异常，等待后复查任务状态");
      await new Promise(resolve=>setTimeout(resolve,options.confirmDelayMs ?? 3000));
      try {
        const current = await tasks(auth, api.list);
        if (current.signedTasks.some((t: any) => String(t.signInstanceWid) === checkpoint.signInstanceWid))
          return { status: "success", message: "提交响应异常，但复查确认已签到" };
        if (current.unSignedTasks.some((t:any)=>String(t.signInstanceWid)===checkpoint.signInstanceWid))
          return {status:"error",message:"提交请求异常，复查确认任务仍未签到",retryable:true};
      } catch {}
      return { status: "uncertain", message: "提交响应异常且未确认状态；不自动重试，请在官方应用核实" };
    }
  } catch (e) {
    if (submitted) return { status: "uncertain", message: "中断任务的提交状态无法确认，请人工核实，不自动重新提交" };
    if (e instanceof EngineError) return { status: e.status, message: e.message, retryable: e.retryable };
    return { status: "error", message: "执行失败，请检查配置或协议兼容性", retryable: false };
  }
}
export async function execute(account: Account, deviceId: string, mode: Mode, options: ExecutionOptions = {}): Promise<Result> {
  const trace: string[] = [];
  const result = await runExecution(account,deviceId,mode,options,trace);
  return {...result,detail:[...trace,result.message].join("\n")};
}
