import fs from 'node:fs';
import path from 'node:path';
export function readApplicationCatalog(directory = path.resolve('applications')) {
  const apps = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const file = path.join(directory, entry.name, 'application.json');
    if (!fs.existsSync(file)) continue;
    const app = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!/^[a-z][a-z0-9-]*$/u.test(app.id) || app.id !== entry.name || typeof app.name !== 'string') throw new Error('Invalid application catalogue: ' + entry.name);
    if (app.upstream && (typeof app.upstream.serverName !== 'string' || typeof app.upstream.upstreamApp !== 'string')) throw new Error('Invalid application upstream: ' + app.id);
    apps.push(app);
  }
  const upstreams = apps.filter(app => app.upstream);
  for (const key of ['serverName', 'upstreamApp', 'gatewayId', 'path']) {
    const values = upstreams.map(app => app.upstream[key]);
    if (new Set(values).size !== values.length || values.some(value => typeof value !== 'string' || !value)) throw new Error('Duplicate or missing application ' + key);
  }
  return apps.sort((a, b) => a.id.localeCompare(b.id));
}
export function applyApplicationCatalog(manifest, apps, preferences = { disabled: [] }) {
  if (!Array.isArray(preferences.disabled) || preferences.disabled.some(id => typeof id !== 'string')) throw new Error('Invalid application preferences');
  const result = structuredClone(manifest);
  const active = new Set(manifest.upstreams.map(item => item.serverName));
  // Actual account modules are owned by the catalogue; demo servers remain separate.
  result.upstreams = manifest.upstreams.filter(item => item.upstreamApp?.startsWith('mock-'));
  for (const app of apps) {
    if (app.upstream && active.has(app.upstream.serverName) && !preferences.disabled.includes(app.id)) {
      result.upstreams.push(structuredClone(app.upstream));
    }
  }
  result._readme = 'Generated from applications/<app>/application.json and applications/preferences.json; only connected/selected modules start.';
  return result;
}
