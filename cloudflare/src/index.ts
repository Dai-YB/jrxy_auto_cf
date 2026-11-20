import { AppError, type Env, type Mode } from "./types";
import { readJson } from "./security";
import { authorize, signIn, signOut, rateLimit } from "./auth";
import { deleteAccount, getAccount, listAccounts, publicAccount, saveAccount, saveLog, setPaused } from "./storage";
import { notifyOption, sendNotify } from "./notify";
import { dispatch, enqueue, jobView, processJob } from "./jobs";
import { localTime, scheduleView, tick, updateSchedule } from "./scheduler";
import { extractDeviceId } from "./engine/device";
import { settings } from "./config";

const json = (data: unknown, status = 200): Response => Response.json(data, { status, headers: {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"
} });
async function api(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if(path==="/api/auth/login" && method==="POST")return signIn(request,env);
  if(path==="/api/auth/logout" && method==="POST")return signOut(request,env);
  const identity=await authorize(request,env);
  if(path==="/api/auth/session" && method==="GET")return json(identity);
  if (path === "/api/status" && method === "GET") {
    const count = await env.DB.prepare("SELECT count(*) AS n,coalesce(sum(paused),0) AS paused FROM accounts WHERE deleted=0").first<{n: number;paused:number}>();
    const offset = settings(env).timezone;
    return json({ platform: "Cloudflare Workers", engine_ready:true, accounts_dir:"D1 accounts", timezone:`UTC${offset >= 0 ? "+" : ""}${offset}`,
      account_count: count?.n ?? 0, paused_count:count?.paused ?? 0, scheduler: await scheduleView(env), server_time: localTime(Date.now(),offset) });
  }
  if (path === "/api/device-id/extract" && method === "POST") {
    const body = await readJson(request);
    const deviceId = extractDeviceId(String(body.value ?? ""), body.header as "info" | "ext", body.encoding as "base64" | "hex");
    // 不持久化请求头，不返回其中的用户、位置或令牌字段。
    return json({ deviceId });
  }
  if (path === "/api/accounts" && method === "GET") return json({ accounts: await listAccounts(env) });
  if (path === "/api/accounts" && method === "POST") {
    const body = await readJson(request);
    return json({ account: await saveAccount(env, String(body.name ?? ""), body, true) }, 201);
  }
  const match = /^\/api\/accounts\/([^/]+)(?:\/(run|test-login|sign-range|pause|test-notify))?$/.exec(path);
  if (match) {
    let name: string;
    try { name = decodeURIComponent(match[1]); } catch { throw new AppError("账号名无效"); }
    if (!match[2]) {
      if (method === "GET") { const { row, account } = await getAccount(env, name); return json(publicAccount(row, account)); }
      if (method === "POST") return json({ account: await saveAccount(env, name, await readJson(request), false) });
      if (method === "DELETE") { await deleteAccount(env, name); return json({ ok: true }); }
    } else if (method === "POST") {
      const body = await readJson(request);
      if(match[2]==="pause") {
        if(typeof body.paused!=="boolean")throw new AppError("请提供 paused 布尔值");
        const result=await setPaused(env,name,body.paused);
        ctx.waitUntil(dispatch(env));
        return json(result);
      }
      if(match[2]==="test-notify") {
        const {account}=await getAccount(env,name);
        if(notifyOption(account).method!==2 || !notifyOption(account).rcvOption)throw new AppError("请先保存并启用推送配置");
        await rateLimit(env,"notify-test:"+name,1,60_000);
        const result=await sendNotify(account,`【测试推送】${name}`,"这是一条管理台测试消息，不会执行登录或签到。");
        await saveLog(env,name,"测试推送",result,"仅测试当前账号已保存的通知渠道");
        return json({ok:!result.startsWith("推送失败"),result});
      }
      const mode = match[2] === "test-login" ? "login" : match[2] === "sign-range" ? "range" : body.mode;
      if (!["dry", "submit", "login", "range"].includes(String(mode))) throw new AppError("不支持的执行模式");
      const ids = await enqueue(env, [name], mode as Mode);
      ctx.waitUntil(dispatch(env));
      return json({ ids }, 202);
    }
  }
  if (path === "/api/batch-run" && method === "POST") {
    const { mode } = await readJson(request);
    if (mode !== "dry" && mode !== "submit") throw new AppError("仅支持 dry / submit");
    const names = await env.DB.prepare("SELECT name,paused FROM accounts WHERE deleted=0 ORDER BY name").all<{name: string;paused:number}>();
    const eligible=names.results.filter(account=>mode!=="submit" || !account.paused);
    const ids = await enqueue(env, eligible.map(n => n.name), mode, "批量");
    ctx.waitUntil(dispatch(env));
    return json({ ids, skipped: names.results.length - ids.length }, 202);
  }
  if (path === "/api/jobs" && method === "GET") return json({ jobs: await jobView(env, (url.searchParams.get("ids") ?? "").split(",").filter(Boolean)) });
  if (path === "/api/schedule" && method === "POST") return json({ scheduler: await updateSchedule(env, await readJson(request)) });
  if (path === "/api/logs" && method === "GET") {
    const raw = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(raw) ? Math.max(1,Math.min(Math.trunc(raw),200)) : 50;
    const logs = await env.DB.prepare("SELECT ts,account,kind,result,detail FROM sign_log ORDER BY id DESC LIMIT ?").bind(limit).all<any>();
    return json({ logs: logs.results.map(row => ({...row,ts:localTime(row.ts,settings(env).timezone)})) });
  }
  if (path === "/api/logs/clear" && method === "POST") {
    await env.DB.prepare("DELETE FROM sign_log").run();
    await saveLog(env,null,"日志管理","日志已清空","由 Web 页面手动清除");
    return json({ ok: true });
  }
  throw new AppError("接口不存在或请求方法不支持", 404);
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try { return await api(request, env, ctx); }
    catch (e) { return json({ detail: e instanceof AppError ? e.message : "内部处理失败，请检查数据库迁移与服务配置" }, e instanceof AppError ? e.code : 500); }
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> { await tick(env, controller.scheduledTime); },
  async queue(batch: MessageBatch<{ id: string }>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (typeof message.body?.id !== "string" || message.body.id.length > 200) { message.ack(); continue; }
        await processJob(env, message.body.id);
        await dispatch(env);
        message.ack();
      } catch { message.retry({ delaySeconds: 60 }); }
    }
  }
} satisfies ExportedHandler<Env, { id: string }>;
