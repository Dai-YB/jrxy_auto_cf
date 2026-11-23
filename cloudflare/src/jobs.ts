import { execute, type Checkpoint } from "./engine/sign";
import { getAccount } from "./storage";
import { classify, notification, notifyHead, notifyOption, sendNotify } from "./notify";
import { redact, requireConfigured, seal } from "./security";
import { localTime, settings } from "./config";
import { accountValid } from "./identity";
import { purgeGrantedAccount } from "./expiry";
import { AppError, EngineError, type Batch, type Env, type Job, type Mode, type Result } from "./types";
import { expireSlots, ownsSlotSql, releaseSlot, reserveSlot, slotClaim, slotGate, syncGate } from "./execution";

const earlierWave=(left:string,right:string)=>`(${left}.priority>${right}.priority OR (${left}.priority=${right}.priority AND ${left}.wave_no<${right}.wave_no))`;
const reportLease=(alias:string,now=Date.now())=>`${alias}.lease_until>${Math.trunc(now)} AND EXISTS(SELECT 1 FROM execution_slots s WHERE s.kind='job' AND s.task_id=${alias}.id AND s.owner=${alias}.owner AND s.lease_until>${Math.trunc(now)})`;

export interface Admission {
  ids:string[];
  total:number;
  created:number;
  continued:number;
  completed:number;
  skipped:number;
  reasons:{paused:number;busy:number;unavailable:number};
}
export async function admitJobs(env:Env,names:string[],mode:Mode,triggerLabel="手动",batchRequest=false):Promise<Admission> {
  requireConfigured(env);
  names=[...new Set(names)];
  const result:Admission={ids:[],total:names.length,created:0,continued:0,completed:0,skipped:0,reasons:{paused:0,busy:0,unavailable:0}};
  if(!names.length)return result;
  if(!batchRequest&&names.length===1){
    const {row}=await getAccount(env,names[0]);
    if(mode==="submit"&&row.paused)throw new AppError("账号已暂停，请恢复后再签到",409);
  }
  const now=Date.now(),batchId=crypto.randomUUID(),input=JSON.stringify(names);
  const active="(old.status!='done' OR old.report_pending=1)";
  // 同一未结束批次的成功结果也只接续展示，不能因点击“签到全部”重新提交。
  const related=`(${active} OR (?='submit' AND old.mode='submit' AND old.status='done' AND json_valid(old.result)
    AND json_extract(old.result,'$.status') IN('success','already') AND EXISTS(SELECT 1 FROM batches b WHERE b.id=old.batch_id AND b.finished_at IS NULL)))`;
  const rows=await env.DB.batch([
    env.DB.prepare("INSERT INTO batches(id,trigger,mode,label,created_at,round_due,concurrency_limit) SELECT ?,'manual',?,?,?,?,parallelism FROM execution_settings WHERE id=1")
      .bind(batchId,mode,triggerLabel,now,now),
    env.DB.prepare(`INSERT INTO jobs(id,account,mode,trigger,next_at,created_at,trigger_label,batch_id,sequence_no,account_version,priority,wave_no,checkpoint,target)
      SELECT ? || ':' || a.name,a.name,?,'manual',?,?,?,?,ROW_NUMBER() OVER(ORDER BY a.priority DESC,CAST(n.key AS INTEGER))-1,a.pause_version,a.priority,
        CAST((ROW_NUMBER() OVER(PARTITION BY a.priority ORDER BY CAST(n.key AS INTEGER))-1)/(SELECT concurrency_limit FROM batches WHERE id=?) AS INTEGER),
        CASE WHEN ?='submit' THEN a.submission_checkpoint END,CASE WHEN ?='submit' THEN a.submission_checkpoint END
      FROM json_each(?) n JOIN accounts a ON a.name=n.value WHERE a.deleted=0 AND (a.authorization_until IS NULL OR a.authorization_until>?) AND (?!='submit' OR a.paused=0)
        AND NOT EXISTS(SELECT 1 FROM jobs old WHERE old.account=a.name AND ${related})`)
      .bind(batchId,mode,now,now,triggerLabel,batchId,batchId,mode,mode,input,now,mode,mode),
    env.DB.prepare(`SELECT a.name,a.deleted,a.paused,a.authorization_until,j.id,j.mode,j.status,j.report_pending,j.batch_id FROM json_each(?) n
      LEFT JOIN accounts a ON a.name=n.value LEFT JOIN jobs j ON j.id=(SELECT old.id FROM jobs old WHERE old.account=a.name AND ${related}
        ORDER BY CASE WHEN ${active} THEN 0 ELSE 1 END,CASE WHEN ${active} THEN old.created_at END,old.created_at DESC,old.rowid DESC LIMIT 1)
      ORDER BY CAST(n.key AS INTEGER)`).bind(input,mode),
    env.DB.prepare("DELETE FROM batches WHERE id=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE batch_id=?)").bind(batchId,batchId)
  ]);
  for(const row of rows[2].results as unknown as Array<{name:string|null;deleted:number;paused:number;authorization_until:number|null;id:string|null;mode:Mode;status:string;report_pending:number;batch_id:string}>){
    if(!row.name||!accountValid(row,now)){result.reasons.unavailable++;continue;}
    if(mode==="submit"&&row.paused){result.reasons.paused++;continue;}
    if(!row.id||row.mode!==mode||(mode!=="submit"&&row.batch_id!==batchId)){result.reasons.busy++;continue;}
    result.ids.push(row.id);
    if(row.batch_id===batchId)result.created++;
    else if(row.status==="done"&&!row.report_pending)result.completed++;
    else result.continued++;
  }
  result.skipped=result.reasons.paused+result.reasons.busy+result.reasons.unavailable;
  if(!batchRequest&&names.length===1&&!result.ids.length)throw new AppError(result.reasons.paused?"账号已暂停，请恢复后再签到":"该账号已有待执行任务或已失效，请查看任务状态，不能重复执行",409);
  return result;
}
export async function enqueue(env: Env, names: string[], mode: Mode, triggerLabel = "手动"): Promise<string[]> {
  return (await admitJobs(env,names,mode,triggerLabel,triggerLabel==="批量")).ids;
}

export async function advanceBatch(env: Env, id: string, now = Date.now()): Promise<void> {
  const batch = await env.DB.prepare("SELECT * FROM batches WHERE id=? AND finished_at IS NULL").bind(id).first<Batch>();
  if (!batch) return;
  const jobs = (await env.DB.prepare("SELECT * FROM jobs WHERE batch_id=? ORDER BY sequence_no").bind(id).all<Job>()).results;
  if (jobs.some(j => j.report_pending || j.status === "running")) return;
  if (!jobs.length) {
    await env.DB.prepare("UPDATE batches SET finished_at=?,summary='没有可用账号',detail='' WHERE id=? AND finished_at IS NULL AND NOT EXISTS(SELECT 1 FROM jobs WHERE batch_id=?)").bind(now,id,id).run();
    return;
  }
  if (jobs.every(j => j.status === "done")) {
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
  const nextRound = batch.round+1;
  const due = Math.max(now + settings(env).retryMs, ...pending.map(j => j.next_at));
  const fallback=batch.concurrency_limit>1&&pending.some(job=>{
    try{return Boolean(job.result&&JSON.parse(job.result).transientFailure);}catch{return false;}
  });
  const ready="NOT EXISTS(SELECT 1 FROM jobs j WHERE j.batch_id=batches.id AND (j.report_pending=1 OR j.status='running' OR (j.status='pending' AND j.attempts<batches.round)))";
  await env.DB.batch([
    env.DB.prepare(`UPDATE jobs SET next_at=max(next_at,?),dispatched_at=0,wave_no=CASE WHEN ? THEN sequence_no ELSE wave_no END
      WHERE batch_id=? AND status='pending' AND EXISTS(SELECT 1 FROM batches WHERE id=? AND round=? AND finished_at IS NULL AND ${ready})`)
      .bind(due,fallback?1:0,id,id,batch.round),
    env.DB.prepare(`UPDATE batches SET round=?,round_due=?,concurrency_limit=CASE WHEN ? THEN 1 ELSE concurrency_limit END,
      fallback_reason=CASE WHEN ? THEN '上游请求异常，后续重试轮使用串行' ELSE fallback_reason END
      WHERE id=? AND round=? AND finished_at IS NULL AND ${ready}`)
      .bind(nextRound,due,fallback?1:0,fallback?1:0,id,batch.round)
  ]);
}

export async function dispatch(env: Env, limit=3): Promise<void> {
  requireConfigured(env);
  const now = Date.now();
  await env.DB.prepare(`UPDATE execution_slots SET kind=NULL,task_id=NULL,owner=NULL,lease_until=0,delivery_token=NULL WHERE owner IS NULL AND
    ((kind='job' AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.id=task_id AND (j.status='pending' OR j.report_pending=1))) OR
     (kind='enrollment' AND NOT EXISTS(SELECT 1 FROM enrollment_attempts e WHERE e.id=task_id AND e.status='pending' AND e.expires_at>?)))`).bind(now).run();
  await syncGate(env);
  await env.DB.prepare(`UPDATE jobs SET status='pending',owner=NULL,dispatched_at=0,next_at=?,recoveries=recoveries+1,attempts=max(attempts-1,0)
    WHERE status='running' AND report_pending=0 AND lease_until<?`).bind(now, now).run();
  const active = await env.DB.prepare(`SELECT b.id FROM batches b WHERE b.finished_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.batch_id=b.id AND
      (j.report_pending=1 OR j.status='running' OR (j.status='pending' AND j.attempts<b.round)))
    ORDER BY b.created_at LIMIT 1`).all<{ id: string }>();
  for (const batch of active.results) await advanceBatch(env, batch.id, now);
  const candidates=await env.DB.prepare(`SELECT j.*,b.round_due FROM jobs j JOIN batches b ON b.id=j.batch_id
    WHERE b.finished_at IS NULL AND j.dispatched_at<? AND NOT EXISTS(SELECT 1 FROM account_locks l WHERE l.account=j.account AND l.lease_until>?)
      AND NOT EXISTS(SELECT 1 FROM execution_slots s WHERE s.kind='job' AND s.task_id=j.id AND s.lease_until>?) AND (
      (j.report_pending=1 AND j.lease_until<=?) OR
      (j.status='pending' AND j.report_pending=0 AND j.next_at<=? AND b.round_due<=?
        AND j.attempts<b.round AND NOT EXISTS(SELECT 1 FROM jobs p WHERE p.batch_id=j.batch_id
          AND ${earlierWave("p","j")} AND (p.status='running' OR p.report_pending=1 OR (p.status!='done' AND p.attempts<b.round)))))
    ORDER BY j.report_pending DESC,b.created_at,j.sequence_no LIMIT ?`).bind(now-120000,now,now,now,now+60000,now+60000,Math.max(1,Math.min(3,limit))).all<Job & {round_due:number}>();
  for(const job of candidates.results){
    const due=job.report_pending?now:Math.max(now,job.next_at,job.round_due),deliveryToken=crypto.randomUUID();
    if(!await reserveSlot(env,"job",job.id,now,due,deliveryToken))continue;
    const claimed=await env.DB.prepare(`UPDATE jobs SET dispatched_at=? WHERE id=? AND dispatched_at<? AND (status='pending' OR report_pending=1) RETURNING id`)
      .bind(due,job.id,now-120000).first();
    if(!claimed){await releaseSlot(env,"job",job.id,null,deliveryToken);continue;}
    try{
      const delaySeconds=Math.ceil((due-now)/1000);
      if(delaySeconds)await env.JOBS.send({id:job.id,deliveryToken},{delaySeconds});else await env.JOBS.send({id:job.id,deliveryToken});
    }catch{
      await env.DB.prepare(`UPDATE jobs SET dispatched_at=0 WHERE id=? AND dispatched_at=? AND EXISTS
        (SELECT 1 FROM execution_slots WHERE kind='job' AND task_id=jobs.id AND owner IS NULL AND delivery_token=?)`).bind(job.id,due,deliveryToken).run();
      await releaseSlot(env,"job",job.id,null,deliveryToken);
    }
  }
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
      result={...result,status:"paused",retryable:false,message:"账号已暂停或恢复过，旧重试任务已取消"};
      const saved=await env.DB.prepare(`UPDATE jobs SET status='done',result=?,finished_at=?,notification_result=NULL
        WHERE id=? AND owner=? AND report_pending=1 AND status='pending' AND ${reportLease("jobs")} RETURNING id`)
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
    else if (retry) push = `推送跳过（${result.retryAction==="verify"?"提交待确认，下一轮仅复查":"本轮执行异常"}；整轮结束后等待${settings(env).retryMs / 60_000}分钟，剩余${Math.max(0,job.max_attempts-job.attempts)}次）`;
    else if (job.mode === "dry" || job.mode === "submit") {
      const notifyClaim = await env.DB.prepare(`UPDATE jobs SET notified=1 WHERE id=? AND owner=? AND notified=0
        AND report_pending=1 AND ${reportLease("jobs")} AND EXISTS(SELECT 1 FROM accounts a WHERE a.name=jobs.account AND a.deleted=0 AND (a.authorization_until IS NULL OR a.authorization_until>?)) RETURNING id`).bind(job.id, owner,Date.now()).first();
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
    await env.DB.prepare(`UPDATE jobs SET notification_result=? WHERE id=? AND owner=? AND report_pending=1 AND ${reportLease("jobs")}`)
      .bind(push, job.id, owner).run();
  }
  const now = Date.now();
  const label = job.mode === "login" ? (result.status === "success" ? "登录成功" : "登录失败")
    : job.mode === "range" ? (result.status === "success" ? "签到范围已获取并应用" : "范围获取失败") : classify(result);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sign_log(ts,account,kind,result,detail,batch_id) SELECT ?,account,?,?,?,batch_id FROM jobs
      WHERE id=? AND owner=? AND report_pending=1 AND lease_until>? AND ${ownsSlotSql("job")}
      AND EXISTS(SELECT 1 FROM accounts a WHERE a.name=jobs.account AND a.deleted=0 AND (a.authorization_until IS NULL OR a.authorization_until>?))`)
      .bind(now,`${trigger}${action}[${job.account}]`,label,((result.detail||result.message)+`\n\n本账号已执行${job.attempts}次，最多${job.max_attempts}次；${retry?"整轮结束后进入下一轮":"本次任务已结束（不等同签到成功）"}`+(push?`\n[${push}]`:"")).slice(-4000),job.id,owner,now,job.id,owner,now,now),
    env.DB.prepare(`UPDATE batches SET last_finished_at=? WHERE id=? AND EXISTS
      (SELECT 1 FROM jobs WHERE id=? AND owner=? AND report_pending=1 AND ${reportLease("jobs",now)})`).bind(now, job.batch_id, job.id, owner),
    env.DB.prepare(`UPDATE jobs SET next_at=max(next_at,?),dispatched_at=0 WHERE batch_id=? AND status='pending'
      AND EXISTS(SELECT 1 FROM jobs p WHERE p.id=? AND p.owner=? AND p.report_pending=1 AND ${reportLease("p",now)} AND ${earlierWave("p","jobs")})`)
      .bind(now + settings(env).intervalMs, job.batch_id, job.id, owner),
    env.DB.prepare(`UPDATE jobs SET report_pending=0,owner=NULL,lease_until=0,dispatched_at=0 WHERE id=? AND owner=? AND report_pending=1 AND ${reportLease("jobs",now)}`)
      .bind(job.id, owner)
  ]);
  await advanceBatch(env, job.batch_id!, now);
}

export async function processJob(env: Env, id: string, run = execute, deliveryToken:string|null=null): Promise<{retryAfter:number}|void> {
  requireConfigured(env);
  const now = Date.now();
  const owner = crypto.randomUUID();
  const cfg = settings(env);
  const lease = now + cfg.runTimeoutMs + 60_000;
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first<Job>();
  if(deliveryToken){
    const reservation=await env.DB.prepare("SELECT owner,lease_until FROM execution_slots WHERE kind='job' AND task_id=? AND delivery_token=?").bind(id,deliveryToken).first<{owner:string|null;lease_until:number}>();
    if(!reservation)return;
    if(reservation.owner&&reservation.lease_until>now)return;
  }
  if (!job || (job.status === "done" && !job.report_pending)) {if(deliveryToken)await releaseSlot(env,"job",id,null,deliveryToken);return;}
  if(job.lease_until>now)return;
  const eligibility=await env.DB.prepare("SELECT deleted,authorization_until FROM accounts WHERE name=?").bind(job.account).first<{deleted:number;authorization_until:number|null}>();
  if(!eligibility||!accountValid(eligibility,now)){await purgeGrantedAccount(env,job.account);if(deliveryToken)await releaseSlot(env,"job",id,null,deliveryToken);return;}
  const batch = await env.DB.prepare("SELECT * FROM batches WHERE id=?").bind(job.batch_id).first<Batch>();
  if (!batch || batch.finished_at) {if(deliveryToken)await releaseSlot(env,"job",id,null,deliveryToken);return;}
  if (!job.report_pending && (job.status !== "pending" || job.attempts >= batch.round)) {
    if(deliveryToken)await releaseSlot(env,"job",id,null,deliveryToken);return;
  }
  if(!job.report_pending&&Math.max(job.next_at,batch.round_due)>now){
    const due=Math.max(job.next_at,batch.round_due);
    if(deliveryToken){
      await env.DB.prepare("UPDATE execution_slots SET lease_until=max(lease_until,?) WHERE kind='job' AND task_id=? AND owner IS NULL AND delivery_token=?")
        .bind(due+120000,id,deliveryToken).run();
      await syncGate(env);
      return {retryAfter:Math.max(1,Math.min(43200,Math.ceil((due-now)/1000)))};
    }
    return;
  }
  const claimed = await env.DB.batch([
    expireSlots(env,now),slotGate(env,now,lease),slotClaim(env,"job",id,owner,now,lease,deliveryToken),
    env.DB.prepare(`INSERT INTO account_locks(account,job_id,owner,lease_until)
      SELECT ?,?,?,? WHERE ${ownsSlotSql("job")}
      ON CONFLICT(account) DO UPDATE SET job_id=excluded.job_id,owner=excluded.owner,lease_until=excluded.lease_until
      WHERE account_locks.lease_until<=?`).bind(job.account,id,owner,lease,id,owner,now,now),
    env.DB.prepare(`UPDATE jobs SET status=CASE WHEN report_pending=1 THEN status ELSE 'running' END,owner=?,lease_until=?,
      attempts=attempts+CASE WHEN report_pending=1 THEN 0 ELSE 1 END,
      checkpoint=CASE WHEN mode='submit' AND report_pending=0 THEN coalesce((SELECT submission_checkpoint FROM accounts WHERE name=jobs.account),checkpoint) ELSE checkpoint END,
      target=CASE WHEN mode='submit' AND report_pending=0 THEN coalesce((SELECT submission_checkpoint FROM accounts WHERE name=jobs.account),target) ELSE target END,
      attempt_started_at=CASE WHEN report_pending=1 THEN attempt_started_at ELSE ? END
      WHERE id=? AND lease_until<=? AND (report_pending=1 OR (status='pending' AND next_at<=? AND
        EXISTS(SELECT 1 FROM batches b WHERE b.id=jobs.batch_id AND b.finished_at IS NULL AND b.round_due<=? AND jobs.attempts<b.round
          AND NOT EXISTS(SELECT 1 FROM jobs p WHERE p.batch_id=b.id AND ${earlierWave("p","jobs")}
            AND (p.status='running' OR p.report_pending=1 OR (p.status!='done' AND p.attempts<b.round))))))
      AND ${ownsSlotSql("job")}
      AND EXISTS(SELECT 1 FROM account_locks WHERE account=? AND owner=? AND lease_until>?) RETURNING *`)
      .bind(owner,lease,now,id,now,now,now,id,owner,now,job.account,owner,now)
  ]);
  const current = claimed[4].results[0] as unknown as Job | undefined;
  if (!current) {
    if(deliveryToken)await env.DB.prepare(`UPDATE jobs SET dispatched_at=0 WHERE id=? AND lease_until<=? AND (status='pending' OR report_pending=1)
      AND EXISTS(SELECT 1 FROM execution_slots WHERE kind='job' AND task_id=jobs.id AND (owner IS NULL OR owner=?) AND delivery_token=?)`).bind(id,now,owner,deliveryToken).run();
    await release(env, job.account, owner);
    if(deliveryToken)await releaseSlot(env,"job",id,null,deliveryToken);
    return;
  }
  try {
    if (!current.report_pending) {
      let result: Result;
      let rangeConfig: string | null = null,persistenceFailed=false;
      const persist=async<T>(work:()=>Promise<T>):Promise<T>=>{
        try{return await work();}catch{persistenceFailed=true;throw new AppError("任务持久化暂不可用，停止继续请求",503);}
      };
      try {
        const { row, account } = await getAccount(env, current.account).catch(error=>{if(!(error instanceof AppError))persistenceFailed=true;throw error;});
        const stopped = current.mode==="submit" && (row.paused || row.pause_version!==current.account_version);
        if (stopped && !current.checkpoint) result={status:"paused",message:"账号已暂停或暂停状态已变更，本次签到已跳过"};
        else if (current.recoveries > 2) result = { status: current.checkpoint ? "uncertain" : "error", message: "任务多次中断，已停止，请检查运行额度和网络" };
        else result = await run(account, row.device_id, current.mode, {
          checkpoint: current.checkpoint ? JSON.parse(current.checkpoint) as Checkpoint : undefined,
          target: current.target ? JSON.parse(current.target) as Checkpoint : undefined,
          httpTimeoutMs: cfg.httpTimeoutMs, runTimeoutMs: cfg.runTimeoutMs,timezone:cfg.timezone,
          onTarget:async target=>{
            const saved=await persist(()=>env.DB.prepare(`UPDATE jobs SET target=? WHERE id=? AND owner=? AND status='running' AND lease_until>? AND ${ownsSlotSql("job")} RETURNING id`)
              .bind(JSON.stringify(target),id,owner,Date.now(),id,owner,Date.now()).first());
            if(!saved)throw new AppError("任务租约已失效，停止继续请求",409);
          },
          beforeSubmit: async checkpoint => {
            const checkedAt=Date.now(),serialized=JSON.stringify(checkpoint);
            const saved=await persist(()=>env.DB.batch([
              env.DB.prepare(`UPDATE jobs SET checkpoint=?,target=? WHERE id=? AND owner=? AND status='running'
                AND lease_until>? AND ${ownsSlotSql("job")}
                AND EXISTS(SELECT 1 FROM account_locks l WHERE l.account=jobs.account AND l.owner=? AND l.lease_until>?)
                AND EXISTS(SELECT 1 FROM accounts a WHERE a.name=jobs.account AND a.deleted=0 AND a.paused=0 AND a.pause_version=jobs.account_version AND (a.authorization_until IS NULL OR a.authorization_until>?)) RETURNING id`)
                .bind(serialized,serialized,id,owner,checkedAt,id,owner,checkedAt,owner,checkedAt,checkedAt),
              env.DB.prepare(`UPDATE accounts SET submission_checkpoint=? WHERE name=? AND deleted=0 AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND owner=? AND status='running' AND checkpoint=? AND ${reportLease("jobs",checkedAt)}) RETURNING name`)
                .bind(serialized,current.account,id,owner,serialized)
            ]));
            if (!saved[0].results.length||!saved[1].results.length) {
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
        const secretValues = [account.password, notifyOption(account).rcvOption, account.username, account.displayName??""];
        result.message = redact(result.message, secretValues);
        if (result.detail) result.detail = redact(result.detail, secretValues);
      } catch (e) {
        result = { status: "fail", message: e instanceof AppError ? e.message : "任务无法读取配置或执行，请检查账号与服务设置" };
      }
      if(persistenceFailed)throw new Error("任务持久化暂不可用，保留检查点等待恢复");
      const stillValid=await env.DB.prepare("SELECT deleted,authorization_until FROM accounts WHERE name=?").bind(current.account).first<{deleted:number;authorization_until:number|null}>();
      if(!stillValid||!accountValid(stillValid)){await purgeGrantedAccount(env,current.account);return;}
      if(current.mode==="submit" && result.retryable) {
        const state=await env.DB.prepare("SELECT paused,pause_version FROM accounts WHERE name=? AND deleted=0").bind(current.account).first<{paused:number;pause_version:number}>();
        if(!state || state.paused || state.pause_version!==current.account_version)result={...result,status:"paused",retryable:false,message:"任务未完成，但账号已暂停或恢复过；不再重试旧任务"};
      }
      const retry = ["error","uncertain"].includes(result.status) && result.retryable === true && current.trigger === "schedule" && current.attempts < current.max_attempts;
      const clearCheckpoint=result.submissionState==="signed"||result.submissionState==="unsigned"||["success","already"].includes(result.status);
      const finished = Date.now();
      const statements: D1PreparedStatement[] = [];
      if(current.mode==="submit"&&!clearCheckpoint)statements.push(env.DB.prepare(`UPDATE accounts SET submission_checkpoint=(SELECT checkpoint FROM jobs WHERE id=?)
        WHERE name=? AND deleted=0 AND submission_checkpoint IS NULL AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND owner=? AND status='running' AND checkpoint IS NOT NULL AND ${reportLease("jobs",finished)})`)
        .bind(id,current.account,id,owner));
      if(clearCheckpoint)statements.push(env.DB.prepare(`UPDATE accounts SET submission_checkpoint=NULL WHERE name=? AND deleted=0
        AND submission_checkpoint=(SELECT checkpoint FROM jobs WHERE id=? AND owner=? AND status='running' AND lease_until>?) AND ${ownsSlotSql("job")}`)
        .bind(current.account,id,owner,finished,id,owner,finished));
      if (rangeConfig) statements.push(env.DB.prepare(`UPDATE accounts SET config=? WHERE name=? AND deleted=0 AND (authorization_until IS NULL OR authorization_until>?)
        AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND owner=? AND status='running' AND lease_until>?)
        AND ${ownsSlotSql("job")}`).bind(rangeConfig,current.account,finished,id,owner,finished,id,owner,finished));
      statements.push(env.DB.prepare(`UPDATE jobs SET status=?,result=?,next_at=?,finished_at=?,report_pending=1,dispatched_at=0,notification_result=NULL,notified=0,recoveries=0,
        checkpoint=CASE WHEN ?=1 THEN NULL ELSE checkpoint END
        WHERE id=? AND owner=? AND status='running' AND lease_until>? AND ${ownsSlotSql("job")} AND EXISTS(SELECT 1 FROM accounts a WHERE a.name=jobs.account AND a.deleted=0 AND (a.authorization_until IS NULL OR a.authorization_until>?)) RETURNING *`)
        .bind(retry ? "pending" : "done", JSON.stringify(result), finished + (retry ? cfg.retryMs : 0), retry ? null : finished,
          clearCheckpoint ? 1 : 0,id,owner,finished,id,owner,finished,finished));
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
    env.DB.prepare("UPDATE execution_slots SET kind=NULL,task_id=NULL,owner=NULL,lease_until=0,delivery_token=NULL WHERE kind='job' AND owner=?").bind(owner)
  ]);
  await syncGate(env);
}
export async function jobView(env: Env, ids: string[]): Promise<Record<string, unknown>[]> {
  if (!ids.length || ids.length > 50 || ids.some(id => id.length > 200)) throw new AppError("无效任务列表");
  const now=Date.now();
  const rows = await env.DB.prepare(`SELECT j.id,j.account,j.mode,j.trigger,j.status,j.attempts,j.max_attempts,j.created_at,j.finished_at,j.result,j.next_at,j.report_pending,
    j.checkpoint IS NOT NULL AS verification_pending,b.round,b.round_due,b.concurrency_limit,b.fallback_reason
    FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.id IN (${ids.map(() => "?").join(",")})
    AND EXISTS(SELECT 1 FROM accounts a WHERE a.name=j.account AND a.deleted=0 AND (a.authorization_until IS NULL OR a.authorization_until>?)) ORDER BY j.created_at,j.sequence_no`).bind(...ids,now).all<any>();
  return rows.results.map(row=>{
    const result=row.result?JSON.parse(row.result):null;
    const waitingRound=row.status==="pending"&&row.attempts>=row.round;
    const nextAt=row.status==="pending"&&!waitingRound?Math.max(row.next_at,row.round_due):null;
    const state=row.report_pending?"reporting":row.status==="running"?"running":row.status==="done"?"finished":waitingRound?"waiting_round":row.attempts>0?"retry_pending":"queued";
    return {...row,result,status:row.report_pending?"running":row.status,progressState:state,remainingAttempts:Math.max(0,row.max_attempts-row.attempts),
      nextAttemptAt:nextAt,nextAttemptText:nextAt?localTime(nextAt,settings(env).timezone):null,timezone:`UTC${settings(env).timezone>=0?"+":""}${settings(env).timezone}`,verificationPending:Boolean(row.verification_pending)};
  });
}
