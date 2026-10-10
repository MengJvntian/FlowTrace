# Google 应用配置

本项目通过 workspace-mcp 接入 Gmail、Calendar、Docs、Drive 和 Sheets。每款应用使用独立授权目录；按对应 [应用教程](../applications/README.md) 连接账户。

## 准备环境和 Cloud 项目

1. 安装 Python 和 uv，确保终端能执行 `uvx`。
2. 运行 `uvx --from workspace-mcp==2.0.1 workspace-mcp --help`，准备固定版本缓存。本项目日常启动使用离线缓存。
3. 在自己的 Google Cloud 项目启用所需 API：Gmail API、Google Calendar API、Google Docs API、Google Drive API、Google Sheets API。Docs 读取也可能依赖 Drive API。
4. 配置 OAuth 同意页面和自己的 OAuth 客户端。外部应用处于测试模式时，将使用账户加入测试用户。
5. 按实际授权页面提示配置客户端类型和回调地址；不要将飞书回调或其他应用的配置直接套用到 Google。

## 连接与启动

1. 打开所需 Google 应用目录的 README，确认读写 scope 和 API 已配置。
2. 双击该目录 `connect.bat`，在本机输入自己的 OAuth Client ID、Secret 和账户，完成浏览器授权。
3. 返回终端完成账户检查；账户读取成功不等于所有业务工具均有权限。
4. 按 [安装说明](user/INSTALL.md) 加载实际应用清单，并按 [路由说明](../applications/agent-routing/README.md) 接入 Agent。

已有可用授权不需重新连接。`SERVICE_DISABLED` 应启用错误中指定 API；权限不足应核对 scope、同意页面与应用状态；令牌失效时再重新授权。

## 停用与取消授权

先停用应用和受管路由，再在 Google 账户的第三方连接页面撤销关联，最后删除对应本机凭据目录。共用 OAuth 客户端时撤销可能影响其他 Google 应用，具体范围和步骤见各应用 README。
