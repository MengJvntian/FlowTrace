# 飞书

## 一、授权

本教程使用国内飞书、自建应用和固定官方 MCP 0.5.1；未创建应用时先到 [飞书开放平台](https://open.feishu.cn/app) 创建，名称可自行选择。

### 1. 添加权限并发布

1. 进入应用的“开发配置 → 权限管理”，开通**用户身份**权限 `docx:document`、`bitable:app`、`offline_access`。最后一项用于持续访问已授权的数据；未开通可能返回20027。仅开应用身份权限不能替代用户授权。
2. 在安全设置/OAuth重定向地址保存 `http://localhost:3000/callback`。这是授权回调，不是工作台地址；不能擅自改成127.0.0.1。
3. 创建版本并发布，把自己的账户加入可用范围；按平台要求完成管理员审批。只有保存权限、未发布时，新权限可能未生效。本接入不需要机器人或消息订阅。

### 2. 本机连接

1. 在“凭证与基础信息”取得 App ID 与 App Secret。
2. 双击 `connect.bat`，填写 App ID，隐藏输入 App Secret，完成飞书网页授权。登录等待约60秒，建议先配置后台。
3. 看到登录成功后，用 `check.bat` 检查本机令牌状态；是否能读写某篇文档仍取决于用户自身的文档共享权限。
4. 按安装说明启动对应 Gateway，再配置 Agent 入口。已有授权无需重复连接。权限不足检查 scope/发布状态；回调错误检查完整URL；超时重试登录即可，不必重新创建应用。

本机应用凭据：`%LOCALAPPDATA%/mcp-cross-app-trace/feishu.credential.xml`；用户令牌由官方 MCP 本机授权存储管理。授权与普通工具发现、业务成功是不同层级。

参考：[官方用户身份配置](https://github.com/larksuite/lark-openapi-mcp/blob/main/docs/usage/configuration/configuration-zh.md)。

## 二、取消授权

### 1. 停用本平台入口

暂停本应用的 Agent 任务。双击上一级 `manage-apps.bat`，选择本应用后选“停用”（菜单 5）；也可在项目根目录运行：

```sh
node tools/application-catalog.js disable feishu
```

模块停用在重新加载 Gateway 后生效。清理凭据前先停止仍在使用它的本项目 Gateway/上游：前台控制台按 Ctrl+C，受管后台实例用 `npm run unmount`。仅关闭网页或关闭强制监控开关不等于取消授权。

### 2. 在服务端撤销权限

1. 从飞书账号的应用授权管理，或最近的应用授权通知中的管理入口，找到自己的自建应用，按页面撤销用户授权。该入口随客户端/租户版本变化；找不到时请企业管理员处理，不能把退出 MCP 登录当作云端撤销。
2. 该自建应用只用于本项目且不再使用时，由管理员在企业应用管理中停用；如还要删除，按平台要求先停用已发布应用，再到开放平台的凭证与基础信息中删除。共享应用不要直接停用/删除，应只撤销自己的授权。
3. 不用 App Secret 时可由管理员重置，旧 Secret 不再用于换取新凭据；重置 Secret 本身不能当作已撤销所有已发放用户令牌的证明。

参考：[官方授权通知与撤销说明](https://www.feishu.cn/content/article/7652246966524562399)、[飞书/Lark 官方管理员应用停用说明](https://www.larksuite.com/hc/zh-CN/articles/284874730500-%E7%AE%A1%E7%90%86%E5%91%98%E7%A7%BB%E9%99%A4%E6%88%96%E5%81%9C%E7%94%A8%E5%BA%94%E7%94%A8)。

### 3. 删除本机保存的凭据

先记下自己的 App ID；已安装依赖时，在项目根目录运行官方 CLI 的单应用退出命令：

```sh
node node_modules/@larksuiteoapi/lark-mcp/dist/cli.js logout -a cli_你的AppID
```

把占位符替换成实际 App ID。指定 `-a` 只清除此应用本机用户令牌，不要使用无 App ID 的全局退出，以免清除其他飞书应用授权。此命令只清理本机，不等于云端撤销。然后打开 `%LOCALAPPDATA%/mcp-cross-app-trace`，删除 `feishu.credential.xml` 和本项目副本。

命令依据：[官方 CLI logout 说明](https://github.com/larksuite/lark-openapi-mcp/blob/main/docs/reference/cli/cli-zh.md#lark-mcp-logout)。

### 4. 清理客户端并确认结果

在 Codex/DSH 中停用本应用的受管 MCP 条目，或按 [路由教程](../agent-routing/README.md) 重新准备、检查和应用不包含本应用的计划，然后重载客户端。只处理本应用，保留其他应用和开发工具；所有保留连接仍须 `required=false` / `failOnStartupError=false`。

退出仍持有旧凭据的 Agent/上游进程；如果曾在终端、系统环境变量或其他 MCP 客户端保存相同凭据，也清除本应用对应的副本。只删本机文件不会使云端 Token 自动失效，云端撤销也不会删除已经采集的历史原文。历史数据按 [停用指南](../../docs/user/DISCONNECT.md) 单独处理。

完成后在应用中心确认本应用已停用，客户端不再调用它，并检查平台后台的撤销/停用结果。工具列表仍可见不代表业务授权仍有效；不要为验证撤销结果再次运行 `connect.bat`、重新登录或创建业务对象。以后需要恢复时，重新授予权限并绑定。
