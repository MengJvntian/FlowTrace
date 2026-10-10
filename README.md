# FlowTrace

**跨应用智能体数据流监控工作台。** FlowTrace 将 Codex 与 DeepSeek Harness 的应用 MCP 调用接入统一 Gateway，记录读取、写入、失败与耗时，并在浏览器中展示任务、调用时间线和字段流向。你可以查看 Agent 从哪里读取信息、向哪个应用写入内容，并打开请求、响应和原文证据核对具体操作。

平台适合在自己的电脑上观察 Agent 的跨应用工作过程，例如邮件内容如何进入日历、仓库信息如何写入文档。监控记录保存在本机；真实应用使用你自己的账户授权。

## 功能

- **任务工作台**：任务命名、搜索、分组、建议分组与手动拆分合并。
- **调用时间线**：查看操作顺序、耗时、结果与完整请求响应，定位失败步骤。
- **字段流向**：展示跨应用字段关联、原文引用和匹配依据，区分已观测与推断。
- **应用中心**：查看账户绑定、连接、工具可用性、最近故障和工具定义变化。
- **强制监控开关**：开启后，网关不可用则拒绝应用操作；关闭后允许受管路由降级直连，并标记未监控。普通聊天保持可用。
- **大任务浏览**：分页、长正文按需展开；没有新数据时自动刷新保留页面与滚动位置。

## 快速开始

需要 **Node.js 24+** 和 **npm**。在项目根目录运行：

```sh
npm ci
npm run demo:view
```

打开 `http://127.0.0.1:8788/` 查看虚构邮件到日历的数据流演示，无需绑定账户。Windows 安装依赖后也可双击 `start-demo.bat`。

### 实时监控

```sh
npm run serve -- --no-open
```

工作台地址为 `http://127.0.0.1:8787/`，Gateway 为 `http://127.0.0.1:8790/`。Windows 对应入口是 `start-monitor.bat`。默认装载本地 Mock 邮件和日历；接入真实应用需绑定账户、装载对应清单并配置 Agent 路由，详见 [安装与启动](docs/user/INSTALL.md)。

### Gateway 离线时操作开关

运行 `npm run workbench` 或双击 `open-workbench.bat`，打开独立应用中心 `http://127.0.0.1:8789/applications.html`。这个入口不启动 Gateway，离线时也能关闭强制监控。

## 支持的应用

| 类别 | 应用 |
| --- | --- |
| 邮件与日历 | Gmail、QQ 邮箱、Google Calendar |
| 文档与表格 | Google Docs、Drive、Sheets、飞书、腾讯文档、Notion |
| 代码托管 | GitHub、Gitee |
| 办公协作 | 钉钉 |

各应用的前置条件、权限、授权与取消授权步骤见 [应用目录](applications/README.md)。部分应用需要自建应用或管理员权限；可用功能和配额以供应商账户实际权限为准。

## 使用说明

- [安装与启动](docs/user/INSTALL.md)：环境准备、演示、实时服务和真实应用加载。
- [任务与数据流](docs/user/task-workbench.md)：任务整理、时间线、字段关联和长正文。
- [连接 Agent](applications/agent-routing/README.md)：配置 Codex / DSH 受管路由。
- [强制监控开关](docs/user/MONITORING_SWITCH.md)：开关行为及离线恢复。
- [账户与凭据](docs/user/credentials.md)：本机保存位置和凭据管理。
- [停用与取消授权](docs/user/DISCONNECT.md)：停止服务、移除路由与撤销账户访问。
- [常见问题](docs/user/troubleshooting.md)：连接失败、404、授权和页面问题。

## 文件结构

以下列出主要目录和入口；应用目录内的额外脚本按各自需求组织。

```text
./
├── README.md                         项目介绍与使用导航
├── start-demo.bat                    Windows：打开虚构数据演示
├── start-monitor.bat                 Windows：启动实时 Gateway 和工作台
├── stop-monitor.bat                  Windows：停止受管后台服务（前台用 Ctrl+C）
├── open-workbench.bat                Windows：打开独立应用中心与故障恢复页面
├── package.json                      npm 命令、依赖与运行环境要求
├── package-lock.json                 固定依赖版本
├── trace.manifest.json               默认本地 Mock 邮件、日历清单
├── .gitignore                        本机数据、凭据与依赖的忽略规则
├── .gitattributes                    文本文件与换行规则
├── .npmrc                            npm 本地缓存设置
├── applications/                     应用接入模块
│   ├── README.md                     全部应用的授权与取消授权教程索引
│   ├── manage-apps.bat               查看、启用、停用应用的 Windows 菜单
│   ├── manage-apps.ps1               应用管理菜单实现
│   ├── reload.bat                    重载已配置的应用
│   ├── agent-routing/                Agent 路由、严格检查与监控开关入口
│   ├── _shared/                      共用的连接、检查与清单生成逻辑
│   ├── github/                       GitHub（单个模块结构示例）
│   │   ├── README.md                 授权与取消授权说明
│   │   ├── application.json          模块与上游定义
│   │   ├── connect.bat               连接自己的账户
│   │   └── check.bat                 检查连接
│   ├── google-gmail/                 Gmail
│   ├── google-calendar/              Google Calendar
│   ├── google-docs/                  Google Docs
│   ├── google-drive/                 Google Drive
│   ├── google-sheets/                Google Sheets
│   ├── feishu/                       飞书
│   ├── tencent-docs/                 腾讯文档
│   ├── dingtalk/                     钉钉
│   ├── notion/                       Notion
│   ├── gitee/                        Gitee
│   └── qq-mail/                      QQ 邮箱
├── docs/                             用户文档
│   ├── README.md                     文档索引
│   ├── route-a-runbook.md            Google Cloud 与 OAuth 配置
│   └── user/                         安装、工作台、账户、开关与故障排查
├── src/                              程序实现
│   ├── gateway/                      MCP 转发与监控采集
│   ├── collector/                    事件、调用配对与数据库存储
│   ├── lineage/                      字段提取、匹配与流向分析
│   ├── adapters/                     应用适配与工具语义
│   ├── credentials/                  OAuth 存储与刷新
│   ├── setup/                        Agent 配置识别与路由安装
│   ├── web/                          工作台后端和浏览器界面
│   ├── cli/                          本机记录查询与导出
│   ├── demo/                         虚构数据演示
│   ├── mock_servers/                 本地 Mock 邮件、日历服务
│   └── shared/                       公共工具
├── bin/                              服务与命令行入口
│   ├── serve.js                      统一启动、停止服务
│   ├── trace-manager.js              管理上游与 Agent 网关路由
│   ├── web.js                        网页服务
│   ├── application-routing.js        准备、检查、安装客户端路由
│   ├── application-router.js         按监控模式转发调用
│   ├── monitoring-mode.js            查看与切换监控开关
│   └── trace.js                      查询与导出记录
├── tools/                            本机启动、连接、管理与诊断工具
│   ├── node.js                       Node.js 运行时检查
│   ├── start-demo.js                 生成演示数据并启动页面
│   ├── open-workbench.js             独立工作台入口
│   ├── start-next-apps.ps1           加载已连接应用并启动服务
│   └── application-catalog.js        管理应用启用状态与清单
├── config/manifests/                 Google 和 GitHub 的通用清单示例
└── dsh-bundle-mcp-trace/             DSH 可选 Mock 连接示例及使用说明
```

安装和运行后会生成 `node_modules/`（依赖）、`.npm-cache/`（下载缓存）、`demo-data/`（本机数据库、日志和导出）、`trace.manifest.applications.json`（实际应用清单）以及应用偏好、路由状态和工具缓存。它们无需手动创建，也不会随仓库提供。

## 监控与数据边界

监控覆盖经过本项目受管路由或 Gateway 的 MCP 调用，不覆盖任意浏览器、终端或其他连接器的访问。字段匹配展示观测和推断依据，不能单独证明 Agent 的业务意图或因果关系。

应用连接须保持 **Codex `required=false`、DSH `failOnStartupError=false`**。强制监控限制应用调用，不能将应用连接设成普通聊天启动的必需服务。

工作台可显示完整业务原文。数据库、日志和导出需要由你自行保管；关闭网页不会撤销账户授权。移除账户时请按对应应用教程同时处理路由、本机凭据与供应商授权。
