import { AppError, type Account, type AccountRow, type Env } from "./types";
import { seal, unseal } from "./security";
import { initializeDeviceId } from "./engine/device";
import { notifyOption } from "./notify";
import { accountValid, displayName, identityKey } from "./identity";
import { purgeGrantedAccount } from "./expiry";

export function validName(name: string): boolean { return /^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9_.\-\u4e00-\u9fa5]{0,31}$/.test(name); }
function text(body: Record<string, unknown>, key: string, old: string, max: number, trim = true): string {
  if (!(key in body)) return old;
  if (typeof body[key] !== "string") throw new AppError(`${key} 必须是文本`);
  const v = trim ? body[key].trim() : body[key];
  if (v.length > max) throw new AppError(`${key} 过长`);
  return v;
}
function coordinate(v: unknown, max: number): number | null {
  if (v === null || v === "" || v === undefined) return null;
  if (typeof v !== "number" && typeof v !== "string") throw new AppError("坐标必须为数字");
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > max) throw new AppError("经纬度超出有效范围");
  return n;
}
export function buildAccount(body: Record<string, unknown>, old?: Account): Account {
  const type = Number(body.type ?? old?.type ?? 2);
  if (type !== 1 && type !== 2) throw new AppError("仅支持 1 签到和 2 查寝");
  const account: Account = {
    schoolName: text(body, "schoolName", old?.schoolName ?? "", 100) || old?.schoolName || "",
    username: text(body, "username", old?.username ?? "", 100) || old?.username || "",
    password: text(body, "password", old?.password ?? "", 256, false) || old?.password || "",
    type,
    lon: body.lon === "" || body.lon == null ? old?.lon ?? null : coordinate(body.lon,180),
    lat: body.lat === "" || body.lat == null ? old?.lat ?? null : coordinate(body.lat,90),
    address: text(body, "address", old?.address ?? "", 300),
    abnormalReason: text(body, "abnormalReason", old?.abnormalReason ?? "", 300),
    notifyKey: text(body, "notifyKey", old?.notifyKey ?? "", 256) || old?.notifyKey || ""
  };
  if ("displayName" in body) account.displayName = displayName(body.displayName);
  else if (old?.displayName) account.displayName = old.displayName;
  const previous = old ? notifyOption(old) : { method: 0, rcvOption: "" };
  const supplied = body.notifyOption && typeof body.notifyOption === "object" ? body.notifyOption as Record<string, unknown> : {};
  const method = Number(body.notifyMethod ?? supplied.method ?? ("notifyKey" in body ? (account.notifyKey ? 2 : 0) : previous.method));
  const rcv = body.notifyRcv ?? supplied.rcvOption ?? ("notifyKey" in body ? account.notifyKey : previous.rcvOption);
  account.notifyOption = { method: [0,1,2].includes(method) ? method : 0, rcvOption: String(rcv ?? "").trim() };
  account.notifyKey = account.notifyOption.rcvOption;
  if (body.clearNotify === true) { account.notifyKey = ""; account.notifyOption = { method:0,rcvOption:"" }; }
  account.checkTitle = Number(body.checkTitle ?? old?.checkTitle ?? 0) === 1 ? 1 : 0;
  account.formTitle = text(body, "formTitle", old?.formTitle ?? "", 300);
  account.httpProxy = text(body, "httpProxy", old?.httpProxy ?? "", 2048);
  // 未配置任务标题时保持键缺失，避免空字符串匹配所有任务并选中最后一项。
  if (!account.formTitle) delete account.formTitle;
  if (body.forms !== undefined) {
    if (!Array.isArray(body.forms) || body.forms.length > 100 || body.forms.some(v => !v || typeof v !== "object" || !v.form ||
        typeof v.form.value !== "string" || v.form.value.length > 2000 ||
        (v.form.title !== undefined && (typeof v.form.title !== "string" || v.form.title.length > 500)) ||
        (v.form.extra !== undefined && (typeof v.form.extra !== "string" || v.form.extra.length > 2000))))
      throw new AppError("forms 需要是 [{form:{title,value,extra?}}] 文本配置数组");
    account.forms = body.forms as Account["forms"];
  } else account.forms = old?.forms;
  if (!account.schoolName || !account.username || !account.password) throw new AppError("学校、学号和密码不能为空");
  if (account.notifyKey.length > 2048) throw new AppError("通知地址过长");
  if (body.photo) throw new AppError("照片功能按要求已移除");
  return account;
}
export function accountPriority(value:unknown):number {
  const n=typeof value==="string"&&value.trim()!==""?Number(value):value;
  if(typeof n!=="number"||!Number.isInteger(n)||n<0||n>100)throw new AppError("签到权重必须为0～100的整数，数值越大越优先");
  return n;
}
export async function setPriorities(env:Env,body:Record<string,unknown>):Promise<{updated:number}> {
  const names=body.names,priority=accountPriority(body.priority);
  if(!Array.isArray(names)||names.length<1||names.length>100||names.some(name=>typeof name!=="string"||!validName(name)))throw new AppError("请选择1～100个有效账号");
  const rows=await env.DB.batch([
    env.DB.prepare(`UPDATE accounts SET priority=? WHERE name IN(SELECT value FROM json_each(?)) AND deleted=0 AND (authorization_until IS NULL OR authorization_until>?) RETURNING name`)
      .bind(priority,JSON.stringify([...new Set(names)]),Date.now()),
    env.DB.prepare("INSERT INTO sign_log(ts,kind,result,detail) VALUES(?,'账号权重','优先级已更新',?)").bind(Date.now(),`权重${priority}，仅影响新建批次`)
  ]);
  return {updated:rows[0].results.length};
}
export async function getAccount(env: Env, name: string): Promise<{ row: AccountRow; account: Account }> {
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE name=? AND deleted=0").bind(name).first<AccountRow>();
  if (!row) throw new AppError("账号不存在", 404);
  if (!accountValid(row)) throw new AppError("账号授权已到期",410);
  return { row, account: await unseal<Account>(row.config, env.ENCRYPTION_KEY, `account:${name}`) };
}
export function publicAccount(row: AccountRow, account: Account): Record<string, unknown> {
  const { password, notifyKey, notifyOption: hiddenNotify, ...rest } = account;
  const option = notifyOption(account);
  return { ...rest, name: row.name, deviceId: row.device_id, device_id: row.device_id,
    school: account.schoolName, priority:row.priority??0, paused:Boolean(row.paused), authorization_until:row.authorization_until ?? null, source:row.grant_code_id?"redemption":"admin", username_set: Boolean(account.username), password_set: Boolean(password),
    notify_set: Boolean(option.rcvOption), notify_method: option.method, notify_rcv: option.rcvOption };
}
export async function listAccounts(env: Env): Promise<Record<string, unknown>[]> {
  const rows = await env.DB.prepare("SELECT * FROM accounts WHERE deleted=0 AND (authorization_until IS NULL OR authorization_until>?) ORDER BY name").bind(Date.now()).all<AccountRow>();
  return Promise.all(rows.results.map(async row => publicAccount(row, await unseal<Account>(row.config, env.ENCRYPTION_KEY, `account:${row.name}`))));
}
export async function saveAccount(env: Env, name: string, body: Record<string, unknown>, create: boolean): Promise<Record<string, unknown>> {
  if (!validName(name)) throw new AppError("账号名需为1~32位中英文、数字、下划线、点或短横线，首位不能是符号");
  const old = await env.DB.prepare("SELECT * FROM accounts WHERE name=?").bind(name).first<AccountRow>();
  if (create && old && !old.deleted) throw new AppError("账号名已存在", 409);
  if (!create && (!old || old.deleted)) throw new AppError("账号不存在", 404);
  const oldConfig = old && !old.deleted ? await unseal<Account>(old.config, env.ENCRYPTION_KEY, `account:${name}`) : undefined;
  const account = buildAccount(body, oldConfig);
  const priority="priority" in body?accountPriority(body.priority):old?.priority??0;
  if(old && !old.deleted && !accountValid(old))throw new AppError("账号授权已到期，不能编辑或重新激活",410);
  if(old?.grant_code_id && oldConfig && (account.schoolName!==oldConfig.schoolName || account.username!==oldConfig.username))
    throw new AppError("授权账号不能更换绑定学校或账号");
  const identity = identityKey(env,account.schoolName,account.username);
  const duplicate = await env.DB.prepare("SELECT name FROM accounts WHERE identity_key=? AND name!=? AND deleted=0 AND (authorization_until IS NULL OR authorization_until>?) LIMIT 1")
    .bind(identity,name,Date.now()).first();
  if(duplicate)throw new AppError("该学校账号已配置，不能重复添加",409);
  const device = text(body, "deviceId", "", 128);
  const prior = !old && !device ? await env.DB.prepare("SELECT device_id FROM accounts WHERE identity_key=? AND deleted=1 AND grant_code_id IS NULL ORDER BY created_at DESC LIMIT 1")
    .bind(identity).first<{device_id:string}>() : null;
  const deviceId = initializeDeviceId(device, old?.device_id ?? prior?.device_id);
  const config = await seal(account, env.ENCRYPTION_KEY, `account:${name}`);
  if (create) {
    const saved = await env.DB.prepare(`INSERT INTO accounts(name,config,device_id,created_at,identity_key,priority)
      SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.identity_key=? AND a.name!=? AND a.deleted=0)
      ON CONFLICT(name) DO UPDATE SET config=excluded.config,device_id=excluded.device_id,identity_key=excluded.identity_key,priority=excluded.priority,deleted=0 WHERE accounts.deleted=1 AND accounts.grant_code_id IS NULL RETURNING name`)
      .bind(name, config, deviceId, Date.now(),identity,priority,identity,name).first();
    if (!saved) throw new AppError("账号名已存在", 409);
  } else {
    const saved = await env.DB.prepare(`UPDATE accounts SET config=?,device_id=?,identity_key=?,priority=? WHERE name=? AND deleted=0 AND (authorization_until IS NULL OR authorization_until>?) AND NOT EXISTS
      (SELECT 1 FROM jobs WHERE account=? AND (status!='done' OR report_pending=1))
      AND NOT EXISTS(SELECT 1 FROM accounts a WHERE a.identity_key=? AND a.name!=? AND a.deleted=0) RETURNING name`).bind(config, deviceId, identity,priority,name,Date.now(),name,identity,name).first();
    if (!saved) throw new AppError("账号有待执行任务，请完成后再编辑", 409);
  }
  await saveLog(env, name, "账号管理", create ? "账号已创建" : "账号已更新", "设备绑定已固定，敏感配置已加密");
  return publicAccount({ ...old,name, device_id: deviceId,priority,paused:old?.paused ?? 0 } as AccountRow, account);
}
export async function deleteAccount(env: Env, name: string): Promise<void> {
  const granted=await env.DB.prepare("SELECT grant_code_id FROM accounts WHERE name=? AND deleted=0").bind(name).first<{grant_code_id:string|null}>();
  if(granted?.grant_code_id){await purgeGrantedAccount(env,name);return;}
  const row = await env.DB.prepare(`UPDATE accounts SET deleted=1,config='' WHERE name=? AND deleted=0
    AND NOT EXISTS(SELECT 1 FROM jobs WHERE account=? AND (status!='done' OR report_pending=1)) RETURNING name`).bind(name, name).first();
  if (!row) throw new AppError("账号不存在或仍有待执行任务", 409);
  await saveLog(env, name, "账号管理", "账号已删除", "已清除账号凭据，仅保留名称与设备绑定供重新接入");
}
export async function setPaused(env: Env, name: string, paused: boolean): Promise<{paused:boolean;inFlight:boolean}> {
  await getAccount(env,name);
  const now=Date.now();
  const result=JSON.stringify({status:"paused",message:"账号已暂停，本次签到已跳过；恢复后不会补跑"});
  const rows=await env.DB.batch([
    env.DB.prepare(`UPDATE accounts SET paused=?,pause_version=pause_version+CASE WHEN paused!=? THEN 1 ELSE 0 END,
      resume_after=CASE WHEN paused=1 AND ?=0 THEN ? ELSE resume_after END WHERE name=? AND deleted=0 RETURNING name`)
      .bind(paused?1:0,paused?1:0,paused?1:0,now,name),
    env.DB.prepare(`INSERT INTO sign_log(ts,account,kind,result,detail) SELECT ?,account,'账号暂停','签到已跳过','暂停时取消尚未提交的签到任务'
      FROM jobs WHERE account=? AND mode='submit' AND status='pending' AND checkpoint IS NULL AND report_pending=0
      AND EXISTS(SELECT 1 FROM accounts WHERE name=? AND paused=1 AND deleted=0)`)
      .bind(now,name,name),
    env.DB.prepare(`UPDATE jobs SET status='done',result=?,finished_at=?,dispatched_at=0 WHERE account=? AND mode='submit'
      AND status='pending' AND checkpoint IS NULL AND report_pending=0
      AND EXISTS(SELECT 1 FROM accounts WHERE name=? AND paused=1 AND deleted=0)`).bind(result,now,name,name),
    env.DB.prepare(`INSERT INTO sign_log(ts,account,kind,result,detail) SELECT ?,name,'账号管理',?,? FROM accounts WHERE name=? AND deleted=0`)
      .bind(now,paused?"账号已暂停":"账号已恢复",paused?"暂停签到提交，保留账号和设备绑定":"仅允许新任务，不补跑暂停期间签到",name),
    env.DB.prepare(`SELECT id FROM jobs WHERE account=? AND mode='submit' AND status!='done' AND checkpoint IS NOT NULL LIMIT 1`).bind(name)
  ]);
  if(!rows[0].results.length)throw new AppError("账号不存在",404);
  return {paused,inFlight:rows[4].results.length>0};
}
export async function saveLog(env: Env, account: string | null, kind: string, result: string, detail: string): Promise<void> {
  const now=Date.now();
  await env.DB.prepare(`INSERT INTO sign_log(ts,account,kind,result,detail) SELECT ?,?,?,?,?
    WHERE ? IS NULL OR EXISTS(SELECT 1 FROM accounts WHERE name=? AND (authorization_until IS NULL OR authorization_until>?))`)
    .bind(now, account, kind, result.slice(0,200), detail.slice(-4000),account,account,now).run();
}
