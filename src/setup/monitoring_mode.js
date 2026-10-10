import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function readMonitoringMode(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || typeof value.enforce !== 'boolean') throw new Error('Invalid mode');
    return { enforce: value.enforce, state: 'saved' };
  } catch (error) {
    // Missing/corrupt state can never silently authorize bypass.
    return { enforce: true, state: error.code === 'ENOENT' ? 'default' : 'invalid' };
  }
}
export function writeMonitoringMode(file, enforce) {
  if (typeof enforce !== 'boolean') throw new TypeError('Choose a boolean mode');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, enforce, updated_at: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return readMonitoringMode(file);
}
