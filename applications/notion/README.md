# Notion

## 一、授权

1. 打开 [Notion 连接管理](https://www.notion.so/profile/integrations)，创建自己工作区的内部连接（Internal connection）。本平台使用官方开源 `@notionhq/notion-mcp-server@2.5.2`，不要求购买 Notion AI。
2. 按需要开启读取、插入、更新内容能力。建立专用页面，在连接后台 Content access 授予它访问权限，或页面右上角“··· → Connections/连接”添加该连接。Token 有效不等于连接能访问所有页面。
3. 双击 `connect.bat`，隐藏输入 Token，不加 `Bearer `。`account_read_verified: true` 表示连接身份读取成功，页面权限需另行验证；失败不替换旧凭据。
4. 用 `check.bat` 检查现有连接；在实际 Gateway 就绪后配置 Agent 路由，清单路径为 `/notion/mcp`。

本机凭据：`%LOCALAPPDATA%/mcp-cross-app-trace/notion.credential.xml`。

## 二、取消授权

### 1. 停用本平台入口

暂停本应用的 Agent 任务。双击上一级 `manage-apps.bat`，选择本应用后选“停用”（菜单 5）；也可在项目根目录运行：

```sh
node tools/application-catalog.js disable notion
```

模块停用在重新加载 Gateway 后生效。清理凭据前先停止仍在使用它的本项目 Gateway/上游：前台控制台按 Ctrl+C，受管后台实例用 `npm run unmount`。仅关闭网页或关闭强制监控开关不等于取消授权。

### 2. 在服务端撤销权限

1. 只撤回某页的访问：打开页面“··· → Connections/连接”，找到本项目连接并 Disconnect/断开；同时检查其他页面或父页授予的范围。移除单页连接不代表 Token 本身失效。
2. 停止整个集成：进入 [连接管理](https://www.notion.so/profile/integrations)，选择本项目内部连接，在管理设置中删除连接或执行页面提供的撤销/重置 Token 操作。删除连接与移除单页访问的范围不同；仅减少 Content access 不等于注销 Token。
3. 若使用的是个人访问令牌而非内部连接，在其 Token 管理页撤销对应 Token。只注销不再使用的连接/Token，不删除工作区或父页面。

页面断开依据：[Notion 官方连接管理说明](https://www.notion.com/help/add-and-manage-connections-with-the-api)；连接配置见 [官方内部连接教程](https://www.notion.com/help/create-integrations-with-the-notion-api)。后台注销选项以所使用的连接类型和实际页面为准。

### 3. 删除本机保存的凭据

打开 `%LOCALAPPDATA%/mcp-cross-app-trace`，删除 `notion.credential.xml` 及本项目对应副本；不要误删其他应用文件。

### 4. 清理客户端并确认结果

在 Codex/DSH 中停用本应用的受管 MCP 条目，或按 [路由教程](../agent-routing/README.md) 重新准备、检查和应用不包含本应用的计划，然后重载客户端。只处理本应用，保留其他应用和开发工具；所有保留连接仍须 `required=false` / `failOnStartupError=false`。

退出仍持有旧凭据的 Agent/上游进程；如果曾在终端、系统环境变量或其他 MCP 客户端保存相同凭据，也清除本应用对应的副本。只删本机文件不会使云端 Token 自动失效，云端撤销也不会删除已经采集的历史原文。历史数据按 [停用指南](../../docs/user/DISCONNECT.md) 单独处理。

完成后在应用中心确认本应用已停用，客户端不再调用它，并检查平台后台的撤销/停用结果。工具列表仍可见不代表业务授权仍有效；不要为验证撤销结果再次运行 `connect.bat`、重新登录或创建业务对象。以后需要恢复时，重新授予权限并绑定。
