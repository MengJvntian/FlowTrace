// Explicit deployment recovery when an obsolete PID file points at a dead mount.
// Never kill a process by port: require our exact gateway/manifest/DB fingerprint.
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd(), manifest = path.resolve('trace.manifest.applications.json');
const url = 'http://127.0.0.1:8790/healthz';
const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
const health = await response.json();
if (!response.ok || health.transport !== 'trace-manager' || path.resolve(health.manifest ?? '') !== manifest
  || path.resolve(health.db ?? '') !== path.join(root, 'demo-data/events.db')) throw new Error('Gateway identity mismatch; no stop signal written');
fs.writeFileSync('demo-data/serve.stop', 'controlled deployment stop\n');
let stopped = false;
for (let attempt = 0; attempt < 40; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 500));
  try { await fetch(url, { signal: AbortSignal.timeout(1000) }); }
  catch { stopped = true; break; }
}
if (!stopped) throw new Error('Graceful stop not confirmed; no process was killed');
console.log('Confirmed platform Gateway received graceful stop; no process was killed by port or stale PID.');
