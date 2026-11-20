// 协议适配自 jrxy-engine/scripts/merged_ios_v4_submit.py（MPL-2.0）。
// 以下为原项目公开的协议材料，不是用户凭据；不得用于数据存储加密。
import { constants, createCipheriv, createHash, privateDecrypt, publicEncrypt } from "node:crypto";
import { Buffer } from "node:buffer";
import { EngineError } from "../types";
import { IOS_UA, Session } from "./http";

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCpwqE77zx+WexQWf1qDzb8EGey
et7VO78JiCDrZLcesaGjN5B8s66bMCfcn9R3GN25/EA3lFPI86hgluMPT6X1rneW
QRdKMaFWtxZLc+0Gdkf8zvdPf3rcYt6VjPnq3Hu1iSdytD8SIuTcSGFoPctId7jZ
zEjMjj74mnu3WtihZQIDAQAB
-----END PUBLIC KEY-----`;
// 完整私钥在 constants.ts 中与原协议逐字一致，测试校验其可解析性。
import { PROTOCOL_PRIVATE_KEY } from "./constants";
export const AES_IV = Buffer.from([1,2,3,4,5,6,7,8,9,1,2,3,4,5,6,7]);
export const md5 = (s: string): string => createHash("md5").update(s).digest("hex");
export function aes(text: string, key: string): string {
  const bytes = Buffer.from(key);
  if (![16,24,32].includes(bytes.length)) throw new EngineError("上游返回了无效的加密密钥");
  const c = createCipheriv(`aes-${bytes.length * 8}-cbc`, bytes, AES_IV);
  return Buffer.concat([c.update(Buffer.from(text)), c.final()]).toString("base64");
}
export function des(text: string, key = "XCE927=="): string {
  const bytes = Buffer.from(key);
  if (bytes.length !== 8) throw new Error("DES key must contain 8 bytes");
  // E_K(D_K(E_K(x))) = E_K(x)，重复密钥的 3DES 与原协议 DES 完全等价。
  const c = createCipheriv("des-ede3-cbc", Buffer.concat([bytes, bytes, bytes]), Buffer.from([1,2,3,4,5,6,7,8]));
  return Buffer.concat([c.update(Buffer.from(text)), c.final()]).toString("base64");
}
export function interleave(s: string): string {
  return [...s].filter((_, i) => i % 2 === 0).join("") + [...s].filter((_, i) => i % 2 === 1).join("");
}
function pythonRepr(v: unknown): string {
  if (typeof v === "string") {
    const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
    const escaped = [...v].map(c => {
      if (c === "\\") return "\\\\";
      if (c === quote) return "\\" + c;
      if (c === "\n") return "\\n";
      if (c === "\r") return "\\r";
      if (c === "\t") return "\\t";
      const n = c.codePointAt(0)!;
      return n < 32 || n === 127 ? "\\x" + n.toString(16).padStart(2,"0") : c;
    }).join("");
    return quote + escaped + quote;
  }
  return pythonStr(v);
}
export function pythonStr(v: unknown): string {
  if (v === true) return "True";
  if (v === false) return "False";
  if (v === null) return "None";
  if (Array.isArray(v)) return "[" + v.map(pythonRepr).join(", ") + "]";
  if (v && typeof v === "object") return "{" + Object.entries(v).map(([k,value]) => pythonRepr(k) + ": " + pythonRepr(value)).join(", ") + "}";
  return String(v);
}
export function pythonJson(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value,undefined,0);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    if (Object.is(value,-0)) return "-0.0";
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(pythonJson).join(", ") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).map(([k,v]) => JSON.stringify(k) + ": " + pythonJson(v)).join(", ") + "}";
  throw new EngineError("表单包含不支持的字段类型");
}
export function pythonFloat(value: number): string {
  if (!Number.isFinite(value)) throw new EngineError("坐标必须为有限数字");
  if (Object.is(value,-0)) return "-0.0";
  const absolute = Math.abs(value);
  const text = absolute !== 0 && (absolute < 0.0001 || absolute >= 1e16) ? value.toExponential() : String(value);
  if (text.includes("e")) {
    const [mantissa, exponent] = text.split("e");
    const n = Number(exponent);
    return `${mantissa}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2,"0")}`;
  }
  return Number.isInteger(value) ? text + ".0" : text;
}
function pythonSort(a: string, b: string): number {
  const left = [...a], right = [...b];
  for (let i=0; i<Math.min(left.length,right.length); i++) {
    const difference = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length-right.length;
}
export function signedBody(form: Record<string, unknown>, key: string): { bodyString: string; sign: string } {
  // 原Web将坐标转换为Python float；整数坐标也必须保留 .0，避免签名与密文不一致。
  const floating = (name: string, value: unknown) => (name === "longitude" || name === "latitude") && typeof value === "number";
  const serialized = "{" + Object.entries(form).map(([name,value]) => JSON.stringify(name) + ": " +
    (floating(name,value) ? pythonFloat(value as number) : pythonJson(value))).join(", ") + "}";
  const bodyString = aes(serialized, key);
  const values = Object.entries(form).map(([name,value]) => floating(name,value) ? pythonFloat(value as number) : pythonStr(value));
  const sign = md5(values.sort(pythonSort).join("") + bodyString + key);
  return { bodyString, sign };
}
export async function fetchSecret(session: Session, tenant: string, deviceId: string): Promise<string> {
  const plain = `${crypto.randomUUID()}|first_v4`;
  const data = { p: publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(plain)).toString("base64"),
    s: md5(`${plain}&2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`) };
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("base64");
  const headers = { "User-Agent":IOS_UA, tenantId: tenant, CpdailyClientType: "CPDAILY", CpdailyStandAlone: "0", clientType: "cpdaily_student",
    deviceType: "1", SessionTokenKey: token, SessionToken: token, wisDeviceId: deviceId,
    CpdailyInfo: des(JSON.stringify({ deviceId, systemName: "android", appVersion: "9.9.22", model: "23127PN0CC",
      lon: 0, lat: 0, cpdailyVersion: "9.9.22", systemVersion: "14", userId: "" })) };
  for (const host of ["https://data-xxt.aichaoxing.com/", "https://mobile.campushoy.com/"]) {
    try {
      let response = await session.json(host + "app/auth/dynamic/secret/getSecretKey/v-920", data, headers);
      for (let i = 0; i < 6 && response && typeof response === "object"; i++) {
        const key = ["data", "datas", "result"].find(k => k in response);
        if (!key) break;
        response = response[key];
      }
      if (typeof response !== "string") continue;
      const parts = privateDecrypt({ key: PROTOCOL_PRIVATE_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(response, "base64"))
        .toString("utf8").split("|");
      if (parts.length < 3 || !parts[2]) continue;
      const key = interleave("h8r7uN8t" + parts[2]);
      if (Buffer.byteLength(key) === 16) return key;
    } catch (e) {
      // 原引擎在候选主机不可用/响应不兼容时尝试下一主机；限流响应则停止。
      if (e instanceof EngineError && e.message.includes("上游限制访问")) throw e;
    }
  }
  throw new EngineError("动态密钥协商失败", "error", true);
}
export function randomLoginPrefix(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
  return [...crypto.getRandomValues(new Uint8Array(64))].map(n => alphabet[n % alphabet.length]).join("");
}
