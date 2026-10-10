# Google Docs

## 一、授权

1. 在自己的 Google Cloud 项目配置 OAuth 客户端与同意页面，启用 **Google Docs API 和 Google Drive API**；测试模式把自己的 Google 账号加入测试用户。配置方法见 [Google 接入教程](../../docs/route-a-runbook.md) 和 [安装说明](../../docs/user/INSTALL.md)。
2. 在本机配置 OAuth Client ID/Secret，准备包含本应用的 Gateway 清单并启动对应上游。默认 Mock 清单不含真实 Google 端点。当前 `connect.bat` 需要已有的本机账户配置；找不到账号时先按接入教程初始化，不要反复点击授权。
3. 双击本目录 `connect.bat`，在 Google 页面选择自己的账户，核对应用名称和请求权限后确认。用途：文档内容读取、创建和修改；目录搜索与当前读回实现还依赖 Drive 访问权限。 实际 scope 以固定版本 workspace-mcp、所选工具和授权页面为准；不需要的业务能力不应额外授权。
4. 本项目使用开源 `workspace-mcp==2.0.1`，不是 Google 官方 MCP；需要先安装/缓存该版本。各应用使用独立凭据目录，不复制其他应用的访问或刷新令牌。
5. 按授权页面完成流程；已有成功授权无需重复连接。 日后 `check.bat` 使用现有配置检查工具发现，不代表所有业务权限可用。

本机令牌目录：`%USERPROFILE%/.google_workspace_mcp/credentials-docs`。Token、OAuth Secret 不放入项目 JSON，不提交到 GitHub。

## 二、取消授权

### 1. 停用本平台入口

暂停本应用的 Agent 任务。双击上一级 `manage-apps.bat`，选择本应用后选“停用”（菜单 5）；也可在项目根目录运行：

```sh
node tools/application-catalog.js disable google-docs
```

模块停用在重新加载 Gateway 后生效。清理凭据前先停止仍在使用它的本项目 Gateway/上游：前台控制台按 Ctrl+C，受管后台实例用 `npm run unmount`。仅关闭网页或关闭强制监控开关不等于取消授权。

### 2. 在服务端撤销权限

1. 登录绑定的 Google 账户，打开 [第三方关联管理](https://myaccount.google.com/connections)。
2. 找到授权时显示的 OAuth 应用名称，进入详情，在访问 Google 账户数据的关联中选择撤销访问权限并确认。不要只停用“使用 Google 登录”，那可能只影响登录而保留数据访问。
3. **共用 OAuth Client ID 时，撤销可能同时影响 Gmail、Calendar、Docs、Drive、Sheets 等关联授权。** 本机凭据分目录不等于云端授权互相独立。若只想暂时停用这一款、保留其他 Google 应用，先执行模块停用并删除该应用本机凭据；这属于本机停用，不能标为“已在 Google 撤销”。
4. 只有该 Cloud 项目/客户端专用于测试且已不再使用时，再考虑停用 API 或删除 OAuth 客户端；不要影响其他程序。关闭 API 与撤销 OAuth 是不同操作。

操作依据：[Google 官方关联管理说明](https://support.google.com/accounts/answer/13533235?hl=zh-Hans)。

### 3. 删除本机保存的凭据

按 Win+R 打开 `%USERPROFILE%/.google_workspace_mcp/credentials-docs`，删除仅属于本项目/此账户的令牌 JSON 和相关备份。多账户时只处理目标账户，不删除 `.google_workspace_mcp` 总目录或其他 `credentials-*` 目录。若某项 OAuth Client 配置仍被其他 Google 应用使用，保留它。

### 4. 清理客户端并确认结果

在 Codex/DSH 中停用本应用的受管 MCP 条目，或按 [路由教程](../agent-routing/README.md) 重新准备、检查和应用不包含本应用的计划，然后重载客户端。只处理本应用，保留其他应用和开发工具；所有保留连接仍须 `required=false` / `failOnStartupError=false`。

退出仍持有旧凭据的 Agent/上游进程；如果曾在终端、系统环境变量或其他 MCP 客户端保存相同凭据，也清除本应用对应的副本。只删本机文件不会使云端 Token 自动失效，云端撤销也不会删除已经采集的历史原文。历史数据按 [停用指南](../../docs/user/DISCONNECT.md) 单独处理。

完成后在应用中心确认本应用已停用，客户端不再调用它，并检查平台后台的撤销/停用结果。工具列表仍可见不代表业务授权仍有效；不要为验证撤销结果再次运行 `connect.bat`、重新登录或创建业务对象。以后需要恢复时，重新授予权限并绑定。
