import { EngineError } from "../types";
import { getDomain } from "tldts";

export const LOGIN_UA = "Mozilla/5.0 (Linux; Android 8.0.0; MI 6 Build/OPR1.170623.027; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/92.0.4515.131 Mobile Safari/537.36 okhttp/3.12.4";
export const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 cpdaily/9.9.22 wisedu/9.9.22";
export function publicUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new EngineError("上游地址无效"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[") ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) {
    throw new EngineError("仅允许公网 HTTPS 域名，不支持本地代理或校园内网地址");
  }
  return url;
}
interface Cookie { name: string; value: string; domain: string; path: string; hostOnly: boolean; secure: boolean; expires: number; }
export class CookieJar {
  private cookies: Cookie[] = [];
  set(header: string, url: URL): void {
    const [pair, ...attrs] = header.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) return;
    const c: Cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: url.hostname,
      path: url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/", hostOnly: true, secure: false, expires: Infinity };
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(c.name) || /[\x00-\x20\x7f;]/.test(c.value)) return;
    let maxAge: number | undefined;
    for (const attr of attrs) {
      const i = attr.indexOf("=");
      const name = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const value = (i < 0 ? "" : attr.slice(i + 1)).trim();
      if (name === "domain") {
        const domain = value.replace(/^\./, "").toLowerCase();
        // 按公共后缀表允许合法父域Cookie，既兼容CAS跨子域，又拒绝.edu/.com等宽域注入。
        if (!getDomain(domain,{allowPrivateDomains:true}) || (domain !== url.hostname && !url.hostname.endsWith("." + domain))) return;
        c.domain = domain; c.hostOnly = false;
      } else if (name === "path" && value.startsWith("/")) c.path = value;
      else if (name === "secure") c.secure = true;
      else if (name === "max-age" && /^-?\d+$/.test(value)) maxAge = Number(value);
      else if (name === "expires") { const n = Date.parse(value); if (Number.isFinite(n)) c.expires = n; }
    }
    if (maxAge !== undefined) c.expires = Date.now() + maxAge * 1000;
    this.cookies = this.cookies.filter(x => !(x.name === c.name && x.domain === c.domain && x.path === c.path));
    if (c.expires > Date.now() && this.cookies.length < 100) this.cookies.push(c);
  }
  header(url: URL): string {
    return this.cookies.filter(c => (c.domain === url.hostname || (!c.hostOnly && url.hostname.endsWith("."+c.domain))) && (!c.secure || url.protocol === "https:") && c.expires > Date.now() &&
      (url.pathname === c.path || (url.pathname.startsWith(c.path) && (c.path.endsWith("/") || url.pathname[c.path.length] === "/"))))
      .sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join("; ");
  }
  names(): string[] { return [...new Set(this.cookies.filter(c => c.expires > Date.now()).map(c => c.name))].sort(); }
  get(name: string, url: string): string {
    const pair = this.header(new URL(url)).split("; ").find(v => v.startsWith(name + "="));
    return pair?.slice(name.length + 1) ?? "";
  }
}
export interface HttpResult { status: number; url: string; headers: Headers; text: string; }
export class Session {
  readonly jar = new CookieJar();
  private count = 0;
  private deadline: number;
  constructor(private transport: typeof fetch = fetch, private timeoutMs = 30_000, runTimeoutMs = 300_000) {
    this.deadline = Date.now() + runTimeoutMs;
  }
  async request(input: string, options: RequestInit = {}, follow = true): Promise<HttpResult> {
    let url = publicUrl(input);
    let method = options.method ?? "GET";
    let body = options.body;
    const headers = new Headers(options.headers);
    if(!headers.has("User-Agent"))headers.set("User-Agent", LOGIN_UA);
    for (let hop = 0; hop <= 10; hop++) {
      if (++this.count > 40) throw new EngineError("本次任务请求数过多，已停止");
      const left = this.deadline - Date.now();
      if (left <= 0) throw new EngineError("任务网络总时限已到", "error", true);
      const h = new Headers(headers);
      h.set("Cookie", this.jar.header(url));
      if (options.headers && new Headers(options.headers).has("Cookie") && hop === 0) h.set("Cookie", new Headers(options.headers).get("Cookie")!);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), Math.min(this.timeoutMs, left));
      let result: HttpResult;
      try {
        const response = await this.transport(url.href, { method, body, headers: h, redirect: "manual", signal: abort.signal });
        for (const cookie of response.headers.getSetCookie()) this.jar.set(cookie, url);
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new EngineError("上游响应过大"); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        result = { status: response.status, url: url.href, headers: response.headers, text: new TextDecoder().decode(bytes) };
      } catch (e) {
        if (e instanceof EngineError) throw e;
        throw new EngineError("上游网络请求失败或超时", "error", true);
      } finally { clearTimeout(timer); }
      if (result.status === 418 || result.status === 429) throw new EngineError("上游限制访问，请停止自动执行并检查账号/网络");
      if (follow && [301, 302, 303, 307, 308].includes(result.status) && result.headers.has("location")) {
        const next = publicUrl(new URL(result.headers.get("location")!, url).href);
        if ((result.status === 303 && method !== "HEAD") || (result.status === 302 && method !== "HEAD") || (result.status === 301 && method === "POST")) {
          method = "GET"; body = undefined; headers.delete("Content-Type");
        } else if (next.origin !== url.origin && body) throw new EngineError("拒绝将登录数据重定向到其他域名");
        headers.delete("Cookie"); headers.delete("Authorization");
        url = next;
        continue;
      }
      if (result.status >= 500) throw new EngineError(`上游服务暂不可用（HTTP ${result.status}）`, "error", true);
      return result;
    }
    throw new EngineError("登录重定向次数过多");
  }
  async json<T = any>(url: string, data?: unknown, headers?: HeadersInit): Promise<T> {
    const r = await this.request(url, { method: data === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) },
      body: data === undefined ? undefined : JSON.stringify(data) });
    if (r.status < 200 || r.status >= 300) throw new EngineError(`上游返回 HTTP ${r.status}`);
    try { return JSON.parse(r.text) as T; } catch { throw new EngineError("上游未返回 JSON，可能登录失效或需要人工验证"); }
  }
}
