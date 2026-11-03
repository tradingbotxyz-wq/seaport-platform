// SERVICE: case management, amendments (four-eyes), delinquency tracking, late fees,
// per-loan sub-ledger and restructuring / workout analysis.

import type { Services, User } from '../core/context.ts';
import { assertNotRecentlyReset } from '../core/cooldown.ts';
import { requirePermission, can, now, nextRef, daysBetween, addDays } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { emit } from '../core/outbox.ts';
import { check } from '../lib/validate.ts';
import { badRequest, conflict, forbidden, notFound, validation } from '../lib/errors.ts';
import * as ledger from './ledger.ts';
import { createDistributionInternal } from './fund.ts';

export const SYSTEM: User = { username: 'system', name: 'System', role: 'SYSTEM' };
const SLA_HOURS: Record<string, number> = { URGENT: 4, HIGH: 24, MEDIUM: 72, LOW: 120 };
export const CASE_TYPES = ['DELINQUENCY', 'MATURITY_EXTENSION', 'PAYMENT_QUERY', 'DISPUTE', 'DILUTION', 'INVESTOR_REQUEST', 'TRANSFER', 'REDEMPTION', 'RESTRUCTURE', 'KYC_REFRESH', 'GENERAL'];
const BUCKETS: [number, string][] = [[0, 'Current'], [30, '1–30 days'], [60, '31–60 days'], [90, '61–90 days'], [Infinity, '90+ days']];

// ---------- Delinquency & late fees ----------

export async function delinquency(svc: Services) {
  const today = svc.today();
  const loans = svc.db.all(
    `SELECT l.*, o.name AS buyer, p.program_code, p.deal_name, p.day_count, p.late_margin_bps, i.invoice_number
     FROM loans l JOIN obligors o ON o.id = l.obligor_id JOIN programs p ON p.id = l.program_id JOIN invoices i ON i.id = l.invoice_id
     WHERE l.status = 'OPEN' ORDER BY l.maturity_date`);
  const pastDue = loans.filter((l) => l.maturity_date < today);
  const accrued = new Map<number, number>();
  const byProgram = new Map<string, any[]>();
  for (const l of pastDue) byProgram.set(l.program_code, [...(byProgram.get(l.program_code) ?? []), l]);
  for (const list of byProgram.values()) {
    const r = await svc.engine.lateCharges(today, list[0].day_count, list[0].late_margin_bps,
      list.map((l) => ({ id: l.id, shortfall_cents: l.face_cents - l.received_cents, base_bps: l.base_bps, maturity_date: l.maturity_date })));
    for (const it of r.items) accrued.set(it.id, it.charge_cents);
  }
  const openCases = new Map(svc.db.all("SELECT entity_id, ref FROM cases WHERE entity_type = 'loan' AND status NOT IN ('RESOLVED','REJECTED')").map((c) => [c.entity_id, c.ref]));
  const rows = loans.map((l) => {
    const dpd = Math.max(0, daysBetween(l.maturity_date, today));
    return {
      id: l.id, loan_ref: l.loan_ref, buyer: l.buyer, program_code: l.program_code, invoice_number: l.invoice_number, currency: l.currency,
      maturity_date: l.maturity_date, original_maturity_date: l.original_maturity_date, days_past_due: dpd,
      bucket: BUCKETS.find(([t]) => dpd <= t)![1], outstanding_cents: l.face_cents - l.received_cents,
      late_fee_accrued_cents: accrued.get(l.id) ?? 0, late_fee_posted_cents: l.late_fees_posted_cents,
      case_ref: openCases.get(l.id) ?? null,
    };
  });
  const buckets = BUCKETS.map(([, label]) => {
    const r = rows.filter((x) => x.bucket === label);
    return { bucket: label, count: r.length, by_currency: Object.entries(r.reduce((a: Record<string, number>, x) => ({ ...a, [x.currency]: (a[x.currency] ?? 0) + x.outstanding_cents }), {})).map(([currency, cents]) => ({ currency, cents })) };
  });
  return { as_of: today, buckets, loans: rows.filter((r) => r.days_past_due > 0), unposted_fees: rows.filter((r) => r.late_fee_accrued_cents > r.late_fee_posted_cents).length };
}

/** Opens a delinquency case for each loan > 30 days past due without one (idempotent). */
export async function sweep(svc: Services) {
  const d = await delinquency(svc);
  let opened = 0;
  for (const l of d.loans) {
    if (l.days_past_due <= 30 || l.case_ref) continue;
    svc.db.tx(() => {
      openCase(svc, SYSTEM, {
        case_type: 'DELINQUENCY', priority: l.days_past_due > 60 ? 'URGENT' : 'HIGH', entity_type: 'loan', entity_id: l.id, source: 'SYSTEM',
        subject: `${l.loan_ref} ${l.buyer} ${l.days_past_due} days past due`,
        description: `Outstanding ${l.currency} ${(l.outstanding_cents / 100).toLocaleString('en-US')} on ${l.invoice_number}, matured ${l.maturity_date}. Contact obligor, confirm payment date, consider extension or restructuring.`,
      });
    });
    opened++;
  }
  return { opened };
}

export async function postLateFees(svc: Services, user: User) {
  requirePermission(user, 'service.fees');
  const d = await delinquency(svc);
  const due = d.loans.filter((l) => l.late_fee_accrued_cents > l.late_fee_posted_cents);
  if (!due.length) return { posted: 0, total_by_currency: {} };
  const totals: Record<string, number> = {};
  const posted: string[] = [];
  svc.db.tx(() => {
    for (const l of due) {
      // Re-read inside the transaction: a concurrent run may already have posted these fees.
      const loan = svc.db.get<any>("SELECT program_id, late_fees_posted_cents FROM loans WHERE id = ? AND status = 'OPEN'", [l.id]);
      if (!loan) continue;
      const amount = l.late_fee_accrued_cents - loan.late_fees_posted_cents;
      if (amount <= 0) continue;
      const moved = svc.db.run('UPDATE loans SET late_fees_posted_cents = ?, fees_cents = fees_cents + ? WHERE id = ? AND late_fees_posted_cents = ?',
        [l.late_fee_accrued_cents, amount, l.id, loan.late_fees_posted_cents]).changes;
      if (moved !== 1) continue;
      ledger.post(svc.db, user, {
        date: svc.today(), description: `Late payment charge ${l.loan_ref} (${l.days_past_due} days past due)`, source_type: 'LATE_FEE', source_id: l.id, currency: l.currency,
        lines: [{ account: '1300', debit: amount, program_id: loan.program_id, loan_id: l.id }, { account: '4100', credit: amount, program_id: loan.program_id, loan_id: l.id }],
      });
      totals[l.currency] = (totals[l.currency] ?? 0) + amount;
      posted.push(l.loan_ref);
    }
    if (posted.length) audit.record(svc.db, user, 'late_fees.posted', 'loan', null, { loans: posted, totals });
  });
  return { posted: posted.length, total_by_currency: totals };
}

// ---------- Cases ----------

function openCase(svc: Services, user: User, c: { case_type: string; priority: string; subject: string; description?: string; entity_type?: string | null; entity_id?: number | null; source?: string; assignee?: string | null }) {
  const ref = nextRef(svc.db, 'CASE', 5);
  const ts = now();
  const sla = new Date(Date.now() + SLA_HOURS[c.priority] * 3600e3).toISOString();
  const { id } = svc.db.run(
    `INSERT INTO cases (ref, case_type, subject, description, entity_type, entity_id, priority, status, assignee, sla_due_at, source, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, 'OPEN', ?,?,?,?,?,?)`,
    [ref, c.case_type, c.subject, c.description ?? null, c.entity_type ?? null, c.entity_id ?? null, c.priority, c.assignee ?? null, sla, c.source ?? 'MANUAL', user.username, ts, ts]);
  event(svc, id, 'STATUS', `Opened (${c.priority}, SLA ${SLA_HOURS[c.priority]}h)`, user);
  audit.record(svc.db, user, 'case.opened', 'case', id, { ref, type: c.case_type, priority: c.priority, entity: c.entity_type ? `${c.entity_type}:${c.entity_id}` : null });
  emit(svc.db, 'case.opened', 'case', id, { id, ref, subject: c.subject, priority: c.priority });
  return { id, ref };
}

function event(svc: Services, caseId: number, kind: string, body: string, user: User) {
  svc.db.run('INSERT INTO case_events (case_id, kind, body, actor, at) VALUES (?,?,?,?,?)', [caseId, kind, body, user.username, now()]);
  svc.db.run('UPDATE cases SET updated_at = ? WHERE id = ?', [now(), caseId]);
}

export function listCases(svc: Services, user: User, query: URLSearchParams) {
  const where: string[] = [];
  const params: any[] = [];
  const status = query.get('status');
  if (status === 'open') where.push("c.status NOT IN ('RESOLVED','REJECTED')");
  else if (status) { where.push('c.status = ?'); params.push(status); }
  if (query.get('mine')) { where.push('c.assignee = ?'); params.push(user.username); }
  if (query.get('type')) { where.push('c.case_type = ?'); params.push(query.get('type')); }
  const nowIso = now();
  return svc.db.all(
    `SELECT c.*, u.name AS assignee_name,
       (SELECT COUNT(*) FROM amendments a WHERE a.case_id = c.id AND a.status = 'PROPOSED') AS pending_amendments
     FROM cases c LEFT JOIN users u ON u.username = c.assignee ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE c.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, c.sla_due_at LIMIT 500`, params)
    .map((c) => ({ ...c, sla_breached: !['RESOLVED', 'REJECTED'].includes(c.status) && c.sla_due_at < nowIso }));
}

export function createCase(svc: Services, user: User, body: unknown, viaPortal = false) {
  if (!viaPortal) requirePermission(user, 'service.cases');
  const input = check<any>(body, {
    case_type: { type: 'enum', required: true, values: CASE_TYPES },
    priority: { type: 'enum', required: true, values: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
    subject: { type: 'string', required: true, maxLength: 200 },
    description: { type: 'string', maxLength: 4000 },
    entity_type: { type: 'enum', values: ['loan', 'commitment', 'investor', 'program', 'obligor'] },
    entity_id: { type: 'int', min: 1 },
    assignee: { type: 'string', maxLength: 40 },
  });
  if (input.entity_type && !input.entity_id) throw validation({ entity_id: 'choose the record this case is about' });
  if (input.assignee && !svc.db.get('SELECT username FROM users WHERE username = ? AND active = 1', [input.assignee])) throw validation({ assignee: 'unknown user' });
  return svc.db.tx(() => ({ status: 201, json: openCase(svc, user, input) }));
}

function entitySummary(svc: Services, type: string | null, id: number | null) {
  if (!type || !id) return null;
  if (type === 'loan') return svc.db.get(`SELECT l.id, l.loan_ref AS label, l.currency, l.face_cents, l.received_cents, l.purchase_cents, l.maturity_date, l.original_maturity_date, l.status, o.name AS buyer, i.all_in_bps
    FROM loans l JOIN obligors o ON o.id = l.obligor_id JOIN invoices i ON i.id = l.invoice_id WHERE l.id = ?`, [id]);
  if (type === 'commitment') return svc.db.get(`SELECT c.id, i.code || ' · ' || i.name || ' / ' || p.ref || ' ' || c.tranche AS label, c.amount_cents, c.currency, c.pool_id, c.tranche, c.investor_id
    FROM commitments c JOIN investors i ON i.id = c.investor_id JOIN pools p ON p.id = c.pool_id WHERE c.id = ?`, [id]);
  if (type === 'investor') return svc.db.get('SELECT id, code || \' · \' || name AS label FROM investors WHERE id = ?', [id]);
  if (type === 'program') return svc.db.get('SELECT id, program_code || \' · \' || deal_name AS label FROM programs WHERE id = ?', [id]);
  if (type === 'obligor') return svc.db.get('SELECT id, name AS label FROM obligors WHERE id = ?', [id]);
  return null;
}

export function getCase(svc: Services, user: User, id: number) {
  const c = svc.db.get('SELECT c.*, u.name AS assignee_name FROM cases c LEFT JOIN users u ON u.username = c.assignee WHERE c.id = ?', [id]);
  if (!c) throw notFound('Case');
  return {
    ...c,
    sla_breached: !['RESOLVED', 'REJECTED'].includes(c.status) && c.sla_due_at < now(),
    entity: entitySummary(svc, c.entity_type, c.entity_id),
    events: svc.db.all('SELECT e.*, u.name AS actor_name FROM case_events e LEFT JOIN users u ON u.username = e.actor WHERE case_id = ? ORDER BY e.id', [id]),
    amendments: svc.db.all('SELECT * FROM amendments WHERE case_id = ? ORDER BY id DESC', [id]).map((a) => ({
      ...a, payload: JSON.parse(a.payload), preview: a.preview ? JSON.parse(a.preview) : null, result: a.result ? JSON.parse(a.result) : null,
      can_decide: a.status === 'PROPOSED' && can(user, 'service.approve') && a.requested_by !== user.username,
    })),
  };
}

export function updateCase(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'service.cases');
  const c = svc.db.get('SELECT * FROM cases WHERE id = ?', [id]);
  if (!c) throw notFound('Case');
  return svc.db.tx(() => {
    if (typeof body?.comment === 'string' && body.comment.trim()) event(svc, id, 'COMMENT', body.comment.trim().slice(0, 4000), user);
    if (body?.assignee !== undefined && body.assignee !== c.assignee) {
      if (body.assignee && !svc.db.get('SELECT username FROM users WHERE username = ? AND active = 1', [body.assignee])) throw validation({ assignee: 'unknown user' });
      svc.db.run('UPDATE cases SET assignee = ? WHERE id = ?', [body.assignee || null, id]);
      event(svc, id, 'ASSIGN', body.assignee ? `Assigned to ${body.assignee}` : 'Unassigned', user);
    }
    if (body?.priority && body.priority !== c.priority) {
      if (!SLA_HOURS[body.priority]) throw validation({ priority: 'invalid' });
      svc.db.run('UPDATE cases SET priority = ?, sla_due_at = ? WHERE id = ?', [body.priority, new Date(Date.parse(c.created_at) + SLA_HOURS[body.priority] * 3600e3).toISOString(), id]);
      event(svc, id, 'STATUS', `Priority ${c.priority} → ${body.priority}`, user);
    }
    if (body?.status && body.status !== c.status) {
      if (!['OPEN', 'IN_PROGRESS', 'RESOLVED', 'REJECTED'].includes(body.status)) throw validation({ status: 'invalid' });
      if (['RESOLVED', 'REJECTED'].includes(body.status)) {
        if (!body.resolution?.trim()) throw validation({ resolution: 'describe the outcome' });
        if (svc.db.get("SELECT id FROM amendments WHERE case_id = ? AND status = 'PROPOSED'", [id])) throw conflict('Decide the pending amendment first');
      }
      svc.db.run('UPDATE cases SET status = ?, resolution = COALESCE(?, resolution), resolved_at = ? WHERE id = ?',
        [body.status, body.resolution ?? null, ['RESOLVED', 'REJECTED'].includes(body.status) ? now() : null, id]);
      event(svc, id, 'STATUS', `${c.status} → ${body.status}${body.resolution ? `: ${body.resolution}` : ''}`, user);
      audit.record(svc.db, user, 'case.status', 'case', id, { from: c.status, to: body.status, resolution: body.resolution ?? null });
    }
    return { ok: true };
  });
}

// ---------- Amendments ----------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown) => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v));
const isInt = (v: unknown, lo: number, hi: number) => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** Payload checks per amendment type, before anything is stored. */
function validatePayload(svc: Services, type: string, p: any) {
  const e: Record<string, string> = {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw validation({ payload: 'must be an object' });
  if (type === 'LOAN_EXTENSION') {
    if (!isInt(p.loan_id, 1, Number.MAX_SAFE_INTEGER)) e.loan_id = 'required';
    if (!isDate(p.new_maturity_date)) e.new_maturity_date = 'must be a date (YYYY-MM-DD)';
  } else if (type === 'COMMITMENT_TRANSFER') {
    if (!isInt(p.commitment_id, 1, Number.MAX_SAFE_INTEGER)) e.commitment_id = 'required';
    if (!isInt(p.to_investor_id, 1, Number.MAX_SAFE_INTEGER)) e.to_investor_id = 'required';
  } else if (type === 'REDEMPTION') {
    if (!isInt(p.commitment_id, 1, Number.MAX_SAFE_INTEGER)) e.commitment_id = 'required';
    if (p.payment_date !== undefined && (!isDate(p.payment_date) || p.payment_date < svc.today())) e.payment_date = 'must be today or later';
  } else if (type === 'RESTRUCTURE') {
    if (!isInt(p.loan_id, 1, Number.MAX_SAFE_INTEGER)) e.loan_id = 'required';
    if (!isInt(p.periods, 1, 120)) e.periods = 'whole months, 1 to 120';
    if (p.margin_bps !== undefined && !isInt(p.margin_bps, 0, 5000)) e.margin_bps = 'whole basis points, 0 to 5000';
    if (p.rate_path !== undefined && (!Array.isArray(p.rate_path) || !p.rate_path.length || p.rate_path.length > 120
      || p.rate_path.some((r: any) => !isInt(r?.from_period, 1, 120) || !isInt(r?.base_bps, -500, 5000)))) e.rate_path = 'list of {from_period 1-120, base_bps -500..5000}';
  }
  if (Object.keys(e).length) throw validation(e);
}

async function previewAmendment(svc: Services, type: string, p: any) {
  validatePayload(svc, type, p);
  if (type === 'LOAN_EXTENSION') {
    const l = svc.db.get(`SELECT l.*, i.all_in_bps, pr.day_count FROM loans l JOIN invoices i ON i.id = l.invoice_id JOIN programs pr ON pr.id = l.program_id WHERE l.id = ?`, [p.loan_id]);
    if (!l) throw badRequest('Unknown loan');
    if (l.status !== 'OPEN') throw conflict(`${l.loan_ref} is ${l.status}`);
    if (!p.new_maturity_date || p.new_maturity_date <= l.maturity_date) throw validation({ new_maturity_date: `must be after the current maturity ${l.maturity_date}` });
    const extra = daysBetween(l.maturity_date, p.new_maturity_date);
    if (extra > 180) throw validation({ new_maturity_date: 'extensions over 180 days need a restructure' });
    const principal = Math.max(l.purchase_cents - l.received_cents, 0);
    const basis = l.day_count === 'ACT/365' ? 365 : 360;
    const fee = Math.round((principal * (l.all_in_bps ?? 0) * extra) / (basis * 10000));
    return { loan_ref: l.loan_ref, currency: l.currency, from: l.maturity_date, to: p.new_maturity_date, extra_days: extra, extension_fee_cents: fee, principal_cents: principal, all_in_bps: l.all_in_bps };
  }
  if (type === 'COMMITMENT_TRANSFER') {
    const c = svc.db.get('SELECT c.*, i.code FROM commitments c JOIN investors i ON i.id = c.investor_id WHERE c.id = ?', [p.commitment_id]);
    if (!c || c.status !== 'ACTIVE') throw badRequest('Unknown or inactive commitment');
    const to = svc.db.get('SELECT * FROM investors WHERE id = ? AND active = 1', [p.to_investor_id]);
    if (!to) throw badRequest('Unknown receiving investor');
    if (to.id === c.investor_id) throw validation({ to_investor_id: 'must be a different investor' });
    if (svc.db.get('SELECT id FROM commitments WHERE investor_id = ? AND pool_id = ? AND tranche = ?', [to.id, c.pool_id, c.tranche])) throw conflict(`${to.code} already holds a commitment in this tranche`);
    const pending = svc.db.get(`SELECT 1 FROM capital_call_lines l JOIN capital_calls cc ON cc.id = l.call_id WHERE l.commitment_id = ? AND cc.status = 'DRAFT'
      UNION ALL SELECT 1 FROM distribution_lines dl JOIN distributions d ON d.id = dl.distribution_id WHERE dl.commitment_id = ? AND (d.status = 'DRAFT' OR (d.status = 'APPROVED'))`, [c.id, c.id]);
    if (pending) throw conflict('Settle or cancel the draft capital calls and unpaid distributions on this commitment before transferring it');
    // Investor capital (3000) carried by this commitment = called (issued) less capital returned; receivable (1100) = called less received.
    const called = svc.db.get<{ s: number }>("SELECT COALESCE(SUM(l.amount_cents),0) s FROM capital_call_lines l JOIN capital_calls cc ON cc.id = l.call_id WHERE l.commitment_id = ? AND cc.status IN ('ISSUED','SETTLED')", [c.id])!.s;
    const paid = svc.db.get<{ s: number }>('SELECT COALESCE(SUM(received_cents),0) s FROM capital_call_lines WHERE commitment_id = ?', [c.id])!.s;
    const returned = svc.db.get<{ s: number }>("SELECT COALESCE(SUM(dl.amount_cents),0) s FROM distribution_lines dl JOIN distributions d ON d.id = dl.distribution_id WHERE dl.commitment_id = ? AND d.kind = 'CAPITAL' AND d.status IN ('APPROVED','PAID')", [c.id])!.s;
    return { from: c.code, to: to.code, commitment_cents: c.amount_cents, paid_in_cents: paid, capital_cents: called - returned, receivable_cents: called - paid, currency: c.currency, tranche: c.tranche };
  }
  if (type === 'REDEMPTION') {
    const c = svc.db.get('SELECT c.*, i.code FROM commitments c JOIN investors i ON i.id = c.investor_id WHERE c.id = ?', [p.commitment_id]);
    if (!c) throw badRequest('Unknown commitment');
    const paid = svc.db.get<{ s: number }>('SELECT COALESCE(SUM(received_cents),0) s FROM capital_call_lines WHERE commitment_id = ?', [c.id])!.s;
    const returned = svc.db.get<{ s: number }>("SELECT COALESCE(SUM(l.amount_cents),0) s FROM distribution_lines l JOIN distributions d ON d.id = l.distribution_id WHERE l.commitment_id = ? AND d.kind = 'CAPITAL' AND d.status <> 'CANCELLED'", [c.id])!.s;
    if (!Number.isSafeInteger(p.amount_cents) || p.amount_cents <= 0 || p.amount_cents > paid - returned) throw validation({ amount_cents: `must be between 0.01 and net paid-in ${((paid - returned) / 100).toLocaleString('en-US')}` });
    return { investor: c.code, currency: c.currency, net_paid_in_cents: paid - returned, amount_cents: p.amount_cents, payment_date: p.payment_date };
  }
  if (type === 'RESTRUCTURE') {
    const l = svc.db.get('SELECT * FROM loans WHERE id = ?', [p.loan_id]);
    if (!l || l.status !== 'OPEN') throw badRequest('Unknown or settled loan');
    const exposure = l.face_cents - l.received_cents;
    const plan = await svc.engine.call('/service/amortize', { principal_cents: exposure, start_date: svc.today(), periods: p.periods, margin_bps: p.margin_bps ?? 0,
      rate_path: p.rate_path ?? [{ from_period: 1, base_bps: l.base_bps }] });
    return { loan_ref: l.loan_ref, currency: l.currency, exposure_cents: exposure, final_date: plan.final_date, total_interest_cents: plan.total_interest_cents, schedule: plan.schedule };
  }
  throw badRequest('Unknown amendment type');
}

export async function proposeAmendment(svc: Services, user: User, caseId: number, body: any) {
  requirePermission(user, 'service.amend');
  const c = svc.db.get('SELECT * FROM cases WHERE id = ?', [caseId]);
  if (!c) throw notFound('Case');
  if (['RESOLVED', 'REJECTED'].includes(c.status)) throw conflict('Case is closed');
  const type = body?.amendment_type;
  if (!['LOAN_EXTENSION', 'COMMITMENT_TRANSFER', 'REDEMPTION', 'RESTRUCTURE'].includes(type)) throw validation({ amendment_type: 'invalid' });
  if (svc.db.get("SELECT id FROM amendments WHERE case_id = ? AND status = 'PROPOSED'", [caseId])) throw conflict('This case already has a pending amendment');
  const payload = body.payload ?? {};
  const preview = await previewAmendment(svc, type, payload);
  return svc.db.tx(() => {
    const { id } = svc.db.run('INSERT INTO amendments (case_id, amendment_type, payload, preview, status, requested_by, requested_at) VALUES (?,?,?,?,?,?,?)',
      [caseId, type, JSON.stringify(payload), JSON.stringify(preview), 'PROPOSED', user.username, now()]);
    svc.db.run("UPDATE cases SET status = 'PENDING_APPROVAL' WHERE id = ?", [caseId]);
    event(svc, caseId, 'AMENDMENT', `Proposed ${type.replace('_', ' ').toLowerCase()} — awaiting approval`, user);
    audit.record(svc.db, user, 'amendment.proposed', 'case', caseId, { amendment_id: id, type, payload });
    return { status: 201, json: { id, preview } };
  });
}

export async function decideAmendment(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'service.approve');
  assertNotRecentlyReset(svc, user);
  const a = svc.db.get('SELECT * FROM amendments WHERE id = ?', [id]);
  if (!a) throw notFound('Amendment');
  if (a.status !== 'PROPOSED') throw conflict(`Amendment is ${a.status}`);
  if (a.requested_by === user.username) throw forbidden('Four-eyes: an amendment must be approved by someone other than the requester (SoD-11)');
  const decision = body?.decision;
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (!['APPLY', 'REJECT'].includes(decision)) throw validation({ decision: 'APPLY or REJECT' });
  if (decision === 'REJECT' && !note) throw validation({ note: 'give a reason' });
  const payload = JSON.parse(a.payload);
  const preview = decision === 'APPLY' ? await previewAmendment(svc, a.amendment_type, payload) : null; // re-validate against current state
  return svc.db.tx(() => {
    // Claim the decision first: a concurrent APPLY and REJECT cannot both succeed.
    const claimed = svc.db.run("UPDATE amendments SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'PROPOSED'",
      [decision === 'APPLY' ? 'APPLIED' : 'REJECTED', user.username, now(), id]).changes;
    if (claimed !== 1) throw conflict('Amendment was already decided');
    let result: any = null;
    if (decision === 'APPLY') result = apply(svc, user, a.amendment_type, payload, preview);
    svc.db.run('UPDATE amendments SET result = ? WHERE id = ?', [JSON.stringify(result ?? { note }), id]);
    svc.db.run("UPDATE cases SET status = 'IN_PROGRESS' WHERE id = ?", [a.case_id]);
    event(svc, a.case_id, 'AMENDMENT', decision === 'APPLY' ? `Approved and applied by ${user.name}${note ? `: ${note}` : ''}` : `Rejected by ${user.name}: ${note}`, user);
    audit.record(svc.db, user, decision === 'APPLY' ? 'amendment.applied' : 'amendment.rejected', 'case', a.case_id, { amendment_id: id, type: a.amendment_type, result, note });
    return { ok: true, result };
  });
}

function apply(svc: Services, user: User, type: string, p: any, preview: any) {
  if (type === 'LOAN_EXTENSION') {
    const l = svc.db.get('SELECT * FROM loans WHERE id = ?', [p.loan_id]);
    svc.db.run('UPDATE loans SET original_maturity_date = COALESCE(original_maturity_date, maturity_date), maturity_date = ?, fees_cents = fees_cents + ? WHERE id = ?', [p.new_maturity_date, preview.extension_fee_cents, l.id]);
    let je = null;
    if (preview.extension_fee_cents > 0) {
      je = ledger.post(svc.db, user, {
        date: svc.today(), description: `Extension fee ${l.loan_ref}: ${preview.extra_days} days to ${p.new_maturity_date}`, source_type: 'EXTENSION_FEE', source_id: l.id, currency: l.currency,
        lines: [{ account: '1300', debit: preview.extension_fee_cents, program_id: l.program_id, loan_id: l.id }, { account: '4200', credit: preview.extension_fee_cents, program_id: l.program_id, loan_id: l.id }],
      });
    }
    return { loan_ref: l.loan_ref, new_maturity_date: p.new_maturity_date, fee_cents: preview.extension_fee_cents, journal_entry_id: je };
  }
  if (type === 'COMMITMENT_TRANSFER') {
    const c = svc.db.get('SELECT * FROM commitments WHERE id = ?', [p.commitment_id]);
    svc.db.run('UPDATE commitments SET investor_id = ? WHERE id = ?', [p.to_investor_id, c.id]);
    svc.db.run('UPDATE capital_call_lines SET investor_id = ? WHERE commitment_id = ?', [p.to_investor_id, c.id]);
    let je = null;
    const lines: any[] = [];
    if (preview.capital_cents > 0) lines.push({ account: '3000', debit: preview.capital_cents, investor_id: c.investor_id }, { account: '3000', credit: preview.capital_cents, investor_id: p.to_investor_id });
    if (preview.receivable_cents > 0) lines.push({ account: '1100', debit: preview.receivable_cents, investor_id: p.to_investor_id }, { account: '1100', credit: preview.receivable_cents, investor_id: c.investor_id });
    if (lines.length) {
      je = ledger.post(svc.db, user, {
        date: svc.today(), description: `Transfer of ${preview.tranche} commitment ${preview.from} → ${preview.to}`, source_type: 'COMMITMENT_TRANSFER', source_id: c.id, currency: c.currency, lines,
      });
    }
    return { commitment_id: c.id, from: preview.from, to: preview.to, journal_entry_id: je };
  }
  if (type === 'REDEMPTION') {
    const c = svc.db.get('SELECT * FROM commitments WHERE id = ?', [p.commitment_id]);
    const r = createDistributionInternal(svc, user, { pool_id: c.pool_id, tranche: c.tranche, kind: 'CAPITAL', amount_cents: p.amount_cents, payment_date: p.payment_date ?? addDays(svc.today(), 5), commitment_id: c.id }) as any;
    return { distribution: r.json.ref, note: 'Return-of-capital distribution created; it needs Treasury approval before payment.' };
  }
  if (type === 'RESTRUCTURE') {
    const l = svc.db.get('SELECT * FROM loans WHERE id = ?', [p.loan_id]);
    svc.db.run('UPDATE loans SET original_maturity_date = COALESCE(original_maturity_date, maturity_date), maturity_date = ? WHERE id = ?', [preview.final_date, l.id]);
    emit(svc.db, 'loan.restructured', 'loan', l.id, { loan_ref: l.loan_ref, final_date: preview.final_date });
    return { loan_ref: l.loan_ref, final_date: preview.final_date, periods: preview.schedule.length, schedule: preview.schedule };
  }
  return null;
}

// ---------- Loan sub-ledger & workout ----------

const COMPONENTS: [string, string[]][] = [
  ['Principal (purchased receivable)', ['1200']],
  ['Interest - unearned discount', ['2100']],
  ['Interest - investor payable', ['2300']],
  ['Interest - Seaport income', ['4000']],
  ['Fees & charges receivable', ['1300']],
  ['Fee income (late, extension)', ['4100', '4200']],
  ['Escrow / seller reserve', ['2200']],
  ['Cash', ['1000']],
];

export function loanSubledger(svc: Services, loanId: number) {
  const l = svc.db.get(`SELECT l.*, o.name AS buyer, p.program_code, i.invoice_number FROM loans l JOIN obligors o ON o.id = l.obligor_id JOIN programs p ON p.id = l.program_id JOIN invoices i ON i.id = l.invoice_id WHERE l.id = ?`, [loanId]);
  if (!l) throw notFound('Loan');
  const bal = new Map(svc.db.all('SELECT account_code, SUM(debit_cents) d, SUM(credit_cents) c FROM ledger_lines WHERE loan_id = ? GROUP BY account_code', [loanId]).map((r) => [r.account_code, r]));
  const restructure = svc.db.get("SELECT a.result FROM amendments a JOIN cases c ON c.id = a.case_id WHERE a.amendment_type = 'RESTRUCTURE' AND a.status = 'APPLIED' AND c.entity_type = 'loan' AND c.entity_id = ? ORDER BY a.id DESC LIMIT 1", [loanId]);
  return {
    loan: l,
    components: COMPONENTS.map(([label, codes]) => {
      const d = codes.reduce((a, c) => a + (bal.get(c)?.d ?? 0), 0);
      const c = codes.reduce((a, x) => a + (bal.get(x)?.c ?? 0), 0);
      return { label, accounts: codes.join(', '), debit_cents: d, credit_cents: c, balance_cents: d - c };
    }),
    schedule: restructure ? JSON.parse(restructure.result).schedule : null,
    cases: svc.db.all("SELECT id, ref, case_type, status, subject FROM cases WHERE entity_type = 'loan' AND entity_id = ? ORDER BY id DESC", [loanId]),
  };
}

export async function workout(svc: Services, body: any) {
  const loanId = body?.loan_id;
  const l = svc.db.get('SELECT * FROM loans WHERE id = ?', [loanId]);
  if (!l) throw badRequest('Unknown loan');
  return svc.engine.call('/service/workout', { ...body.assumptions, exposure_cents: l.face_cents - l.received_cents, start_date: svc.today() });
}

export function serviceSummary(svc: Services) {
  const nowIso = now();
  const c = (sql: string, p: any[] = []) => svc.db.get<{ n: number }>(sql, p)!.n;
  return {
    open_cases: c("SELECT COUNT(*) n FROM cases WHERE status NOT IN ('RESOLVED','REJECTED')"),
    sla_breached: c("SELECT COUNT(*) n FROM cases WHERE status NOT IN ('RESOLVED','REJECTED') AND sla_due_at < ?", [nowIso]),
    pending_amendments: c("SELECT COUNT(*) n FROM amendments WHERE status = 'PROPOSED'"),
    resolved_30d: c("SELECT COUNT(*) n FROM cases WHERE status = 'RESOLVED' AND resolved_at >= ?", [addDays(svc.today(), -30)]),
  };
}
