// APPROVALS: maker-checker for reference data that drives money.
//
// Changes to programs, obligors (limits, advance rates, pricing), benchmark fixings, FX rates,
// beneficiary bank accounts and user access are not applied when submitted. They become a
// change request that a second, authorised person approves (never the requester). Limits above
// delegated credit authority need the credit committee (ADMIN). When approved, the change is
// re-validated against the record as it is then (a record changed in the meantime is refused).

import type { Services, User } from '../core/context.ts';
import { can, now, nextRef, requirePermission, ROLES } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { emit } from '../core/outbox.ts';
import { conflict, forbidden, notFound, validation } from '../lib/errors.ts';
import { fxToUsd } from './exposure.ts';
import { assertNotRecentlyReset } from '../core/cooldown.ts';

export type ChangeKind =
  | 'PROGRAM_CREATE' | 'PROGRAM_UPDATE' | 'OBLIGOR_CREATE' | 'OBLIGOR_UPDATE'
  | 'FX_RATE' | 'RATE_FIXING' | 'BANK_ACCOUNT_CREATE' | 'BANK_ACCOUNT_UPDATE'
  | 'USER_CREATE' | 'USER_UPDATE' | 'USER_RESET_PASSWORD' | 'USER_RESET_MFA';

/** Who may approve each kind. The requester can never approve their own request. */
export const APPROVER: Record<ChangeKind, string> = {
  PROGRAM_CREATE: 'master.approve', PROGRAM_UPDATE: 'master.approve',
  OBLIGOR_CREATE: 'master.approve', OBLIGOR_UPDATE: 'master.approve',
  FX_RATE: 'rates.approve', RATE_FIXING: 'rates.approve',
  BANK_ACCOUNT_CREATE: 'payments.accounts.approve', BANK_ACCOUNT_UPDATE: 'payments.accounts.approve',
  USER_CREATE: 'users.approve', USER_UPDATE: 'users.approve', USER_RESET_PASSWORD: 'users.approve', USER_RESET_MFA: 'users.approve',
};

type Applier = (svc: Services, approver: User, cr: any, payload: any) => unknown;
const appliers = new Map<ChangeKind, Applier>();
/** Each owning module registers how its change kinds are applied. */
export function registerApplier(kind: ChangeKind, fn: Applier) { appliers.set(kind, fn); }

export function requestChange(svc: Services, user: User, c: {
  kind: ChangeKind; entity_type: string; entity_id?: string | number | null; summary: string; payload: unknown; before?: unknown; reason?: string; requires_role?: string | null;
}) {
  const pending = c.entity_id != null && svc.db.get('SELECT ref FROM change_requests WHERE kind = ? AND entity_type = ? AND entity_id = ? AND status = ?',
    [c.kind, c.entity_type, String(c.entity_id), 'PENDING']);
  if (pending) throw conflict(`A change to this record is already awaiting approval (${(pending as any).ref}). Approve, reject or cancel it first.`);
  return svc.db.tx(() => {
    const ref = nextRef(svc.db, 'CR', 6);
    const r = svc.db.run(`INSERT INTO change_requests (ref, kind, entity_type, entity_id, summary, payload, before, reason, requires_role, status, requested_by, requested_at)
      VALUES (?,?,?,?,?,?,?,?,?, 'PENDING', ?, ?)`, [ref, c.kind, c.entity_type, c.entity_id == null ? null : String(c.entity_id), c.summary.slice(0, 300),
      JSON.stringify(c.payload), c.before === undefined ? null : JSON.stringify(c.before), c.reason?.slice(0, 1000) ?? null, c.requires_role ?? null, user.username, now()]);
    audit.record(svc.db, user, 'change.requested', 'change_request', r.id, { ref, kind: c.kind, entity_type: c.entity_type, entity_id: c.entity_id ?? null, summary: c.summary });
    emit(svc.db, 'change.requested', 'change_request', r.id, { ref, kind: c.kind, summary: c.summary });
    return {
      status: 202,
      json: { pending_approval: true, change_request: { id: r.id, ref, kind: c.kind, summary: c.summary },
        message: `Submitted for approval as ${ref}. It takes effect when ${c.requires_role === 'ADMIN' ? 'the credit committee' : 'a second authorised user'} approves it.` },
    };
  });
}

const VIEW_PERMS = ['master.edit', 'master.approve', 'master.rates', 'rates.approve', 'payments.accounts', 'payments.accounts.approve', 'users.manage', 'users.approve', 'reports.regulatory'];

export function listChanges(svc: Services, user: User, query: URLSearchParams) {
  if (!VIEW_PERMS.some((p) => can(user, p))) return [];
  const status = query.get('status') ?? 'PENDING';
  const rows = svc.db.all(`SELECT c.*, u.name AS requested_by_name, d.name AS decided_by_name FROM change_requests c
    LEFT JOIN users u ON u.username = c.requested_by LEFT JOIN users d ON d.username = c.decided_by
    WHERE (? = 'ALL' OR c.status = ?) ORDER BY c.id DESC LIMIT 200`, [status, status]);
  return rows.map((r) => {
    const kind = r.kind as ChangeKind;
    const approverOk = can(user, APPROVER[kind]) && (!r.requires_role || user.role === r.requires_role);
    return {
      ...r, payload: redact(JSON.parse(r.payload)), before: r.before ? redact(JSON.parse(r.before)) : null,
      can_approve: r.status === 'PENDING' && r.requested_by !== user.username && approverOk,
      can_cancel: r.status === 'PENDING' && r.requested_by === user.username,
      approver_permission: APPROVER[kind],
    };
  });
}

/** Bank account and routing numbers are never sent to the browser in full. */
function redact(o: any) {
  if (!o || typeof o !== 'object') return o;
  const out = { ...o };
  const mask = (s: any) => (typeof s === 'string' && s.length > 4 ? `••••${s.slice(-4)}` : s);
  for (const k of ['account_number', 'iban', 'routing_number']) if (k in out) out[k] = mask(out[k]);
  delete out.password_hash; delete out.mfa_secret;
  return out;
}

export function pendingCount(svc: Services, user: User) {
  return listChanges(svc, user, new URLSearchParams({ status: 'PENDING' })).filter((c) => c.can_approve).length;
}

export function decideChange(svc: Services, user: User, id: number, body: any) {
  const cr = svc.db.get<any>('SELECT * FROM change_requests WHERE id = ?', [id]);
  if (!cr) throw notFound('Change request');
  const decision = body?.decision;
  if (decision !== 'APPROVE' && decision !== 'REJECT') throw validation({ decision: 'APPROVE or REJECT' });
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 1000) : '';
  if (decision === 'REJECT' && !note) throw validation({ note: 'give a reason for rejecting' });
  requirePermission(user, APPROVER[cr.kind as ChangeKind]);
  if (cr.requested_by === user.username) throw forbidden('Four-eyes: you cannot approve or reject your own change request');
  if (decision === 'APPROVE') assertNotRecentlyReset(svc, user);
  if (decision === 'APPROVE' && cr.requires_role && user.role !== cr.requires_role) {
    throw forbidden(cr.requires_role === 'ADMIN' ? 'This change exceeds delegated credit authority and needs the credit committee (SoD-7)' : `Needs a ${cr.requires_role} approver`);
  }
  return svc.db.tx(() => {
    // Conditional transition: a request can be decided once, even under concurrent clicks.
    const moved = svc.db.run(`UPDATE change_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'PENDING'`,
      [decision === 'APPROVE' ? 'APPLIED' : 'REJECTED', user.username, now(), note || null, id]).changes;
    if (!moved) throw conflict(`Change request is already ${svc.db.get<any>('SELECT status FROM change_requests WHERE id = ?', [id])!.status}`);
    let result: unknown = null;
    if (decision === 'APPROVE') {
      const apply = appliers.get(cr.kind);
      if (!apply) throw new Error(`No applier for ${cr.kind}`);
      result = apply(svc, user, cr, JSON.parse(cr.payload));
    }
    audit.record(svc.db, user, decision === 'APPROVE' ? 'change.approved' : 'change.rejected', 'change_request', id,
      { ref: cr.ref, kind: cr.kind, entity_type: cr.entity_type, entity_id: cr.entity_id, requested_by: cr.requested_by, note: note || null });
    emit(svc.db, decision === 'APPROVE' ? 'change.approved' : 'change.rejected', 'change_request', id, { ref: cr.ref, summary: cr.summary });
    return { ok: true, status: decision === 'APPROVE' ? 'APPLIED' : 'REJECTED', result };
  });
}

export function cancelChange(svc: Services, user: User, id: number) {
  const cr = svc.db.get<any>('SELECT * FROM change_requests WHERE id = ?', [id]);
  if (!cr) throw notFound('Change request');
  if (cr.requested_by !== user.username) throw forbidden('Only the requester can withdraw a change request');
  return svc.db.tx(() => {
    if (!svc.db.run("UPDATE change_requests SET status = 'CANCELLED', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'PENDING'", [user.username, now(), id]).changes) {
      throw conflict('Change request is no longer pending');
    }
    audit.record(svc.db, user, 'change.cancelled', 'change_request', id, { ref: cr.ref });
    return { ok: true };
  });
}

/** The record must still look as it did when the change was requested. */
export function assertUnchanged(current: any, cr: any, fields: string[]) {
  if (!cr.before) return;
  const before = JSON.parse(cr.before);
  const drift = fields.filter((f) => f in before && String(current?.[f] ?? '') !== String(before[f] ?? ''));
  if (drift.length) throw conflict(`The record changed after this request was raised (${drift.join(', ')}). Reject it and raise a new request.`);
}

/** Credit limits above delegated authority need the committee. Unknown FX fails closed. */
export function limitNeedsCommittee(svc: Services, limitCents: number, currency: string, authorityUsdCents: number) {
  const usd = fxToUsd(svc.db)(limitCents, currency);
  if (!Number.isFinite(usd)) return true;
  return usd > authorityUsdCents;
}

export const ALL_ROLES = ROLES.map((r) => r.role);
