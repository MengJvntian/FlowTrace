import fs from 'node:fs';
import path from 'node:path';
import { readApplicationCatalog, applyApplicationCatalog } from '../src/adapters/application_catalog.js';
const apps = readApplicationCatalog();
const preferencesPath = 'applications/preferences.json';
const preferences = fs.existsSync(preferencesPath) ? JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) : { disabled: [] };
const [mode = 'list', ...args] = process.argv.slice(2);
if (mode === 'list') {
  console.log(JSON.stringify(apps.map(app => ({ id: app.id, name: app.name, status: app.status,
    enabled: Boolean(app.upstream && !preferences.disabled.includes(app.id)), folder: path.resolve('applications', app.id) })), null, 2));
} else if (mode === 'enable' || mode === 'disable') {
  const app = apps.find(app => app.id === args[0]);
  if (!app?.upstream) throw new Error('Choose an implemented application ID');
  const disabled = new Set(preferences.disabled);
  if (mode === 'disable') disabled.add(app.id); else disabled.delete(app.id);
  const temp = preferencesPath + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ ...preferences, disabled: [...disabled].sort() }, null, 2) + '\n');
  fs.renameSync(temp, preferencesPath);
  console.log(`${app.name}: ${mode}. Reload the Gateway to apply; account credentials and history are retained.`);
} else if (mode === 'prepare') {
  const [source, target] = args;
  if (!source || !target) throw new Error('Specify source and target manifest paths');
  fs.writeFileSync(target, JSON.stringify(applyApplicationCatalog(JSON.parse(fs.readFileSync(source, 'utf8')), apps, preferences), null, 2) + '\n');
  console.log(`Prepared ${target} from the application catalogue; no authorization started.`);
} else throw new Error('Choose list, enable <id>, disable <id>, or prepare <source> <target>');
