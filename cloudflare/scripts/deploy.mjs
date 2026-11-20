import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const config=JSON.parse(readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8"));
if(!config.d1_databases?.[0]?.database_id || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(config.d1_databases[0].database_id)) {
  console.error("部署已停止：请先将真实D1 database_id写入wrangler.jsonc，不会创建或发布占位数据库。");process.exit(1);
}
// 非生产分支只运行 npm run build；发布命令必须显式指向生产分支。
const branch=process.env.WORKERS_CI_BRANCH||process.env.CF_PAGES_BRANCH||process.env.CF_BUILD_BRANCH;
const production=process.env.PRODUCTION_BRANCH||"main";
if(branch&&branch!==production){console.error(`部署已停止：当前分支不是配置的生产分支 ${production}。预览请使用 npm run build。`);process.exit(1);}
const require=createRequire(import.meta.url);
const wrangler=join(dirname(require.resolve("wrangler/package.json")),"bin","wrangler.js");
const cwd=fileURLToPath(new URL("../",import.meta.url));
for(const args of [["d1","migrations","apply","DB","--remote"],["deploy"]]) {
  const result=spawnSync(process.execPath,[wrangler,...args],{cwd,stdio:"inherit",env:process.env});
  if(result.error){console.error("无法启动Wrangler部署命令");process.exit(1);}
  if(result.status!==0)process.exit(result.status??1);
}
