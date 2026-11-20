import { createHmac } from "node:crypto";
import type { Env } from "./types";

export function identityKey(env: Env, school: string, username: string): string {
  return createHmac("sha256",env.ENCRYPTION_KEY).update(JSON.stringify(["account-identity",school.trim(),username.trim()])).digest("hex");
}
export function accountValid(row: {deleted?:number;authorization_until?:number|null}, now=Date.now()): boolean {
  return !row.deleted && (row.authorization_until == null || row.authorization_until > now);
}
