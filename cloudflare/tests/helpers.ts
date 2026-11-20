import { signIn } from "../src/auth";
import type { Env } from "../src/types";
export async function adminHeaders(env: Env, origin="https://manager.example"): Promise<Record<string,string>> {
  const response=await signIn(new Request(origin+"/api/auth/login",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
    body:JSON.stringify({username:env.ADMIN_USERNAME,password:env.ADMIN_PASSWORD})}),env);
  const data=await response.json() as {csrfToken:string};
  return {Cookie:response.headers.get("Set-Cookie")!.split(";")[0],"X-CSRF-Token":data.csrfToken,Origin:origin,"Content-Type":"application/json"};
}
