import fs from 'node:fs';
import { withDomesticDocs } from '../src/adapters/domestic-docs.js';
const source = process.argv[2] ?? 'config/manifests/trace.manifest.feishu.json';
const target = process.argv[3] ?? 'config/manifests/trace.manifest.domestic-docs.json';
const enabled = (process.argv[4] ?? 'tencent-docs').split(',').filter(Boolean);
fs.writeFileSync(target, JSON.stringify(withDomesticDocs(JSON.parse(fs.readFileSync(source, 'utf8')), enabled), null, 2) + '\n');
console.log(`Prepared ${target}; no services or authorization started.`);
