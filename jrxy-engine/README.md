# jrxy Python 协议参考

本目录保留迁移前的协议实现，用于审查、原业务规则对照测试和理解登录/查询/加密/提交链路。**Cloudflare 不运行这里的Python代码**；实际项目入口是 [`../cloudflare/`](../cloudflare/)。

## 主要对应关系

- `actions/wiseLoginService.py`、`casLogin.py`、`iapLogin.py`：学校发现与登录参考。
- `actions/autoSign.py`：签到/查寝任务与附加表单。
- `scripts/merged_ios_v4_submit.py`：动态密钥及iOS提交协议。
- `scripts/extract_deviceid.py`：本人协议请求头中的deviceId提取工具。
- `actions/utils.py`：原工具与接口路径。

历史Python代码还含照片、OCR及其他任务逻辑，不代表这些功能在 `jrxy_auto_cf` 中启用。不要直接使用历史脚本中的自动生成deviceId或打印敏感调试信息作为新的部署方式。

原实现声明的来源为 [maserpoassr/jrxy-engine](https://github.com/maserpoassr/jrxy-engine)，基于 auto-cpdaily 项目谱系；保留 [MPL-2.0](LICENSE) 许可。品牌文本统一为 `jrxy`，协议路径、字段和固定协议材料未因品牌更名改变。

## 学习使用说明

**仅供学习与研究使用。** 只可处理本人或明确授权的账号，遵守相关平台规定及适用法律。
