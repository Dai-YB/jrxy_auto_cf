import { AppError, type Env } from "./types";

export const SLOT_GATE="execution-slots-v1";
export type WorkKind="job"|"enrollment";
// 旧Worker只认识execution_gate；新执行位持有兼容门闩，阻止滚动升级期间旧消费者绕过容量。
export function expireSlots(env:Env,now:number):D1PreparedStatement {
  return env.DB.prepare("UPDATE execution_slots SET kind=NULL,task_id=NULL,owner=NULL,lease_until=0,delivery_token=NULL WHERE lease_until<=?").bind(now);
}
export function slotGate(env:Env,now:number,lease:number):D1PreparedStatement {
  return env.DB.prepare(`UPDATE execution_gate SET owner=?,lease_until=max(lease_until,?) WHERE id=1 AND (lease_until<=? OR owner=?)`)
    .bind(SLOT_GATE,lease,now,SLOT_GATE);
}
export function slotClaim(env:Env,kind:WorkKind,id:string,owner:string|null,now:number,lease:number,deliveryToken:string|null=null):D1PreparedStatement {
  // 升级前已开始的授权验证没有执行位，也应暂时计入共享容量。
  const legacy=`(SELECT count(*) FROM enrollment_attempts e WHERE e.status='verifying' AND e.lease_until>${Math.trunc(now)}
    AND NOT EXISTS(SELECT 1 FROM execution_slots x WHERE x.kind='enrollment' AND x.task_id=e.id AND x.lease_until>${Math.trunc(now)}))`;
  return env.DB.prepare(`UPDATE execution_slots SET kind=?,task_id=?,owner=?,lease_until=?,delivery_token=coalesce(?,delivery_token) WHERE id=(
    SELECT s.id FROM execution_slots s WHERE
      ((? IS NOT NULL AND s.kind=? AND s.task_id=? AND s.owner IS NULL AND s.lease_until>?) OR
       (s.lease_until<=? AND NOT EXISTS(SELECT 1 FROM execution_slots x WHERE x.kind=? AND x.task_id=? AND x.lease_until>?)
        AND (SELECT count(*) FROM execution_slots x WHERE x.lease_until>?)+${legacy}<(SELECT parallelism FROM execution_settings WHERE id=1)))
      AND (SELECT count(*) FROM execution_slots x WHERE x.owner IS NOT NULL AND x.lease_until>?)+${legacy}<(SELECT parallelism FROM execution_settings WHERE id=1)
      AND (? IS NULL OR ? IS NULL OR (s.kind=? AND s.task_id=? AND s.delivery_token=?))
      AND EXISTS(SELECT 1 FROM execution_gate WHERE id=1 AND owner=?)
    ORDER BY CASE WHEN s.kind=? AND s.task_id=? AND s.lease_until>? THEN 0 ELSE 1 END,s.id LIMIT 1) RETURNING id`)
    .bind(kind,id,owner,lease,deliveryToken,owner,kind,id,now,now,kind,id,now,now,now,owner,deliveryToken,kind,id,deliveryToken,SLOT_GATE,kind,id,now);
}
export function ownsSlotSql(kind:WorkKind):string {
  return `EXISTS(SELECT 1 FROM execution_slots s WHERE s.kind='${kind}' AND s.task_id=? AND s.owner=? AND s.lease_until>?)`;
}
export async function reserveSlot(env:Env,kind:WorkKind,id:string,now=Date.now(),due=now,deliveryToken:string|null=null):Promise<boolean> {
  const lease=Math.max(now,due)+120000;
  const result=await env.DB.batch([expireSlots(env,now),slotGate(env,now,lease),slotClaim(env,kind,id,null,now,lease,deliveryToken)]);
  const reserved=result[2].results.length>0;
  if(!reserved)await syncGate(env);
  return reserved;
}
export async function releaseSlot(env:Env,kind:WorkKind,id:string,owner:string|null,deliveryToken:string|null=null):Promise<void> {
  await env.DB.prepare("UPDATE execution_slots SET kind=NULL,task_id=NULL,owner=NULL,lease_until=0,delivery_token=NULL WHERE kind=? AND task_id=? AND owner IS ? AND (? IS NULL OR delivery_token=?)")
    .bind(kind,id,owner,deliveryToken,deliveryToken).run();
  await syncGate(env);
}
export async function syncGate(env:Env):Promise<void> {
  // 一个SQL快照同步最长租约，不能用JS先读后写覆盖同时领取的新owner。
  await env.DB.prepare(`UPDATE execution_gate SET lease_until=coalesce((SELECT max(lease_until) FROM execution_slots),0),
    owner=CASE WHEN coalesce((SELECT max(lease_until) FROM execution_slots),0)>? THEN ? ELSE NULL END WHERE id=1 AND owner=?`)
    .bind(Date.now(),SLOT_GATE,SLOT_GATE).run();
}
export async function executionView(env:Env):Promise<unknown> {
  const now=Date.now();
  const settings=await env.DB.prepare("SELECT parallelism FROM execution_settings WHERE id=1").first<{parallelism:number}>();
  const active=await env.DB.prepare("SELECT count(*) AS n FROM execution_slots WHERE owner IS NOT NULL AND lease_until>?").bind(now).first<{n:number}>();
  const waiting=await env.DB.prepare(`SELECT (SELECT count(*) FROM jobs WHERE status='pending' OR report_pending=1)+
    (SELECT count(*) FROM enrollment_attempts WHERE status IN('pending','ready') AND expires_at>?) AS n`).bind(now).first<{n:number}>();
  return {parallelism:settings?.parallelism??1,active:active?.n??0,waiting:waiting?.n??0,maxParallelism:3};
}
export async function updateExecution(env:Env,body:Record<string,unknown>):Promise<unknown> {
  const n=body.parallelism;
  if(typeof n!=="number"||!Number.isInteger(n)||n<1||n>3)throw new AppError("并发上限只能为1、2或3");
  await env.DB.batch([
    env.DB.prepare("UPDATE execution_settings SET parallelism=? WHERE id=1").bind(n),
    env.DB.prepare("INSERT INTO sign_log(ts,kind,result,detail) VALUES(?,'执行设置','并发上限已更新',?)").bind(Date.now(),`最大同时执行${n}个账号；已开始任务自然结束，免费额度仍需监测`)
  ]);
  return executionView(env);
}
