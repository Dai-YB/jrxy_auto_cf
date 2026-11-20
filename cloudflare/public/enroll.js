"use strict";
const $=id=>document.getElementById(id);
let verifiedCode="",preset=null,receipt="",polling=false,finished=false,submitting=false;
async function request(action,body){
  let response;
  try{response=await fetch("/api/public/redemption/"+action,{method:"POST",headers:{"Content-Type":"application/json"},credentials:"omit",body:JSON.stringify(body)});}
  catch{throw new Error("网络连接失败，请稍后重试");}
  const data=await response.json().catch(()=>({detail:"服务响应异常，请稍后重试"}));
  if(!response.ok){const error=new Error(data.detail||"验证失败");error.status=response.status;throw error;}return data;
}
function error(message){$("enrollError").textContent=message;$("enrollError").hidden=false;}
function duration(seconds){return seconds%86400===0?seconds/86400+"天":seconds/3600+"小时";}
function newReceipt(){const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
function setStep(step){for(const [index,id] of ["stepCode","stepAccount","stepDone"].entries())$(id).classList.toggle("current",index<=step);}
function busy(value){for(const id of ["enrollmentName","schoolUsername","schoolPassword","consent","saveEnrollment","changeCode"])$(id).disabled=value;}
function reset(){
  if(submitting)return;verifiedCode="";preset=null;receipt="";finished=false;$("enrollError").hidden=true;$("presetPanel").hidden=true;$("enrollForm").hidden=true;
  $("codeForm").hidden=false;$("enrollSuccess").hidden=true;$("enrollProgress").hidden=true;$("retryStatus").hidden=true;$("enrollmentName").value="";$("schoolUsername").value="";$("schoolPassword").value="";busy(false);setStep(0);
  $("enrollTitle").textContent="验证兑换码";$("enrollDescription").textContent="每个兑换码仅可绑定一个账号，成功开通后不可重复使用。";
}
$("codeForm").addEventListener("submit",async event=>{
  event.preventDefault();$("checkCode").disabled=true;$("enrollError").hidden=true;
  try{
    const code=$("redeemCode").value.trim();const result=await request("check",{code});verifiedCode=code;preset=result;
    $("presetSchool").textContent=result.schoolName;$("presetType").textContent=result.type===1?"签到":"查寝";
    $("presetDuration").textContent=duration(result.durationSeconds)+"（开通后计时）";
    $("presetSchedule").textContent=result.schedule.enabled?result.schedule.time+" · "+result.schedule.timezone:result.schedule.autoEnableOnEnrollment?"开通后自动启用 · "+result.schedule.time+"（"+result.schedule.timezone+"）":"管理员已关闭定时";
    $("codeForm").hidden=true;$("presetPanel").hidden=false;$("enrollForm").hidden=false;setStep(1);
    $("enrollTitle").textContent="绑定学校账号";$("enrollDescription").textContent="验证登录通过后才会保存。学校、位置和任务类型使用管理员预设。";
    $("enrollmentName").focus();
  }catch(e){error(e.message);}finally{$("checkCode").disabled=false;}
});
$("changeCode").addEventListener("click",reset);
$("showSchoolPassword").addEventListener("click",()=>{const show=$("schoolPassword").type==="password";$("schoolPassword").type=show?"text":"password";$("showSchoolPassword").textContent=show?"隐藏":"显示";$("showSchoolPassword").setAttribute("aria-pressed",String(show));$("showSchoolPassword").setAttribute("aria-label",show?"隐藏学校密码":"显示学校密码");});
function applyStatus(data){
  if(data.status==="succeeded"){
    finished=true;submitting=false;busy(false);setStep(2);$("enrollForm").hidden=true;$("enrollProgress").hidden=true;$("presetPanel").hidden=true;$("enrollSuccess").hidden=false;$("enrollError").hidden=true;$("retryStatus").hidden=true;
    $("enrollTitle").textContent="授权已完成";$("enrollDescription").textContent="兑换码已绑定本账号，不能重复使用。";
    $("successSummary").textContent=(preset?.schoolName||"学校")+" · "+(preset?.type===1?"签到":"查寝");$("successExpiry").textContent=data.expiresText+"（"+data.schedule.timezone+"）";
    $("successSchedule").textContent=data.schedule.enabled?"已加入每日自动签到，将按 "+data.schedule.time+"（"+data.schedule.timezone+"）执行。下次："+data.schedule.next+"。":"账号已加入自动签到名单，但管理员已关闭全局计划，请联系管理员。";
    $("enrollmentName").value="";$("schoolUsername").value="";$("schoolPassword").value="";$("redeemCode").value="";verifiedCode="";return true;
  }
  if(data.status==="failed"){
    finished=true;submitting=false;busy(false);$("enrollProgress").hidden=true;$("retryStatus").hidden=true;$("schoolPassword").value="";receipt="";error(data.message);return true;
  }
  $("progressTitle").textContent=data.status==="setting_up"?"登录已通过，正在保存":"正在验证登录";
  $("progressText").textContent=data.message||"请等待验证完成，暂未开通签到。";return false;
}
async function poll(){
  if(polling||!receipt||finished)return;polling=true;$("retryStatus").hidden=true;
  try{
    while(!finished){const status=await request("status",{receipt});if(applyStatus(status))break;await new Promise(resolve=>setTimeout(resolve,3000));}
  }catch(e){
    error(e.message);$("retryStatus").hidden=false;
    if(e.status===404){submitting=false;busy(false);receipt="";$("enrollProgress").hidden=true;$("retryStatus").hidden=true;}
  }finally{polling=false;}
}
$("enrollForm").addEventListener("submit",async event=>{
  event.preventDefault();if(submitting||!verifiedCode)return;
  const name=$("enrollmentName").value.trim();
  if(!name||name.length>50||!/^[\p{L}\p{M}\p{N} .·•・'’_-]+$/u.test(name)||/[\p{Cc}\p{Cf}]/u.test($("enrollmentName").value)){error("请填写1～50个字符的有效姓名");return;}
  $("enrollError").hidden=true;$("retryStatus").hidden=true;finished=false;submitting=true;busy(true);
  receipt=newReceipt();$("enrollProgress").hidden=false;$("progressTitle").textContent="正在提交登录验证";
  try{
    const result=await request("start",{code:verifiedCode,displayName:name,username:$("schoolUsername").value.trim(),password:$("schoolPassword").value,receipt,consent:$("consent").checked});
    $("schoolPassword").value="";if(!applyStatus(result))await poll();
  }catch(e){
    $("schoolPassword").value="";error(e.message);
    if(e.status && e.status<500){submitting=false;busy(false);receipt="";$("enrollProgress").hidden=true;}
    else{$("progressText").textContent="响应未确认，请查询当前验证结果，避免重复提交。";$("retryStatus").hidden=false;}
  }
});
$("retryStatus").addEventListener("click",()=>poll());
