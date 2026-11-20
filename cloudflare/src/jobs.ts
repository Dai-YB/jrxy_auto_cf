import { execute, type Checkpoint } from "./engine/sign";
import { getAccount } from "./storage";
import { classify, notification, notifyHead, notifyOption, sendNotify } from "./notify";
import { redact, requireConfigured, seal } from "./security";
import { settings } from "./config";
import { accountValid } from "./identity";
import { cleanupExpiredAccounts } from "./expiry";
import { AppError, EngineError, type Batch, type Env, type Job, type Mode, type Result } from "./types";

export async function enqueue(env: Env, names: string[], mode: Mode, triggerLabel = "手动"): Promise<string[]> {
  requireConfigured(env);
  if (!names.length) return [];
  if(names.length===1)await getAccount(env,names[0]);
  if(mode==="submit" && names.length===1) {
    const account=await env.DB.prepare("SELECT paused FROM accounts WHERE name=? AND deleted=0").bind(names[0]).first<{paused:number}>();
    if(account?.paused)throw new AppError("账号已暂停，请恢复后再签到",409);
  }
  const now = Date.now();
  const batchId = crypto.randomUUID();
  // 一次 INSERT SELECT 建立整批快照，避免账号数量线性消耗免费版每次调用的数据库查询额度。
  const rows = await env.DB.batch<{id: string}>([
    env.DB.prepare("INSERT INTO batches(id,trigger,mode,label,created_at,round_due) VALUES(?,'manual',?,?,?,?)")
      .bind(batchId,mode,triggerLabel,now,now),
    env.DB.prepare(`INSERT INTO jobs(id,account,mode,trigger,next_at,created_at,trigger_label,batch_id,sequence_no,account_version)
      SELECT ? || ':' || a.name,a.name,?,'manual',?,?,?,?,CAST(n.key AS INTEGER),a.pause_version
      FROM json_each(?) n JOIN accounts a ON a.name=n.value WHERE a.deleted=0 AND (a.authorization_until IS NULL OR a.authorization_until>?) AND (?!='submit' OR a.paused=0) AND NOT EXISTS
      (SELECT 1 FROM jobs WHERE account=a.name AND (status!='done' OR report_pending=1)) RETURNING id`)
      .bind(batchId,mode,now,now,triggerLabel,batchId,JSON.stringify(names),now,mode)
  ]);
  const ids = rows.slice(1).flatMap(row => row.results.map(value => String(value.id)));
  if (!ids.length) {
    await env.DB.prepare("DELETE FROM batches WHERE id=?").bind(batchId).run();
    if (names.length === 1) throw new AppError("账号不存在或已有待执行任务", 409);
  }
  return ids;
}

export async function advanceBatch(env: Env, id: string, now = Date.now()): Promise<void> {
  const batch = await env.DB.prepare("SELECT * FROM batches WHERE id=? AND finished_at IS NULL").bind(id).first<Batch>();
  if (!batch) return;
  const jobs = (await env.DB.prepare("SELECT * FROM jobs WHERE batch_id=? ORDER BY sequence_no").bind(id).all<Job>()).results;
  if (jobs.some(j => j.report_pending || j.status === "running")) return;
  if (jobs.length && jobs.every(j => j.status === "done")) {
    const counts: Record<string, number> = {};
    const lines = jobs.map(job => {
      const result = job.result ? classify(JSON.parse(job.result)) : "执行异常";
      const head = notifyHead(result);
      counts[head] = (counts[head] ?? 0) + 1;
      return `${job.account}：${result}`;
    });
    const summary = Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(" / ");
    const detail = lines.join("\n");
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO sign_log(ts,kind,result,detail,batch_id) SELECT ?,?,?,?,id FROM batches
        WHERE id=? AND privacy_version=? AND finished_at IS NULL AND (trigger='schedule' OR label='批量')`)
        .bind(now, `${batch.label}汇总`, summary, detail.slice(-4000), id,batch.privacy_version),
      env.DB.prepare(`UPDATE schedule SET last_run=?,last_result=? WHERE id=1 AND EXISTS
        (SELECT 1 FROM batches WHERE id=? AND privacy_version=? AND trigger='schedule' AND finished_at IS NULL)`)
        .bind(batch.created_at, summary, id,batch.privacy_version),
      env.DB.prepare("UPDATE batches SET finished_at=?,summary=?,detail=? WHERE id=? AND privacy_version=? AND finished_at IS NULL")
        .bind(now, summary, detail, id,batch.privacy_version)
    ]);
    void results;
    return;
  }
  const pending = jobs.filter(j => j.status === "pending");
  if (!pending.length || pending.some(j => j.attempts < batch.round)) return;
  // 整轮结束后才开始重试等待，不让失败账号抢在本轮剩余账号之前重试。
  const nextRound = Math.min(...pending.map(j => j.attempts + 1));
  const due = Math.max(now + settings(env).retryMs, ...pending.map(j => j.next_at));
  await env.DB.batch([
    env.DB.prepare(`UPDATE jobs SET next_at=max(next_at,?),dispatched_at=0 WHERE batch_id=? AND status='pending'
      AND EXISTS(SELECT 1 FROM batches WHERE id=? AND round=? AND finished_at IS NULL)`)
      .bind(due, id, id, batch.round),
    env.DB.prepare("UPDATE batches SET round=?,round_due=? WHERE id=? AND round=? AND finished_at IS NULL")
      .bind(nextRound, due, id, batch.round)
  ]);
}

export async function dispatch(env: Env): Promise<void> {
  requireConfigured(env);
  const now = Date.now();
  await env.DB.prepare(`UPDATE jobs SET status='pending',owner=NULL,dispatched_at=0,next_at=?,recoveries=recoveries+1,attempts=max(attempts-1,0)
    WHERE status='running' AND report_pending=0 AND lease_until<?`).bind(now, now).run();
  const active = await env.DB.prepare(`SELECT b.id FROM batches b WHERE b.finished_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.batch_id=b.id AND
      (j.report_pending=1 OR j.status='running' OR (j.status='pending' AND j.attempts<b.round)))
    ORDER BY b.created_at LIMIT 1`).all<{ id: string }>();
  for (const batch of active.results) await advanceBatch(env, batch.id, now);
  const gate = await env.DB.prepare("SELECT lease_until FROM execution_gate WHERE id=1").first<{ lease_until: number }>();
  if ((gate?.lease_until ?? 0) > now) return;
  // 每次只派发全局最早的可执行账号，数据库栅栏兜底队列乱序/重复投递。
  const job = await env.DB.prepare(`SELECT j.*,b.round_due FROM jobs j JOIN batches b ON b.id=j.batch_id
    WHERE b.finished_at IS NULL AND (
      (j.report_pending=1 AND j.lease_until<=?) OR
      (j.status='pending' AND j.report_pending=0 AND j.next_at<=? AND b.round_due<=?
        AND j.attempts<b.round AND NOT EXISTS(SELECT 1 FROM jobs p WHERE p.batch_id=j.batch_id
          AND p.sequence_no<j.sequence_no AND (p.status='running' OR p.report_pending=1 OR (p.status!='done' AND p.attempts<b.round)))))
    ORDER BY j.report_pending DESC,b.created_at,j.sequence_no LIMIT 1`).bind(now, now + 60_000, now + 60_000).first<Job & {round_due: number}>();
  if (!job) return;
  const due = job.report_pending ? now : Math.max(now,job.next_at,job.round_due);
  const claimed = await env.DB.prepare(`UPDATE jobs SET dispatched_at=? WHERE id=? AND dispatched_at<?
    AND (status='pending' OR report_pending=1) RETURNING id`).bind(due, job.id, now - 120_000).first();
  if (!claimed) return;
  try {
    const delaySeconds = Math.ceil((due-now)/1000);
    if(delaySeconds)await env.JOBS.send({id:job.id},{delaySeconds});
    else await env.JOBS.send({id:job.id});
  } catch { await env.DB.prepare("UPDATE jobs SET dispatched_at=0 WHERE id=? AND dispatched_at=?").bind(job.id, due).run(); }
}

async function finishReport(env: Env, job: Job, owner: string): Promise<void> {
  const eligibility=await env.DB.prepare("SELECT deleted,authorization_until FROM accounts WHERE name=?").bind(job.account).first<{deleted:number;authorization_until:number|null}>();
  if(!eligibility || !accountValid(eligibility))return;
  let result = JSON.parse(job.result!) as Result;
  let retry = job.status === "pending";
  // 报告阶段也要核对暂停版本，避免暂停发生在重试结果落盘之后而旧任务仍显示为待重试。
  if(retry && job.mode==="submit") {
    const state=await env.DB.prepare("SELECT paused,pause_version FROM accounts WHERE name=? AND deleted=0").bind(job.account).first<{paused:number;pause_version:number}>();
    if(!state || state.paused || state.pause_version!==job.account_version) {
      result={status:"paused",message:"账号已暂停或恢复过，旧重试任务已取消"};
      const saved=await env.DB.prepare(`UPDATE jobs SET status='done',result=?,finished_at=?,notification_result=NULL
        WHERE id=? AND owner=? AND report_pending=1 AND status='pending' RETURNING id`)
        .bind(JSON.stringify(result),Date.now(),job.id,owner).first();
      if(!saved)return;
      retry=false;job.notification_result=null;
    }
  }
  const action = job.mode === "dry" ? "探测" : job.mode === "submit" ? "签到" : job.mode === "login" ? "登录测试" : "范围获取";
  const trigger = job.trigger === "schedule" && job.attempts > 1 ? `定时重试${job.attempts - 1}` : job.trigger_label;
  let push = job.notification_result ?? "";
  if (!job.notification_result) {
    if (result.status === "paused") push = "推送跳过（账号暂停，不发送签到失败通知）";
    else if (job.mode === "dry" && env.NOTIFY_ON_DRY !== "1") push = "推送跳过（探测默认不推送，可设 NOTIFY_ON_DRY=1）";
    else if (retry) push = `推送跳过（执行异常，${settings(env).retryMs / 60_000} 分钟后重试）`;
    else if (job.mode === "dry" || job.mode === "submit") {
      const notifyClaim = await env.DB.prepare(`UPDATE jobs SET notified=1 WHERE id=? AND owner=? AND notified=0
        AND report_pending=1 AND EXISTS(SELECT 1 FROM accounts a WHERE a.name=jobs.account AND a.deleted=0 AND (a.authorization_until IS NULL OR a.authorization_until>?)) RETURNING id`).bind(job.id, owner,Date.now()).first();
      if (notifyClaim) {
        try {
          const { account } = await getAccount(env, job.account);
          const content = notification(job.account, result, trigger, job.mode === "dry",
            job.attempt_started_at ?? job.created_at, job.finished_at ?? Date.now(), settings(env).timezone);
          push = await sendNotify(account, content.title, content.message);
        } catch { push = "推送失败：无法读取账号通知配置"; }
      } else {
        // 外部推送没有幂等键，崩溃时无法证明是否已送达，不冒充成功或重复发送。
        push = "推送状态未知：上次发送期间中断，为避免重复推送未再次发送";
      }
    }
    await env.DB.prepare("UPDATE jobs SET notification_result=? WHERE id=? AND owner=? AND report_pending=1")
      .bind(push, job.id, owner).run();
  }
  const now = Date.now();
  const label = job.mode === "login" ? (result.status === "success" ? "登录成功" : "登录失败")
    : job.mode === "range" ? (result.status === "success" ? "签到范围已获取并应用" : "范围获取失败") : classify(result);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sign_log(ts,account,kind,result,detail,batch_id) SELECT ?,account,?,?,?,batch_id FROM jobs
      WHERE id=? AND owner=? AND report_pending=1 AND EXISTS(SELECT 1 FROM accounts a WHERE a.name=jobs.account AND a.deleted=0 AND (a.authorization_until IS NULL OR a.authorization_until>?))`)
      .bind(now, `${trigger}${action}[${job.account}]`, label, ((result.detail || result.message) + (push ? `\n\n[${push}]` : "")).slice(-4000), job.id, owner,now),
    env.DB.prepare(`UPDATE batches SET last_finished_at=? WHERE id=? AND EXISTS
      (SELECT 1 FROM jobs WHERE id=? AND owner=? AND report_pending=1)`).bind(now, job.batch_id, job.id, owner),
    env.DB.prepare(`UPDATE jobs SET next_at=max(next_at,?),dispatched_at=0 WHERE batch_id=? AND status='pending'
      AND EXISTS(SELECT 1 FROM jobs p WHERE p.id=? AND p.owner=? AND p.report_pending=1)`)
      .bind(now + settings(env).intervalMs, job.batch_id, job.id, owner),
    env.DB.prepare("UPDATE jobs SET report_pending=0,owner=NULL,lease_until=0,dispatched_at=0 WHERE id=? AND owner=? AND report_pending=1")
      .bind(job.id, owner)
  ]);
  await advanceBatch(env, job.batch_id!, now);
}

export async function processJob(env: Env, id: string, run = execute): Promise<void> {
  requireConfigured(env);
  const now = Date.now();
  const owner = crypto.randomUUID();
  const cfg = settings(env);
  const lease = now + cfg.runTimeoutMs + 60_000;
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first<Job>();
  if (!job || (job.status === "done" && !job.report_pending) || job.lease_until > now) return;
  const eligibility=await env.DB.prepare("SELECT deleted,authorization_until FROM accounts WHERE name=?").bind(job.account).first<{deleted:number;authorization_until:number|null}>();
  if(!eligibility||!accountValid(eligibility,now)){await cleanupExpiredAccounts(env,now);return;}
  const batch = await env.DB.prepare("SELECT * FROM batches WHERE id=?").bind(job.batch_id).first<Batch>();
  if (!batch || batch.finished_at) return;
  if (!job.report_pending && (job.status !== "pending" || job.next_at > now || batch.round_due > now || job.attempts >= batch.round)) return;
  const claimed = await env.DB.batch([
    env.DB.prepare("UPDATE execution_gate SET owner=?,lease_until=? WHERE id=1 AND lease_until<=?").bind(owner, lease, now),
    env.DB.prepare(`INSERT INTO account_locks(account,job_id,owner,lease_until)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM execution_gate WHERE id=1 AND owner=?)
      ON CONFLICT(account) DO UPDATE SET job_id=excluded.job_id,owner=excluded.owner,lease_until=excluded.lease_until
      WHERE account_locks.lease_until<=?`).bind(job.account, id, owner, lease, owner, now),
    env.DB.prepare(`UPDATE jobs SET status=CASE WHEN report_pending=1 THEN status ELSE 'running' END,owner=?,lease_until=?,
      attempts=attempts+CASE WHEN report_pending=1 THEN 0 ELSE 1 END,
      attempt_started_at=CASE WHEN report_pending=1 THEN attempt_started_at ELSE ? END
      WHERE id=? AND lease_until<=? AND (report_pending=1 OR (status='pending' AND next_at<=? AND
        EXISTS(SELECT 1 FROM batches b WHERE b.id=jobs.batch_id AND b.finished_at IS NULL AND b.round_due<=? AND jobs.attempts<b.round
          AND NOT EXISTS(SELECT 1 FROM jobs p WHERE p.batch_id=b.id AND p.sequence_no<jobs.sequence_no
            AND (p.status='running' OR p.report_pending=1 OR (p.status!='done' AND p.attempts<b.round))))))
      AND EXISTS(SELECT 1 FROM execution_gate WHERE id=1 AND owner=?)
      AND EXISTS(SELECT 1 FROM account_locks WHERE account=? AND owner=?) RETURNING *`)
      .bind(owner, lease, now, id, now, now, now, owner, job.account, owner)
  ]);
  const current = claimed[2].results[0] as unknown as Job | undefined;
  if (!current) {
    await release(env, job.account, owner);
    return;
  }
  try {
    if (!current.report_pending) {
      let result: Result;
      let rangeConfig: string | null = null;
      try {
        const { row, account } = await getAccount(env, current.account);
        const stopped = current.mode==="submit" && (row.paused || row.pause_version!==current.account_version);
        if (stopped && !current.checkpoint) result={status:"paused",message:"账号已暂停或暂停状态已变更，本次签到已跳过"};
        else if (current.recoveries > 2) result = { status: current.checkpoint ? "uncertain" : "error", message: "任务多次中断，已停止，请检查运行额度和网络" };
        else result = await run(account, row.device_id, current.mode, {
          checkpoint: current.checkpoint ? JSON.parse(current.checkpoint) as Checkpoint : undefined,
          httpTimeoutMs: cfg.httpTimeoutMs, runTimeoutMs: cfg.runTimeoutMs,
          beforeSubmit: async checkpoint => {
            const saved = await env.DB.prepare(`UPDATE jobs SET checkpoint=? WHERE id=? AND owner=? AND status='running'
              AND lease_until>? AND EXISTS(SELECT 1 FROM execution_gate WHERE id=1 AND owner=?)
              AND EXISTS(SELECT 1 FROM accounts a WHERE a.name=jobs.account AND a.deleted=0 AND a.paused=0 AND a.pause_version=jobs.account_version AND (a.authorization_until IS NULL OR a.authorization_until>?)) RETURNING id`)
              .bind(JSON.stringify(checkpoint), id, owner, Date.now(), owner,Date.now()).first();
            if (!saved) {
              const state=await env.DB.prepare("SELECT paused,pause_version,authorization_until FROM accounts WHERE name=?").bind(current.account).first<{paused:number;pause_version:number;authorization_until:number|null}>();
              if(!state || !accountValid(state))throw new EngineError("授权已到期，本次未提交签到","expired");
              if(state.paused || state.pause_version!==current.account_version)throw new EngineError("账号已暂停，本次未提交签到","paused");
              throw new AppError("任务租约失效，拒绝提交",409);
            }
          }
        });
        if (current.mode === "range" && result.status === "success" && result.data) {
          const lon = Number(result.data.lon), lat = Number(result.data.lat);
          if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new AppError("范围坐标无效");
          account.lon = lon; account.lat = lat;
          account.address = String(result.data.address || account.address);
          rangeConfig = await seal(account, env.ENCRYPTION_KEY, `account:${current.account}`);
          result.message = "签到范围已获取并应用";
        }
        const secretValues = [account.password, notifyOption(account).rcvOption, account.username];
        result.message = redact(result.message, secretValues);
        if (result.detail) result.detail = redact(result.detail, secretValues);
      } catch (e) {
        result = { status: "fail", message: e instanceof AppError ? e.message : "任务无法读取配置或执行，请检查账号与服务设置" };
      }
      const stillValid=await env.DB.prepare("SELECT deleted,authorization_until FROM accounts WHERE name=?").bind(current.account).first<{deleted:number;authorization_until:number|null}>();
      if(!stillValid||!accountValid(stillValid)){await cleanupExpiredAccounts(env);return;}
      if(current.mode==="submit" && result.retryable) {
        const state=await env.DB.prepare("SELECT paused,pause_version FROM accounts WHERE name=? AND deleted=0").bind(current.account).first<{paused:number;pause_version:number}>();
        if(!state || state.paused || state.pause_version!==current.account_version)result={status:"paused",message:"任务未完成，但账号已暂停或恢复过；不再重试旧任务"};
      }
      const retry = result.retryable === true && current.trigger === "schedule" && current.attempts < current.max_attempts;
      const finished = Date.now();
      const statements: D1PreparedStatement[] = [];
      if (rangeConfig) statements.push(env.DB.prepare(`UPDATE accounts SET config=? WHERE name=? AND deleted=0 AND (authorization_until IS NULL OR authorization_until>?)
        AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND owner=? AND status='running')`).bind(rangeConfig, current.account, finished,id, owner));
      statements.push(env.DB.prepare(`UPDATE jobs SET status=?,result=?,next_at=?,finished_at=?,report_pending=1,dispatched_at=0,notification_result=NULL,notified=0,
        checkpoint=CASE WHEN ?=1 THEN NULL ELSE checkpoint END
        WHERE id=? AND owner=? AND status='running' AND EXISTS(SELECT 1 FROM accounts a WHERE a.name=jobs.account AND a.deleted=0 AND (a.authorization_until IS NULL OR a.authorization_until>?)) RETURNING *`)
        .bind(retry ? "pending" : "done", JSON.stringify(result), finished + (retry ? cfg.retryMs : 0), retry ? null : finished,
          retry ? 1 : 0, id, owner,finished));
      const saved = await env.DB.batch(statements);
      const reporting = saved[saved.length - 1].results[0] as unknown as Job | undefined;
      if (reporting) await finishReport(env, reporting, owner);
    } else await finishReport(env, current, owner);
  } catch {
    // 结果和待报告状态先落盘。恢复时只补日志/通知，不重跑已完成的签到。
    await env.DB.prepare("UPDATE jobs SET lease_until=0,owner=NULL,dispatched_at=0 WHERE id=? AND owner=? AND report_pending=1")
      .bind(id, owner).run();
    throw new Error("任务处理暂时失败，将从持久化状态恢复");
  } finally { await release(env, current.account, owner); }
}
async function release(env: Env, account: string, owner: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM account_locks WHERE account=? AND owner=?").bind(account, owner),
    env.DB.prepare("UPDATE execution_gate SET owner=NULL,lease_until=0 WHERE id=1 AND owner=?").bind(owner)
  ]);
}
export async function jobView(env: Env, ids: string[]): Promise<Record<string, unknown>[]> {
  if (!ids.length || ids.length > 50 || ids.some(id => id.length > 200)) throw new AppError("无效任务列表");
  const rows = await env.DB.prepare(`SELECT id,account,mode,trigger,status,attempts,created_at,finished_at,result,next_at,report_pending
    FROM jobs WHERE id IN (${ids.map(() => "?").join(",")}) AND EXISTS(SELECT 1 FROM accounts a WHERE a.name=jobs.account AND a.deleted=0 AND (a.authorization_until IS NULL OR a.authorization_until>?)) ORDER BY created_at,sequence_no`).bind(...ids,Date.now()).all<any>();
  return rows.results.map(row => ({ ...row, status: row.report_pending ? "running" : row.status, result: row.result ? JSON.parse(row.result) : null }));
}
