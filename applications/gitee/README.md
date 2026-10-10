# Gitee

## 一、授权

1. 在 [Gitee 私人令牌管理](https://gitee.com/profile/personal_access_tokens) 创建自己的 Token。按实际任务选择账户信息、仓库与 Issue 等所需权限；本平台使用 `https://api.gitee.com/mcp`，无需 Gitee 企业版试用。
2. 双击本目录 `connect.bat`，隐藏输入原始 Token，不加 `Bearer `。脚本在工具发现成功后保存凭据；发现工具并不代表仓库业务操作已成功。
3. `check.bat` 使用已保存 Token 检查。仓库读取、Issue 写入等仍受 Token scope、仓库成员角色及服务端工具支持限制。
4. 按安装说明启动实际应用 Gateway，确认 `/gitee/mcp` 就绪后再配置 Agent 路由。应用遇到付费门槛时不购买、不将其当作免费能力。

本机凭据：`%LOCALAPPDATA%/mcp-cross-app-trace/gitee.credential.xml`。

## 二、取消授权

### 1. 停用本平台入口

暂停本应用的 Agent 任务。双击上一级 `manage-apps.bat`，选择本应用后选“停用”（菜单 5）；也可在项目根目录运行：

```sh
node tools/application-catalog.js disable gitee
```

模块停用在重新加载 Gateway 后生效。清理凭据前先停止仍在使用它的本项目 Gateway/上游：前台控制台按 Ctrl+C，受管后台实例用 `npm run unmount`。仅关闭网页或关闭强制监控开关不等于取消授权。

### 2. 在服务端撤销权限

1. 登录同一账号，打开 [私人令牌管理](https://gitee.com/profile/personal_access_tokens)。该页面需要登录，列表按钮以实际页面为准。
2. 找到本项目使用的 Token，选择删除/撤销并完成账号验证；如果入口名称变动，从账号设置中的“私人令牌”进入，或查看 [Gitee 官方帮助](https://help.gitee.com/)。
3. 确认 Token 已移除。删除本机文件或退出 Gitee 登录不能代替撤销 Token。不要为“撤销”重新生成另一个 Token，也不要删除业务仓库或 Issue。

### 3. 删除本机保存的凭据

打开 `%LOCALAPPDATA%/mcp-cross-app-trace`，删除 `gitee.credential.xml` 和本项目对应副本；保留其他应用凭据。

### 4. 清理客户端并确认结果

在 Codex/DSH 中停用本应用的受管 MCP 条目，或按 [路由教程](../agent-routing/README.md) 重新准备、检查和应用不包含本应用的计划，然后重载客户端。只处理本应用，保留其他应用和开发工具；所有保留连接仍须 `required=false` / `failOnStartupError=false`。

退出仍持有旧凭据的 Agent/上游进程；如果曾在终端、系统环境变量或其他 MCP 客户端保存相同凭据，也清除本应用对应的副本。只删本机文件不会使云端 Token 自动失效，云端撤销也不会删除已经采集的历史原文。历史数据按 [停用指南](../../docs/user/DISCONNECT.md) 单独处理。

完成后在应用中心确认本应用已停用，客户端不再调用它，并检查平台后台的撤销/停用结果。工具列表仍可见不代表业务授权仍有效；不要为验证撤销结果再次运行 `connect.bat`、重新登录或创建业务对象。以后需要恢复时，重新授予权限并绑定。
