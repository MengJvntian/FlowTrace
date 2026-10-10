# 连接 Agent 与任务标签

按 [Agent 路由模块](../../applications/agent-routing/README.md) 准备、检查并安装本机路由。先启动所选应用的 Gateway，确认工具可用，再安装入口并重载客户端；已有应用授权无需重复申请。

## Agent 归属

Gateway 在普通上游路径前提供两组客户端接入口：

| 客户端 | URL 示例 | 记录标签 |
| --- | --- | --- |
| Codex | `http://127.0.0.1:8790/codex/gmail/mcp` | `codex` |
| DeepSeek Harness | `http://127.0.0.1:8790/dsh/gmail/mcp` | `deepseek_harness` |

上述真实应用端点需在实际清单中装载后才能使用。默认 Mock 邮件对应 `/codex/mail/mcp` 或 `/dsh/mail/mcp`。清单中的上游 `path` 始终不带 Agent 前缀，例如 `/gmail/mcp`；两组入口复用同一个上游。

Agent 标签根据接入口产生，不是身份认证。不要用另一客户端的入口，否则记录会归属到错误的 Agent。

## 区分任务

HTTP 请求可带 `X-Trace-Task`，取值为 1–80 个字母、数字、下划线或连字符。同一客户端、同一运行中，不同应用使用相同任务值，可归入同一任务以分析跨应用字段流动。未提供编号时按客户端运行记录，工作台可提供推断分组及手动整理。

## 启动与恢复

所有应用连接保持 Codex `required=false`、DSH `failOnStartupError=false`，应用故障不应阻断普通聊天。强制监控使用本项目的应用调用开关，详见 [开关说明](MONITORING_SWITCH.md)。配置变更后须重载客户端；修改文件不会更新当前聊天已加载的工具列表。
