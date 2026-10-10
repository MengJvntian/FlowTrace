# 腾讯文档

## 一、授权

1. 登录 [腾讯文档 MCP 授权页](https://docs.qq.com/open/auth/mcp.html)，取得个人 Token。平台原生权限范围由授权页面决定，并非本项目可自行收窄；按需要核对文档访问范围。
2. 双击 `connect.bat`，隐藏输入页面给出的 Authorization 原值，不自行加 `Bearer `。
3. `check.bat` 验证远程 MCP 工具发现，不创建文档。真实文档读写还受账号、共享范围和相应能力权限限制；VIP权限错误不通过购买绕过，只使用免费可用的目标功能。
4. 对应上游为 `https://docs.qq.com/openapi/mcp`。Gateway 就绪后配置 Agent 路由；未知工具仍记录调用，但读写分类与字段关联覆盖需单独核对。

本机凭据：`%LOCALAPPDATA%/mcp-cross-app-trace/tencent-docs.credential.xml`。参考：[腾讯官方 MCP 配置说明](https://developer.cloud.tencent.com/mcp/server/11803)。

## 二、取消授权

### 1. 停用本平台入口

暂停本应用的 Agent 任务。双击上一级 `manage-apps.bat`，选择本应用后选“停用”（菜单 5）；也可在项目根目录运行：

```sh
node tools/application-catalog.js disable tencent-docs
```

模块停用在重新加载 Gateway 后生效。清理凭据前先停止仍在使用它的本项目 Gateway/上游：前台控制台按 Ctrl+C，受管后台实例用 `npm run unmount`。仅关闭网页或关闭强制监控开关不等于取消授权。

### 2. 在服务端撤销权限

1. 登录绑定账号，打开 [MCP Token 授权页](https://docs.qq.com/open/auth/mcp.html)，查看该账号的 Token/授权管理。
2. **目前公开官方说明确认了获取 Token 的入口，但未明确独立撤销按钮，也未确认重新获取 Token 一定会使旧 Token 失效。** 若实际页面提供撤销/删除/重置，按其提示操作并确认旧 Token 已失效；不要凭“生成了新 Token”就判撤销成功。
3. 若页面没有撤销功能，通过腾讯文档官方帮助/客服申请注销本项目 Token 或相关授权。此时可先完成本机停用和凭据删除，记录为“本机已停用，云端撤销待确认”。
4. 不需要删除文档、注销QQ/微信账号，或撤销其他无关应用。

### 3. 删除本机保存的凭据

打开 `%LOCALAPPDATA%/mcp-cross-app-trace`，删除 `tencent-docs.credential.xml` 和本项目副本；只删除这个文件不能让服务器上的旧 Token 自动失效。

### 4. 清理客户端并确认结果

在 Codex/DSH 中停用本应用的受管 MCP 条目，或按 [路由教程](../agent-routing/README.md) 重新准备、检查和应用不包含本应用的计划，然后重载客户端。只处理本应用，保留其他应用和开发工具；所有保留连接仍须 `required=false` / `failOnStartupError=false`。

退出仍持有旧凭据的 Agent/上游进程；如果曾在终端、系统环境变量或其他 MCP 客户端保存相同凭据，也清除本应用对应的副本。只删本机文件不会使云端 Token 自动失效，云端撤销也不会删除已经采集的历史原文。历史数据按 [停用指南](../../docs/user/DISCONNECT.md) 单独处理。

完成后在应用中心确认本应用已停用，客户端不再调用它，并检查平台后台的撤销/停用结果。工具列表仍可见不代表业务授权仍有效；不要为验证撤销结果再次运行 `connect.bat`、重新登录或创建业务对象。以后需要恢复时，重新授予权限并绑定。
