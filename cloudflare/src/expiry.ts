import type { Env } from "./types";
import { syncGate } from "./execution";

// 删除授权账号关联个人数据，授权码摘要/已使用状态保留，不能再次使用。
export async function purgeGrantedAccount(env: Env, name: string): Promise<void> {
  const eligible = "EXISTS(SELECT 1 FROM accounts a WHERE a.name=? AND a.grant_code_id IS NOT NULL)";
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sign_log WHERE (account=? OR (account IS NULL AND batch_id IN (SELECT batch_id FROM jobs WHERE account=?))) AND ${eligible}`).bind(name,name,name),
    env.DB.prepare(`UPDATE schedule SET last_result=NULL WHERE last_run IN
      (SELECT b.created_at FROM batches b JOIN jobs j ON j.batch_id=b.id WHERE j.account=? AND b.trigger='schedule') AND ${eligible}`).bind(name,name),
    env.DB.prepare(`UPDATE batches SET summary=NULL,detail=NULL,privacy_version=privacy_version+1 WHERE id IN (SELECT batch_id FROM jobs WHERE account=?) AND ${eligible}`).bind(name,name),
    env.DB.prepare(`DELETE FROM enrollment_attempts WHERE account_name=? AND ${eligible}`).bind(name,name),
    env.DB.prepare(`DELETE FROM account_locks WHERE account=? AND ${eligible}`).bind(name,name),
    env.DB.prepare(`UPDATE execution_slots SET kind=NULL,task_id=NULL,owner=NULL,lease_until=0 WHERE kind='job' AND owner IS NULL
      AND task_id IN(SELECT id FROM jobs WHERE account=?) AND ${eligible}`).bind(name,name),
    env.DB.prepare(`DELETE FROM jobs WHERE account=? AND ${eligible}`).bind(name,name),
    env.DB.prepare("DELETE FROM accounts WHERE name=? AND grant_code_id IS NOT NULL").bind(name),
    env.DB.prepare(`UPDATE batches SET finished_at=coalesce(finished_at,?),summary='授权账号记录已清理',detail=NULL
      WHERE summary IS NULL AND NOT EXISTS(SELECT 1 FROM jobs WHERE batch_id=batches.id)`).bind(Date.now())
  ]);
  await syncGate(env);
}
export async function cleanupExpiredAccounts(env: Env, now=Date.now(),limit=1): Promise<number> {
  const rows=await env.DB.prepare("SELECT name FROM accounts WHERE grant_code_id IS NOT NULL AND authorization_until<=? ORDER BY authorization_until LIMIT ?")
    .bind(now,Math.max(1,Math.min(5,limit))).all<{name:string}>();
  for(const row of rows.results)await purgeGrantedAccount(env,row.name);
  return rows.results.length;
}
