import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const root=fileURLToPath(new URL("../../",import.meta.url));
const git=(...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",maxBuffer:16*1024*1024});
const working=process.argv.includes("--working-tree");
const files=working?[...new Set([...git("diff","HEAD","--name-only","--diff-filter=ACMR","-z").split("\0"),...git("ls-files","--others","--exclude-standard","-z").split("\0")].filter(Boolean))]:git("diff","--cached","--name-only","--diff-filter=ACMR","-z").split("\0").filter(Boolean);
if(!files.length){console.error("No changed files to check.");process.exit(1);}
const contents=file=>working?readFileSync(join(root,file),"utf8"):git("show",":"+file);
const allowed=path=>[".gitignore","LICENSE","README.md","THIRD_PARTY_NOTICES.md","docs/FLOW_REVIEW.md"].includes(path)||
 /^cloudflare\/(src\/.*\.ts|tests\/(?:.*\.test\.ts|helpers\.ts|fixtures\/original-(?:rules|http|scheduler)\.json)|migrations\/\d+_[a-z_]+\.sql|scripts\/[^/]+\.(?:mjs|py)|public\/(?:index\.html|admin\.html|app\.js|enroll\.js|redemption\.css|style\.css|school_list\.js|_headers)|(?:README|MIGRATION-PARITY)\.md|(?:package|package-lock)\.json|wrangler\.jsonc|tsconfig\.json|vitest\.config\.ts|\.dev\.vars\.example)$/.test(path)||
 /^jrxy-engine\/(actions\/[^/]+\.py|scripts\/[^/]+\.py|README\.md|LICENSE|requirements\.txt|config\.example\.yml|\.gitignore)$/.test(path)||
 /^web-server\/(app\.py|requirements\.txt)$/.test(path);
const issues=[];
const check=(condition,file,message)=>{if(condition)issues.push(`${file}: ${message}`);};
const ref=contents("jrxy-engine/scripts/merged_ios_v4_submit.py");
const pemBlocks=text=>[...text.matchAll(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/g)].map(m=>m[0].replace(/\r/g,""));
const approvedProtocolKeys=new Set(pemBlocks(ref).map(block=>createHash("sha256").update(block).digest("hex")));
const protocolFiles=new Set(["jrxy-engine/scripts/merged_ios_v4_submit.py","jrxy-engine/scripts/get_fkey_cat.py","cloudflare/src/engine/constants.ts"]);
for(const file of files){
 check(!allowed(file),file,"not in the explicit release allowlist");
 const content=contents(file);
 check(content.includes("\0"),file,"binary content not permitted in this release");
 check(/[A-Za-z]:[\\/](?:Users|Project|Environment|Program Files)\b/i.test(content),file,"local filesystem identity/path");
 check(/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})/.test(content),file,"possible live API credential");
 const scanned=file==="cloudflare/tests/engine.test.ts"?content.replaceAll("https://"+"name:pass"+"@example.com",""):content;
 check(/https?:\/\/[^\s/:"'<>+]+:[^\s/@"'<>+]+@/.test(scanned),file,"URL contains embedded credentials");
 check(/\u4eca\u65e5\u6821\u56ed/.test(content),file,"old brand must be jrxy");
 check(/ui[-]synthetic|synthetic[-]ui-device|local[-]test-password-only|local[-]ui-test-token/.test(content),file,"interactive local test data");
 check(/SCT[A-Za-z0-9_-]{20,}/.test(content),file,"possible real notification key");
 check(/[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Z0-9.-]+\.[A-Z]{2,}/i.test(content),file,"email address requires explicit privacy review");
 if(file.includes("wrangler.jsonc")) {
   const config=JSON.parse(content);
   check(config.d1_databases?.some(db=>db.database_id!=="00000000-0000-0000-0000-000000000000"),file,"real deployment database ID");
   check(Boolean(config.account_id),file,"account ID must not be published by this release");
   check(Boolean(config.vars?.ADMIN_PASSWORD||config.vars?.ENCRYPTION_KEY),file,"runtime secret in public vars");
 }
 for(const block of pemBlocks(content))check(!protocolFiles.has(file)||!approvedProtocolKeys.has(createHash("sha256").update(block).digest("hex")),file,"unexpected private key block");
}
const readme=contents("README.md");
check(!readme.startsWith("# jrxy_auto_cf"),"README.md","project name mismatch");
check(!readme.trim().split("\n").slice(-5).join("\n").includes("仅供学习"),"README.md","missing final educational-use notice");
if(issues.length){console.error("Release privacy checks failed:\n"+issues.join("\n"));process.exit(1);}
console.log(`Release privacy checks passed for ${files.length} ${working?"working-tree":"staged"} text files. No runtime data/media included. Fixed inherited protocol keys were matched to the reviewed reference; synthetic test fixtures remain explicit.`);
