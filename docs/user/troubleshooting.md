# 常见问题

## 演示中Gateway离线

start-demo只生成并展示虚构数据，不启动实时Gateway，并隔离真实账户。这是预期行为。要接收Agent调用运行start-monitor或npm run serve；两者区别见 [安装说明](INSTALL.md)。

## Node或依赖缺失

安装Node.js24+，在项目根目录运行npm ci。Windows执行策略阻止npm.ps1时用npm.cmd，不要关闭安全软件或设置Bypass。仓库不包含node_modules和捆绑运行时。

## 工具不可用或404

确认实际Gateway清单声明了该应用，路径不带/codex或/dsh前缀，再查看上游就绪、tools/list和账户权限。应用目录存在并不等于端点已挂载。只为已准备应用生成路由，变更后重载客户端。

## Agent无法启动普通聊天

检查应用是否被误设required=true/failOnStartupError=true，改回可选。强制监控应发生在应用调用阶段；Gateway故障时可通过独立工作台关闭开关。

## 授权后还报错

先区分令牌保存、API启用、授权scope、工具发现与实际业务权限。已成功保存授权不应反复OAuth。Google各应用使用独立credentials-*目录，首次安装还需缓存固定workspace-mcp版本。

## 页面没有新数据

确认Agent调用经过目标Gateway、本机数据库路径一致、任务与筛选正确。无变化时自动刷新保留DOM是正常行为；手动刷新会重新读取快照。
