import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
const read=name=>readFileSync(new URL("../public/"+name,import.meta.url),"utf8");
const html=read("admin.html"),js=read("app.js"),css=read("style.css"),headers=read("_headers");
function checkPage(html,js,name){
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);assert.equal(ids.length,new Set(ids).size,"页面ID不能重复："+name);
  for(const match of js.matchAll(/\$\("([^"]+)"\)/g))assert.ok(ids.includes(match[1]),"脚本引用不存在的控件："+match[1]);
  assert.ok(!/\bon(?:click|submit|change|input)\s*=/.test(html),"不允许内联事件处理器");
  assert.ok(!/<script\b[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html.replace(/<script\b[^>]*src=[^>]*><\/script>/g,"")),"脚本需使用外部文件");
  assert.ok(!/localStorage\.setItem|X-Web-Token|innerHTML\s*=/.test(js),"不能使用旧令牌鉴权或注入未转义HTML");
  new Script(js,{filename:"public/"+name});return ids;
}
const ids=checkPage(html,js,"app.js");
for(const id of ["loginForm","loginUsername","loginPassword","logoutButton","accountRows","accountCards","accountForm","scheduleForm","logList","testNotify","codeBatchForm","codeOutput"])
  assert.ok(ids.includes(id),"缺少后台功能："+id);
assert.ok(!headers.includes("script-src 'self' 'unsafe-inline'"),"脚本CSP不得允许unsafe-inline");
assert.ok(css.includes("@media(max-width:600px)"),"需要手机响应式布局");
assert.ok(html.includes('autocomplete="current-password"')&&html.includes('autocomplete="username"'),"登录支持密码管理器");
const select=html.match(/<select id="accountType"[\s\S]*?<\/select>/)[0];
assert.deepEqual([...select.matchAll(/value="(\d+)"/g)].map(m=>m[1]).sort(),["1","2"],"仅支持签到与查寝");
assert.match(html,/<input id="codeQuantity"[^>]*min="1"[^>]*max="10"[^>]*step="1"/);
assert.ok(!/\brequired\b/.test(html.match(/<input id="accountDevice"[^>]*>/)[0]),"后台新账号设备ID默认自动处理");
assert.ok(ids.includes("enrollmentList")&&ids.includes("refreshEnrollments"),"后台需要脱敏验证诊断");
const userHtml=read("index.html"),userJs=read("enroll.js");
const userIds=checkPage(userHtml,userJs,"enroll.js");
for(const id of ["codeForm","redeemCode","enrollForm","enrollmentName","schoolUsername","schoolPassword","enrollProgress","enrollSuccess"])
  assert.ok(userIds.includes(id),"缺少用户开通控件："+id);
assert.match(userHtml,/<input id="enrollmentName"[^>]*maxlength="50"[^>]*required/);
assert.ok(!userIds.includes("loginForm")&&!userIds.includes("accountRows"),"默认页不得展示管理员数据");
assert.ok(!/storage\.setItem/i.test(userJs),"用户凭据与兑换码不持久化到浏览器");
assert.ok(!/name="(?:lon|lat|schoolName|deviceId|notifyRcv)"/.test(userHtml),"用户不能输入后台预设字段");
console.log("UI contract passed: separate user/admin pages, safe scripts, one-time-code controls, mobile layouts and account management.");
