import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError, type Env } from "./types";
import { readJson, requireConfigured, requireSameOrigin } from "./security";

const SESSION_MS = 12 * 3600_000;
const WINDOW_MS = 15 * 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
function credentialVersion(env: Env): string {
  return createHmac("sha256", env.ENCRYPTION_KEY).update(JSON.stringify([env.ADMIN_USERNAME,env.ADMIN_PASSWORD])).digest("hex");
}
function local(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === "http:" && ["127.0.0.1","localhost","[::1]"].includes(url.hostname);
}
export function cookieName(request: Request): string { return local(request) ? "jrxy_dev_session" : "__Host-jrxy_session"; }
function sessionCookie(request: Request, token: string, maxAge: number): string {
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${local(request) ? "" : "; Secure"}`;
}
function cookieToken(request: Request): string {
  const prefix = cookieName(request) + "=";
  const value = (request.headers.get("Cookie") ?? "").split(";").map(s=>s.trim()).find(s=>s.startsWith(prefix))?.slice(prefix.length) ?? "";
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : "";
}
function csrf(token: string, version: string): string { return createHmac("sha256",version).update("csrf:"+token).digest("hex"); }
export async function rateLimit(env: Env, key: string, limit: number, windowMs: number): Promise<void> {
  const now = Date.now();
  const bucket = Math.floor(now/windowMs);
  // 仅存带密钥摘要的分桶标识，不存密码/明文IP。并发请求用单条SQL计数。
  const hashed = createHmac("sha256",env.ENCRYPTION_KEY).update(`${key}:${bucket}`).digest("hex");
  const result = await env.DB.prepare(`INSERT INTO rate_limits(key,hits,expires_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits`).bind(hashed,(bucket+1)*windowMs).first<{hits:number}>();
  if ((result?.hits ?? limit+1) > limit) throw new AppError("操作过于频繁，请稍后再试",429);
}
export async function authorize(request: Request, env: Env): Promise<{username: string; csrfToken: string}> {
  requireConfigured(env);
  requireSameOrigin(request);
  const token = cookieToken(request);
  if(!token)throw new AppError("请先登录管理台",401);
  const version = credentialVersion(env);
  const session = await env.DB.prepare("SELECT credential_version,expires_at FROM admin_sessions WHERE token_hash=?")
    .bind(digest(token)).first<{credential_version:string;expires_at:number}>();
  if(!session || session.expires_at<=Date.now() || !equal(session.credential_version,version))throw new AppError("登录已过期，请重新登录",401);
  const csrfToken = csrf(token,version);
  if(!["GET","HEAD","OPTIONS"].includes(request.method)) {
    requireSameOrigin(request,true);
    if(!equal(request.headers.get("X-CSRF-Token") ?? "",csrfToken))throw new AppError("会话校验失败，请刷新页面",403);
  }
  return {username:env.ADMIN_USERNAME,csrfToken};
}
export async function signIn(request: Request, env: Env): Promise<Response> {
  requireConfigured(env);
  if(new URL(request.url).protocol!=="https:" && !local(request))throw new AppError("登录必须使用 HTTPS",400);
  requireSameOrigin(request,true);
  const body = await readJson(request);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  await rateLimit(env,"login-ip:"+ip,10,WINDOW_MS);
  await rateLimit(env,"login-global",100,WINDOW_MS);
  const username = typeof body.username==="string" ? body.username.trim() : "";
  const password = typeof body.password==="string" ? body.password : "";
  const userOk = equal(username,env.ADMIN_USERNAME);
  const passOk = equal(password,env.ADMIN_PASSWORD);
  if(!userOk || !passOk)throw new AppError("账号或密码错误",401);
  const now=Date.now(),token=randomBytes(32).toString("base64url"),version=credentialVersion(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at<=? OR credential_version!=?").bind(now,version),
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at<=?").bind(now),
    env.DB.prepare("INSERT INTO admin_sessions(token_hash,credential_version,created_at,expires_at) VALUES(?,?,?,?)")
      .bind(digest(token),version,now,now+SESSION_MS)
  ]);
  return Response.json({username:env.ADMIN_USERNAME,csrfToken:csrf(token,version)}, {headers:{
    "Set-Cookie":sessionCookie(request,token,SESSION_MS/1000),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"
  }});
}
export async function signOut(request: Request, env: Env): Promise<Response> {
  await authorize(request,env);
  await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(digest(cookieToken(request))).run();
  return Response.json({ok:true},{headers:{"Set-Cookie":sessionCookie(request,"",0),"Cache-Control":"no-store"}});
}
