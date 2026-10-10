# 强制监控开关

## 网页操作与故障恢复

在工作台左侧打开「应用中心」，点击「开启 / 关闭强制监控」。网页只保存本项目的模式文件，后续路由调用读取新模式；不会修改客户端配置、重启网关或重新授权。证据库仍只读。

`start-monitor.bat` 会在可见控制台启动 Gateway、默认 Mock 清单上游和工作台，不只是打开网页。真实应用启动方式见 [安装说明](INSTALL.md)。Gateway 启动失败时可直接双击根目录 `open-workbench.bat`。独立入口默认在 `http://127.0.0.1:8789/applications.html`，只启动页面、不启动 Gateway 或上游；因此网关离线时仍可关闭开关。端口占用时可运行 `node tools/node.js tools/open-workbench.js --port=8792`。控制台保持可见，按 Ctrl+C 结束独立页面服务。

所有应用连接必须保持 Codex `required = false`、DSH `failOnStartupError: false`。网页开关不会代替或自动修复已被其他工具改成必需的客户端配置；如果旧配置仍有 true，先通过本机编辑器改回 false，才能恢复普通会话。不要通过设置必需 MCP 来强制监控。

入口：`applications/manage-apps.bat` 的 M 菜单，或 `applications/agent-routing/monitoring-on.bat`、`monitoring-off.bat`、`monitoring-status.bat`。这些入口不依赖网关，不打开浏览器、不重新授权。

| 开关 | 网关与目标应用可用 | 网关或目标应用不可用 |
|---|---|---|
| 开启（默认） | 经 Gateway 操作并采集 | 拒绝应用操作，普通聊天与本地修复仍可用 |
| 关闭 | 仍优先经 Gateway | 使用已保存授权直连，返回“未监控”标记 |

开关每次应用调用重新读取，无需因切换重启客户端。配置缺失或损坏按开启处理，可运行关闭脚本显式解除。关闭不恢复旧直连 MCP 配置，而是允许同一本机入口选择直连；恢复网关后，下一次调用优先回到 Gateway。

## 安装与恢复

先启动 `trace.manifest.applications.json` 完整清单并验证所选应用就绪，然后运行 `applications/agent-routing/install-switch.bat`。安装先发现并缓存真实工具定义，再备份、核对摘要、更新管理块；任一发现失败，不写客户端配置。凭据仍在原账户存储中，不复制到客户端或工具缓存。

首次安装后需要重新加载 Codex 客户端与 DSH 插件，使 MCP 入口从 HTTP 切换到本机 stdio 路由器。仅新建聊天不保证 DSH 插件重新加载。后续开关切换无需重载。网关离线时初始化只读取工具缓存，不尝试连接应用；缓存丢失时仅提供 `trace_monitoring_status`，重新安装以刷新工具缓存。

所有应用入口始终 Codex `required=false` / DSH `failOnStartupError=false`。**强制监控不是 required=true，禁止为此把可选应用改成会话必需服务。**即使强制开启且网关损坏，Codex 仍能通过本地文件与终端修复；也可从独立脚本关闭开关。

## 使用边界

业务调用一旦提交，不因响应丢失自动重试或改走直连。错误明确提示结果未知，先核对应用实际状态。关闭时本机 `demo-data/application-router/unmonitored.jsonl` 仅记录应用、Agent、工具、时间和结果类别；它不是网关数据流证据，不能冒充监控采集成功。

约束范围是本平台管理的应用 MCP。它不封锁任意终端网络请求、浏览器或其他连接器。严格检查仍用于监控任务开始前验证实际清单、目标应用和入口；本机路由器补充每次调用的模式判断。健康检查发现采集写入失败时拒绝使用该网关，但健康检查与业务提交不是原子操作，不宣称覆盖所有采集故障。

真实应用先按各模块教程连接，账户绑定、工具发现与真实业务结果分别核验。
