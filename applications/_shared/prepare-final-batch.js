import fs from 'node:fs';
import { readApplicationCatalog } from '../../src/adapters/application_catalog.js';
import { withFinalBatch, FINAL_BATCH_IDS } from '../../src/adapters/final-batch.js';
const [mode, ...args] = process.argv.slice(2);
const selectionFile = 'applications/_shared/final-batch-selection.json';
if (mode === 'select') {
  const id = args[0];
  if (!FINAL_BATCH_IDS.includes(id)) throw new Error('Invalid application');
  const current = fs.existsSync(selectionFile) ? JSON.parse(fs.readFileSync(selectionFile, 'utf8')).apps : [];
  if (!Array.isArray(current) || current.some(item => !FINAL_BATCH_IDS.includes(item))) throw new Error('Invalid selection');
  const temporary = selectionFile + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ apps: [...new Set([...current, id])].sort() }, null, 2) + '\n');
  fs.renameSync(temporary, selectionFile);
  console.log('Selected ' + id + '; reload is a separate action.');
} else if (mode === 'prepare') {
  const [source, target, ids = ''] = args;
  if (!source || !target || source === target) throw new Error('Specify separate source and target manifests');
  const manifest = withFinalBatch(JSON.parse(fs.readFileSync(source, 'utf8')), readApplicationCatalog(), ids.split(',').filter(Boolean));
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(temporary, target);
  console.log('Prepared final batch manifest; no services or authorization started.');
} else throw new Error('Choose select <id> or prepare <source> <target> <ids>');
