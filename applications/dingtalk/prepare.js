import fs from 'node:fs';
import { DINGTALK_UPSTREAM } from '../../src/adapters/dingtalk.js';
const [source, target] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(source, 'utf8'));
manifest.upstreams = manifest.upstreams.filter(upstream => upstream.serverName !== 'dingtalk');
manifest.upstreams.push(structuredClone(DINGTALK_UPSTREAM));
fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n');
console.log('Prepared DingTalk manifest; no services or authorization started.');
