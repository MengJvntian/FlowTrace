// Local fictional-data demonstration. No OAuth or client configuration changes.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7) ?? 8788);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const result = spawnSync(process.execPath, ['bin/demo.js', '--mode=inproc', '--client-label=demo',
  '--db=demo-data/demo-view/events.db', '--calendar-store=demo-data/demo-view/calendar-events.json',
  '--evidence-out=demo-data/demo-view/report.json'], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
if (process.argv.includes('--generate-only')) process.exit(0);
const address = `http://127.0.0.1:${port}`;
const viewer = spawn(process.execPath, ['bin/web.js', '--db=demo-data/demo-view/events.db',
  `--port=${port}`, '--retention-days=0'], { cwd: root, stdio: 'inherit', env: { ...process.env, TRACE_DEMO_MODE: '1' } });
viewer.on('error', error => { console.error(error.message); process.exitCode = 1; });
viewer.on('exit', code => { process.exitCode = code ?? 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => viewer.kill());
console.log('Fictional-data viewer; live Gateway is not started. Ctrl+C stops this viewer.');
for (let i = 0; i < 40 && viewer.exitCode === null; i++) {
  try {
    const response = await fetch(address + '/api/meta', { signal: AbortSignal.timeout(500) });
    if (response.ok) {
      console.log('Open: ' + address);
      if (!process.argv.includes('--no-open') && process.platform === 'win32') spawn('explorer.exe', [address], { stdio: 'ignore' });
      break;
    }
  } catch { /* Wait for local viewer. */ }
  await new Promise(resolve => setTimeout(resolve, 250));
}
