// AUTHENTICATION: password sign-in, TOTP MFA with recovery codes, server-side sessions,
// lockout, forced password change, session management and administrator resets.
//
// Session lifecycle
//   POST /api/auth/login        username + password  -> session cookie (HttpOnly, SameSite=Strict)
//   the session then has a "state" that limits what it can call:
//     MFA        -> POST /api/auth/mfa            (6-digit code or a recovery code)
//     MFA_SETUP  -> POST /api/auth/mfa/setup, /api/auth/mfa/confirm   (first sign-in when MFA is required)
//     PASSWORD   -> POST /api/auth/password       (temporary password issued by an administrator)
//     ACTIVE     -> everything the role allows
//   Idle timeout (default 30 min) and absolute lifetime (default 12 h) are enforced server-side.

import type { IncomingMessage } from 'node:http';
import type { Services, User, Role } from '../core/context.ts';
import { now, requirePermission } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import {
  hashPassword, hashPasswordSync, verifyPassword, passwordProblems, randomToken, sha256, hmac, encrypt, decrypt,
  newTotpSecret, verifyTotp, otpauthUri, newRecoveryCodes, randomPassword,
} from '../core/security.ts';
import { HttpError, badRequest, conflict, forbidden, notFound, validation } from '../lib/errors.ts';
import { requestChange, registerApplier } from './approvals.ts';

export type SessionState = 'MFA' | 'MFA_SETUP' | 'PASSWORD' | 'ACTIVE';

export interface SessionCtx {
  idHash: string;
  state: SessionState;
  expiresAt: string;
}

const MAX_MFA_FAILURES = 5;            // per session, then the session ends
const MFA_ACCOUNT_LOCK_AFTER = 10;     // consecutive wrong codes across sessions lock the account
/** Progressive lockout: 5 failures -> 1 min, then doubling, capped at 30 min. Short locks limit lock-out abuse. */
const lockMinutes = (failed: number) => (failed < 5 ? 0 : Math.min(30, 2 ** (failed - 5)));
const DEMO_PASSWORD = 'Seaport#Demo2026';
export const demoPassword = () => DEMO_PASSWORD;

export const cookieName = (svc: Services) => (svc.auth.secureCookies ? '__Host-sg_sid' : 'sg_sid');

function cookie(svc: Services, value: string, maxAgeSec: number) {
  return `${cookieName(svc)}=${value}; Path=/; HttpOnly; SameSite=Strict${svc.auth.secureCookies ? '; Secure' : ''}; Max-Age=${maxAgeSec}`;
}
const clearCookie = (svc: Services) => cookie(svc, '', 0);

export function readSessionToken(svc: Services, req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const name = cookieName(svc);
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      const token = v.join('=');
      return /^[A-Za-z0-9_-]{32,64}$/.test(token) ? token : null;
    }
  }
  return null;
}

export function clientIp(svc: Services, req: IncomingMessage): string {
  if (svc.auth.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
    if (first) return first.slice(0, 64);
  }
  return (req.socket.remoteAddress ?? 'unknown').slice(0, 64);
}

// ---------- rate limiting (per IP, in memory; nginx/WAF add a second layer in AWS) ----------

const attempts = new Map<string, number[]>();
function rateLimit(key: string, limit: number, windowMs: number) {
  const t = Date.now();
  const list = (attempts.get(key) ?? []).filter((x) => t - x < windowMs);
  if (list.length >= limit) {
    attempts.set(key, list);
    throw new HttpError(429, 'too_many_requests', 'Too many attempts. Wait a few minutes and try again.');
  }
  list.push(t);
  attempts.set(key, list);
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (!v.some((x) => t - x < windowMs)) attempts.delete(k);
}
export function resetRateLimits() { attempts.clear(); }

// ---------- session resolution (called by the HTTP layer on every request) ----------

function stateOf(svc: Services, u: any, mfaPassed: boolean): SessionState {
  if (u.mfa_enabled && !mfaPassed) return 'MFA';
  if (!u.mfa_enabled && svc.auth.mfaRequired) return 'MFA_SETUP';
  if (u.must_change_password) return 'PASSWORD';
  return 'ACTIVE';
}

export function resolveSession(svc: Services, token: string): { user: User; session: SessionCtx } | null {
  const idHash = sha256(token);
  const s = svc.db.get<any>('SELECT * FROM sessions WHERE id_hash = ?', [idHash]);
  if (!s || s.revoked_at) return null;
  const t = Date.now();
  if (Date.parse(s.expires_at) <= t) return null;
  if (t - Date.parse(s.last_seen_at) > svc.auth.idleMinutes * 60_000) {
    svc.db.run("UPDATE sessions SET revoked_at = ?, revoked_reason = 'idle timeout' WHERE id_hash = ?", [now(), idHash]);
    return null;
  }
  const u = svc.db.get<any>('SELECT * FROM users WHERE username = ? AND active = 1', [s.username]);
  if (!u) return null;
  if (t - Date.parse(s.last_seen_at) > 30_000) svc.db.run('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?', [now(), idHash]);
  return { user: { username: u.username, name: u.name, role: u.role as Role }, session: { idHash, state: stateOf(svc, u, !!s.mfa_passed), expiresAt: s.expires_at } };
}

function newSession(svc: Services, req: IncomingMessage, username: string, mfaPassed: boolean) {
  const token = randomToken(32);
  const ts = now();
  const expires = new Date(Date.now() + svc.auth.absoluteHours * 3600_000).toISOString();
  svc.db.run('INSERT INTO sessions (id_hash, username, mfa_passed, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)',
    [sha256(token), username, mfaPassed ? 1 : 0, ts, ts, expires, clientIp(svc, req), String(req.headers['user-agent'] ?? '').slice(0, 200)]);
  return { token, maxAge: svc.auth.absoluteHours * 3600 };
}

/** Replace the session id (after any privilege change) to defeat session fixation. */
function rotate(svc: Services, req: IncomingMessage, session: SessionCtx, username: string, mfaPassed: boolean) {
  svc.db.run("UPDATE sessions SET revoked_at = ?, revoked_reason = 'rotated' WHERE id_hash = ?", [now(), session.idHash]);
  return newSession(svc, req, username, mfaPassed);
}

const userRow = (svc: Services, username: string) => svc.db.get<any>('SELECT * FROM users WHERE username = ?', [username]);
const anon = (username: string): User => ({ username: `anonymous:${String(username).slice(0, 40)}`, name: 'Anonymous', role: 'VIEWER' });

function sessionView(svc: Services, username: string, state: SessionState) {
  const u = userRow(svc, username);
  return {
    authenticated: true, state,
    user: { username: u.username, name: u.name, role: u.role, mfa_enabled: !!u.mfa_enabled },
    mfa_required: svc.auth.mfaRequired,
  };
}

// ---------- endpoints ----------

export function config(svc: Services) {
  return { mode: svc.auth.mode, mfa_required: svc.auth.mfaRequired, idle_minutes: svc.auth.idleMinutes };
}

export function session(svc: Services, user: User | undefined, s: SessionCtx | undefined) {
  if (!user) return { authenticated: false, mode: svc.auth.mode };
  if (!s) return { authenticated: true, state: 'ACTIVE', user: { username: user.username, name: user.name, role: user.role, mfa_enabled: false }, mode: 'demo' };
  return { ...sessionView(svc, user.username, s.state), expires_at: s.expiresAt, idle_minutes: svc.auth.idleMinutes };
}

export async function login(svc: Services, req: IncomingMessage, body: any) {
  if (svc.auth.mode !== 'password') throw badRequest('Password sign-in is disabled in demo mode');
  const ip = clientIp(svc, req);
  rateLimit(`login:${ip}`, 10, 5 * 60_000);
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase().slice(0, 64) : '';
  const password = typeof body?.password === 'string' ? body.password.slice(0, 256) : '';
  if (!username || !password) throw validation({ username: 'required', password: 'required' });
  const u = userRow(svc, username);
  // One message for every failure: wrong password, unknown user, locked account.
  const fail = () => new HttpError(401, 'invalid_credentials', 'Incorrect username or password, or the account is temporarily locked. Try again in a few minutes.');
  const who = u ? username : 'unknown-user'; // never log what was typed for an unknown user (it may be a password)

  if (u?.locked_until && Date.parse(u.locked_until) > Date.now()) {
    await verifyPassword(password, null); // same cost as a real check
    audit.record(svc.db, anon(who), 'auth.login_blocked', 'user', who, { ip, reason: 'locked' });
    throw fail();
  }
  const ok = await verifyPassword(password, u?.active ? u.password_hash : null);
  if (!ok || !u?.active) {
    svc.db.tx(() => {
      if (u) {
        // Atomic increment: parallel failures cannot overwrite each other.
        const failed = svc.db.get<{ f: number }>('UPDATE users SET failed_logins = failed_logins + 1 WHERE username = ? RETURNING failed_logins f', [username])!.f;
        const mins = lockMinutes(failed);
        if (mins) {
          svc.db.run('UPDATE users SET locked_until = ? WHERE username = ?', [new Date(Date.now() + mins * 60_000).toISOString(), username]);
          audit.record(svc.db, anon(who), 'auth.locked', 'user', who, { ip, minutes: mins, failures: failed });
        }
      }
      audit.record(svc.db, anon(who), 'auth.login_failed', 'user', who, { ip });
    });
    throw fail();
  }
  return svc.db.tx(() => {
    svc.db.run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE username = ?', [now(), username]);
    const { token, maxAge } = newSession(svc, req, username, false);
    const state = stateOf(svc, u, false);
    audit.record(svc.db, { username, name: u.name, role: u.role }, 'auth.login', 'user', username, { ip, next: state });
    return { json: sessionView(svc, username, state), setCookie: cookie(svc, token, maxAge) };
  });
}

export function logout(svc: Services, user: User | undefined, s: SessionCtx | undefined) {
  if (s) {
    svc.db.run("UPDATE sessions SET revoked_at = ?, revoked_reason = 'logout' WHERE id_hash = ? AND revoked_at IS NULL", [now(), s.idHash]);
    if (user) audit.record(svc.db, user, 'auth.logout', 'user', user.username, {});
  }
  return { json: { ok: true }, setCookie: clearCookie(svc) };
}

const mfaFailures = new Map<string, number>();

export function verifyMfa(svc: Services, req: IncomingMessage, user: User, s: SessionCtx, body: any) {
  if (s.state !== 'MFA') throw conflict('No MFA challenge is pending for this session');
  rateLimit(`mfa:${clientIp(svc, req)}`, 20, 5 * 60_000);
  const u = userRow(svc, user.username);
  const code = String(body?.code ?? '').replace(/\s+/g, '').slice(0, 20);
  let accepted = false;
  if (/^\d{6}$/.test(code)) {
    const step = verifyTotp(decrypt(svc.appKey, u.mfa_secret), code, u.mfa_last_step ?? null);
    if (step !== null) {
      // Conditional update: two parallel requests cannot both use the same code.
      accepted = svc.db.run('UPDATE users SET mfa_last_step = ? WHERE username = ? AND (mfa_last_step IS NULL OR mfa_last_step < ?)', [step, u.username, step]).changes === 1;
    }
  } else if (/^[a-z2-7]{5}-?[a-z2-7]{5}$/i.test(code)) {
    const norm = code.toLowerCase().replace('-', '');
    const h = hmac(svc.appKey, `${u.username}:${norm.slice(0, 5)}-${norm.slice(5)}`);
    accepted = svc.db.run('UPDATE mfa_recovery_codes SET used_at = ? WHERE username = ? AND code_hash = ? AND used_at IS NULL', [now(), u.username, h]).changes === 1;
    if (accepted) audit.record(svc.db, user, 'auth.recovery_code_used', 'user', user.username, {
      remaining: svc.db.get<{ n: number }>('SELECT COUNT(*) n FROM mfa_recovery_codes WHERE username = ? AND used_at IS NULL', [u.username])!.n,
    });
  }
  if (!accepted) {
    const n = (mfaFailures.get(s.idHash) ?? 0) + 1;
    mfaFailures.set(s.idHash, n);
    // Persistent per-account counter: guessing across many sessions and IPs locks the account.
    const total = svc.db.get<{ f: number }>('UPDATE users SET mfa_failed = mfa_failed + 1 WHERE username = ? RETURNING mfa_failed f', [user.username])!.f;
    audit.record(svc.db, user, 'auth.mfa_failed', 'user', user.username, { ip: clientIp(svc, req), attempt: n, consecutive: total });
    if (total >= MFA_ACCOUNT_LOCK_AFTER) {
      svc.db.run("UPDATE users SET locked_until = ?, mfa_failed = 0 WHERE username = ?", [new Date(Date.now() + 30 * 60_000).toISOString(), user.username]);
      svc.db.run("UPDATE sessions SET revoked_at = ?, revoked_reason = 'mfa lockout' WHERE username = ? AND revoked_at IS NULL", [now(), user.username]);
      audit.record(svc.db, user, 'auth.locked', 'user', user.username, { reason: 'too many wrong MFA codes', minutes: 30 });
      throw new HttpError(401, 'mfa_failed', 'Too many incorrect codes. The account is locked for 30 minutes. Sign in again later.');
    }
    if (n >= MAX_MFA_FAILURES) {
      svc.db.run("UPDATE sessions SET revoked_at = ?, revoked_reason = 'mfa failures' WHERE id_hash = ?", [now(), s.idHash]);
      mfaFailures.delete(s.idHash);
      throw new HttpError(401, 'mfa_failed', 'Too many incorrect codes. Sign in again.');
    }
    throw new HttpError(401, 'mfa_failed', 'That code is not valid. Check your authenticator app and try again.');
  }
  mfaFailures.delete(s.idHash);
  svc.db.run('UPDATE users SET mfa_failed = 0 WHERE username = ?', [user.username]);
  return svc.db.tx(() => {
    const { token, maxAge } = rotate(svc, req, s, user.username, true);
    audit.record(svc.db, user, 'auth.mfa_passed', 'user', user.username, {});
    return { json: sessionView(svc, user.username, stateOf(svc, u, true)), setCookie: cookie(svc, token, maxAge) };
  });
}

export function setupMfa(svc: Services, user: User, s: SessionCtx | undefined) {
  if (!s) throw badRequest('MFA needs a signed-in session');
  const u = userRow(svc, user.username);
  if (u.mfa_enabled) throw conflict('MFA is already set up. Ask an administrator to reset it if you lost your device.');
  if (s.state !== 'MFA_SETUP' && s.state !== 'ACTIVE' && s.state !== 'PASSWORD') throw forbidden();
  const secret = newTotpSecret();
  svc.db.run('UPDATE users SET mfa_secret = ?, mfa_enabled = 0, mfa_last_step = NULL WHERE username = ?', [encrypt(svc.appKey, secret), user.username]);
  return { secret, otpauth_uri: otpauthUri(secret, user.username), issuer: 'Seaport Global', account: user.username };
}

export function confirmMfa(svc: Services, req: IncomingMessage, user: User, s: SessionCtx | undefined, body: any) {
  if (!s) throw badRequest('MFA needs a signed-in session');
  const u = userRow(svc, user.username);
  if (u.mfa_enabled) throw conflict('MFA is already set up');
  if (!u.mfa_secret) throw conflict('Start MFA setup first');
  const step = verifyTotp(decrypt(svc.appKey, u.mfa_secret), String(body?.code ?? '').replace(/\s+/g, ''), null);
  if (step === null) throw new HttpError(422, 'mfa_failed', 'That code is not valid. Check the time on your phone and try the next code.');
  const codes = newRecoveryCodes();
  return svc.db.tx(() => {
    svc.db.run('UPDATE users SET mfa_enabled = 1, mfa_last_step = ? WHERE username = ?', [step, user.username]);
    svc.db.run('DELETE FROM mfa_recovery_codes WHERE username = ?', [user.username]);
    for (const c of codes) svc.db.run('INSERT INTO mfa_recovery_codes (username, code_hash) VALUES (?,?)', [user.username, hmac(svc.appKey, `${user.username}:${c}`)]);
    audit.record(svc.db, user, 'auth.mfa_enabled', 'user', user.username, {});
    const { token, maxAge } = rotate(svc, req, s, user.username, true);
    return { json: { ...sessionView(svc, user.username, stateOf(svc, { ...u, mfa_enabled: 1 }, true)), recovery_codes: codes }, setCookie: cookie(svc, token, maxAge) };
  });
}

export async function changePassword(svc: Services, req: IncomingMessage, user: User, s: SessionCtx | undefined, body: any) {
  if (!s) throw badRequest('Password change needs a signed-in session');
  if (s.state !== 'PASSWORD' && s.state !== 'ACTIVE') throw forbidden();
  rateLimit(`pw:${user.username}`, 10, 15 * 60_000);
  const u = userRow(svc, user.username);
  const current = String(body?.current_password ?? '');
  const next = String(body?.new_password ?? '');
  if (!(await verifyPassword(current, u.password_hash))) {
    audit.record(svc.db, user, 'auth.password_change_failed', 'user', user.username, {});
    throw new HttpError(422, 'validation_error', 'Current password is incorrect', { current_password: 'incorrect' });
  }
  const problems = passwordProblems(next, u.username, u.name);
  if (current === next) problems.push('Choose a password you have not used here');
  if (problems.length) throw new HttpError(422, 'validation_error', problems.join('. '), { new_password: problems.join('. ') });
  const hash = await hashPassword(next);
  return svc.db.tx(() => {
    svc.db.run('UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE username = ?', [hash, now(), user.username]);
    svc.db.run("UPDATE sessions SET revoked_at = ?, revoked_reason = 'password changed' WHERE username = ? AND revoked_at IS NULL AND id_hash <> ?", [now(), user.username, s.idHash]);
    audit.record(svc.db, user, 'auth.password_changed', 'user', user.username, {});
    const mfaPassed = !!svc.db.get<any>('SELECT mfa_passed FROM sessions WHERE id_hash = ?', [s.idHash])?.mfa_passed;
    const { token, maxAge } = rotate(svc, req, s, user.username, mfaPassed);
    return { json: sessionView(svc, user.username, stateOf(svc, { ...u, must_change_password: 0 }, mfaPassed)), setCookie: cookie(svc, token, maxAge) };
  });
}

export function listSessions(svc: Services, user: User, s: SessionCtx | undefined) {
  return svc.db.all('SELECT id_hash, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions WHERE username = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC',
    [user.username, now()]).map((r) => ({ id: r.id_hash.slice(0, 16), current: r.id_hash === s?.idHash, created_at: r.created_at, last_seen_at: r.last_seen_at, ip: r.ip, user_agent: r.user_agent }));
}

export function revokeSession(svc: Services, user: User, id: string) {
  if (!/^[0-9a-f]{16}$/.test(id)) throw badRequest('Bad session id');
  const r = svc.db.run("UPDATE sessions SET revoked_at = ?, revoked_reason = 'revoked by user' WHERE username = ? AND substr(id_hash, 1, 16) = ? AND revoked_at IS NULL", [now(), user.username, id]);
  if (!r.changes) throw notFound('Session');
  audit.record(svc.db, user, 'auth.session_revoked', 'user', user.username, {});
  return { ok: true };
}

// ---------- administration ----------

/**
 * Credential resets are four-eyes: an administrator requests one, and a second administrator or
 * Compliance approves it. The one-time password goes to the APPROVER (who hands it to the user by
 * a separate channel), never to the requester. A reset account cannot approve anything for
 * RESET_COOLDOWN_HOURS, so a reset cannot be turned into a second pair of eyes.
 */
export function adminResetPassword(svc: Services, admin: User, username: string) {
  requirePermission(admin, 'users.manage');
  if (username === admin.username) throw forbidden('Use "Change password" for your own account');
  const u = userRow(svc, username);
  if (!u) throw notFound('User');
  return requestChange(svc, admin, { kind: 'USER_RESET_PASSWORD', entity_type: 'user', entity_id: username, summary: `Reset password for ${u.name} (${username})`, payload: {} });
}

export function adminResetMfa(svc: Services, admin: User, username: string) {
  requirePermission(admin, 'users.manage');
  if (username === admin.username) throw forbidden('Another administrator must reset your MFA');
  const u = userRow(svc, username);
  if (!u) throw notFound('User');
  return requestChange(svc, admin, { kind: 'USER_RESET_MFA', entity_type: 'user', entity_id: username, summary: `Reset two-step verification for ${u.name} (${username}) - verify identity first`, payload: {} });
}

registerApplier('USER_RESET_PASSWORD', (svc, approver, cr) => {
  const username = cr.entity_id;
  if (username === approver.username) throw forbidden('You cannot approve a reset of your own credentials');
  const temp = randomPassword();
  // scrypt is async; a synchronous variant keeps this inside the approval transaction.
  svc.db.run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL, credentials_reset_at = ? WHERE username = ?',
    [hashPasswordSync(temp), now(), username]);
  svc.db.run("UPDATE sessions SET revoked_at = ?, revoked_reason = 'password reset' WHERE username = ? AND revoked_at IS NULL", [now(), username]);
  audit.record(svc.db, approver, 'auth.password_reset', 'user', username, { requested_by: cr.requested_by, change_request: cr.ref });
  return { username, temporary_password: temp, note: 'Give this to the user through a separate channel. They must change it at first sign-in.' };
});

registerApplier('USER_RESET_MFA', (svc, approver, cr) => {
  const username = cr.entity_id;
  if (username === approver.username) throw forbidden('You cannot approve a reset of your own credentials');
  svc.db.run('UPDATE users SET mfa_secret = NULL, mfa_enabled = 0, mfa_last_step = NULL, mfa_failed = 0, credentials_reset_at = ? WHERE username = ?', [now(), username]);
  svc.db.run('DELETE FROM mfa_recovery_codes WHERE username = ?', [username]);
  svc.db.run("UPDATE sessions SET revoked_at = ?, revoked_reason = 'mfa reset' WHERE username = ? AND revoked_at IS NULL", [now(), username]);
  audit.record(svc.db, approver, 'auth.mfa_reset', 'user', username, { requested_by: cr.requested_by, change_request: cr.ref });
  return { username };
});


export function adminUnlock(svc: Services, admin: User, username: string) {
  requirePermission(admin, 'users.manage');
  if (!userRow(svc, username)) throw notFound('User');
  svc.db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE username = ?', [username]);
  audit.record(svc.db, admin, 'auth.unlocked', 'user', username, {});
  return { ok: true };
}

/**
 * Give users without a password one. Non-production: the documented demo password.
 * Production: a random one-time password printed to the console, to be changed at first sign-in.
 */
export async function ensurePasswords(svc: Services, onlyUsers: string[]): Promise<{ username: string; password: string }[]> {
  if (!onlyUsers.length) return [];
  const missing = svc.db.all<{ username: string }>(`SELECT username FROM users WHERE password_hash IS NULL AND active = 1 AND username IN (${onlyUsers.map(() => '?').join(',')})`, onlyUsers);
  const production = process.env.NODE_ENV === 'production';
  const issued: { username: string; password: string }[] = [];
  for (const { username } of missing) {
    const pw = production ? randomPassword() : DEMO_PASSWORD;
    svc.db.run('UPDATE users SET password_hash = ?, must_change_password = ? WHERE username = ?', [await hashPassword(pw), production ? 1 : 0, username]);
    issued.push({ username, password: pw });
  }
  return issued;
}

export const SESSION_PATHS: Record<SessionState, RegExp[]> = {
  ACTIVE: [/./],
  MFA: [/^\/api\/auth\/mfa$/],
  MFA_SETUP: [/^\/api\/auth\/mfa\/(setup|confirm)$/],
  PASSWORD: [/^\/api\/auth\/password$/, /^\/api\/auth\/mfa\/(setup|confirm)$/],
};
export const ALWAYS_PATHS = [/^\/api\/auth\/(session|logout|config)$/];
