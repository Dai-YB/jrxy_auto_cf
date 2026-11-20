import { Buffer } from "node:buffer";
import { AppError, type Env } from "./types";

export function requireConfigured(env: Env): void {
  if (!env.ADMIN_USERNAME?.trim() || env.ADMIN_USERNAME.length > 100 || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12 ||
      env.ADMIN_PASSWORD.length > 1024 || env.ADMIN_PASSWORD === env.ADMIN_USERNAME || !/^[A-Za-z0-9+/]{43}=$/.test(env.ENCRYPTION_KEY ?? "")) {
    throw new AppError("请先配置管理员账号、至少12字符的强密码，以及原有的数据加密密钥", 503);
  }
}
export function requireSameOrigin(request: Request, requireOrigin = false): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if (site === "cross-site" || (origin && origin !== new URL(request.url).origin) || (requireOrigin && !origin))
    throw new AppError("拒绝跨站请求", 403);
}
async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", Buffer.from(secret, "base64"), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(value: unknown, secret: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    await key(secret), new TextEncoder().encode(JSON.stringify(value)));
  return `v1.${Buffer.from(iv).toString("base64")}.${Buffer.from(ciphertext).toString("base64")}`;
}
export async function unseal<T>(value: string, secret: string, context: string): Promise<T> {
  const [version, iv, cipher] = value.split(".");
  if (version !== "v1" || !iv || !cipher) throw new AppError("存储数据格式无效", 500);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64"),
      additionalData: new TextEncoder().encode(context) }, await key(secret), Buffer.from(cipher, "base64"));
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch { throw new AppError("数据解密失败，请检查 ENCRYPTION_KEY（不要随意更换）", 500); }
}
export function redact(value: string, secrets: string[] = []): string {
  let text = value;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[REDACTED]");
  return text.replace(/((?:password|sessionToken(?:Key)?|MOD_AUTH_CAS|cookie|secret|sendkey)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s]+/g, "[URL]").slice(-4000);
}
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) throw new AppError("请求必须是 JSON", 415);
  const limit = 32768;
  if (Number(request.headers.get("content-length")) > limit) throw new AppError("请求过大", 413);
  const reader = request.body?.getReader();
  if (!reader) return {};
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new AppError("请求过大", 413); }
    chunks.push(value);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new AppError("无效的 JSON 对象"); }
}
