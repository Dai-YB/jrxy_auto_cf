// Python urllib.parse.urlencode / json.dumps 的协议用编码，不用于任意对象序列化。
export function formEncode(values: Iterable<[string,string]>): string {
  const quote=(value:string)=>encodeURIComponent(value).replace(/[!'()*]/g,c=>"%"+c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g,"+");
  return [...values].map(([key,value])=>quote(key)+"="+quote(value)).join("&");
}
export function pythonJson(value: unknown, ascii = false): string {
  if (typeof value === "string") {
    const text=JSON.stringify(value);
    return ascii?text.replace(/[\u007f-\uffff]/g,c=>"\\u"+c.charCodeAt(0).toString(16).padStart(4,"0")):text;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    if (Object.is(value,-0)) return "-0.0";
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(v=>pythonJson(v,ascii)).join(", ") + "]";
  if (typeof value === "object") return "{" + Object.entries(value).map(([k,v]) => pythonJson(k,ascii) + ": " + pythonJson(v,ascii)).join(", ") + "}";
  throw new Error("表单包含不支持的字段类型");
}
