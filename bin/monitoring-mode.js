import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMonitoringMode, writeMonitoringMode } from '../src/setup/monitoring_mode.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'applications/agent-routing/monitoring.json');
const mode = process.argv[2] ?? 'status';
if (!['on', 'off', 'status'].includes(mode)) { console.error('Choose on, off, or status'); process.exitCode = 2; }
else {
  const result = mode === 'status' ? readMonitoringMode(file) : writeMonitoringMode(file, mode === 'on');
  console.log(result.enforce ? '强制监控：开启。网关不可用时拒绝应用调用；普通聊天仍可启动。' : '强制监控：关闭。优先网关；网关不可用时允许直连并标记未监控。');
  console.log('仅对已安装本平台应用路由器的 MCP 入口生效；开关不改客户端配置、不启动服务、不打开浏览器。');
  if (result.state === 'invalid') { console.error('开关文件损坏，按强制开启处理。运行 off 可显式解除。'); process.exitCode = 2; }
}
