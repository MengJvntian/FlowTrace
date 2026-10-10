# 安装与启动

## 环境

- Node.js 24 或更高版本，npm。
- 核心 Gateway、页面与虚构数据演示可在支持 Node 的系统上运行；双击脚本、DPAPI 凭据保存和现有客户端绑定入口面向 Windows。
- Google 应用另外需要 Python/uv（`uvx`）、自己的 Google Cloud OAuth 客户端和对应 API。其他应用的前置条件见各自教程。

在项目根目录安装固定版本依赖：

```sh
npm ci
```

Windows 如果 `npm.ps1` 被执行策略阻止，使用 `npm.cmd ci`；不必关闭安全软件或绕过执行策略。仓库不提供 Node 二进制、node_modules 或他人的账户授权。

## 三种启动入口

| 入口 | 启动内容 | 默认地址 |
| --- | --- | --- |
| `start-demo.bat` / `node tools/start-demo.js` | 生成虚构调用，再启动隔离查看页面；不启动实时 Gateway | `http://127.0.0.1:8788/` |
| `start-monitor.bat` / `npm run serve` | 默认启动两个 Mock 上游、Gateway 和网页 | 网页 `8787`，Gateway `8790` |
| `open-workbench.bat` / `node tools/open-workbench.js` | 独立工作台，Gateway 故障时仍可查看数据、操作监控开关 | `http://127.0.0.1:8789/applications.html` |

`start-demo` 中显示 Gateway 离线是预期行为：它展示虚构证据，并隔离本机真实应用配置。查看页面启动后保留控制台，按 Ctrl+C 停止。需要实时接收 Agent 调用时运行 `start-monitor`，并另外配置客户端 MCP 入口。

`npm run serve -- --no-open` 在前台运行默认实时服务。Windows 双击 `start-monitor.bat` 使用同样的前台方式，关闭控制台会结束它。已有服务会依照 serve 的实例管理规则复用；停止受管实例可用 `stop-monitor.bat` 或 `npm run unmount`。

## 真实应用

1. 阅读 [应用目录](../../applications/README.md)，按目标应用教程绑定自己的账户。GitHub Token 只授权需要访问的仓库；写入功能需要相应权限。
2. 各应用的 `application.json` 是通用定义，引用环境变量，不含密钥。不要直接把十二款应用全部启用。
3. Windows 已保存的本机凭据可通过 `powershell.exe -NoProfile -File tools/start-next-apps.ps1 -Foreground -NoOpen` 加载，生成实际应用清单并启动。此脚本不会请求 OAuth 或修改客户端配置。Google 须先用对应 connect 入口完成授权。
4. 非 Windows 或采用自己的凭据管理方式，可复制 `trace.manifest.json` 为被忽略的 `trace.manifest.applications.json`，加入已就绪应用定义，设置需要的环境变量，再执行：

```sh
node bin/application-routing.js preflight --manifest trace.manifest.applications.json
npm run serve -- --manifest trace.manifest.applications.json --no-open
node bin/application-routing.js check --manifest trace.manifest.applications.json --health --strict
```

Google 上游默认使用 `uvx --offline --from workspace-mcp==2.0.1`。新电脑须先缓存该版本，例如 `uvx --from workspace-mcp==2.0.1 workspace-mcp --help`，再按应用教程配置 OAuth；离线缓存不是随仓库分发的依赖。

## Agent 与监控开关

客户端安装和路由检查见 [连接说明](client-routing.md) 和 [路由模块](../../applications/agent-routing/README.md)。生成片段先检查再应用；变更后重载客户端。Gateway 清单路径始终不带 `/codex` 或 `/dsh`，客户端 URL 才带 Agent 前缀。

**所有应用连接必须可选：Codex `required=false`，DSH `failOnStartupError=false`。** 强制监控发生在后续应用调用阶段，不能通过必需 MCP 阻断普通聊天启动。

网页左侧“应用中心”可查看连接、工具与最近故障，并切换强制监控。ON：Gateway 不可用则拒绝应用调用。OFF：仍优先 Gateway，故障时允许路由器使用用户自己的授权直连，并标明未监控。独立工作台不依赖 Gateway，因此离线时仍能关闭开关。此约束覆盖本项目管理的 MCP 路由，不能阻止任意脚本、浏览器或其他连接器访问数据。
