// Administration CLI for operators with shell access to the server (bootstrap and break-glass).
//
//   npm run admin -- create-user <username> <ROLE> "<Full Name>" [email]   first administrator, or any user
//   npm run admin -- reset-password <username>                          new one-time password
//   npm run admin -- reset-mfa <username>                               clears MFA so the user enrols again
//   npm run admin -- unlock <username>
//   npm run admin -- list-users
//
// Every action is written to the audit trail as actor "cli:<os user>". Temporary passwords are
// printed once and must be changed at first sign-in.

import { join } from 'node:path';
import { userInfo } from 'node:os';
import { createServices, ROOT } from './app.ts';
import { ROLES, now, type User } from './core/context.ts';
import * as audit from './core/audit.ts';
import { hashPassword, randomPassword } from './core/security.ts';
import type { EngineClient } from './integrations/engine.ts';

const [cmd, ...args] = process.argv.slice(2);
const offline = new Proxy({}, { get: () => () => { throw new Error('engine not available in the admin CLI'); } }) as EngineClient;
const svc = createServices({ dbPath: process.env.DB_PATH ?? join(ROOT, 'data', 'seaport.db'), engine: offline, filesDir: process.env.FILES_DIR ?? join(ROOT, 'data', 'files') });
const actor: User = { username: `cli:${userInfo().username}`, name: 'Command line', role: 'SYSTEM' };
const die = (msg: string) => { console.error(msg); process.exit(1); };
const user = (u?: string) => {
  if (!u) die('username required');
  const row = svc.db.get<any>('SELECT * FROM users WHERE username = ?', [u!]);
  if (!row) die(`No user ${u}`);
  return row;
};

async function temporaryPassword(username: string) {
  const pw = randomPassword();
  svc.db.run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE username = ?', [await hashPassword(pw), username]);
  svc.db.run("UPDATE sessions SET revoked_at = ?, revoked_reason = 'cli reset' WHERE username = ? AND revoked_at IS NULL", [now(), username]);
  return pw;
}

switch (cmd) {
  case 'create-user': {
    const [username, role, name, email] = args;
    if (!username || !/^[a-z][a-z0-9._-]{2,30}$/.test(username)) die('username: lower-case letters, digits . _ - (3-31 characters)');
    if (!ROLES.some((r) => r.role === role)) die(`role must be one of ${ROLES.map((r) => r.role).join(', ')}`);
    if (!name) die('full name required');
    if (svc.db.get('SELECT 1 FROM users WHERE username = ?', [username])) die('user already exists');
    svc.db.run('INSERT INTO users (username, name, email, role, active, must_change_password, created_at) VALUES (?,?,?,?,1,1,?)', [username, name, email ?? null, role, now()]);
    const pw = await temporaryPassword(username);
    audit.record(svc.db, actor, 'user.created', 'user', username, { role, name, via: 'cli' });
    console.log(`Created ${username} (${role}). One-time password: ${pw}\nThe user must change it and set up MFA at first sign-in.`);
    break;
  }
  case 'reset-password': {
    const u = user(args[0]);
    const pw = await temporaryPassword(u.username);
    audit.record(svc.db, actor, 'auth.password_reset', 'user', u.username, { via: 'cli' });
    console.log(`One-time password for ${u.username}: ${pw}`);
    break;
  }
  case 'reset-mfa': {
    const u = user(args[0]);
    svc.db.run('UPDATE users SET mfa_secret = NULL, mfa_enabled = 0, mfa_last_step = NULL WHERE username = ?', [u.username]);
    svc.db.run('DELETE FROM mfa_recovery_codes WHERE username = ?', [u.username]);
    svc.db.run("UPDATE sessions SET revoked_at = ?, revoked_reason = 'cli mfa reset' WHERE username = ? AND revoked_at IS NULL", [now(), u.username]);
    audit.record(svc.db, actor, 'auth.mfa_reset', 'user', u.username, { via: 'cli' });
    console.log(`MFA cleared for ${u.username}; they will set it up again at next sign-in.`);
    break;
  }
  case 'unlock': {
    const u = user(args[0]);
    svc.db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE username = ?', [u.username]);
    audit.record(svc.db, actor, 'auth.unlocked', 'user', u.username, { via: 'cli' });
    console.log(`Unlocked ${u.username}`);
    break;
  }
  case 'list-users':
    for (const u of svc.db.all('SELECT username, role, active, mfa_enabled, must_change_password, last_login_at FROM users ORDER BY username')) {
      console.log(`${u.username.padEnd(16)} ${u.role.padEnd(12)} ${u.active ? 'active  ' : 'inactive'} mfa:${u.mfa_enabled ? 'on ' : 'off'} ${u.must_change_password ? 'temp-password ' : ''}${u.last_login_at ?? ''}`);
    }
    break;
  default:
    console.log('Usage: npm run admin -- create-user|reset-password|reset-mfa|unlock|list-users ...');
    process.exit(cmd ? 1 : 0);
}
svc.db.close();
