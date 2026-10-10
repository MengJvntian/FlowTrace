# 账户与凭据

## 连接账户

从 [应用目录](../../applications/README.md) 选择应用，按对应 README 配置权限，再运行该应用的 `connect.bat`。连接需要的 Token、Secret 或邮箱授权码在本机输入。授权保存成功后，日常使用无需重复连接；遇到错误先检查 API、权限和令牌状态。

## 本机保存位置

| 类型 | 保存位置与用途 |
| --- | --- |
| Windows 应用连接配置 | `%LOCALAPPDATA%/mcp-cross-app-trace/*.credential.xml`，使用当前 Windows 用户的 DPAPI 保护；具体文件名见各应用 README |
| Google workspace-mcp 授权 | `%USERPROFILE%/.google_workspace_mcp/credentials-*`，每款应用使用自己的凭据目录 |
| 通用 HTTP OAuth 工具 | Windows：`%LOCALAPPDATA%/mcp-cross-app-trace/credentials.json`；Linux/macOS：`$XDG_CONFIG_HOME/mcp-cross-app-trace/credentials.json`，缺省为 `~/.config/mcp-cross-app-trace/credentials.json` |

Windows 通用 OAuth JSON 文件依赖用户目录的访问权限，不能等同于 DPAPI 加密文件。不要复制他人的凭据，也不要将这些文件放入项目目录。

## 通用 HTTP OAuth 工具

此入口用于需要 Bearer 令牌的远程 HTTP MCP，不替代各应用的连接脚本，也不能给 Google workspace-mcp 的 stdio 上游提供授权。

```sh
npm run oauth -- --help
npm run oauth -- --status
npm run oauth -- --logout
```

登录需使用自己的 OAuth 客户端、提供商端点与所需 scope。查看 `--help` 后配置 `--login`；`--no-browser` 可关闭自动打开浏览器。授权有效且含 refresh token 时可自动刷新，刷新失败须根据返回原因重新授权。

## 取消授权

先停用对应应用路由和上游，再到供应商后台撤销集成、Token 或 OAuth，最后删除对应本机凭据。通用工具的 `--logout` 只删除本机副本，不撤销云端访问。

Google 共用 OAuth 客户端时，撤销关联可能影响多款 Google 应用。具体步骤见 [各应用教程](../../applications/README.md) 和 [停用指南](DISCONNECT.md)。监控数据库和导出包含业务原文，取消授权不会删除历史数据。
