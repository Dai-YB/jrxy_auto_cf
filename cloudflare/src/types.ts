export interface Env {
  DB: D1Database;
  JOBS: Queue<{ id: string; kind?: "enrollment" }>;
  ASSETS: Fetcher;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  ENCRYPTION_KEY: string;
  CATCHUP_MINUTES?: string;
  MAX_RETRIES?: string;
  RETRY_DELAY_SECONDS?: string;
  RETRY_DELAY_MINUTES?: string;
  NOTIFY_ON_DRY?: string;
  JRXY_INTERVAL?: string;
  JRXY_HTTP_TIMEOUT?: string;
  JRXY_RUN_TIMEOUT?: string;
  TZ_OFFSET?: string;
  SIGN_TIME?: string;
  AUTO_SIGN?: string;
}

export interface Account {
  displayName?: string;
  schoolName: string;
  username: string;
  password: string;
  type: 1 | 2;
  lon: number | null;
  lat: number | null;
  address: string;
  abnormalReason: string;
  notifyKey: string;
  notifyOption?: { method: number; rcvOption: string };
  checkTitle?: number;
  formTitle?: string;
  forms?: Array<{ form: { title?: string; value: string; extra?: string } }>;
  httpProxy?: string;
}
export interface AccountRow {
  name: string;
  config: string;
  device_id: string;
  deleted: number;
  created_at: number;
  paused: number;
  pause_version: number;
  resume_after: number;
  identity_key: string | null;
  grant_code_id: string | null;
  authorization_from: number | null;
  authorization_until: number | null;
}
export type Mode = "dry" | "submit" | "login" | "range";
export interface Result {
  status: "success" | "already" | "no_task" | "dry" | "fail" | "error" | "captcha" | "unsupported" | "uncertain" | "paused" | "expired";
  message: string;
  detail?: string;
  retryable?: boolean;
  data?: Record<string, unknown>;
}
export interface Job {
  id: string;
  account: string;
  mode: Mode;
  trigger: "manual" | "schedule";
  trigger_label: string;
  batch_id: string | null;
  sequence_no: number;
  status: "pending" | "running" | "done";
  attempts: number;
  max_attempts: number;
  next_at: number;
  created_at: number;
  finished_at: number | null;
  dispatched_at: number;
  lease_until: number;
  owner: string | null;
  checkpoint: string | null;
  result: string | null;
  notified: number;
  report_pending: number;
  attempt_started_at: number | null;
  recoveries: number;
  notification_result: string | null;
  account_version: number;
}
export interface Batch {
  id: string;
  trigger: "manual" | "schedule";
  mode: Mode;
  label: string;
  created_at: number;
  round: number;
  round_due: number;
  last_finished_at: number | null;
  finished_at: number | null;
  summary: string | null;
  detail: string | null;
  privacy_version: number;
}
export interface Schedule {
  id: number;
  enabled: number;
  time: string;
  revision: number;
  effective_after: number;
  last_slot: string | null;
  initialized?: number;
  last_run?: number | null;
  last_result?: string | null;
}

export class AppError extends Error {
  constructor(message: string, public code = 400) { super(message); }
}
export type RequestStage = "request" | "tenant_list" | "tenant_info" | "portal" | "login_form" | "login_ticket" | "captcha_check" | "login_submit" | "login_callback" | "setup";
export interface RequestDiagnostic {
  stage: RequestStage;
  kind: "timeout" | "total_timeout" | "transport" | "http" | "response" | "request_limit" | "redirect_limit" | "policy" | "internal";
  host?: string;
  method?: "GET" | "POST" | "HEAD";
  httpStatus?: number;
  elapsedMs?: number;
}
export class EngineError extends Error {
  constructor(message: string, public status: Result["status"] = "fail", public retryable = false, public diagnostic?: RequestDiagnostic) { super(message); }
}
export const LABELS: Record<Result["status"], string> = {
  success: "签到成功", already: "今日已签到", no_task: "暂无待签任务", dry: "探测通过",
  fail: "签到失败", error: "执行异常", captcha: "需要人工验证", unsupported: "任务不支持", uncertain: "提交状态待确认", paused: "账号已暂停", expired: "授权已到期"
};
export function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
