# jrxy_auto_cf 流程审查

## 范围与结论

审查覆盖：管理员登录、账号存储、CAS/IAP无验证码登录、任务查询与选择、表单、设备ID、动态密钥、签名提交、复查、每日计划、批量顺序、暂停/恢复、通知、日志、数据迁移与部署。

基线为所附 Python 原项目的实际 Web 调用链：`web-server/app.py` → `jrxy-engine/scripts/merged_ios_v4_submit.py --variant fkey_cat --protocol ios`，而不是 README 中未被当前入口调用的所有历史功能。

**主协议和对应业务规则按原实现保留，并使用原Python生成的合成样本对照。运行架构、登录管理、暂停、安全处理和异步API存在明确变化，因此不能宣称每条旧代码或所有异常行为完全相同。** 真实学校、远程免费CPU配额及通知终端送达不在本地验证结论内。

## 分阶段检查

| 阶段 | 原来源 | 本版处理 / 验证 |
|---|---|---|
| 管理鉴权 | 原WEB_TOKEN | 按新需求改为独立账号密码、会话摘要、HttpOnly Cookie、Origin/CSRF、限速；旧token拒绝 |
| 账号与设备 | 原YAML/device_id | D1加密账号及姓名；两个入口先自动沿用/生成并保存固定ID，手动迁移ID可选；编辑留空沿用，不因显示名称修改重建内部ID |
| 学校发现 | wiseLoginService | 按原入口次数执行，不再缓存并跳过请求；登录/范围一轮发现，探测/签到两轮发现，后者登录后再次查租户 |
| CAS表单 | casLogin | 发现后重新GET登录页；casLoginForm整页输入、pwdFromId首个/ loginFromId第二个表单；新Cookie/令牌、Python表单编码及盐加密一致 |
| IAP登录 | iapLogin | 原lt/验证码请求使用无Content-Type的{}正文；doLogin为POST查询参数、回跳POST；额外保留校园门户成功校验 |
| Cookie/跳转 | requests.Session | 合法父域Cookie、公共后缀隔离、跳转限制；不跨域重放登录请求体 |
| 登录测试 | test_login | 仅登录，返回host/Cookie名称，不查询任务，不回传Cookie值 |
| 任务列表 | AutoSign.getUnSignTask | 查询预热、未签/请假回退、标题匹配；异常列表结构停止，不当成成功或无任务 |
| 表单 | AutoSign.fillForm | 类型1/2、附加选项/checkTitle/extra保持，原Python对照；不支持的照片任务停止 |
| 签名 | submit_ios_v4 | AES-CBC、MD5、Python字符串排序、浮点坐标序列化，固定输入对照 |
| 密钥协商 | fetch_secrets | 原候选主机顺序、RSA协商、fkey_cat派生；不把密钥输出到日志 |
| 提交 | Web指定ios | 同一请求体字段、关键头、Cookie；提交前持久化检查点及暂停版本检查 |
| 异常复查 | confirm_signed | 已签→成功；明确未签→仅定时有限重试；状态未知→停止人工核实，比原宽泛重试更保守 |
| 每日定时 | _pending_slot/_fire | UTC业务换算、计划快照、补执行窗口、时间点幂等、串行/间隔、整轮重试 |
| 暂停/恢复 | 新需求 | 入口过滤、队列取消、提交前版本核对、恢复不补跑；待报告重试也重新检查暂停版本 |
| 结果持久化 | 原progress/log | D1结果和待报告状态先落盘，崩溃恢复只补日志/通知，不重跑已完成的签到 |
| 通知 | send_notify/run_and_report | 原Server酱/Webhook契约、标题/时间/触发、探测开关、最终重试通知；服务受理不等于终端送达 |
| UI | 新需求 | 原生响应式管理台，暂停与真实提交确认，学校密码不回显；不保存旧访问token |
| 兑换开通 | 新增用户授权 | 先生成/沿用ID并保存到短期记录，再调用原登录函数验证，成功后事务绑定唯一兑换码；失败清除姓名、密码及临时设备标识，不以生成ID冒充学校授权 |
| 开通诊断 | 新增排障 | 结构化记录阶段/方法/域名/耗时/HTTP状态及send/headers/body/decode/json环节；区分未获响应、正文中断、响应处理异常；不包含原始异常与个人请求内容 |
| 到期清理 | 新增授权期限 | 任务建立/消费/提交/结果写入均校验；删除兑换账号及个人记录，保留码已用摘要，旧任务不可重建个人数据 |
| 发布 | Git连接Cloudflare | 同一代码/配置，检查→增量迁移→发布；预览dry-run不连接生产库 |

## 本次审查修复

### 原生fetch调用错误复核

发现并在真正的workerd中复现一个确定性阻断：`Session`将原生fetch保存为成员后用 `this.transport(...)` 调用，接收者变成Session对象，原生函数抛出 `Illegal invocation`。在到达网络出口前就失败，旧异常包装却显示为DNS/TLS/连接问题。

- 修复为先取出函数，再以普通函数调用，避免错误this；不更改账号、设备ID或协议参数。
- 明确的Illegal invocation归为内部调用错误、不重试，不输出原始异常或其中的敏感字段。
- 之前158项（含原Python请求轨迹）使用替代fetch，不能发现原生函数接收者限制。新增 `scripts/test-native-fetch.mjs` 保留真正的workerd原生fetch，只将网络出口转给本地内存服务。
- 同一测试修复前失败、修复后通过22项检查/246次本地请求：默认/显式fetch注入、16条原入口链路、4条自助开通使用的直接登录链路。姓名与学校用户名设置为不同值，检查上游仍使用用户名。
- `npm test`已强制串联该原生测试。此证据确认代码阻断已修复，不等于真实Cloudflare出口与学校证书/服务已验证。

### 请求轨迹复核

此前133项通过覆盖业务规则与模拟流程，未证明完整HTTP请求链路一致。本轮先从原Python入口捕获16条合成轨迹，修复前16条均不匹配，修复后全部通过：

- 原 `test_login.py` / `fetch_sign_range.py` 一轮学校发现；原 `merged_ios_v4_submit.py` 调用发现两次，登录后还查询一次租户。Worker已恢复这些顺序，不再用学校元数据缓存跳过请求。
- CAS发现登录地址后再次GET登录页，使用最新Cookie、execution和密码盐；`casLoginForm`整页字段与其他模板的限定范围分开处理。
- 表单使用Python urlencode规则（包括`~`、`*`等字符）、登录AES串按原76列换行；IAP的`{}`正文不擅自添加JSON或text/plain类型。
- 请求JSON的空格及ASCII转义匹配原调用方式；动态密钥和提交按原显式20秒请求时限；原段值非空检查保留。Workers整体计时语义仍不同于requests读超时，见下文。
- 空Cookie头不发送；标准getSetCookie和Workers getAll兼容，多个Cookie及Expires逗号不合并拆错。响应头/正文处理异常不再伪装成连接失败。
- `original-http.test.ts` 比较16条轨迹的应用层方法、URL、显式请求头、正文和Cookie。固定随机输入后对齐签名及加密头；RSA随机填充只校验结构，不逐字比较。另测同学校不同账号不共享Cookie或跳过发现。

轨迹生成只执行AST提取的原函数，requests使用内存适配器且socket连接被禁用；不导入原Web服务器、不读取账号目录。传输层自动添加的Content-Length、压缩/连接头以及TLS握手不在逐字对照范围内。

### 既有审查修复

- 重复 `loginFromId` 表单不再把不同表单隐藏字段混在一起，选取与原模板对应的第二个。
- IAP跳回登录页时不再仅凭预登录Cookie误报成功。
- 查询验证码状态遇到异常HTTP响应时停止，不盲目提交密码。
- 任务列表结构异常、范围无任务及坐标无效时返回明确失败，不进入提交。
- 范围结果补回 `signWid`，保持原查询结果契约。
- 重试结果已落盘、通知/日志尚未完成时发生暂停或恢复，恢复报告阶段会终止旧重试，不继续运行或伪报失败推送。

## 必须保留的差异与边界

1. Python常驻线程/子进程/本地磁盘改为Workers、Queues与D1，这是平台迁移，不是原代码原样运行。
2. 管理账号密码登录与账号暂停为明确新增要求。
3. 后台和兑换账号统一按原Web `ensure_device_id()` 规则，登录/探测前先沿用可确认绑定，无值时首次生成UUID并固定。管理员可选填旧ID，编辑留空保持原值。原独立 `test_login.py` 仅做CAS/IAP登录，ID参与后续动态密钥协商和签到；不为登录接口臆造设备字段，也不能凭生成ID保证学校设备授权。
4. 不使用OCR，不上传照片，不提供类型0/3/4任务；触发验证码停止并报告。
5. 仅支持公网HTTPS和有效TLS证书，不照搬 `verify=False`；本机HTTP代理不适用于云端。
6. 原requests默认连接10秒/读取30秒，协商与提交显式20秒；Workers将显式20秒应用于完整请求，并保留总时限、大小和跳转上限。原requests仅对未建立连接的失败有限重试，Workers不对送达情况不明的fetch异常重放POST。免费配额及出口/TLS差异仍需远程Metrics和同次脱敏诊断核实。
7. 外部推送没有端到端幂等键，发送期间崩溃可能未知；不会把未知写成成功。
8. 运行API异步返回任务ID，页面内部轮询；直接调用旧同步API的脚本需要适配。
9. 新安装尚无授权时定时默认关闭；首次成功兑换可开启未由管理员设置过的初始计划。主动关闭/保存过的计划不覆盖，兑换账号只参与开通后的计划，不立即签到或补跑。
10. 日志脱敏，不照搬原代码打印会话令牌、密码或密钥的调试输出。

## 验证证据

- `original-parity.test.ts`：任务选择、表单、Python签名材料与结果分类。
- `original-http.test.ts`：16条原Python入口轨迹及跨账号无缓存/无会话共享测试，覆盖请求序列、headers、body、Cookie及固定输入下的加密输出。
- `login.test.ts`：CAS/IAP、重复表单、Cookie与错误状态。
- `engine.test.ts` / `crypto-runtime.test.ts`：加密、任务、探测、提交异常复查。
- `end-to-end.test.ts`：管理API→队列→模拟上游→提交/不提交→通知与日志。
- `pause.test.ts` / `batches.test.ts`：暂停、恢复、乱序、并发、重试及中断。
- `auth.test.ts` / `migration.test.ts`：安全会话、限速、旧数据增量升级。
- `notify.test.ts`：通知URL、消息格式、受理/失败/非JSON响应与脱敏。
- `device.test.ts` / `redemption.test.ts`：登录前设备ID已保存、重试不换ID、姓名加密/幂等/同名隔离与旧任务兼容。
- `diagnostics.test.ts`：请求超时/传输失败/HTTP状态及登录阶段，诊断白名单、管理员隔离与短期清理。

测试使用合成账号、学校、设备和坐标，不读取真实账户、不真实签到、不发送实际通知。最新数量以 `npm test` 为准。

## 学习使用说明

**本项目仅供学习与研究使用。** 不提供未经授权的访问、代签到或规避管理的授权；实际使用应遵守学校、平台规定与适用法律。
