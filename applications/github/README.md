# GitHub

## 一、授权

1. 打开 [细粒度 Token 创建页](https://github.com/settings/personal-access-tokens/new)，选择自己的 Resource owner 和需要监控的公开/私有仓库，设置有效期。
2. 只读取 README 时使用 Contents: Read-only，Metadata 按默认权限。需要创建或修改 Issue 时另外授予目标仓库 Issues: Read and write；修改代码文件则需 Contents 写权限。不要为未使用功能扩大权限，组织仓库按组织要求审批。
3. 双击本目录 `connect.bat`，填写自己的 GitHub 用户名并隐藏输入 Token；`check.bat` 核对账户身份。身份验证不代表所有仓库工具或写入权限可用。
4. 按 [安装说明](../../docs/user/INSTALL.md) 启动实际应用清单，并在 Gateway 就绪后配置 Agent 入口。上游是 GitHub 官方远程 MCP。

本机凭据：`%LOCALAPPDATA%/mcp-cross-app-trace/github-readonly.credential.xml`。文件名是兼容名称，不表示 Token 一定只读。

## 二、取消授权

### 1. 停用本平台入口

暂停本应用的 Agent 任务。双击上一级 `manage-apps.bat`，选择本应用后选“停用”（菜单 5）；也可在项目根目录运行：

```sh
node tools/application-catalog.js disable github
```

模块停用在重新加载 Gateway 后生效。清理凭据前先停止仍在使用它的本项目 Gateway/上游：前台控制台按 Ctrl+C，受管后台实例用 `npm run unmount`。仅关闭网页或关闭强制监控开关不等于取消授权。

### 2. 在服务端撤销权限

1. 打开 [GitHub Token 管理](https://github.com/settings/personal-access-tokens)，或头像 → Settings → Developer settings → Personal access tokens。
2. 根据创建时的类型进入 Fine-grained tokens 或 Tokens (classic)，找到本项目 Token，点击 Delete 并确认。
3. 删除该 Token 会影响所有复用它的程序；只需要移除某个仓库权限时，可编辑细粒度 Token 的仓库范围。删除 Token 不会删除仓库、文件或 Issue。

操作依据：[GitHub 官方 Token 管理说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#deleting-a-personal-access-token)。

### 3. 删除本机保存的凭据

按 Win+R 打开 `%LOCALAPPDATA%/mcp-cross-app-trace`，删除 `github-readonly.credential.xml` 及仅属于它的副本。不要删除其他应用凭据或 Git 的其他账户配置。

### 4. 清理客户端并确认结果

在 Codex/DSH 中停用本应用的受管 MCP 条目，或按 [路由教程](../agent-routing/README.md) 重新准备、检查和应用不包含本应用的计划，然后重载客户端。只处理本应用，保留其他应用和开发工具；所有保留连接仍须 `required=false` / `failOnStartupError=false`。

退出仍持有旧凭据的 Agent/上游进程；如果曾在终端、系统环境变量或其他 MCP 客户端保存相同凭据，也清除本应用对应的副本。只删本机文件不会使云端 Token 自动失效，云端撤销也不会删除已经采集的历史原文。历史数据按 [停用指南](../../docs/user/DISCONNECT.md) 单独处理。

完成后在应用中心确认本应用已停用，客户端不再调用它，并检查平台后台的撤销/停用结果。工具列表仍可见不代表业务授权仍有效；不要为验证撤销结果再次运行 `connect.bat`、重新登录或创建业务对象。以后需要恢复时，重新授予权限并绑定。
