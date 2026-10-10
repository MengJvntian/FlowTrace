import fs from 'node:fs';
import path from 'node:path';
export function googleDataEmail() {
  const names = ['drive', 'sheets', 'gmail'].flatMap(app => {
    const dir = path.join(process.env.USERPROFILE, '.google_workspace_mcp', 'credentials-' + app);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^[^@\s]+@[^@\s]+\.json$/u.test(name)) : [];
  });
  const accounts = [...new Set(names.map(name => name.slice(0, -5)))];
  if (accounts.length !== 1) throw new Error('Expected one configured Google account');
  return accounts[0];
}
export function requireOwnGoogleDataCredential(app, email) {
  if (!['drive', 'sheets'].includes(app)) throw new Error('Unsupported data app');
  const file = path.join(process.env.USERPROFILE, '.google_workspace_mcp', 'credentials-' + app, email + '.json');
  if (!fs.existsSync(file)) throw new Error(`Run applications/google-${app}/connect.bat first; own app authorization is missing`);
  const credential = JSON.parse(fs.readFileSync(file, 'utf8'));
  const scopes = new Set(credential.scopes ?? []);
  const drive = 'https://www.googleapis.com/auth/drive';
  const sheet = 'https://www.googleapis.com/auth/spreadsheets';
  const authorized = app === 'drive' ? scopes.has(drive) || scopes.has(drive + '.readonly') : scopes.has(sheet);
  if (!authorized || !(credential.token || credential.refresh_token)) throw new Error(`Authorize ${app} using its own connect.bat`);
  // Only verify presence; the upstream owns refresh and use. Never export tokens.
}
