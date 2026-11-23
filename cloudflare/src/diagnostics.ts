import { LABELS, type ExecutionReport, type RequestDiagnostic, type RequestStage, type RequestTrace } from "./types";

const stages: RequestStage[] = ["request","tenant_list","tenant_info","portal","login_form","login_ticket","captcha_check","login_submit","login_callback","task_list","task_detail","secret","submit","confirmation","setup"];
const kinds: RequestDiagnostic["kind"][] = ["timeout","total_timeout","transport","body_read","response_processing","http","response","request_limit","redirect_limit","policy","internal"];
// 仅保存白名单元数据；绝不序列化Error、URL、请求/响应内容。
export function safeDiagnostic(value: unknown, privateValues: string[] = []): RequestDiagnostic | null {
  if (!value || typeof value !== "object") return null;
  const input=value as Record<string,unknown>;
  if (!stages.includes(input.stage as RequestStage) || !kinds.includes(input.kind as RequestDiagnostic["kind"])) return null;
  const result: RequestDiagnostic={stage:input.stage as RequestStage,kind:input.kind as RequestDiagnostic["kind"]};
  const host=input.host;
  if (typeof host==="string" && host.length<=253 && !/^[\d.]+$/.test(host) && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(host) &&
      !privateValues.some(secret=>secret && host.toLowerCase().includes(secret.toLowerCase()))) result.host=host.toLowerCase();
  if (typeof input.method==="string"&&["GET","POST","HEAD"].includes(input.method)) result.method=input.method as RequestDiagnostic["method"];
  if (typeof input.phase==="string"&&["send","headers","body","decode","json"].includes(input.phase)) result.phase=input.phase as RequestDiagnostic["phase"];
  if (Number.isInteger(input.httpStatus) && Number(input.httpStatus)>=100 && Number(input.httpStatus)<=599) result.httpStatus=Number(input.httpStatus);
  for(const key of ["elapsedMs","sessionElapsedMs","idleMs","timeoutMs"] as const)
    if(Number.isFinite(input[key])&&Number(input[key])>=0)result[key]=Math.min(600000,Math.round(Number(input[key])));
  for(const [key,max] of [["requestIndex",41],["redirectCount",10],["receivedBytes",2097152]] as const)
    if(Number.isSafeInteger(input[key])&&Number(input[key])>=0)result[key]=Math.min(max,Number(input[key]));
  return result;
}

export const MAX_REQUEST_TRACE=41;
export const MAX_REPORT_BYTES=32768;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errorCodes=["ECONNRESET","ECONNREFUSED","ETIMEDOUT","ENOTFOUND","EAI_AGAIN","CERT_HAS_EXPIRED","ERR_TLS_CERT_ALTNAME_INVALID","UNABLE_TO_VERIFY_LEAF_SIGNATURE"];
export function transportErrorCode(value:unknown):RequestTrace["errorCode"]|undefined {
  if(!value||typeof value!=="object")return;
  const code=(value as {code?:unknown}).code;
  return typeof code==="string"&&errorCodes.includes(code)?code as RequestTrace["errorCode"]:undefined;
}
const timestamp=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=8640000000000000;
const integer=(value:unknown,min:number,max:number)=>Number.isInteger(value)&&Number(value)>=min&&Number(value)<=max;
export function safeRequestTrace(value:unknown,privateValues:string[]=[]):RequestTrace[] {
  if(!Array.isArray(value))return [];
  const traces:RequestTrace[]=[];
  for(const item of value.slice(0,MAX_REQUEST_TRACE)){
    if(!item||typeof item!=="object"||!timestamp(item.startedAt)||!["started","headers","completed","failed"].includes(item.outcome))continue;
    const diagnostic=safeDiagnostic({...item,kind:item.kind??"response"},privateValues);if(!diagnostic)continue;
    const {kind,...metadata}=diagnostic;
    const row:RequestTrace={...metadata,startedAt:item.startedAt,outcome:item.outcome};
    if(item.kind!==undefined)row.kind=kind;
    for(const key of ["headersMs","bodyMs"] as const)if(Number.isFinite(item[key])&&item[key]>=0)row[key]=Math.min(600000,Math.round(item[key]));
    if(["json","html","text","other"].includes(item.responseType))row.responseType=item.responseType;
    if(typeof item.rayId==="string"&&/^[a-f0-9]{16,32}-[A-Z]{3}$/i.test(item.rayId)&&!privateValues.some(secret=>secret&&item.rayId.toLowerCase().includes(secret.toLowerCase())))row.rayId=item.rayId;
    const code=transportErrorCode({code:item.errorCode});if(code)row.errorCode=code;
    traces.push(row);
  }
  return traces;
}
export function safeExecutionReport(value:unknown,privateValues:string[]=[]):ExecutionReport|null {
  if(!value||typeof value!=="object")return null;
  const input=value as Record<string,any>,network=input.network;
  if(input.schema!==1||typeof input.id!=="string"||!uuid.test(input.id)||!timestamp(input.startedAt)||!timestamp(input.finishedAt)||input.finishedAt<input.startedAt||
    !["dry","submit","login","range"].includes(input.mode)||!["manual","schedule"].includes(input.trigger)||typeof input.result!=="string"||!Object.hasOwn(LABELS,input.result)||
    !integer(input.attempt,1,100)||!integer(input.maxAttempts,1,11)||!integer(input.batchRound,1,100)||!integer(input.concurrencyLimit,1,3)||
    typeof input.verificationOnly!=="boolean"||typeof input.retryable!=="boolean"||!network||
    !integer(network.httpTimeoutMs,1,120000)||!integer(network.runTimeoutMs,1,600000)||network.submitTimeoutMs!==20000)return null;
  const report:ExecutionReport={schema:1,id:input.id,startedAt:input.startedAt,finishedAt:input.finishedAt,mode:input.mode,trigger:input.trigger,
    attempt:input.attempt,maxAttempts:input.maxAttempts,batchRound:input.batchRound,concurrencyLimit:input.concurrencyLimit,
    verificationOnly:input.verificationOnly,result:input.result as ExecutionReport["result"],retryable:input.retryable,
    network:{httpTimeoutMs:network.httpTimeoutMs,runTimeoutMs:network.runTimeoutMs,submitTimeoutMs:20000},
    requests:safeRequestTrace(input.requests,privateValues),truncated:input.truncated===true||Array.isArray(input.requests)&&input.requests.length>MAX_REQUEST_TRACE};
  if(typeof input.version==="string"&&uuid.test(input.version))report.version=input.version;
  const bytes=new TextEncoder();
  while(bytes.encode(JSON.stringify(report)).length>MAX_REPORT_BYTES&&report.requests.length){report.requests.shift();report.truncated=true;}
  return report;
}
