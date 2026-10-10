# 应用模块与账户绑定

提供以下十二款应用模块。每个应用的 README.md 分为“授权”和“取消授权”：说明权限、连接入口、服务端撤销、本机凭据清理及客户端路由停用。connect.bat 用于绑定自己的账户，check.bat 用于检查，application.json 是引用环境变量的通用 MCP 定义。

| 模块 | 应用 |
| --- | --- |
| google-gmail | [Gmail：授权与取消授权](google-gmail/README.md) |
| google-calendar | [Google Calendar：授权与取消授权](google-calendar/README.md) |
| google-docs | [Google Docs：授权与取消授权](google-docs/README.md) |
| google-drive | [Google Drive：授权与取消授权](google-drive/README.md) |
| google-sheets | [Google Sheets：授权与取消授权](google-sheets/README.md) |
| github | [GitHub：授权与取消授权](github/README.md) |
| gitee | [Gitee：授权与取消授权](gitee/README.md) |
| feishu | [飞书：授权与取消授权](feishu/README.md) |
| dingtalk | [钉钉：授权与取消授权](dingtalk/README.md) |
| tencent-docs | [腾讯文档：授权与取消授权](tencent-docs/README.md) |
| notion | [Notion：授权与取消授权](notion/README.md) |
| qq-mail | [QQ 邮箱：授权与取消授权](qq-mail/README.md) |

网页工作台左侧“应用中心”集中查看绑定、连接、工具和故障；npm run workbench 只启动独立页面，默认8789，Gateway离线时也可操作监控开关。账户密钥仍在本机绑定脚本输入，不经网页展示。

manage-apps.bat 提供本机应用教程、绑定/检查和启停菜单；启停生成本机 preferences.json，不删除云端授权。准备实际清单后启动实时Gateway，客户端路由入口在 agent-routing，始终保持可选连接。

首次安装见 [安装说明](../docs/user/INSTALL.md)，路由操作见 [Agent模块](agent-routing/README.md)，不再使用时见 [停用指南](../docs/user/DISCONNECT.md)。应用模块不携带账户授权；使用前需要绑定自己的账户。
