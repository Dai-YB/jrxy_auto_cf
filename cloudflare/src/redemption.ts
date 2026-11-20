import { createHmac, randomBytes } from "node:crypto";
import { AppError, EngineError, type Account, type AccountRow, type Env, type RequestDiagnostic } from "./types";
import { safeDiagnostic } from "./diagnostics";
import { requireConfigured, requireSameOrigin, readJson, seal, unseal } from "./security";
import { displayName, identityKey } from "./identity";
import { rateLimit } from "./auth";
import { login } from "./engine/login";
import { Session } from "./engine/http";
import { initializeDeviceId } from "./engine/device";
import { enrollmentNotify, notifyOption } from "./notify";
import { expireSlots, ownsSlotSql, releaseSlot, reserveSlot, slotClaim, slotGate, syncGate } from "./execution";
import { settings, localTime } from "./config";
import { getSchedule, scheduleView } from "./scheduler";

interface Preset {
  id:string;note:string;school_name:string;task_type:1|2;longitude:number;latitude:number;address:string;
  duration_seconds:number;redeem_before:number|null;created_at:number;
}
interface CodeRow {id:string;batch_id:string;code_hash:string;suffix:string;status:string;attempt_id:string|null;reserved_until:number|null;used_at:number|null;authorization_until:number|null;code_cipher:string|null;}
interface Attempt {
  id:string;code_id:string;receipt_hash:string;request_hash:string;identity_key:string|null;credentials:string;status:string;
  owner:string|null;lease_until:number;created_at:number;expires_at:number;dispatched_at:number;
  account_name:string|null;account_config:string;device_id:string;error_code:string|null;authorization_until:number|null;diagnostic:string|null;
}
const ATTEMPT_MS=10*60_000;
const messages:Record<string,string>={
  invalid:"授权码无效或不可用",used:"授权码已使用，不能再次授权",expired:"授权码已过最晚使用时间",revoked:"授权码已撤销",
  busy:"授权码正在验证，请等待当前操作完成",credentials:"学校登录未通过，请核对账号密码或联系管理员查看诊断；本次未开通且未消耗授权码",captcha:"学校登录需要人工验证，本次未开通且未消耗授权码",
  network:"登录验证请求未取得响应，请联系管理员查看诊断；本次未开通且未消耗授权码",
  response_read:"登录验证已收到响应但正文读取失败，请联系管理员查看诊断；本次未开通且未消耗授权码",
  timeout:"登录验证链路请求超时，请联系管理员查看诊断；本次未开通且未消耗授权码",
  upstream:"登录验证接口返回异常状态，请联系管理员查看诊断；本次未开通且未消耗授权码",
  protocol:"登录验证响应或协议不兼容，请联系管理员查看诊断；本次未开通且未消耗授权码",
  unsupported:"该学校登录方式暂不支持，本次未开通且未消耗授权码",
  duplicate:"该学校账号已配置，请联系管理员处理",interrupted:"验证中断或超时，请重新提交；本次未消耗授权码",
  conflict:"账号设置未完成，请联系管理员核实",unknown:"验证未完成，请稍后重试",expired_account:"授权已到期，账号资料已进入清理流程"
};
function hash(env:Env,kind:string,value:string):string {return createHmac("sha256",env.ENCRYPTION_KEY).update(kind+":"+value).digest("hex");}
function codeValue(value:unknown):string {
  if(typeof value!=="string"||value.length>100)throw new AppError(messages.invalid);
  const normalized=value.trim().toUpperCase().replace(/[\s-]/g,"");
  if(!/^JRXY[A-F0-9]{32}$/.test(normalized))throw new AppError(messages.invalid);
  return normalized;
}
function receiptValue(value:unknown):string {
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(value))throw new AppError("操作回执无效，请重新打开页面");
  return value;
}
function cleanText(value:unknown,max:number,label:string):string {
  if(typeof value!=="string"||!value.trim()||value.length>max)throw new AppError(label+"格式无效");
  return value.trim();
}
function available(code:CodeRow,preset:Preset,now=Date.now()):void {
  if(code.status==="used")throw new AppError(messages.used,409);
  if(code.status==="revoked")throw new AppError(messages.revoked,409);
  if(preset.redeem_before!==null&&preset.redeem_before<=now)throw new AppError(messages.expired,410);
  if(code.status==="reserved")throw new AppError(messages.busy,409);
}
async function loadCode(env:Env,value:unknown):Promise<{code:CodeRow;preset:Preset}> {
  const code=await env.DB.prepare("SELECT * FROM redemption_codes WHERE code_hash=?").bind(hash(env,"redeem-code",codeValue(value))).first<CodeRow>();
  if(!code)throw new AppError(messages.invalid,404);
  const preset=await env.DB.prepare("SELECT * FROM redemption_batches WHERE id=?").bind(code.batch_id).first<Preset>();
  if(!preset)throw new AppError(messages.invalid,404);
  return {code,preset};
}
export async function createCodeBatch(env:Env,body:Record<string,unknown>):Promise<unknown> {
  const quantity=body.quantity;
  if(typeof quantity!=="number"||!Number.isInteger(quantity)||quantity<1||quantity>10)throw new AppError("每批只能生成1～10个授权码，数量必须为整数");
  const school=cleanText(body.schoolName,100,"学校"),address=cleanText(body.address,300,"地址");
  const type=Number(body.type);
  if(type!==1&&type!==2)throw new AppError("仅支持签到或查寝");
  const lon=body.lon,lat=body.lat;
  if(typeof lon!=="number"||typeof lat!=="number"||!Number.isFinite(lon)||!Number.isFinite(lat)||Math.abs(lon)>180||Math.abs(lat)>90)throw new AppError("请填写有效的经纬度");
  const defaults=body.durationUnit===undefined&&body.durationValue===undefined;
  const unit=defaults?"hours":body.durationUnit,value=defaults?24:body.durationValue;
  if((unit!=="hours"&&unit!=="days")||typeof value!=="number"||!Number.isInteger(value)||value<1)throw new AppError("使用时长必须为整数小时或天");
  const duration=value*(unit==="days"?86400:3600);
  if(duration>31536000)throw new AppError("使用时长最长365天");
  const now=Date.now();
  const redeemBefore=body.redeemBefore==null||body.redeemBefore===""?null:Number(body.redeemBefore);
  if(redeemBefore!==null&&(!Number.isSafeInteger(redeemBefore)||redeemBefore<=now))throw new AppError("最晚使用时间必须在未来");
  const note=body.note==null?"":String(body.note).trim();if(note.length>100)throw new AppError("批次备注过长");
  const id=crypto.randomUUID();const codes:string[]=[];
  const statements=[env.DB.prepare(`INSERT INTO redemption_batches(id,note,school_name,task_type,longitude,latitude,address,duration_seconds,redeem_before,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id,note,school,type,lon,lat,address,duration,redeemBefore,now)];
  for(let i=0;i<quantity;i++){
    const random=randomBytes(16).toString("hex").toUpperCase();const value="JRXY-"+random.match(/.{8}/g)!.join("-");codes.push(value);
    const codeId=crypto.randomUUID(),cipher=await seal(value,env.ENCRYPTION_KEY,`authorization-code:${codeId}`);
    statements.push(env.DB.prepare("INSERT INTO redemption_codes(id,batch_id,code_hash,suffix,code_cipher) VALUES(?,?,?,?,?)")
      .bind(codeId,id,hash(env,"redeem-code",codeValue(value)),random.slice(-6),cipher));
  }
  statements.push(env.DB.prepare("INSERT INTO sign_log(ts,kind,result,detail) VALUES(?,'授权码管理','批次已生成',?)").bind(now,`生成${quantity}个一次性码；完整授权码不保存到日志`));
  await env.DB.batch(statements);
  return {id,quantity,codes,text:codes.join("\n"),durationSeconds:duration,redeemBefore};
}
export async function listCodeBatches(env:Env,cursor?:string|null):Promise<unknown> {
  if(cursor!=null&&(!/^[1-9]\d{0,15}$/.test(cursor)||!Number.isSafeInteger(Number(cursor))))throw new AppError("分页游标无效");
  const rows=await env.DB.prepare(`SELECT rowid AS position,id,batch_id,suffix,status,used_at,authorization_until,code_cipher IS NOT NULL AS recoverable
    FROM redemption_codes WHERE rowid<? ORDER BY rowid DESC LIMIT 11`).bind(cursor?Number(cursor):Number.MAX_SAFE_INTEGER).all<CodeRow & {position:number;recoverable:number}>();
  const codes=rows.results.slice(0,10),ids=[...new Set(codes.map(code=>code.batch_id))];
  const batches=await env.DB.prepare(`SELECT b.*,(SELECT count(*) FROM redemption_codes c WHERE c.batch_id=b.id) AS quantity,
    (SELECT count(*) FROM redemption_codes c WHERE c.batch_id=b.id AND c.status='used') AS used,
    (SELECT count(*) FROM redemption_codes c WHERE c.batch_id=b.id AND c.status IN('unused','reserved')) AS revocable
    FROM redemption_batches b WHERE b.id IN(SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<Preset & {quantity:number;used:number;revocable:number}>();
  const now=Date.now();
  return {pageSize:10,nextCursor:rows.results.length>10?String(codes[codes.length-1].position):null,batches:ids.map(id=>{
    const batch=batches.results.find(item=>item.id===id)!;
    return {...batch,codes:codes.filter(code=>code.batch_id===id).map(code=>{
      const expired=batch.redeem_before!==null&&batch.redeem_before<=now;
      return {id:code.id,suffix:code.suffix,status:code.status==="used"&&code.authorization_until!==null&&code.authorization_until<=now?"expired":
        ["unused","reserved"].includes(code.status)&&expired?"expired":code.status,used_at:code.used_at,authorization_until:code.authorization_until,
        recoverable:Boolean(code.recoverable),copyable:code.status==="unused"&&!expired&&Boolean(code.recoverable)};
    })};
  })};
}
export async function copyCodes(env:Env,id:string,batch=false):Promise<unknown> {
  const column=batch?"batch_id":"id",now=Date.now();
  const result=await env.DB.prepare(`SELECT c.id,c.code_hash,c.code_cipher FROM redemption_codes c JOIN redemption_batches b ON b.id=c.batch_id
    WHERE c.${column}=? AND c.status='unused' AND c.code_cipher IS NOT NULL AND (b.redeem_before IS NULL OR b.redeem_before>?) ORDER BY c.rowid LIMIT 10`)
    .bind(id,now).all<Pick<CodeRow,"id"|"code_hash"|"code_cipher">>();
  if(!result.results.length)throw new AppError("没有可复制的未使用授权码；旧版只保留摘要，无法恢复原文",409);
  const values=await Promise.all(result.results.map(async code=>{
    const value=await unseal<string>(code.code_cipher!,env.ENCRYPTION_KEY,`authorization-code:${code.id}`);
    if(hash(env,"redeem-code",codeValue(value))!==code.code_hash)throw new AppError("授权码存储校验失败",500);
    return {id:code.id,value};
  }));
  // 解密期间可能发生授权或撤销，再按最新状态过滤，不返回已失效码。
  const current=await env.DB.prepare(`SELECT c.id FROM redemption_codes c JOIN redemption_batches b ON b.id=c.batch_id
    WHERE c.id IN(SELECT value FROM json_each(?)) AND c.status='unused' AND c.code_cipher IS NOT NULL AND (b.redeem_before IS NULL OR b.redeem_before>?)`)
    .bind(JSON.stringify(values.map(value=>value.id)),Date.now()).all<{id:string}>();
  const codes=values.filter(value=>current.results.some(row=>row.id===value.id)).map(value=>value.value);
  if(!codes.length)throw new AppError("授权码状态已变化，请刷新后重试",409);
  return {quantity:codes.length,codes,text:codes.join("\n")};
}
export async function revokeCodes(env:Env,id:string,batch=false):Promise<{revoked:number}> {
  const column=batch?"batch_id":"id";
  const rows=await env.DB.batch([
    env.DB.prepare(`UPDATE redemption_codes SET status='revoked',code_cipher=NULL WHERE ${column}=? AND status IN('unused','reserved') RETURNING id`).bind(id),
    env.DB.prepare(`UPDATE enrollment_attempts SET status='failed',credentials='',identity_key=NULL,account_config='',device_id='',account_name=NULL,owner=NULL,lease_until=0,error_code='revoked',diagnostic=NULL
      WHERE status IN('pending','verifying','ready') AND code_id IN(SELECT id FROM redemption_codes WHERE ${column}=? AND status='revoked')`).bind(id),
    env.DB.prepare(`UPDATE redemption_codes SET attempt_id=NULL,reserved_until=NULL WHERE ${column}=? AND status='revoked'`).bind(id)
  ]);
  await env.DB.prepare(`UPDATE execution_slots SET kind=NULL,task_id=NULL,owner=NULL,lease_until=0 WHERE kind='enrollment' AND owner IS NULL
    AND task_id IN(SELECT e.id FROM enrollment_attempts e JOIN redemption_codes c ON c.id=e.code_id WHERE c.${column}=? AND c.status='revoked')`).bind(id).run();
  await syncGate(env);
  return {revoked:rows[0].results.length};
}
export async function revokeCode(env:Env,id:string):Promise<void> {
  if(!(await revokeCodes(env,id)).revoked)throw new AppError("授权码不存在、已使用或已撤销",409);
}
export async function indexLegacyIdentities(env:Env,limit=10):Promise<void> {
  const rows=await env.DB.prepare("SELECT * FROM accounts WHERE identity_key IS NULL AND deleted=0 LIMIT ?").bind(Math.max(1,Math.min(10,limit))).all<AccountRow>();
  const updates=[];
  for(const row of rows.results){
    const account=await unseal<Account>(row.config,env.ENCRYPTION_KEY,`account:${row.name}`);
    updates.push(env.DB.prepare("UPDATE accounts SET identity_key=? WHERE name=? AND config=? AND identity_key IS NULL")
      .bind(identityKey(env,account.schoolName,account.username),row.name,row.config));
  }
  if(updates.length)await env.DB.batch(updates);
}
async function identityReady(env:Env):Promise<void> {
  await indexLegacyIdentities(env);
  const pending=await env.DB.prepare("SELECT 1 AS pending FROM accounts WHERE identity_key IS NULL AND deleted=0 LIMIT 1").first();
  if(pending)throw new AppError("系统正在准备账号索引，请稍后重试",503);
}
async function duplicateIdentity(env:Env,identity:string):Promise<boolean> {
  return Boolean(await env.DB.prepare("SELECT name FROM accounts WHERE identity_key=? AND deleted=0 AND (authorization_until IS NULL OR authorization_until>?) LIMIT 1").bind(identity,Date.now()).first());
}
export async function publicRedemption(request:Request,env:Env,path:string):Promise<Response> {
  requireConfigured(env);requireSameOrigin(request,true);
  const url=new URL(request.url);
  if(url.protocol!=="https:" && !(url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname)))throw new AppError("授权必须通过HTTPS进行");
  const body=await readJson(request),ip=request.headers.get("CF-Connecting-IP")||"local";
  const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
  if(path==="/api/public/redemption/status"){
    await rateLimit(env,"enrollment-status-ip:"+ip,120,60_000);
    return reply(await enrollmentStatus(env,receiptValue(body.receipt)));
  }
  await rateLimit(env,"redemption-ip:"+ip,20,15*60_000);
  if(path==="/api/public/redemption/check"){
    const {code,preset}=await loadCode(env,body.code);available(code,preset);
    const schedule=await scheduleView(env);
    return reply({schoolName:preset.school_name,type:preset.task_type,durationSeconds:preset.duration_seconds,redeemBefore:preset.redeem_before,schedule:{enabled:schedule.enabled,autoEnableOnEnrollment:schedule.autoEnableOnEnrollment,time:schedule.time,timezone:schedule.timezone}});
  }
  if(path!=="/api/public/redemption/start")throw new AppError("接口不存在",404);
  if(body.consent!==true)throw new AppError("请确认仅使用本人或已获授权账号，并同意有效期内保存必要信息");
  await rateLimit(env,"redemption-start-global",60,15*60_000);
  const receipt=receiptValue(body.receipt),username=cleanText(body.username,100,"账号");
  if(typeof body.password!=="string"||!body.password||body.password.length>256)throw new AppError("请填写有效密码");
  const codeText=codeValue(body.code);
  const name=body.displayName===undefined?undefined:displayName(body.displayName);
  const notification=enrollmentNotify(body);
  const fields=[codeText,username,body.password];if(name!==undefined)fields.push(name);
  if(notification.method===2)fields.push("serverchan",notification.rcvOption);
  const requestHash=hash(env,"enrollment-request",JSON.stringify(fields));
  const old=await env.DB.prepare("SELECT request_hash FROM enrollment_attempts WHERE receipt_hash=?").bind(hash(env,"enrollment-receipt",receipt)).first<{request_hash:string}>();
  if(old){if(old.request_hash!==requestHash)throw new AppError("当前操作已提交，请等待结果或重新开始",409);return reply(await enrollmentStatus(env,receipt),202);}
  if(name===undefined)throw new AppError("请填写姓名；如果页面没有姓名输入框，请刷新后重试");
  const {code,preset}=await loadCode(env,body.code);available(code,preset);
  await rateLimit(env,"redemption-code:"+code.id,5,15*60_000);
  const identity=identityKey(env,preset.school_name,username);
  await rateLimit(env,"redemption-identity:"+identity,5,15*60_000);
  await identityReady(env);
  if(await duplicateIdentity(env,identity))throw new AppError(messages.duplicate,409);
  const id=crypto.randomUUID(),now=Date.now(),expires=now+ATTEMPT_MS;
  const credentials=await seal({username,password:body.password,displayName:name,notifyEnabled:notification.method===2,sendKey:notification.rcvOption},env.ENCRYPTION_KEY,`enrollment:${id}`);
  const rows=await env.DB.batch([
    env.DB.prepare(`UPDATE redemption_codes SET status='reserved',attempt_id=?,reserved_until=? WHERE id=? AND status='unused'
      AND NOT EXISTS(SELECT 1 FROM enrollment_attempts e WHERE e.identity_key=? AND e.status IN('pending','verifying','ready') AND e.expires_at>?)
      AND EXISTS(SELECT 1 FROM redemption_batches WHERE id=redemption_codes.batch_id AND (redeem_before IS NULL OR redeem_before>?))`)
      .bind(id,expires,code.id,identity,now,now),
    env.DB.prepare(`INSERT INTO enrollment_attempts(id,code_id,receipt_hash,request_hash,identity_key,credentials,created_at,expires_at)
      SELECT ?,id,?,?,?,?,?,? FROM redemption_codes WHERE id=? AND status='reserved' AND attempt_id=? RETURNING id`)
      .bind(id,hash(env,"enrollment-receipt",receipt),requestHash,identity,credentials,now,expires,code.id,id)
  ]);
  if(!rows[1].results.length){
    const existing=await env.DB.prepare("SELECT request_hash FROM enrollment_attempts WHERE receipt_hash=?").bind(hash(env,"enrollment-receipt",receipt)).first<{request_hash:string}>();
    if(existing?.request_hash===requestHash)return reply(await enrollmentStatus(env,receipt),202);
    throw new AppError(messages.busy,409);
  }
  await sendEnrollment(env,id);
  return reply({status:"pending",message:"正在验证登录，尚未开通"},202);
}
async function sendEnrollment(env:Env,id:string):Promise<void> {
  const now=Date.now();
  const claimed=await env.DB.prepare(`UPDATE enrollment_attempts SET dispatched_at=? WHERE id=? AND status IN('pending','ready')
    AND expires_at>? AND dispatched_at<? RETURNING status`).bind(now,id,now,now-120_000).first<{status:string}>();
  if(!claimed)return;
  if(claimed.status==="pending"&&!await reserveSlot(env,"enrollment",id,now)){
    await env.DB.prepare("UPDATE enrollment_attempts SET dispatched_at=0 WHERE id=? AND dispatched_at=?").bind(id,now).run();return;
  }
  try{await env.JOBS.send({kind:"enrollment",id});}catch{
    await env.DB.prepare("UPDATE enrollment_attempts SET dispatched_at=0 WHERE id=? AND dispatched_at=?").bind(id,now).run();await releaseSlot(env,"enrollment",id,null);
  }
}
async function failAttempt(env:Env,id:string,reason:string,diagnostic?:RequestDiagnostic|null):Promise<void> {
  const safe=safeDiagnostic(diagnostic);
  await env.DB.batch([
    env.DB.prepare(`UPDATE redemption_codes SET status='unused',attempt_id=NULL,reserved_until=NULL WHERE status='reserved' AND attempt_id=?
      AND EXISTS(SELECT 1 FROM enrollment_attempts WHERE id=? AND status!='succeeded')`).bind(id,id),
    env.DB.prepare(`UPDATE enrollment_attempts SET status='failed',credentials='',identity_key=NULL,account_config='',device_id='',account_name=NULL,owner=NULL,lease_until=0,error_code=?,diagnostic=?
      WHERE id=? AND status NOT IN('succeeded','failed')`).bind(reason,safe?JSON.stringify(safe):null,id)
  ]);
  await releaseSlot(env,"enrollment",id,null);
}
export async function listEnrollments(env:Env):Promise<unknown[]> {
  const rows=await env.DB.prepare(`SELECT e.created_at,e.status,e.error_code,e.diagnostic,c.suffix FROM enrollment_attempts e
    JOIN redemption_codes c ON c.id=e.code_id WHERE e.expires_at>? ORDER BY e.created_at DESC,e.id DESC LIMIT 50`).bind(Date.now()).all<Pick<Attempt,"created_at"|"status"|"error_code"|"diagnostic"> & {suffix:string}>();
  return rows.results.map(row=>{
    let diagnostic:RequestDiagnostic|null=null;
    try{diagnostic=safeDiagnostic(JSON.parse(row.diagnostic??"null"));}catch{}
    return {createdAt:localTime(row.created_at,settings(env).timezone),timezone:`UTC${settings(env).timezone>=0?"+":""}${settings(env).timezone}`,
      status:row.status,suffix:row.suffix,message:row.error_code?(messages[row.error_code]||messages.unknown):null,diagnostic};
  });
}
export async function enrollmentStatus(env:Env,receipt:string):Promise<unknown> {
  const attempt=await env.DB.prepare("SELECT * FROM enrollment_attempts WHERE receipt_hash=? AND expires_at>?").bind(hash(env,"enrollment-receipt",receipt),Date.now()).first<Attempt>();
  if(!attempt)throw new AppError("验证回执已失效，请重新提交或联系管理员",404);
  if(attempt.status==="failed")return {status:"failed",message:messages[attempt.error_code??"unknown"]||messages.unknown};
  if(attempt.status==="succeeded"){
    const row=await env.DB.prepare("SELECT name,config,authorization_until FROM accounts WHERE name=? AND deleted=0 AND authorization_until>?").bind(attempt.account_name,Date.now()).first<{name:string;config:string;authorization_until:number}>();
    if(!row)return {status:"failed",message:messages.expired_account};
    const option=notifyOption(await unseal<Account>(row.config,env.ENCRYPTION_KEY,`account:${row.name}`));
    const schedule=await scheduleView(env);
    return {status:"succeeded",message:"签到设置成功",notifyEnabled:option.method===2&&Boolean(option.rcvOption),authorizationUntil:row.authorization_until,expiresText:localTime(row.authorization_until,settings(env).timezone),
      schedule:{enabled:schedule.enabled,time:schedule.time,timezone:schedule.timezone,next:schedule.next},deviceNote:"设备标识已按原项目规则初始化并固定"};
  }
  return {status:attempt.status==="ready"?"setting_up":attempt.status,message:attempt.status==="ready"?"登录通过，正在保存签到设置":"正在验证登录，尚未开通"};
}
export async function processEnrollment(env:Env,id:string,loginFn=login):Promise<void> {
  requireConfigured(env);
  let attempt=await env.DB.prepare("SELECT * FROM enrollment_attempts WHERE id=?").bind(id).first<Attempt>();
  if(!attempt||["failed","succeeded"].includes(attempt.status)){await releaseSlot(env,"enrollment",id,null);return;}
  const now=Date.now();
  if(attempt.expires_at<=now){await failAttempt(env,id,"interrupted");return;}
  if(attempt.status==="verifying"){
    if(attempt.lease_until<=now)await failAttempt(env,id,"interrupted");
    return;
  }
  const preset=await env.DB.prepare("SELECT b.* FROM redemption_batches b JOIN redemption_codes c ON c.batch_id=b.id WHERE c.id=?").bind(attempt.code_id).first<Preset>();
  if(!preset){await failAttempt(env,id,"invalid");return;}
  if(attempt.status==="pending"){
    const owner=crypto.randomUUID(),lease=now+settings(env).runTimeoutMs+60_000;
    const rows=await env.DB.batch([
      expireSlots(env,now),slotGate(env,now,lease),slotClaim(env,"enrollment",id,owner,now,lease),
      env.DB.prepare(`UPDATE enrollment_attempts SET status='verifying',owner=?,lease_until=? WHERE id=? AND status='pending'
        AND expires_at>? AND ${ownsSlotSql("enrollment")} AND EXISTS(SELECT 1 FROM redemption_codes c JOIN redemption_batches b ON b.id=c.batch_id WHERE c.id=code_id
          AND c.status='reserved' AND c.attempt_id=enrollment_attempts.id AND c.reserved_until>? AND (b.redeem_before IS NULL OR b.redeem_before>?)) RETURNING *`)
        .bind(owner,lease,id,now,id,owner,now,now,now)
    ]);
    const claimed=rows[3].results[0] as unknown as Attempt|undefined;
    if(!claimed){
      await releaseSlot(env,"enrollment",id,owner);
      if(!rows[2].results.length){
        await releaseSlot(env,"enrollment",id,null);
        await env.DB.prepare("UPDATE enrollment_attempts SET dispatched_at=0 WHERE id=? AND status='pending'").bind(id).run();return;
      }
      const latest=await env.DB.prepare("SELECT status FROM enrollment_attempts WHERE id=?").bind(id).first<{status:string}>();
      if(latest?.status==="pending")await failAttempt(env,id,"revoked");return;
    }
    attempt=claimed;
    let privateValues:string[]=[];
    try{
      if(await duplicateIdentity(env,attempt.identity_key!)){await failAttempt(env,id,"duplicate");return;}
      const credentials=await unseal<{username:string;password:string;displayName?:string;notifyEnabled?:boolean;sendKey?:string}>(attempt.credentials,env.ENCRYPTION_KEY,`enrollment:${id}`);
      const account:Account={schoolName:preset.school_name,type:preset.task_type,username:credentials.username,password:credentials.password,
        lon:preset.longitude,lat:preset.latitude,address:preset.address,abnormalReason:"",notifyKey:"",notifyOption:{method:0,rcvOption:""},checkTitle:0};
      if(credentials.displayName!==undefined)account.displayName=displayName(credentials.displayName);
      account.notifyOption=enrollmentNotify(credentials);account.notifyKey=account.notifyOption.rcvOption;
      privateValues=[credentials.username,credentials.password,credentials.displayName??"",account.notifyKey];
      const prior=await env.DB.prepare("SELECT device_id FROM accounts WHERE identity_key=? AND deleted=1 AND grant_code_id IS NULL ORDER BY created_at DESC LIMIT 1").bind(attempt.identity_key).first<{device_id:string}>();
      const device=initializeDeviceId("",attempt.device_id||prior?.device_id);
      const prepared=await env.DB.prepare(`UPDATE enrollment_attempts SET device_id=? WHERE id=? AND status='verifying' AND owner=? AND lease_until>? AND expires_at>?
        AND EXISTS(SELECT 1 FROM redemption_codes c WHERE c.id=code_id AND c.status='reserved' AND c.attempt_id=enrollment_attempts.id)
        AND ${ownsSlotSql("enrollment")} RETURNING id`)
        .bind(device,id,owner,Date.now(),Date.now(),id,owner,Date.now()).first();
      if(!prepared){await failAttempt(env,id,"interrupted");return;}
      await loginFn(account,new Session(fetch,settings(env).httpTimeoutMs,settings(env).runTimeoutMs));
      const name="u_"+randomBytes(10).toString("hex");
      const encrypted=await seal(account,env.ENCRYPTION_KEY,`account:${name}`);
      const ready=await env.DB.prepare(`UPDATE enrollment_attempts SET status='ready',account_name=?,account_config=?,device_id=?,credentials='',owner=NULL,lease_until=0,dispatched_at=0
        WHERE id=? AND owner=? AND status='verifying' AND expires_at>? AND lease_until>? AND ${ownsSlotSql("enrollment")} RETURNING *`).bind(name,encrypted,device,id,owner,Date.now(),Date.now(),id,owner,Date.now()).first<Attempt>();
      if(!ready){await failAttempt(env,id,"interrupted");return;}
      attempt=ready;
    }catch(error){
      const diagnostic=safeDiagnostic(error instanceof EngineError?error.diagnostic:{stage:"setup",kind:"internal"},privateValues);
      const kind=diagnostic?.kind;
      const reason=error instanceof EngineError?(error.status==="captcha"?"captcha":error.status==="unsupported"?"unsupported":
        kind==="timeout"||kind==="total_timeout"?"timeout":kind==="http"?"upstream":kind==="body_read"?"response_read":kind==="transport"?"network":
        error.status==="error"||["policy","request_limit","redirect_limit","internal","response_processing"].includes(kind??"")?"protocol":"credentials"):"unknown";
      await failAttempt(env,id,reason,diagnostic);return;
    }finally{await releaseSlot(env,"enrollment",id,owner);}
  }
  if(attempt.status!=="ready")return;
  await releaseSlot(env,"enrollment",id,null);
  await identityReady(env);
  await getSchedule(env);
  const activated=Date.now(),until=activated+preset.duration_seconds*1000;
  const rows=await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO accounts(name,config,device_id,created_at,identity_key,grant_code_id,authorization_from,authorization_until,resume_after)
      SELECT a.account_name,a.account_config,a.device_id,?,a.identity_key,a.code_id,?,?,? FROM enrollment_attempts a
      JOIN redemption_codes c ON c.id=a.code_id JOIN redemption_batches b ON b.id=c.batch_id
      WHERE a.id=? AND a.status='ready' AND a.expires_at>? AND c.status='reserved' AND c.attempt_id=a.id AND c.reserved_until>?
      AND (b.redeem_before IS NULL OR b.redeem_before>?)
      AND NOT EXISTS(SELECT 1 FROM accounts old WHERE old.deleted=0 AND (old.identity_key=a.identity_key OR old.identity_key IS NULL))`)
      .bind(activated,activated,until,activated,id,activated,activated,activated),
    env.DB.prepare(`UPDATE redemption_codes SET status='used',used_at=?,authorization_until=?,attempt_id=NULL,reserved_until=NULL,code_cipher=NULL WHERE id=? AND status='reserved' AND attempt_id=?
      AND EXISTS(SELECT 1 FROM accounts a JOIN enrollment_attempts e ON a.name=e.account_name WHERE e.id=? AND e.status='ready' AND a.grant_code_id=redemption_codes.id)`)
      .bind(activated,until,attempt.code_id,id,id),
    env.DB.prepare(`UPDATE enrollment_attempts SET status='succeeded',credentials='',identity_key=NULL,account_config='',device_id='',owner=NULL,lease_until=0,authorization_until=?
      WHERE id=? AND status='ready' AND EXISTS(SELECT 1 FROM redemption_codes WHERE id=code_id AND status='used')
      AND EXISTS(SELECT 1 FROM accounts WHERE name=enrollment_attempts.account_name AND grant_code_id=enrollment_attempts.code_id) RETURNING id`).bind(until,id),
    // 初始计划才自动开启；管理员保存过的开关不可被兑换覆盖。
    env.DB.prepare(`UPDATE schedule SET enabled=1,revision=revision+1,effective_after=? WHERE id=1 AND enabled=0 AND revision=1
      AND EXISTS(SELECT 1 FROM enrollment_attempts e JOIN accounts a ON a.name=e.account_name
        WHERE e.id=? AND e.status='succeeded' AND a.grant_code_id=e.code_id AND a.authorization_until>?)`).bind(activated,id,activated)
  ]);
  if(!rows[2].results.length)await failAttempt(env,id,"conflict");
}
export async function cleanupEnrollments(env:Env,now=Date.now()):Promise<number> {
  await env.DB.prepare(`UPDATE redemption_codes SET code_cipher=NULL WHERE id IN(SELECT c.id FROM redemption_codes c JOIN redemption_batches b ON b.id=c.batch_id
    WHERE c.code_cipher IS NOT NULL AND (c.status IN('used','revoked') OR b.redeem_before<=?) LIMIT 20)`).bind(now).run();
  const stale=await env.DB.prepare(`SELECT id FROM enrollment_attempts WHERE status IN('pending','verifying','ready') AND
    (expires_at<=? OR (status='verifying' AND lease_until<=?)) LIMIT 1`).bind(now,now).all<{id:string}>();
  for(const attempt of stale.results)await failAttempt(env,attempt.id,"interrupted");
  await env.DB.prepare("DELETE FROM enrollment_attempts WHERE id IN(SELECT id FROM enrollment_attempts WHERE expires_at<=? AND status IN('succeeded','failed') ORDER BY expires_at LIMIT 20)").bind(now).run();
  await dispatchEnrollments(env,now);
  return stale.results.length;
}
export async function dispatchEnrollments(env:Env,now=Date.now()):Promise<void>{
  const queued=await env.DB.prepare("SELECT id FROM enrollment_attempts WHERE status IN('pending','ready') AND expires_at>? AND dispatched_at<? ORDER BY created_at LIMIT 1")
    .bind(now,now-120_000).all<{id:string}>();
  for(const attempt of queued.results)await sendEnrollment(env,attempt.id);
}
