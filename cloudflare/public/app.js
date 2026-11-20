"use strict";
const $ = id => document.getElementById(id);
const labels = {success:"签到成功",already:"今日已签到",no_task:"暂无待签任务",dry:"探测通过",fail:"签到失败",error:"执行异常",captcha:"需要人工验证",unsupported:"任务不支持",uncertain:"提交状态待确认",paused:"账号已暂停",expired:"授权已到期"};
const modes = {dry:"探测",submit:"签到",login:"登录测试",range:"范围获取"};
const pendingKey = "jrxy_pending_jobs_v2";
let csrfToken = "", signedIn = false, editingName = "", originalDevice = "", accounts = [], filter = "all";
let toastTimer, pollBusy = false, confirmResolve, visibleTaskKey = "", scheduleDirty = false;
const pending = new Map();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function badge(text, kind="neutral") { return element("span",text,"pill "+kind); }
function resultKind(status) {
  return ["success","already","dry"].includes(status) ? "ok" : ["no_task","captcha","uncertain","paused","unsupported"].includes(status) ? "warn" : "bad";
}
function toast(text, bad=false) {
  clearTimeout(toastTimer); $("toast").textContent=text; $("toast").className="toast"+(bad?" bad":""); $("toast").hidden=false;
  toastTimer=setTimeout(()=>$("toast").hidden=true,4500);
}
function showError(error) {
  if (error.status===401) return;
  const target=$("accountDialog").open?$("accountFormError"):$("pageError");
  target.textContent=error.message||"操作失败，请重试";target.hidden=false;
}
function clearErrors() { $("pageError").hidden=true;$("accountFormError").hidden=true; }
async function api(path,method="GET",body,login=false) {
  const headers={"Content-Type":"application/json"};
  if(csrfToken&&method!=="GET")headers["X-CSRF-Token"]=csrfToken;
  let response;
  try { response=await fetch(path,{method,headers,credentials:"same-origin",body:body===undefined?undefined:JSON.stringify(body)}); }
  catch { throw new Error("网络连接失败，请检查网络后重试"); }
  const data=await response.json().catch(()=>({detail:"服务器返回了无法识别的响应"}));
  if(!response.ok) {
    const error=new Error(data.detail||"操作失败");error.status=response.status;
    if(response.status===401&&!login)showLogin();
    if(response.status===403&&!login&&signedIn&&path!=="/api/auth/session") {
      try{const identity=await api("/api/auth/session");csrfToken=identity.csrfToken;}catch{}
    }
    throw error;
  }
  return data;
}
function showLogin() {
  signedIn=false;csrfToken="";accounts=[];editingName="";scheduleDirty=false;
  for(const task of pending.values())task.reject?.(Object.assign(new Error("登录已过期，请重新登录"),{status:401}));
  pending.clear();
  for(const dialog of [$("accountDialog"),$("confirmDialog")])if(dialog.open)dialog.close();
  if(confirmResolve){confirmResolve(false);confirmResolve=null;}
  $("accountForm").reset();$("accountRows").replaceChildren();$("accountCards").replaceChildren();$("logList").replaceChildren();
  $("codeBatchForm").reset();$("codeBatchList").replaceChildren();$("enrollmentList").replaceChildren();hideGeneratedCodes();
  $("boot").hidden=true;$("appView").hidden=true;$("loginView").hidden=false;$("taskResult").hidden=true;$("toast").hidden=true;
  $("loginPassword").value="";
}
async function showApp(identity) {
  csrfToken=identity.csrfToken;signedIn=true;
  $("adminName").textContent=identity.username;
  $("boot").hidden=true;$("loginView").hidden=true;$("appView").hidden=false;$("loginPassword").value="";
  clearErrors();
  try { await refresh(true); } catch(error) { showError(error); }
  if(!signedIn)return;
  try {
    const saved=JSON.parse(sessionStorage.getItem(pendingKey)||"[]");
    if(Array.isArray(saved))for(const task of saved.slice(0,10))if(Array.isArray(task.ids)&&task.ids.length&&task.ids.every(id=>typeof id==="string"&&id.length<=200)) {
      trackTask(task.ids,String(task.mode||"dry"),String(task.label||"执行任务"));
    }
  } catch { sessionStorage.removeItem(pendingKey); }
  await pollJobs();
}
function button(text,callback,className="") {
  const node=element("button",text,"button small "+className);node.type="button";
  node.addEventListener("click",async()=>{node.disabled=true;clearErrors();try{await callback();}catch(error){showError(error);}finally{node.disabled=false;}});
  return node;
}
function confirmAction(title,text,accept="确认",danger=false) {
  if(confirmResolve)return Promise.resolve(false);
  $("confirmTitle").textContent=title;$("confirmText").textContent=text;$("confirmAccept").textContent=accept;
  $("confirmAccept").className="button primary"+(danger?" confirm-danger":"");
  $("confirmDialog").showModal();
  return new Promise(resolve=>confirmResolve=resolve);
}
function resolveConfirm(value) { const resolve=confirmResolve;confirmResolve=null;$("confirmDialog").close();resolve?.(value); }
$("confirmAccept").addEventListener("click",()=>resolveConfirm(true));
$("confirmCancel").addEventListener("click",()=>resolveConfirm(false));
$("confirmDialog").addEventListener("cancel",event=>{event.preventDefault();resolveConfirm(false);});

async function loadStatus(updateForm=false) {
  const status=await api("/api/status");if(!signedIn)return;
  $("accountCount").textContent=status.account_count;$("pausedCount").textContent=status.paused_count;
  $("activeCount").textContent=(status.account_count-status.paused_count)+" 个账号正常运行";
  $("serverTime").textContent=status.server_time;
  $("scheduleTime").textContent=status.scheduler.time;
  $("scheduleBadge").textContent=status.scheduler.enabled?"已开启":"未开启";
  $("scheduleBadge").className="pill "+(status.scheduler.enabled?"ok":"neutral");
  $("scheduleNext").textContent=status.scheduler.enabled?"下次 "+status.scheduler.next:"自动签到已关闭";
  $("timezoneLabel").textContent=status.timezone;
  $("scheduleNote").textContent=status.scheduler.enabled?"下次执行："+status.scheduler.next+"（"+status.timezone+"）":"当前未开启自动签到";
  $("lastRun").textContent=status.scheduler.last_run?"上次："+status.scheduler.last_run+" · "+status.scheduler.last_result:"";
  if(updateForm||!scheduleDirty){$("scheduleEnabled").checked=status.scheduler.enabled;$("scheduleInput").value=status.scheduler.time;}
  $("connectionState").replaceChildren(element("i"),document.createTextNode("已连接"));
}
async function loadAccounts() {
  const result=await api("/api/accounts");if(!signedIn)return;
  accounts=result.accounts;renderAccounts();
}
function accountLabel(account) { return account.displayName||account.name; }
function accountName(name) { const account=accounts.find(item=>item.name===name);return account?accountLabel(account):name; }
function identity(account) {
  const block=element("div",undefined,"account-identity");
  block.append(element("span",accountLabel(account).slice(0,1),"account-avatar"));
  const info=element("div");info.append(element("b",accountLabel(account)),element("small",account.schoolName),element("small",account.username,"student"));
  if(account.authorization_until)info.append(element("small","有效至 "+new Date(account.authorization_until).toLocaleString(),"grant-expiry"));
  block.append(info);return block;
}
function accountActions(account,mobile=false) {
  const actions=element("div",undefined,mobile?"card-actions":"row-actions");
  const sign=button("签到",()=>runAccount(account.name,"submit"),"soft-primary");sign.disabled=account.paused;
  if(account.paused)sign.title="账号已暂停，恢复后才能签到";
  actions.append(button("编辑",()=>openAccount(account.name),"text-button"),button("探测",()=>runAccount(account.name,"dry"),"text-button"),sign,
    button(account.paused?"恢复":"暂停",()=>togglePaused(account),"text-button"),button("删除",()=>removeAccount(account),"text-button danger-text"));
  return actions;
}
function renderAccounts() {
  const query=$("accountSearch").value.trim().toLocaleLowerCase();
  const visible=accounts.filter(account=>(filter==="all"||(filter==="paused"?account.paused:!account.paused))&&
    [account.name,account.displayName,account.schoolName,account.username].some(value=>String(value).toLocaleLowerCase().includes(query)));
  $("listCount").textContent=String(accounts.length);$("accountRows").replaceChildren();$("accountCards").replaceChildren();
  $("accountEmpty").hidden=visible.length>0;
  $("accountEmpty").querySelector("h3").textContent=accounts.length?"没有匹配的账号":"还没有账号";
  $("accountEmpty").querySelector("p").textContent=accounts.length?"试试更换关键词或筛选条件。":"新增账号，开始配置签到与查寝。";
  for(const account of visible) {
    const tr=element("tr");const name=element("td");name.append(identity(account));
    const type=element("td");type.append(badge(account.type===1?"签到":"查寝"));
    const position=element("td",account.address||"未设置位置","position-cell");
    if(account.lon!=null&&account.lat!=null)position.append(element("small",account.lon+", "+account.lat));
    const state=element("td");state.append(badge(account.paused?"已暂停":"正常",account.paused?"paused":"ok"));
    const actions=element("td");actions.append(accountActions(account));tr.append(name,type,position,state,actions);$("accountRows").append(tr);
    const card=element("article",undefined,"account-card");const top=element("div",undefined,"card-top");top.append(identity(account),badge(account.paused?"已暂停":account.type===1?"签到":"查寝",account.paused?"paused":"ok"));
    card.append(top,element("p",account.address||"未设置签到位置","card-position"),accountActions(account,true));$("accountCards").append(card);
  }
  const active=accounts.filter(account=>!account.paused).length;
  $("batchHint").textContent=accounts.length?`${active} 个正常账号 · ${accounts.length-active} 个已暂停` : "先添加账号，再进行探测或签到。";
  $("batchDry").disabled=!accounts.length;$("batchSubmit").disabled=!active;
}
async function loadLogs() {
  const result=await api("/api/logs?limit=100");if(!signedIn)return;
  $("logList").replaceChildren();$("logEmpty").hidden=result.logs.length>0;
  for(const log of result.logs) {
    const details=element("details",undefined,"log-entry");const summary=element("summary");
    const kind=/失败|异常|错误/.test(log.result)?"bad":/暂停|未知|暂无|验证|跳过|待确认/.test(log.result)?"warn":"ok";
    const info=element("div",undefined,"log-info");info.append(element("span",undefined,"log-dot "+kind));
    const text=element("div",undefined,"log-text");text.append(element("b",log.kind),element("small",log.ts));info.append(text);
    summary.append(info,badge(log.result,kind));summary.title=log.result;
    details.append(summary,element("pre",log.detail||"无详情"));$("logList").append(details);
  }
}
async function loadEnrollments(){
  const data=await api("/api/redemption/attempts");if(!signedIn)return;
  $("enrollmentList").replaceChildren();$("enrollmentEmpty").hidden=data.attempts.length>0;
  const states={pending:"等待验证",verifying:"验证中",ready:"正在保存",succeeded:"已开通",failed:"未开通"};
  const stages={request:"上游请求",tenant_list:"获取学校列表",tenant_info:"获取学校信息",portal:"打开校园入口及跳转",login_form:"解析学校登录页",login_ticket:"获取登录票据",captcha_check:"检查验证码",login_submit:"提交学校登录",login_callback:"登录回跳",setup:"准备或保存账号"};
  const kinds={timeout:"单次请求超时",total_timeout:"总网络时限已到",transport:"发送失败，未取得响应（DNS / TLS / 连接原因待核实）",body_read:"已取得响应，正文读取中断",response_processing:"已取得响应，响应头或内容处理错误",http:"上游HTTP异常",response:"响应或登录校验未通过",request_limit:"请求次数超限",redirect_limit:"重定向次数超限",policy:"地址或跨域请求不符合安全规则",internal:"内部处理异常"};
  for(const attempt of data.attempts){
    const item=element("details",undefined,"log-entry"),summary=element("summary"),info=element("div",undefined,"log-text");
    info.append(element("b","兑换码 …"+attempt.suffix),element("small",attempt.createdAt+"（"+attempt.timezone+"）"));
    summary.append(info,badge(states[attempt.status]||attempt.status,attempt.status==="failed"?"bad":attempt.status==="succeeded"?"ok":"warn"));item.append(summary);
    const d=attempt.diagnostic,lines=[attempt.message||states[attempt.status]||attempt.status];
    const phases={send:"发送请求，尚未取得响应",headers:"处理响应头与Cookie",body:"读取响应正文",decode:"解码响应正文",json:"解析JSON响应"};
    if(d){lines.push("阶段："+(stages[d.stage]||"未知"),"分类："+(kinds[d.kind]||"未知"));if(d.phase)lines.push("处理环节："+(phases[d.phase]||"未知"));if(d.host)lines.push("目标域名："+d.host);if(d.method)lines.push("方法："+d.method);if(d.httpStatus)lines.push("HTTP："+d.httpStatus);if(d.elapsedMs!=null)lines.push("请求耗时："+d.elapsedMs+" ms");}
    else if(attempt.status==="failed")lines.push("没有详细诊断；旧版本记录或验证已被撤销/中断。");
    item.append(element("pre",lines.join("\n")));$("enrollmentList").append(item);
  }
}
$("refreshEnrollments").addEventListener("click",async()=>{const button=$("refreshEnrollments");button.disabled=true;try{await loadEnrollments();}catch(error){showError(error);}finally{button.disabled=false;}});
async function refresh(updateForm=false) { await Promise.all([loadStatus(updateForm),loadAccounts(),loadLogs(),loadCodeBatches(),loadEnrollments()]); }
async function togglePaused(account) {
  if(!account.paused&&!await confirmAction("暂停此账号？",`暂停「${accountLabel(account)}」（${account.username}）后，定时、批量和手动签到都将停止。已经发送的签到请求无法撤回。`,"暂停账号"))return;
  const result=await api(`/api/accounts/${encodeURIComponent(account.name)}/pause`,"POST",{paused:!account.paused});
  toast(result.paused?"账号已暂停":"账号已恢复，不补跑暂停期间的任务");
  if(result.inFlight){$("pageError").textContent="当前任务可能已进入提交阶段，无法撤回；请查看最终结果。";$("pageError").hidden=false;}
  await refresh();await pollJobs();
}
async function removeAccount(account) {
  const note=account.source==="redemption"?"该兑换账号的凭据、设备绑定与关联记录将被删除，兑换码不会恢复可用。":"账号配置将删除，设备绑定仍会保留。";
  if(!await confirmAction("删除账号？",`删除「${accountLabel(account)}」（${account.username}）？${note}此操作不能撤销。`,"删除账号",true))return;
  await api("/api/accounts/"+encodeURIComponent(account.name),"DELETE");toast("账号已删除");await refresh();
}
function persistTasks() { sessionStorage.setItem(pendingKey,JSON.stringify([...pending.values()].map(({ids,mode})=>({ids,mode,label:(modes[mode]||"任务")+" · "+ids.length+"个账号"})))); }
function trackTask(ids,mode,label,resolve,reject) {
  const key=ids.join(",");pending.set(key,{ids,mode,label,resolve,reject});visibleTaskKey=key;persistTasks();
  $("taskResult").hidden=false;$("taskTitle").textContent=label;$("taskDetail").textContent="任务已提交，等待执行…";
}
async function runTask(path,mode,label) {
  const result=await api(path,"POST",{mode});
  if(!result.ids?.length){toast("没有可执行的账号，已暂停或忙碌账号会被跳过。");return [];}
  return new Promise((resolve,reject)=>{trackTask(result.ids,mode,label,resolve,reject);pollJobs();});
}
async function runAccount(name,mode) {
  const account=accounts.find(item=>item.name===name),label=accountName(name);
  if(mode==="submit"&&!await confirmAction("确认签到？",`将对「${label}」（${account?.username||name}）执行真实签到。请确认位置及账号配置正确。`,"开始签到"))return;
  return runTask(`/api/accounts/${encodeURIComponent(name)}/run`,mode,`${modes[mode]} · ${label}`);
}
async function pollJobs() {
  if(!signedIn||pollBusy||!pending.size)return;
  pollBusy=true;
  try {
    for(const [key,task] of [...pending]) {
      const jobs=[];
      for(let i=0;i<task.ids.length;i+=50)jobs.push(...(await api("/api/jobs?ids="+encodeURIComponent(task.ids.slice(i,i+50).join(",")))).jobs);
      if(!signedIn)return;
      if(jobs.length!==task.ids.length){
        pending.delete(key);persistTasks();task.resolve?.([]);
        if(key===visibleTaskKey)$("taskDetail").textContent="部分账号已到期或删除，相关任务记录已清理。";
        continue;
      }
      const done=jobs.filter(job=>job.status==="done").length;
      if(key===visibleTaskKey) {
        $("taskTitle").textContent=task.label+(done===jobs.length?" · 已完成":` · ${done}/${jobs.length}`);
        $("taskDetail").textContent=jobs.map(job=>`${accountName(job.account)}：${job.status==="done"?(labels[job.result?.status]||"已完成"):job.status==="running"?"执行中":"等待执行"}\n${job.result?.detail||job.result?.message||""}`).join("\n\n");
      }
      if(done===jobs.length){pending.delete(key);persistTasks();task.resolve?.(jobs);await Promise.all([loadLogs(),loadAccounts(),loadStatus()]);}
    }
  } catch(error) {
    if(error.status!==401) {
      $("taskDetail").textContent="暂时无法获取进度，后台任务不会因此中断。"+error.message;
      if(error.status===404){for(const task of pending.values())task.reject?.(error);pending.clear();persistTasks();}
    }
  } finally {pollBusy=false;}
}
function field(name) { return $("accountForm").elements.namedItem(name); }
async function openAccount(name="") {
  editingName=name;originalDevice="";$("accountForm").reset();$("accountFormError").hidden=true;
  $("accountDialogTitle").textContent=name?"编辑账号 · "+accountName(name):"新增账号";
  field("name").disabled=false;field("name").maxLength=name?50:32;field("password").required=!name;
  $("accountNameNote").textContent=name?"此名称仅用于显示，修改不会改变账号内部编号或设备标识。":"新建名称用于内部标识；保存后可修改显示名称。";
  for(const id of ["testLogin","rangeButton","testNotify"])$(id).disabled=!name;
  $("rangeNote").textContent="";$("loginTestState").textContent="";$("notifyTestState").textContent="测试使用已保存的配置，不会执行签到。";
  $("accountSaveHint").textContent=name?"密码和设备标识留空保持不变。":"设备标识留空自动处理，保存后固定使用。";
  $("accountDialog").querySelector(".advanced-fields").open=false;
  if(name){
    const account=await api("/api/accounts/"+encodeURIComponent(name));if(!signedIn)return;
    for(const key of ["name","schoolName","type","username","deviceId","lon","lat","address","abnormalReason","checkTitle","httpProxy"])field(key).value=account[key]??"";
    field("name").value=accountLabel(account);
    field("notifyMethod").value=String(account.notify_method||0);field("notifyRcv").value=account.notify_rcv||"";originalDevice=account.deviceId;
  }
  $("accountDialog").showModal();
}
function closeAccount() { $("accountDialog").close();$("accountForm").reset();editingName=""; }
$("accountForm").addEventListener("submit",async event=>{
  event.preventDefault();const submit=$("saveAccount");submit.disabled=true;$("accountFormError").hidden=true;
  try{
    const body=Object.fromEntries(new FormData(event.currentTarget));
    if(editingName&&body.deviceId.trim()&&body.deviceId.trim()!==originalDevice&&!await confirmAction("修改设备标识？","只在需要迁移或修正原ID时修改。留空会保持原值，随意更换可能触发学校的设备限制。","确认修改"))return;
    if(editingName){body.displayName=body.name;delete body.name;}
    await api(editingName?"/api/accounts/"+encodeURIComponent(editingName):"/api/accounts","POST",body);
    closeAccount();toast("账号已保存");await refresh();
  }catch(error){showError(error);}finally{submit.disabled=false;}
});
async function editorTask(buttonId,mode,suffix,stateId) {
  const name=editingName;if(!name)return;
  $(buttonId).disabled=true;$(stateId).textContent="正在执行…";
  try{
    const jobs=await runTask(`/api/accounts/${encodeURIComponent(name)}/${suffix}`,mode,`${modes[mode]} · ${accountName(name)}`);
    if(editingName!==name||!$("accountDialog").open||!jobs.length)return;
    const result=jobs[0].result;$(stateId).textContent=result.message;
    if(mode==="range"&&result.status==="success"){
      field("lon").value=result.data.lon;field("lat").value=result.data.lat;field("address").value=result.data.address||field("address").value;
      $(stateId).textContent=`范围已应用：半径 ${result.data.radius}m，${result.data.window_begin||""} — ${result.data.window_end||""}`;
    }
  }catch(error){if(editingName===name)$(stateId).textContent=error.message;}finally{if(editingName===name)$(buttonId).disabled=false;}
}
$("testLogin").addEventListener("click",()=>editorTask("testLogin","login","test-login","loginTestState"));
$("rangeButton").addEventListener("click",async()=>{
  if(await confirmAction("获取并应用签到范围？","将读取学校任务范围并更新该账号的位置。使用前请确认它与你的实际位置一致。","获取范围"))await editorTask("rangeButton","range","sign-range","rangeNote");
});
$("testNotify").addEventListener("click",async()=>{
  const name=editingName;if(!name||!await confirmAction("发送测试推送？","使用此账号已保存的通知配置发送一条测试消息，不会登录学校或签到。","发送测试"))return;
  $("testNotify").disabled=true;$("notifyTestState").textContent="正在发送…";
  try{const result=await api(`/api/accounts/${encodeURIComponent(name)}/test-notify`,"POST",{});if(editingName===name)$("notifyTestState").textContent=result.result;await loadLogs();}
  catch(error){if(editingName===name)$("notifyTestState").textContent=error.message;}finally{if(editingName===name)$("testNotify").disabled=false;}
});
function hideGeneratedCodes(){ $("generatedCodes").hidden=true;$("codeOutput").value="";$("singleCodeCopies").replaceChildren(); }
async function copyCodes(text){
  try{await navigator.clipboard.writeText(text);toast("已复制，请妥善保存");}
  catch{$("codeOutput").focus();$("codeOutput").select();toast("请手动复制选中的兑换码");}
}
async function loadCodeBatches(){
  const data=await api("/api/redemption/batches");if(!signedIn)return;
  $("codeBatchList").replaceChildren();$("codeBatchEmpty").hidden=data.batches.length>0;
  const names={unused:"未使用",reserved:"验证中",used:"已使用",expired:"已过期",revoked:"已撤销"};
  for(const batch of data.batches){
    const item=element("details",undefined,"code-batch-item"),summary=element("summary"),heading=element("div");
    heading.append(element("strong",batch.note||batch.school_name),element("small",`${batch.school_name} · ${batch.task_type===1?"签到":"查寝"} · ${batch.duration_seconds/3600}小时 · ${batch.quantity}个码`));
    const used=batch.codes.filter(code=>code.used_at).length;summary.append(heading,badge(`${used}/${batch.quantity} 已使用`,used?"ok":"neutral"));item.append(summary);
    item.append(element("p",`${batch.address} · ${batch.longitude}, ${batch.latitude}；最晚兑换：${batch.redeem_before?new Date(batch.redeem_before).toLocaleString():"不限"}`,"code-preset-detail"));
    for(const code of batch.codes){
      const row=element("div",undefined,"code-state-row");row.append(element("code","…"+code.suffix),badge(names[code.status]||code.status,code.status==="unused"?"ok":code.status==="reserved"?"warn":"neutral"));
      row.append(element("span",code.authorization_until?"授权到期 "+new Date(code.authorization_until).toLocaleString():"尚未开通","code-dates"));
      if(["unused","reserved"].includes(code.status))row.append(button("撤销",async()=>{
        if(!await confirmAction("撤销兑换码？","撤销后不能继续兑换；正在验证的操作也不会开通。","撤销兑换码",true))return;
        await api(`/api/redemption/codes/${code.id}/revoke`,"POST",{});await loadCodeBatches();toast("兑换码已撤销");
      },"text-button danger-text"));
      item.append(row);
    }
    $("codeBatchList").append(item);
  }
}
$("showCodeForm").addEventListener("click",()=>{$("codeBatchForm").hidden=!$("codeBatchForm").hidden;});
$("hideGeneratedCodes").addEventListener("click",hideGeneratedCodes);
$("copyAllCodes").addEventListener("click",()=>copyCodes($("codeOutput").value));
$("codeBatchForm").addEventListener("submit",async event=>{
  event.preventDefault();$("codeBatchError").hidden=true;$("generateCodes").disabled=true;
  try{
    const quantity=Number($("codeQuantity").value);
    if(!Number.isInteger(quantity)||quantity<1||quantity>10)throw new Error("数量必须为1～10的整数");
    const result=await api("/api/redemption/batches","POST",{quantity,note:$("codeNote").value.trim(),schoolName:$("codeSchool").value.trim(),type:Number($("codeType").value),
      lon:Number($("codeLon").value),lat:Number($("codeLat").value),address:$("codeAddress").value.trim(),durationValue:Number($("codeDuration").value),durationUnit:$("codeUnit").value,
      redeemBefore:$("codeRedeemBefore").value?new Date($("codeRedeemBefore").value).getTime():null});
    if(result.codes.length!==quantity||new Set(result.codes).size!==quantity||result.text.split("\n").length!==quantity)throw new Error("生成结果数量校对失败，请不要使用并联系管理员核查");
    $("codeOutput").value=result.text;$("generatedCount").textContent=`已生成 ${quantity} 个兑换码（${quantity} 行）`;
    $("singleCodeCopies").replaceChildren();result.codes.forEach((code,index)=>$("singleCodeCopies").append(button(`复制第${index+1}行`,()=>copyCodes(code))));
    $("generatedCodes").hidden=false;$("codeBatchForm").hidden=true;await Promise.all([loadCodeBatches(),loadLogs()]);toast("兑换码已生成，请保存完整码");
  }catch(error){$("codeBatchError").textContent=error.message;$("codeBatchError").hidden=false;}finally{$("generateCodes").disabled=false;}
});
$("codeSchool").addEventListener("input",event=>{const query=event.target.value.trim();$("codeSchoolOptions").replaceChildren();if(query)for(const name of (window.SCHOOL_LIST||[]).filter(value=>value.includes(query)).slice(0,30)){const option=element("option");option.value=name;$("codeSchoolOptions").append(option);}});
$("loginForm").addEventListener("submit",async event=>{
  event.preventDefault();$("loginSubmit").disabled=true;$("loginError").hidden=true;
  try{const identity=await api("/api/auth/login","POST",{username:$("loginUsername").value.trim(),password:$("loginPassword").value},true);await showApp(identity);}
  catch(error){$("loginError").textContent=error.message;$("loginError").hidden=false;}finally{$("loginSubmit").disabled=false;}
});
$("togglePassword").addEventListener("click",()=>{
  const show=$("loginPassword").type==="password";$("loginPassword").type=show?"text":"password";$("togglePassword").textContent=show?"隐藏":"显示";
  $("togglePassword").setAttribute("aria-label",show?"隐藏密码":"显示密码");$("togglePassword").setAttribute("aria-pressed",String(show));
});
$("logoutButton").addEventListener("click",async()=>{try{await api("/api/auth/logout","POST",{});sessionStorage.removeItem(pendingKey);showLogin();}catch(error){showError(error);}});
$("scheduleForm").addEventListener("submit",async event=>{
  event.preventDefault();const form=event.currentTarget,enabled=$("scheduleEnabled").checked,time=$("scheduleInput").value;
  if(enabled&&!await confirmAction("保存每日签到计划？",`每天 ${time} 自动执行正常状态账号的签到。已暂停账号会跳过。`,"保存计划"))return;
  const submit=form.querySelector("button[type=submit]");submit.disabled=true;
  try{await api("/api/schedule","POST",{enabled,time});scheduleDirty=false;await Promise.all([loadStatus(true),loadLogs()]);toast("每日计划已保存");}
  catch(error){showError(error);}finally{submit.disabled=false;}
});
for(const id of ["scheduleEnabled","scheduleInput"])$(id).addEventListener("input",()=>scheduleDirty=true);
for(const [id,mode] of [["batchDry","dry"],["batchSubmit","submit"]])$(id).addEventListener("click",async()=>{
  if(mode==="submit"&&!await confirmAction("签到全部正常账号？","已暂停账号不会提交。请确认账号和位置配置正确。","开始签到"))return;
  $(id).disabled=true;try{await runTask("/api/batch-run",mode,mode==="dry"?"批量探测":"批量签到");}catch(error){showError(error);}finally{renderAccounts();}
});
$("clearLogs").addEventListener("click",async()=>{if(!await confirmAction("清空运行日志？","清空后无法在管理台恢复，不影响账号和定时设置。","清空日志",true))return;try{await api("/api/logs/clear","POST",{});await loadLogs();toast("日志已清空");}catch(error){showError(error);}});
$("refreshButton").addEventListener("click",async()=>{const button=$("refreshButton");button.disabled=true;clearErrors();try{await refresh();await pollJobs();}catch(error){showError(error);}finally{button.disabled=false;}});
$("addAccount").addEventListener("click",()=>openAccount().catch(showError));
for(const id of ["closeAccount","cancelAccount"])$(id).addEventListener("click",closeAccount);
$("accountDialog").addEventListener("cancel",event=>{event.preventDefault();closeAccount();});
$("accountSearch").addEventListener("input",renderAccounts);
for(const button of document.querySelectorAll("[data-filter]"))button.addEventListener("click",()=>{
  filter=button.dataset.filter;for(const item of document.querySelectorAll("[data-filter]")){const selected=item===button;item.classList.toggle("selected",selected);item.setAttribute("aria-pressed",String(selected));}renderAccounts();
});
$("accountSchool").addEventListener("input",event=>{const query=event.target.value.trim();$("schoolOptions").replaceChildren();if(query)for(const name of (window.SCHOOL_LIST||[]).filter(value=>value.includes(query)).slice(0,30)){const option=element("option");option.value=name;$("schoolOptions").append(option);}});
$("dismissResult").addEventListener("click",()=>$("taskResult").hidden=true);
setInterval(()=>{if(signedIn&&!document.hidden)pollJobs();},3000);
setInterval(()=>{if(signedIn&&!document.hidden)Promise.all([loadStatus(),loadLogs(),loadAccounts(),loadCodeBatches(),loadEnrollments()]).catch(showError);},60000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&signedIn)pollJobs();});
(async()=>{
  try { localStorage.removeItem("jrxy_web_token");localStorage.removeItem("jrxy_cf_token"); } catch {}
  try {await showApp(await api("/api/auth/session"));}
  catch(error){if(error.status!==401){showLogin();$("loginError").textContent=error.message;$("loginError").hidden=false;}}
})();
