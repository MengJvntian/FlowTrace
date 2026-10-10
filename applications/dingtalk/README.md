# 钉钉

## 一、授权

1. 在 [钉钉开放平台](https://open-dev.dingtalk.com/) 创建自己的组织自建应用；需要有相应开发/管理权限。
2. 按用途开通权限：待办 `Todo.Todo.Read` / `Todo.Todo.Write`；日历 `Calendar.Event.Read` / `Calendar.Event.Write` / `Calendar.EventSchedule.Read`；成员查询 `qyapi_addresslist_search`、`qyapi_get_member`；按手机号查询另需 `qyapi_get_member_by_mobile`。仅做读取时不额外开通写入能力。
3. 通讯录可见范围包含自己，按后台要求发布/启用应用。权限名称以后台标识为准。
4. 双击 `connect.bat`，在本机输入 Client ID/AppKey、隐藏输入 Client Secret；知道自己的组织 User ID 时填写，不知道可留空。
5. `check.bat` 只验证工具发现，输出 `business_verified=false`；成员、待办和日历业务权限要通过就绪 Gateway 中的目标工具单独核验。

本机凭据：`%LOCALAPPDATA%/mcp-cross-app-trace/dingtalk.credential.xml`。适配器不把令牌缓存写入源码。本方式是自建应用的组织授权，不是普通个人网页OAuth。

## 二、取消授权

### 1. 停用本平台入口

暂停本应用的 Agent 任务。双击上一级 `manage-apps.bat`，选择本应用后选“停用”（菜单 5）；也可在项目根目录运行：

```sh
node tools/application-catalog.js disable dingtalk
```

模块停用在重新加载 Gateway 后生效。清理凭据前先停止仍在使用它的本项目 Gateway/上游：前台控制台按 Ctrl+C，受管后台实例用 `npm run unmount`。仅关闭网页或关闭强制监控开关不等于取消授权。

### 2. 在服务端撤销权限

1. 用组织管理员/开发者账号进入 [开放平台](https://open-dev.dingtalk.com/)，选择本项目应用，检查权限管理与应用管理。
2. 若应用仍要保留供其他用途，移除本项目不再需要的接口权限，并按后台要求更新版本/发布；通讯录可见范围按需收回。仅从工作台移除图标不等于收回接口权限。
3. 若应用仅用于本项目且已不用，在管理入口按后台提供的停用/删除流程处理；如果没有权限或没有入口，请组织管理员处理，不宣称仅删本机凭据就完成组织侧撤销。
4. Client Secret 不再使用时可重置旧密钥；已经发放的访问凭据可能受平台有效期影响，不能仅凭 Secret 重置就声称所有会话立即失效。确认旧程序退出并由管理员核对应用状态。

参考：[钉钉官方权限问题说明](https://open-dingtalk.github.io/developerpedia/docs/develop/best-practices/permission-deny/)。后台名称与停用可用性以组织实际页面为准。

### 3. 删除本机保存的凭据

打开 `%LOCALAPPDATA%/mcp-cross-app-trace`，删除 `dingtalk.credential.xml` 和本项目对应副本；不要移除其他钉钉应用的配置。

### 4. 清理客户端并确认结果

在 Codex/DSH 中停用本应用的受管 MCP 条目，或按 [路由教程](../agent-routing/README.md) 重新准备、检查和应用不包含本应用的计划，然后重载客户端。只处理本应用，保留其他应用和开发工具；所有保留连接仍须 `required=false` / `failOnStartupError=false`。

退出仍持有旧凭据的 Agent/上游进程；如果曾在终端、系统环境变量或其他 MCP 客户端保存相同凭据，也清除本应用对应的副本。只删本机文件不会使云端 Token 自动失效，云端撤销也不会删除已经采集的历史原文。历史数据按 [停用指南](../../docs/user/DISCONNECT.md) 单独处理。

完成后在应用中心确认本应用已停用，客户端不再调用它，并检查平台后台的撤销/停用结果。工具列表仍可见不代表业务授权仍有效；不要为验证撤销结果再次运行 `connect.bat`、重新登录或创建业务对象。以后需要恢复时，重新授予权限并绑定。
