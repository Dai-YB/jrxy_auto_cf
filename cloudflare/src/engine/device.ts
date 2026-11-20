// 对应 jrxy-engine/scripts/extract_deviceid.py（MPL-2.0）。只处理用户提供的本人设备请求头。
import { createDecipheriv } from "node:crypto";
import { Buffer } from "node:buffer";
import { AppError } from "../types";

export function requireDeviceId(value: string): string {
  const id = value.trim();
  if (!id) throw new AppError("必须提供手机原绑定 deviceId；请从旧 .device_id 文件迁移或从本人 App 请求头提取，不会自动生成");
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new AppError("deviceId 格式无效");
  return id;
}
export function extractDeviceId(value: string, header: "info" | "ext", encoding: "base64" | "hex"): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8192) throw new AppError("请提供不超过8KB的请求头值");
  if (header !== "info" && header !== "ext") throw new AppError("仅支持 CpdailyInfo 或 Cpdaily-Extension");
  if (encoding !== "base64" && encoding !== "hex") throw new AppError("仅支持 Base64 或 Hex");
  const normalized = value.replace(/\s/g, "");
  if (encoding === "hex" ? !/^(?:[0-9a-f]{2})+$/i.test(normalized) : !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new AppError("请求头编码无效");
  }
  try {
    const raw = Buffer.from(normalized, encoding);
    if (!raw.length || raw.length % 8 !== 0) throw new Error();
    const key = Buffer.from(header === "info" ? "ST83=@XV" : "b3L26XNL");
    const d = createDecipheriv("des-ede3-cbc", Buffer.concat([key,key,key]), Buffer.from([1,2,3,4,5,6,7,8]));
    // 与原脚本一致：接受 PKCS5Padding；无有效填充时尝试原始 JSON。
    d.setAutoPadding(false);
    let plain = Buffer.concat([d.update(raw),d.final()]);
    const padding = plain[plain.length-1];
    if (padding >= 1 && padding <= 8 && plain.subarray(-padding).every((n: number) => n === padding)) plain = plain.subarray(0,-padding);
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plain));
    if (typeof parsed?.deviceId !== "string") throw new Error();
    return requireDeviceId(parsed.deviceId);
  } catch { throw new AppError("无法提取 deviceId，请确认头类型、编码和内容；不会生成替代 ID"); }
}
