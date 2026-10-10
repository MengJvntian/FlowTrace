// Independent local viewer, with a visible console. No Gateway or OAuth startup.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7) ?? 8789);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const address = `http://127.0.0.1:${port}`;
let existing = false;
try { const response = await fetch(address + '/api/meta', { signal: AbortSignal.timeout(1000) }); existing = response.ok && (await response.json()).service.read_only === true; } catch { /* Gateway is not consulted. */ }
if (!existing) {
  const child = spawn(process.execPath, ['bin/web.js', '--db=demo-data/events.db', `--port=${port}`, '--retention-days=0'], { cwd: root, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 0; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
  for (let i = 0; i < 40 && child.exitCode === null; i++) {
    try { const response = await fetch(address + '/api/meta', { signal: AbortSignal.timeout(500) }); if (response.ok) { existing = true; break; } } catch { /* Local startup wait. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
if (existing) {
  console.log('Independent workbench: ' + address + '/applications.html');
  console.log('Gateway is not started. Keep this window open; Ctrl+C stops only this viewer.');
  if (!process.argv.includes('--no-open')) spawn('explorer.exe', [address + '/applications.html'], { stdio: 'ignore' });
} else { console.error('Independent viewer unavailable. Check the local port and dependencies.'); process.exitCode = 1; }
