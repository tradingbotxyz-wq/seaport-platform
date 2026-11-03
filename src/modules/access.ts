// USER ACCESS & SoD + PROFILE

import type { Services, User } from '../core/context.ts';
import { PERMISSIONS, SOD_RULES, ROLES as ROLE_LIST, requirePermission, can, now } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { check } from '../lib/validate.ts';
import { conflict, forbidden, notFound } from '../lib/errors.ts';

const ROLES = ROLE_LIST.map((r) => r.role);
const ROLE_LABELS: Record<string, string> = Object.fromEntries(ROLE_LIST.map((r) => [r.role, r.label]));

export function accessOverview(svc: Services) {
  const users = svc.db.all('SELECT username, name, email, role, active, created_at FROM users ORDER BY active DESC, name');
  const matrix = Object.entries(PERMISSIONS).map(([key, p]) => ({
    key, label: p.label,
    roles: Object.fromEntries(ROLES.map((r) => [r, r === 'ADMIN' || p.roles.includes(r as any)])),
  }));
  // Evidence that SoD held: funding approvals where approver != uploader, and any violations (should be zero).
  const approvals = svc.db.get<{ n: number; bad: number }>(
    "SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN approved_by = uploaded_by THEN 1 ELSE 0 END),0) bad FROM invoice_imports WHERE status = 'APPROVED'")!;
  const postings = svc.db.get<{ n: number; bad: number }>(
    `SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN b.resolved_by = s.uploaded_by THEN 1 ELSE 0 END),0) bad
     FROM bank_lines b JOIN bank_statements s ON s.id = b.statement_id WHERE b.match_status = 'POSTED'`)!;
  return {
    roles: ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r], users: users.filter((u) => u.role === r && u.active).length })),
    users: users.map((u) => ({ ...u, role_label: ROLE_LABELS[u.role] })),
    matrix,
    sod_rules: SOD_RULES,
    sod_evidence: [
      { rule: 'SOD-1', checked: approvals.n, violations: approvals.bad, description: 'Funding approvals by a different user than the uploader' },
      { rule: 'SOD-3', checked: postings.n, violations: postings.bad, description: 'Bank cash postings by a different user than the statement uploader' },
    ],
    recent_changes: svc.db.all("SELECT ts, actor, action, entity_id, details FROM audit_log WHERE action LIKE 'user.%' ORDER BY id DESC LIMIT 20")
      .map((r) => ({ ...r, details: JSON.parse(r.details) })),
  };
}

export function createUser(svc: Services, user: User, body: unknown) {
  requirePermission(user, 'users.manage');
  const input = check<any>(body, {
    username: { type: 'string', required: true, pattern: /^[a-z][a-z0-9._-]{2,30}$/ },
    name: { type: 'string', required: true, maxLength: 80 },
    email: { type: 'string', maxLength: 120, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ },
    role: { type: 'enum', required: true, values: ROLES },
  });
  return svc.db.tx(() => {
    if (svc.db.get('SELECT username FROM users WHERE username = ?', [input.username])) throw conflict('Username already exists');
    svc.db.run('INSERT INTO users (username, name, email, role, active, created_at) VALUES (?,?,?,?,1,?)', [input.username, input.name, input.email ?? null, input.role, now()]);
    audit.record(svc.db, user, 'user.created', 'user', input.username, input);
    return { status: 201, json: svc.db.get('SELECT username, name, email, role, active FROM users WHERE username = ?', [input.username]) };
  });
}

export function updateUser(svc: Services, user: User, username: string, body: any) {
  requirePermission(user, 'users.manage');
  if (username === user.username) throw forbidden('SoD: you cannot change your own access');
  const before = svc.db.get('SELECT username, name, email, role, active FROM users WHERE username = ?', [username]);
  if (!before) throw notFound('User');
  const input = check<any>({ role: before.role, active: !!before.active, ...body }, {
    role: { type: 'enum', required: true, values: ROLES },
    active: { type: 'bool', required: true },
  });
  return svc.db.tx(() => {
    svc.db.run('UPDATE users SET role = ?, active = ? WHERE username = ?', [input.role, input.active ? 1 : 0, username]);
    const admins = svc.db.get<{ n: number }>("SELECT COUNT(*) n FROM users WHERE role = 'ADMIN' AND active = 1")!.n;
    if (!admins) throw conflict('At least one active administrator is required');
    audit.record(svc.db, user, 'user.updated', 'user', username, { before, after: input });
    return svc.db.get('SELECT username, name, email, role, active FROM users WHERE username = ?', [username]);
  });
}

export function profile(svc: Services, user: User) {
  const full = svc.db.get('SELECT u.username, u.name, u.email, u.role, u.created_at, u.investor_id, i.code AS investor_code, i.name AS investor_name FROM users u LEFT JOIN investors i ON i.id = u.investor_id WHERE u.username = ?', [user.username]);
  return {
    ...full,
    role_label: ROLE_LABELS[user.role],
    permissions: Object.entries(PERMISSIONS).map(([key, p]) => ({ key, label: p.label, granted: can(user, key) })),
    activity: svc.db.all('SELECT ts, action, entity_type, entity_id FROM audit_log WHERE actor = ? ORDER BY id DESC LIMIT 25', [user.username]),
    notifications: svc.db.all('SELECT * FROM notifications WHERE audience = ? OR ? = \'ADMIN\' ORDER BY id DESC LIMIT 25', [user.role, user.role]),
  };
}

export function listUsersPublic(svc: Services) {
  return svc.db.all('SELECT username, name, role FROM users WHERE active = 1 ORDER BY name').map((u) => ({ ...u, role_label: ROLE_LABELS[u.role] }));
}
