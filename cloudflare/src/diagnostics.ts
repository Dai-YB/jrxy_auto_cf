import type { RequestDiagnostic, RequestStage } from "./types";

const stages: RequestStage[] = ["request","tenant_list","tenant_info","portal","login_form","login_ticket","captcha_check","login_submit","login_callback","task_list","task_detail","secret","submit","confirmation","setup"];
const kinds: RequestDiagnostic["kind"][] = ["timeout","total_timeout","transport","body_read","response_processing","http","response","request_limit","redirect_limit","policy","internal"];
// 仅保存白名单元数据；绝不序列化Error、URL、请求/响应内容。
export function safeDiagnostic(value: unknown, privateValues: string[] = []): RequestDiagnostic | null {
  if (!value || typeof value !== "object") return null;
  const input=value as Record<string,unknown>;
  if (!stages.includes(input.stage as RequestStage) || !kinds.includes(input.kind as RequestDiagnostic["kind"])) return null;
  const result: RequestDiagnostic={stage:input.stage as RequestStage,kind:input.kind as RequestDiagnostic["kind"]};
  const host=input.host;
  if (typeof host==="string" && host.length<=253 && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(host) &&
      !privateValues.some(secret=>secret && host.toLowerCase().includes(secret.toLowerCase()))) result.host=host.toLowerCase();
  if (["GET","POST","HEAD"].includes(String(input.method))) result.method=input.method as RequestDiagnostic["method"];
  if (["send","headers","body","decode","json"].includes(String(input.phase))) result.phase=input.phase as RequestDiagnostic["phase"];
  if (Number.isInteger(input.httpStatus) && Number(input.httpStatus)>=100 && Number(input.httpStatus)<=599) result.httpStatus=Number(input.httpStatus);
  for(const key of ["elapsedMs","sessionElapsedMs","idleMs","timeoutMs"] as const)
    if(Number.isFinite(input[key])&&Number(input[key])>=0)result[key]=Math.min(600000,Math.round(Number(input[key])));
  for(const [key,max] of [["requestIndex",41],["redirectCount",10],["receivedBytes",2097152]] as const)
    if(Number.isSafeInteger(input[key])&&Number(input[key])>=0)result[key]=Math.min(max,Number(input[key]));
  return result;
}
