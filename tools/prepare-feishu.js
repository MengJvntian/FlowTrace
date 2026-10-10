import fs from 'node:fs';
import { withFeishu } from '../src/adapters/feishu.js';
const source = process.argv[2] ?? 'config/manifests/trace.manifest.next-apps.json';
const target = process.argv[3] ?? 'config/manifests/trace.manifest.feishu.json';
fs.writeFileSync(target, JSON.stringify(withFeishu(JSON.parse(fs.readFileSync(source, 'utf8'))), null, 2) + '\n');
console.log(`Prepared ${target}; no services or authorization started.`);
