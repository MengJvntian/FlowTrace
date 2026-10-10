# 快速开始

安装 Node.js 24+，在根目录运行 npm ci，然后 npm run demo:view。Windows 可双击 start-demo.bat。打开 http://127.0.0.1:8788/ 查看虚构调用、任务与字段流向。

此入口是离线证据演示，不启动实时 Gateway。实时接收 Agent 操作用 npm run serve -- --no-open 或 start-monitor.bat，网页端口8787、Gateway端口8790；默认两个 Mock 上游，无需外部账户。

绑定真实账户与配置 Agent 的步骤见 [安装说明](INSTALL.md) 和 [应用目录](../../applications/README.md)。独立应用中心用 npm run workbench，Gateway 离线时也可操作监控开关。
