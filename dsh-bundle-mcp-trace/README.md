# DSH MCP 连接示例

这是可移植的本地 Mock Mail / Calendar 配置 bundle，端点指向127.0.0.1:8790/dsh。先启动根目录默认 Gateway，再按 DSH 客户端的本地 bundle 安装方式加载本目录。

真实应用不要复制旧机器的绝对路径或备份：使用 bin/application-routing.js prepare/apply 为当前机器生成片段，详见 [路由教程](../applications/agent-routing/README.md)。所有条目 failOnStartupError=false，应用离线不应阻断会话。

示例本身不提供真实应用授权、不启动 Gateway、不安装或修改用户 profile。
