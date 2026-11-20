# jrxy_auto_cf

面向 **jrxy 签到与查寝** 的轻量管理项目，运行于 Cloudflare Workers，使用 D1 保存数据、Queues 执行后台任务、Cron Triggers 触发每日计划。

原生 HTML / CSS / JavaScript 界面，支持桌面和手机；无需自建服务器、Docker、付费容器或 OCR 服务。代码可以放在 GitHub，由 Cloudflare 连接仓库后自动构建部署。

> **使用前须知**：本项目不是官方服务，不保证适配所有学校。代码审查、自动化测试和模拟上游流程通过，不等于真实学校登录、签到和通知已经验证。请仅用于本人或明确授权的账号，并遵守平台规则和相关规定。

## 功能

| 功能 | 说明 |
|---|---|
| 管理员登录 | 独立账号密码，HttpOnly 会话、退出、过期、限速及 CSRF 保护 |
| 签到 / 查寝 | 保留对应任务查询、表单校验、动态密钥及 iOS `first_v4` 提交流程 |
| 账号管理 | 新增、编辑、删除、搜索；学校密码不回显 |
| 设备绑定 | 必须提供手机原绑定 `deviceId`，不随机生成替代值 |
| 暂停 / 恢复 | 暂停期间禁止手动、批量及定时提交；恢复不补跑暂停期间的旧任务 |
| 探测 / 测试 | 登录测试、只探测、范围获取与应用；探测不会提交签到 |
| 每日定时 | 时区设置、补执行窗口、账号顺序和间隔、有限重试、进度恢复 |
| 结果通知 | Server酱 Turbo / Server酱³ / HTTP(S) Webhook，支持独立测试推送 |
| 运行日志 | 持久化结果、批次汇总和通知受理状态；敏感信息脱敏 |

不包含照片上传、收集、政工及教师日志任务，不使用 OCR。若登录临时要求验证码，任务会停止并报告需要人工验证。

## 架构

```text
浏览器（桌面 / 手机）
        │ HTTPS + 管理会话
        ▼
Cloudflare Worker ─────── D1
   │                     账号密文 / 设备绑定 / 暂停状态
   │                     计划 / 任务 / 会话 / 日志
   ├── Queues ── 登录 → 查任务 → 组表单 → 加密 → 提交 / 复查
   │                                                │
   │                                           结果通知
   └── Cron Triggers（每分钟检查每日计划）
```

**GitHub 只保存代码，Cloudflare 运行网页和后端。** 不需要 GitHub Pages 或另一套 GitHub Actions 定时器；本地部署与 Git 集成使用同一条生产部署命令。

## 快速部署

### 1. 准备

- Cloudflare 账号及 Workers、D1、Queues 功能。
- Node.js 22 或更新版本。
- 一个代码仓库。
- 可以从公网 HTTPS 访问的学校登录与任务接口。

项目名称为 `jrxy_auto_cf`。Cloudflare Worker 资源名使用平台允许的短横线形式 **`jrxy-auto-cf`**，队列默认名为 **`jrxy-auto-cf-jobs`**。

### 2. 创建资源

在 `cloudflare/` 目录执行：

```bash
npm ci
npx wrangler login
npx wrangler d1 create jrxy-auto-cf
npx wrangler queues create jrxy-auto-cf-jobs
```

编辑 `cloudflare/wrangler.jsonc`，将 `database_id` 的全零占位值替换成创建 D1 返回的 ID。绑定名称仍使用 `DB`、`JOBS`，不要随意更改。

数据库 ID 是资源标识，不是登录凭据；仓库不提供任何真实部署 ID、访问令牌或账号配置。

### 3. 设置运行时 Secrets

| Secret | 内容 |
|---|---|
| `ADMIN_USERNAME` | 独立管理员用户名，与学校学号不同 |
| `ADMIN_PASSWORD` | 至少 12 字符的强密码，推荐使用随机长密码 |
| `ENCRYPTION_KEY` | 32 随机字节的标准 Base64，用于加密账号配置 |

新安装可生成数据密钥：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

通过 Cloudflare 控制台的 Worker **变量和机密** 设置这些值，或使用：

```bash
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ENCRYPTION_KEY
```

首次 Worker 尚不存在时，可以先完成一次部署，再设置 Secrets。缺少 Secrets 的管理 API 和任务会安全拒绝运行。

> **升级必须保留原 `ENCRYPTION_KEY`。不要重新生成，也不要上传 GitHub。丢失密钥会导致已保存账号无法解密。**

### 4. 发布

```bash
npm run deploy
```

该命令依次执行检查、D1 增量迁移、Worker 发布。全零数据库 ID 会阻止发布；迁移失败时不会继续部署。

打开返回的 Worker 地址，输入管理员账号密码。首次默认关闭自动签到。

### 5. 连接 GitHub 自动部署

在 Cloudflare Worker 的 Git 集成中连接仓库，设置：

| 配置项 | 推荐值 |
|---|---|
| 生产分支 | `main` |
| 项目根目录 | `cloudflare` |
| 构建命令 | `npm run check && npm test && npm run build` |
| 部署命令 | `npm run deploy` |
| Node.js | 22 或更新版本 |

`npm run build` 只做 dry-run，不修改生产数据库。Worker 在 Cloudflare 控制台的名称必须与 Wrangler 配置一致。若生产分支不是 `main`，在构建环境设置 `PRODUCTION_BRANCH`。

构建令牌需要目标账号对应的 Workers、D1 迁移和 Queues 权限；按最小范围授权。**构建环境变量与运行时 Secrets 不同**，管理员密码不需要进入构建日志或仓库。

非生产分支只进行检查和 dry-run。在线预览必须使用独立测试资源，不要复用生产 D1、队列或 Cron。

完整说明：[Cloudflare 部署与升级手册](cloudflare/README.md)。

## 使用顺序

1. 登录管理台，添加本人或已获授权的学校账号。
2. 填写原手机 `deviceId`，沿用已有绑定，不要频繁更换。
3. 配置实际位置（GCJ-02）与地址。范围获取会应用学校返回的中心点，使用前请核对实际位置和相关规则。
4. 先做登录测试，再做只探测。
5. 配置通知并点击“测试推送”。测试使用已保存配置，不登录学校或签到，但会真实向通知渠道发送一条测试消息。
6. 确认无误后手动签到，并在官方应用核实结果，再开启每日计划。
7. 临时不需要签到时暂停账号，恢复后从后续新任务开始。

不要让原服务器和新 Worker 同时对同一账号执行自动签到。

## 定时、暂停与可靠性

- 默认每日时间为 `22:05`、业务时区为 UTC+8；页面保存后以 D1 设置为准。
- 同批次按账号顺序执行，默认账号间隔 10 秒。
- 定时暂时性异常在整轮结束后等待 5 分钟，最多额外重试 2 次。
- 手动与普通批量不自动进行业务重试。
- 提交超时先复查：已签视为成功；明确仍未签可进入定时重试；状态未知则停止并提示核实。
- 暂停取消尚未提交的排队/重试任务；提交前再次检查状态和版本，恢复不会重启已取消任务。
- 已发出的请求无法撤回。进入提交阶段后再暂停，会如实提示并继续记录已发生的结果。
- 结果先持久化，再完成通知与日志；中断恢复不会因为补写日志而重复签到。
- Cron 与 Queues 不是硬实时系统，实际开始可能延迟。

## 推送通知

支持 `SCT...`、`sctp...` 及完整 HTTP(S) Webhook，沿用 `title/desp` 表单格式。

- 手动、批量和定时签到按账号配置推送。
- 探测默认不推送，设置 `NOTIFY_ON_DRY=1` 开启。
- 中间重试异常不重复推送，最终结果推送。
- 暂停跳过不伪报为签到失败，不额外发送失败通知。
- “服务已受理”不等于终端必定收到，通知服务自身的额度和送达情况需要另外确认。
- 推送过程中中断可能无法确认结果，记录未知状态，不冒充成功或无限重发。

## 隐私与安全

本仓库不包含个人账号、密码、真实 deviceId、Cloudflare 访问令牌、运行数据库、日志、浏览器会话、抓包、私人截图或个人电脑路径。

- 管理账号密码只放 Cloudflare Secrets；管理员会话在 D1 只保存摘要。
- 学校配置使用 AES-GCM 加密，主密钥与数据库分离。
- 日志不记录密码、Cookie、会话令牌、动态密钥或通知凭据。
- `.dev.vars`、`.env`、`accounts/`、`.wrangler/`、缓存及运行数据默认忽略。
- 自动化测试中的账号、设备ID、坐标与密钥均为合成样本，不能用于生产。
- 引擎中的固定协议加密材料源自所附协议实现，不是个人或部署凭据，也不用于数据存储加密；来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 发布前执行 `npm run release:check` 检查暂存文件清单和常见敏感模式；它是辅助检查，不替代人工核对。

如发现误上传真实秘密，应立即撤销或轮换相关凭据，而不只是删除文件。

## 免费计划与适配边界

使用的服务支持免费计划，但免费配额不是无限，也不保证所有学校、账号规模或复杂登录页都能在额度内稳定运行。

- 学校需公网 HTTPS 可达、证书有效；校园内网、特殊 MFA、本地 HTTP 代理或关闭 TLS 校验不等价支持。
- 不使用 OCR，遇到验证码会停止自动任务并报告。
- 原 Python Web 的主协议与业务规则有对照测试；管理员登录、暂停、异步存储及安全限制是明确的迁移/增强行为。
- 原 CLI 中未由 Web 使用的实验协议或插件不作为 Cloudflare 新入口。
- 不承诺“与所有旧代码每一行完全相同”或“所有学校保证成功”；具体对应与差异见 [流程审查报告](docs/FLOW_REVIEW.md) 和 [兼容说明](cloudflare/MIGRATION-PARITY.md)。

## 验证状态

发布前已完成流程审查及 **91 项 workerd 自动化测试**，其中19项直接对照原Python规则/API样本；类型、页面契约、构建与依赖审计通过。源码暂存清单另经过隐私扫描与人工核对，不包含运行数据或截图。

这些验证仅覆盖本地和模拟上游。真实学校连通性、实际签到结果、通知终端送达和远程免费配额仍需在授权部署中验证。

## 开发与测试

```bash
cd cloudflare
npm ci
# 复制 .dev.vars.example 为 .dev.vars，并填入本地测试配置
npm run db:local
npm run dev
npm run check
npm test
npm run build
```

- `check`：TypeScript、页面安全/功能契约、统一部署契约。
- `test`：在 workerd 中执行原规则对照、登录、签到、定时、暂停、鉴权、通知、恢复与迁移测试；外部请求使用模拟。
- `build`：仅构建检查，不发布公网。
- `release:check`：检查 Git 暂存内容，不上传文件。

目录：

```text
cloudflare/               可部署项目
  public/                 手机/桌面管理页
  src/                    鉴权、存储、调度、签到与通知
  migrations/             D1 增量迁移
  tests/                  合成数据与原规则回归
  scripts/                部署、迁移、发布检查工具
docs/                     流程审查说明
jrxy-engine/              原 Python 协议参考代码
web-server/app.py         原 Web 规则参考（不在 Worker 上运行）
```

## 许可证与来源

本项目采用 [MPL-2.0](LICENSE)。协议适配保留原实现的来源与许可，不会因为品牌更名而删除第三方版权说明，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 学习使用说明

**本项目仅供学习与研究使用。** 仅可用于本人或明确授权的账号，使用前应确认符合学校、平台条款及适用法律。不得用于未经授权的访问、代签、虚假位置上报或规避管理要求。本项目不承诺服务可用性或签到结果；使用者应自行核对实际状态并承担使用责任。
