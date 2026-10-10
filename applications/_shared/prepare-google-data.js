// Configuration only: keep separate OAuth stores and the user's disable choices.
import fs from 'node:fs';
const [source, target, selection = 'drive,sheets'] = process.argv.slice(2);
if (!source || !target) throw new Error('Specify source and target manifest paths');
const apps = selection.split(',');
if (!apps.length || apps.some(app => !['drive', 'sheets'].includes(app))) throw new Error('Choose drive or sheets');
const manifest = JSON.parse(fs.readFileSync(source, 'utf8'));
for (const app of new Set(apps)) {
  manifest.upstreams = manifest.upstreams.filter(item => item.serverName !== app);
  const moduleFile = `applications/google-${app}/application.json`;
  if (!fs.existsSync(moduleFile)) continue; // Removed modules must not prevent startup.
  const module = JSON.parse(fs.readFileSync(moduleFile, 'utf8'));
  manifest.upstreams.push(module.upstream);
}
fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared ${target}; no authorization or business calls started.`);
