import { AppError, type Env, type Schedule } from "./types";
import { dispatch } from "./jobs";
import { requireConfigured } from "./security";
import { localTime, settings } from "./config";
export { localTime } from "./config";

const DAY = 86_400_000;
export function validateTime(time: string): void {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new AppError("时间格式应为 HH:MM");
}
export function todaySlot(time: string, now: number, offset = 8): number {
  validateTime(time);
  const [h, m] = time.split(":").map(Number);
  return Math.floor((now + offset * 3600_000) / DAY) * DAY - offset * 3600_000 + (h * 60 + m) * 60_000;
}
export function dueSlot(schedule: Schedule, now: number, catchup: number, offset = 8): number | null {
  if (!schedule.enabled) return null;
  let slot = todaySlot(schedule.time, now, offset);
  if (slot > now) slot -= DAY;
  return slot > schedule.effective_after && now - slot <= catchup * 60_000 ? slot : null;
}
export async function getSchedule(env: Env, now = Date.now()): Promise<Schedule> {
  let s = await env.DB.prepare("SELECT * FROM schedule WHERE id=1").first<Schedule>();
  if (!s) throw new AppError("请先执行 D1 数据库迁移", 503);
  if (!s.initialized) {
    const time = env.SIGN_TIME ?? "22:05";
    validateTime(time);
    await env.DB.prepare(`UPDATE schedule SET enabled=?,time=?,effective_after=?,initialized=1
      WHERE id=1 AND initialized=0`).bind(env.AUTO_SIGN === "1" ? 1 : 0, time, now).run();
    s = (await env.DB.prepare("SELECT * FROM schedule WHERE id=1").first<Schedule>())!;
  }
  return s;
}
export async function scheduleView(env: Env): Promise<Record<string, unknown>> {
  const now = Date.now();
  const cfg = settings(env);
  const s = await getSchedule(env, now);
  let next = todaySlot(s.time, now, cfg.timezone);
  if (next <= Math.max(now, s.effective_after)) next += DAY;
  return { enabled: Boolean(s.enabled), time: s.time, timezone: `UTC${cfg.timezone >= 0 ? "+" : ""}${cfg.timezone}`,
    next: s.enabled ? localTime(next, cfg.timezone) : null, last_slot: s.last_slot,
    last_run: s.last_run ? localTime(s.last_run, cfg.timezone) : null, last_result: s.last_result,
    note: "按分钟触发；已开始的批次会继续，后续重试与通知不依赖页面连接" };
}
export async function updateSchedule(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const s = await getSchedule(env);
  const enabled = body.enabled ?? Boolean(s.enabled);
  const time = body.time ?? s.time;
  if (typeof enabled !== "boolean" || typeof time !== "string") throw new AppError("请提供 enabled 和 time");
  validateTime(time);
  const now = Date.now();
  // 原线程版保存/停用计划不会中断 _fire 已开始的批次，队列版保持此行为。
  await env.DB.batch([
    env.DB.prepare("UPDATE schedule SET enabled=?,time=?,revision=revision+1,effective_after=?,initialized=1 WHERE id=1")
      .bind(enabled ? 1 : 0, time, now),
    env.DB.prepare("INSERT INTO sign_log(ts,kind,result,detail) VALUES(?,'定时更新','定时批量签到设置已更新',?)")
      .bind(now, `enabled=${enabled} time=${time}（UTC${settings(env).timezone >= 0 ? "+" : ""}${settings(env).timezone}）；已开始批次继续执行`)
  ]);
  return scheduleView(env);
}
export async function tick(env: Env, now = Date.now()): Promise<void> {
  requireConfigured(env);
  const cfg = settings(env);
  const s = await getSchedule(env, now);
  const slot = dueSlot(s, now, cfg.catchupMs / 60_000, cfg.timezone);
  if (slot !== null) {
    // 使用时间点作为唯一键，不用 revision 生成重复的同日批次。
    const id = `schedule:${slot}`;
    const label = now - slot < 120_000 ? "定时" : "定时补签";
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO batches(id,trigger,mode,label,created_at,round_due)
        SELECT ?,'schedule','submit',?,?,? WHERE EXISTS
        (SELECT 1 FROM schedule WHERE id=1 AND revision=? AND enabled=1 AND last_slot IS NOT ?)
        AND NOT EXISTS(SELECT 1 FROM batches WHERE trigger='schedule' AND finished_at IS NULL)`)
        .bind(id, label, now, now, s.revision, String(slot)),
      env.DB.prepare(`INSERT OR IGNORE INTO jobs(id,account,mode,trigger,max_attempts,next_at,created_at,trigger_label,batch_id,sequence_no,account_version)
        SELECT ? || ':' || name,name,'submit','schedule',?,?,?,?,?,ROW_NUMBER() OVER(ORDER BY name)-1,pause_version
        FROM accounts WHERE deleted=0 AND paused=0 AND resume_after<? AND EXISTS(SELECT 1 FROM batches WHERE id=? AND finished_at IS NULL)
        AND EXISTS(SELECT 1 FROM schedule WHERE id=1 AND revision=? AND enabled=1 AND last_slot IS NOT ?)`)
        .bind(id, cfg.maxAttempts, now, now, label, id, slot, id, s.revision, String(slot)),
      env.DB.prepare(`UPDATE schedule SET last_slot=? WHERE id=1 AND revision=? AND enabled=1
        AND EXISTS(SELECT 1 FROM batches WHERE id=?)`).bind(String(slot), s.revision, id),
      env.DB.prepare(`UPDATE batches SET finished_at=?,summary='没有可用账号',detail='' WHERE id=?
        AND NOT EXISTS(SELECT 1 FROM jobs WHERE batch_id=?)`).bind(now, id, id)
    ]);
  }
  await dispatch(env);
  if (Math.floor(now / 60_000) % 1440 === 0) await env.DB.batch([
    env.DB.prepare("DELETE FROM account_locks WHERE lease_until<?").bind(now),
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at<=?").bind(now)
  ]);
}
