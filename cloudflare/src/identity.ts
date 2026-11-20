import { createHmac } from "node:crypto";
import { AppError, type Env } from "./types";

export function displayName(value: unknown): string {
  if (typeof value !== "string") throw new AppError("请填写姓名");
  const name = value.trim();
  if (!name || name.length > 50 || !/^[\p{L}\p{M}\p{N} .·•・'’_-]+$/u.test(name) || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new AppError("姓名需为1～50个字符，仅支持文字、数字、空格和常见姓名间隔符");
  return name;
}

export function identityKey(env: Env, school: string, username: string): string {
  return createHmac("sha256",env.ENCRYPTION_KEY).update(JSON.stringify(["account-identity",school.trim(),username.trim()])).digest("hex");
}
export function accountValid(row: {deleted?:number;authorization_until?:number|null}, now=Date.now()): boolean {
  return !row.deleted && (row.authorization_until == null || row.authorization_until > now);
}
