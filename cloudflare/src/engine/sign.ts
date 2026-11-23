// 签到与查寝适配自 jrxy-engine/actions/autoSign.py、scripts/merged_ios_v4_submit.py（MPL-2.0）。
import { type Account, type Mode, type Result, EngineError } from "../types";
import { fetchSecret, signedBody } from "./crypto";
import { login, type Login } from "./login";
import { requireDeviceId } from "./device";
import { IOS_UA, Session } from "./http";
import { localTime } from "../config";
import { safeDiagnostic } from "../diagnostics";

export interface Checkpoint { signInstanceWid: string; signWid: string; }
export interface ExecutionOptions {
  checkpoint?: Checkpoint;
  target?: Checkpoint;
  onTarget?: (target: Checkpoint) => Promise<void>;
  timezone?: number;
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
function rejected(response: any): boolean {
  if (!response || typeof response!=="object" || Array.isArray(response)) return true;
  if (response.success===false) return true;
  return response.code!==undefined && ![0,"0",200,"200","SUCCESS"].includes(response.code);
}
async function tasks(auth: Login, path: string, warmup = false): Promise<any> {
  if (warmup) await auth.session.request(auth.host + path,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  const response = await auth.session.json(auth.host + path, {});
  if(rejected(response))throw new EngineError("任务列表接口返回业务异常，不能判为暂无任务","error",true);
  const data=response.datas;
  if(!data || !Array.isArray(data.unSignedTasks) || !Array.isArray(data.leaveTasks))
    throw new EngineError("任务列表结构不完整，未签或请假列表缺失，不能判为暂无任务","error",true);
  for(const key of ["unSignedTasks","leaveTasks","signedTasks","registerLeaveTasks"]){
    if(data[key]!==undefined && (!Array.isArray(data[key]) || data[key].some((item:any)=>!item||typeof item!=="object"||!item.signInstanceWid)))
      throw new EngineError("任务列表结构异常，已停止执行","error",true);
  }
  return {...data,signedTasks:data.signedTasks??[],registerLeaveTasks:data.registerLeaveTasks??[]};
}
function listEvidence(list:any,account:Account,trace:string[],timezone=8):void {
  trace.push(`任务查询：${account.type===1?"签到":"查寝"}；${localTime(Date.now(),timezone)}（UTC${timezone>=0?"+":""}${timezone}）；未签${list.unSignedTasks.length}、请假${list.leaveTasks.length}、已签${list.signedTasks.length}、登记请假${list.registerLeaveTasks.length}`);
}
function transient(error:unknown):boolean {
  return error instanceof EngineError && Boolean(error.retryable) && Boolean(error.diagnostic&&["timeout","total_timeout","transport","body_read","http"].includes(error.diagnostic.kind));
}
function verification(list:any,target:Checkpoint):Result {
  const matches=(item:any)=>String(item.signInstanceWid)===target.signInstanceWid;
  if(list.signedTasks.some(matches))return {status:"success",message:"复查确认原提交任务已签到",submissionState:"signed"};
  if([...list.unSignedTasks,...list.leaveTasks].some(matches))return {status:"error",message:"复查确认原任务仍未签到，可在后续执行中重试",retryable:true,retryAction:"execute",submissionState:"unsigned"};
  return {status:"uncertain",message:"原提交任务未出现在已签或待签列表，尚不能确认；后续只复查，不重复提交",retryable:true,retryAction:"verify",submissionState:"unknown"};
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
  catch { return { status: "fail", message: "已保存的 deviceId 缺失或格式无效，未发起登录；请检查账号设备配置" }; }
  try {
    trace.push("步骤 1/5 登录（使用已保存的固定设备标识）");
    const auth = await (options.loginFn ?? login)(account,new Session(fetch,options.httpTimeoutMs,options.runTimeoutMs),mode);
    trace.push("登录成功；Cookie 与会话令牌不写入日志");
    if(mode === "login")return {status:"success",message:"登录成功",data:{host:auth.host,cookies:auth.session.jar.names()}};
    const api = paths(account.type);
    trace.push("步骤 2/5 查询任务与表单");
    auth.session.at?.("task_list");
    const list = await tasks(auth, api.list, mode !== "range");
    listEvidence(list,account,trace,options.timezone);
    if (options.checkpoint) {
      trace.push("本次仅核对上次提交的原任务，不再次提交");
      return verification(list,options.checkpoint);
    }
    let task=selectTask(list,account,mode);
    if(options.target){
      const matches=(item:any)=>String(item.signInstanceWid)===options.target!.signInstanceWid;
      if(list.signedTasks.some(matches))return {status:"already",message:"查询确认原目标任务已签到",submissionState:"signed"};
      task=[...list.unSignedTasks,...list.leaveTasks].find(matches);
      if(!task)return {status:"error",message:"原目标任务已不在当前列表，可能窗口变化；未确认已签，不计为成功",retryable:true,retryAction:"execute"};
    }
    if(!task && mode==="range")return {status:"fail",message:"当天没有查到签到任务（未签到/已签到列表均为空）"};
    if (!task) return list.signedTasks.length ? { status: "already", message: "当前列表只有已签任务，没有待签项；不代表未返回的任务已签到" } :
      { status: "no_task", message: "当前未查到待签任务（不是签到成功）；请核对官方任务窗口与签到类型" };
    const target={signInstanceWid:String(task.signInstanceWid),signWid:String(task.signWid)};
    if(mode==="submit")await options.onTarget?.(target);
    auth.session.at?.("task_detail");
    const detail = await auth.session.json(auth.host + api.detail, { signInstanceWid: task.signInstanceWid, signWid: task.signWid });
    if (rejected(detail)||!detail.datas||String(detail.datas.signInstanceWid)!==target.signInstanceWid) throw new EngineError("任务详情异常或与目标不一致，未提交签到","error",true);
    if (mode === "range") return rangeResult(detail.datas,task.signWid);
    const form = buildForm(account, detail.datas);
    trace.push("任务与附加表单检查通过；无需照片");
    trace.push("步骤 3/5 动态密钥协商");
    auth.session.at?.("secret");
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
      auth.session.at?.("submit");
      const result = await auth.session.json(auth.host + api.submit, {
        lon: account.lon, lat: account.lat, version: "first_v4", calVersion: "firstv", deviceId, userId: account.username,
        systemName: "iOS", systemVersion: "18.2", model: "iPhone 16 Pro", appVersion: "9.9.22", ...encrypted
      }, { "User-Agent":IOS_UA, deviceType: "2", CpdailyClientType: "CPDAILY", Accept: "*/*", CacheTimeValue: "0", sessionTokenKey: auth.sessionToken,
        "Accept-Language": "zh-Hans-CN", tenantId: auth.tenantId, CpdailyStandAlone: "0", Cookie: cookie.join("; ") },{timeoutMs:20000,ascii:false});
      const message = String(result?.message ?? "").slice(0, 200);
      if (message === "SUCCESS"&&!rejected(result)) return { status: "success", message: "签到成功",submissionState:"signed" };
      // 失败或“重复/处理中”文本均不足以解除检查点，先核对同一任务。
      if(message){
        trace.push("提交未明确成功，核对原任务状态，不凭文本判成功或解除提交保护");
        auth.session.at?.("confirmation");
        const current=await tasks(auth,api.list);listEvidence(current,account,trace,options.timezone);
        const checked=verification(current,checkpoint);
        if(checked.submissionState==="unsigned")return {status:"fail",message,submissionState:"unsigned"};
        return checked;
      }
      throw new EngineError("提交响应缺少结果，需核对原任务","error",true);
    } catch (error) {
      const diagnostic=error instanceof EngineError?error.diagnostic:undefined;
      if(diagnostic?.httpStatus===418||diagnostic?.httpStatus===429)return {status:"uncertain",message:"提交期间上游限制访问，已停止自动请求；请人工核实原任务",retryable:false,retryAction:"verify",submissionState:"unknown",diagnostic};
      trace.push("提交响应异常，等待后复查任务状态");
      await new Promise(resolve=>setTimeout(resolve,options.confirmDelayMs ?? 3000));
      try {
        auth.session.at?.("confirmation");
        const current = await tasks(auth, api.list);listEvidence(current,account,trace,options.timezone);
        return {...verification(current,checkpoint),transientFailure:transient(error),diagnostic};
      } catch (confirmationError) {
        const retryable=!(confirmationError instanceof EngineError)||confirmationError.retryable;
        return { status: "uncertain", message: "提交状态仍未确认；后续只复查原任务，不盲目重复提交",retryable,retryAction:"verify",submissionState:"unknown",
          transientFailure:transient(error)||transient(confirmationError),diagnostic:confirmationError instanceof EngineError?confirmationError.diagnostic:diagnostic };
      }
    }
  } catch (e) {
    const diagnostic=e instanceof EngineError?e.diagnostic:undefined;
    if (submitted) return { status: "uncertain", message: "未能确认上次提交状态；保留原任务检查点，后续只复查",retryable:e instanceof EngineError&&e.retryable,retryAction:"verify",submissionState:"unknown",transientFailure:transient(e),diagnostic };
    if (e instanceof EngineError) return { status: e.status, message: e.message, retryable: e.retryable,retryAction:e.retryable?"execute":undefined,transientFailure:transient(e),diagnostic };
    return { status: "error", message: "执行失败，请检查配置或协议兼容性", retryable: false };
  }
}
export async function execute(account: Account, deviceId: string, mode: Mode, options: ExecutionOptions = {}): Promise<Result> {
  const trace: string[] = [];
  const result = await runExecution(account,deviceId,mode,options,trace);
  const diagnostic=safeDiagnostic(result.diagnostic,[account.password,account.username,account.displayName??"",account.notifyOption?.rcvOption??account.notifyKey]);
  if(diagnostic)trace.push(`上游诊断：${JSON.stringify(diagnostic)}`);
  return {...result,diagnostic:diagnostic??undefined,detail:[...trace,result.message].join("\n")};
}
