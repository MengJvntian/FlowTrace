# Agent 网关连接

## 强制监控开关

使用 `monitoring-on.bat` / `monitoring-off.bat` 切换，`monitoring-status.bat` 查看。默认开启；开启时网关离线拒绝应用调用，但普通聊天可用。关闭时仍优先 Gateway，离线才用保存的授权直连并标记“未监控”。安装入口 `install-switch.bat`，安装后重载客户端，之后切换无需重载。详见 [开关教程](../../docs/user/MONITORING_SWITCH.md)。

**所有网关应用都是可选增强，即使已在线也不得设置 `required = true` / `failOnStartupError: true`；应用故障不能阻断普通 Agent 会话。历史示例或备份中的 true 不得恢复。**

将当前已选应用的 MCP 入口统一到监控网关。应用账户仍由各应用的 `connect.bat` 绑定，不需要重新授权。

普通客户端连接统一生成 `required = false`（Codex）和 `failOnStartupError: false`（DSH）。应用离线时应允许普通会话启动；需要监控的运行由 `start-monitored.bat` 和 `check --strict` 单独检查。

默认清单是 `trace.manifest.json`，仅生成其中声明的应用。使用其他清单时必须明确传入 `--manifest`；`apply` 沿用准备计划记录的清单，核对正在运行的网关清单路径、上游名称、路径和就绪状态，不匹配时不写客户端。仅在应用目录中存在的模块不会自动变成客户端入口。

```powershell
node tools/node.js bin/application-routing.js preflight --manifest trace.manifest.applications.json
node tools/node.js bin/application-routing.js prepare --router --manifest trace.manifest.applications.json
node tools/node.js bin/application-routing.js check --manifest trace.manifest.applications.json --profile desktop --health --strict
```

先确认本机入口与授权已保存，再启动对应清单的网关；检查就绪后才应用准备好的计划。`preflight` 不启动应用、不刷新令牌、不打开授权页；它只确认本机文件和令牌存在，不能证明令牌有效或所有权限已开通。空凭据目录不会视为已授权。准备阶段遇到现有 DSH bundle 中有目标清单之外的入口会阻止替换，请核对清单，避免误删已配置应用。

上游 `path` 使用 `/gmail/mcp` 等普通路径，客户端 URL 才添加 `/codex` 或 `/dsh`。重复 `serverName`、`path`、`gatewayId` 和上游 Agent 前缀均被拒绝。已管理的 bundle 不允许旧 `sync-bundle --write` 覆盖，请使用上述准备和应用流程。

| 入口 | 用途 |
| --- | --- |
| `prepare.bat` | 生成 Codex、DSH 连接片段、安装计划和逐项报告；不改客户端 |
| `bind.bat` | 准备并应用配置；先确认网关就绪，备份原文件，再更新；不打开授权页 |
| `check.bat` | 检查 Codex 与 DSH desktop 的每个目标应用入口和网关健康 |
| `start-monitored.bat` | 启动工作台前检查目标应用路由，启动后检查网关健康；发现直连、重复、缺失或未完整解析则返回失败 |

也可以双击 `applications/manage-apps.bat`，输入 **G** 绑定，输入 **C** 检查。添加、停用、移走应用模块后，先重载网关，再重新绑定入口，让客户端配置跟随新的应用清单。

当前安装目标是 Codex 用户配置与已经安装的 `@local/mcp-trace-http` DSH bundle。保留其他开发工具；已识别的 Codex 应用直连条目被停用，原凭据内容保留在原文件，不复制到生成片段。项目层 Codex 应用入口也会检查并停用，防止与用户配置重复。DSH 其他插件或 profile 的应用入口不自动删除，发现冲突需先复核来源。尚未安装平台 bundle 的用户按项目已有 DSH 插件教程安装后再绑定。

更新后需要客户端重新加载 MCP 配置。修改文件不会替换当前聊天已加载的工具列表；无需重新申请应用授权。

## 读懂检查结果

- **已走网关**：所检查配置中，该应用只有一个正确客户端入口。
- **存在直连**：已识别的应用条目指向其他入口或直接启动程序。
- **重复入口**：同一应用有多个启用入口。
- **网关入口归属需更新**：使用旧入口或另一客户端入口，可能记录错误的 Agent 标签。
- **未配置**：没有找到该应用的正确入口。
- **配置来源未全部解析**：有缺失 bundle、配置错误或不支持的结构，不能宣称覆盖完整。

其他开发工具和无法识别用途的入口会单独报告，不计入目标应用覆盖，也不会被自动删除。启动检查只限制其所检查的目标应用配置，不能阻止其他脚本、浏览器、连接器或启动后修改配置来绕过网关。

默认检查扫描 Codex 用户/当前项目配置、DSH 各 profile、选定 bundle 的所有 patch，以及 DSH 全局 patch。CLI 安装自带的 DSH bundle 可从该安装目录解析；其他客户端安装目录、运行时追加的 `--patch`、动态代码与完整配置叠加语义不在静态检查保证内。`check.bat` 和监控启动入口聚焦 desktop，全部 profile 报告可用下面的命令查看。

```powershell
node tools/node.js bin/application-routing.js check --health --json
node tools/node.js bin/application-routing.js check --profile desktop --health --strict
node tools/node.js bin/application-routing.js check --client codex --health --strict
```

`--strict` 在目标应用未全部配置或网关不健康时返回 3；其他未知工具会保留并显示，不将它们视为已受监控。`check` 不写文件；`prepare` 更新此目录的生成文件；`apply` 只应用与准备时摘要一致的版本2计划，旧计划需重新准备。备份路径见 `installed.json`，备份存放在原文件旁。准备计划不会保存用户原配置正文、Token 或 Secret。

## 使用范围

应用模块可用不表示本机账户已绑定。先按安装说明绑定账户、核验端点，再准备和应用当前机器的路由。

严格检查覆盖它解析的受管路由；不能阻止其他脚本或连接器绕过。采集失败需如实报告，当前不保证所有记录写入失败都在业务提交之前阻断。
