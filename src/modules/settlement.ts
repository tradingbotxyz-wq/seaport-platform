// SETTLEMENT & REPAYMENT
// Records what the client or bank *advised*. Applies no cash and carries no approval.
// Settled status is written back only when the loan is matched on a bank statement (Reconciliation).

import type { Services, User } from '../core/context.ts';
import { requirePermission, now, daysBetween } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { emit } from '../core/outbox.ts';
import { safeFilename, check } from '../lib/validate.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { fixingsFor } from './master.ts';

export type AdvisedStatus = 'RECEIVED' | 'SHORT_PAID' | 'PENDING';

export function advisedStatus(dueCents: number, receivedCents: number): AdvisedStatus {
  if (receivedCents <= 0) return 'PENDING';
  return receivedCents >= dueCents ? 'RECEIVED' : 'SHORT_PAID';
}

export async function uploadSettlementFile(svc: Services, user: User, body: unknown) {
  requirePermission(user, 'settlement.upload');
  const input = check<any>(body, {
    program_id: { type: 'int', required: true, min: 1 },
    settlement_date: { type: 'date', required: true },
    filename: { type: 'string', required: true, maxLength: 200 },
    content_base64: { type: 'string', required: true },
  });
  const program = svc.db.get('SELECT * FROM programs WHERE id = ?', [input.program_id]);
  if (!program) throw badRequest('Unknown program');
  if (input.settlement_date > svc.today()) throw badRequest('Settlement (value) date cannot be in the future');
  input.filename = safeFilename(input.filename);
  const parsed = await svc.engine.parse(input.filename, input.content_base64, 'settlement');
  if (svc.db.get('SELECT id FROM settlement_imports WHERE sha256 = ? AND program_id = ?', [parsed.sha256, program.id])) {
    throw conflict('This exact settlement file has already been uploaded (checksum match)');
  }
  return svc.db.tx(() => {
    const { id } = svc.db.run(
      `INSERT INTO settlement_imports (program_id, filename, file_format, sha256, settlement_date, rows_read, matched, unmatched, parse_report, uploaded_by, uploaded_at)
       VALUES (?,?,?,?,?,?,0,0,?,?,?)`,
      [program.id, input.filename.replace(/[\\/:*?"<>|]/g, '_'), parsed.format, parsed.sha256, input.settlement_date, parsed.rows_read,
        JSON.stringify({ skipped: parsed.skipped, warnings: parsed.warnings }), user.username, now()],
    );
    let matched = 0;
    const seen = new Set<number>();
    for (const row of parsed.rows) {
      let loan = row.loan_id ? svc.db.get('SELECT * FROM loans WHERE loan_ref = ?', [row.loan_id.toUpperCase()]) : null;
      if (!loan && row.invoice_number) {
        loan = svc.db.get('SELECT l.* FROM loans l JOIN invoices i ON i.id = l.invoice_id WHERE l.program_id = ? AND i.invoice_number = ?', [program.id, row.invoice_number]);
      }
      let note: string | null = null;
      if (!loan) note = 'No funded loan matches this loan ID / invoice';
      else if (loan.program_id !== program.id) { note = `Loan ${loan.loan_ref} belongs to another program`; loan = null; }
      else if (seen.has(loan.id)) { note = `Loan ${loan.loan_ref} appears more than once in this file`; loan = null; }
      else if (row.currency && row.currency !== program.currency) { note = `Currency ${row.currency} differs from program currency`; loan = null; }
      if (loan) { seen.add(loan.id); matched++; }
      svc.db.run(
        `INSERT INTO settlement_advices (settlement_import_id, loan_id, loan_ref_raw, invoice_number_raw, amount_cents, value_date, bank_reference, match_status, match_note)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, loan?.id ?? null, row.loan_id, row.invoice_number, row.amount_cents, row.value_date ?? input.settlement_date, row.bank_reference, loan ? 'MATCHED' : 'UNMATCHED', note],
      );
    }
    const unmatched = parsed.rows.length - matched + parsed.skipped.length;
    svc.db.run('UPDATE settlement_imports SET matched = ?, unmatched = ? WHERE id = ?', [matched, unmatched, id]);
    audit.record(svc.db, user, 'settlement.uploaded', 'settlement_import', id, { filename: input.filename, program: program.program_code, matched, unmatched, sha256: parsed.sha256 });
    emit(svc.db, 'settlement.uploaded', 'settlement_import', id, { id, filename: input.filename, matched, unmatched });
    return { status: 201, json: { id, matched, unmatched, rows_read: parsed.rows_read, skipped: parsed.skipped, warnings: parsed.warnings } };
  });
}

function summarize(svc: Services, importId: number) {
  const rows = svc.db.all(
    `SELECT a.amount_cents, l.face_cents FROM settlement_advices a JOIN loans l ON l.id = a.loan_id WHERE a.settlement_import_id = ? AND a.match_status = 'MATCHED'`, [importId]);
  const due = rows.reduce((s, r) => s + r.face_cents, 0);
  const received = rows.reduce((s, r) => s + Math.min(r.amount_cents, r.face_cents), 0);
  const status = received === 0 ? 'Pending' : received >= due ? 'Fully received' : 'Partially received';
  return { due_cents: due, received_cents: received, outstanding_cents: due - received, status };
}

export function listSettlementImports(svc: Services) {
  return svc.db.all(
    `SELECT s.*, p.program_code, p.deal_name, p.deal_code, p.currency, u.name AS uploaded_by_name
     FROM settlement_imports s JOIN programs p ON p.id = s.program_id JOIN users u ON u.username = s.uploaded_by
     ORDER BY s.settlement_date DESC, s.id DESC LIMIT 500`).map((s) => ({ ...s, parse_report: JSON.parse(s.parse_report), ...summarize(svc, s.id) }));
}

export async function settlementView(svc: Services, id: number) {
  const s = svc.db.get(
    `SELECT s.*, p.program_code, p.deal_name, p.deal_code, p.currency, p.collection_account, p.day_count, p.rate_basis, p.late_margin_bps, u.name AS uploaded_by_name
     FROM settlement_imports s JOIN programs p ON p.id = s.program_id JOIN users u ON u.username = s.uploaded_by WHERE s.id = ?`, [id]);
  if (!s) throw notFound('Settlement file');
  const advices = svc.db.all(
    `SELECT a.*, l.loan_ref, l.maturity_date, l.face_cents AS due_cents, l.status AS loan_status, l.bank_reference AS bank_confirmation, l.settled_at,
            l.base_bps, l.received_cents AS bank_received_cents, i.invoice_number, o.name AS buyer
     FROM settlement_advices a LEFT JOIN loans l ON l.id = a.loan_id LEFT JOIN invoices i ON i.id = l.invoice_id LEFT JOIN obligors o ON o.id = l.obligor_id
     WHERE a.settlement_import_id = ? ORDER BY a.id`, [id]);
  const rows = advices.map((a) => {
    if (a.match_status !== 'MATCHED') return { ...a, advised_status: null, variance_cents: null };
    const received = Math.min(a.amount_cents, a.due_cents);
    return { ...a, advised_status: advisedStatus(a.due_cents, a.amount_cents), variance_cents: a.due_cents - received, received_pct: Math.round((received * 1000) / a.due_cents) / 10 };
  });

  // Late payment charges on shortfalls past maturity, to today: shortfall x (base + late margin) x days / basis.
  const lateItems = rows.filter((r) => r.match_status === 'MATCHED' && r.variance_cents > 0 && r.maturity_date < svc.today());
  let late = { total_cents: 0, items: [] as any[] };
  if (lateItems.length) {
    late = await svc.engine.lateCharges(svc.today(), s.day_count, s.late_margin_bps,
      lateItems.map((r) => ({ id: r.id, shortfall_cents: r.variance_cents, base_bps: r.base_bps, maturity_date: r.maturity_date })));
  }
  const lateById = new Map(late.items.map((i: any) => [i.id, i]));
  const matched = rows.filter((r) => r.match_status === 'MATCHED');
  const sum = summarize(svc, id);
  return {
    settlement: { ...s, parse_report: JSON.parse(s.parse_report), ...sum },
    kpis: {
      loans: matched.length,
      received: matched.filter((r) => r.advised_status === 'RECEIVED').length,
      short_paid: matched.filter((r) => r.advised_status === 'SHORT_PAID').length,
      pending: matched.filter((r) => r.advised_status === 'PENDING').length,
      unmatched: rows.length - matched.length,
      due_cents: sum.due_cents,
      received_cents: sum.received_cents,
      outstanding_cents: sum.outstanding_cents,
      shortfall_cents: matched.filter((r) => r.advised_status === 'SHORT_PAID').reduce((a, r) => a + r.variance_cents, 0),
      pending_cents: matched.filter((r) => r.advised_status === 'PENDING').reduce((a, r) => a + r.variance_cents, 0),
      late_charges_cents: late.total_cents,
      bank_settled: matched.filter((r) => r.loan_status === 'SETTLED').length,
    },
    advices: rows.map((r) => ({ ...r, late_charge: lateById.get(r.id) ?? null })),
    late_charge_as_of: svc.today(),
  };
}

/** Open loans with ageing - used by the dashboard and the past-due view. */
export function openLoans(svc: Services) {
  const today = svc.today();
  return svc.db.all(
    `SELECT l.*, o.name AS buyer, o.auto_debit, p.deal_name, p.program_code, i.invoice_number
     FROM loans l JOIN obligors o ON o.id = l.obligor_id JOIN programs p ON p.id = l.program_id JOIN invoices i ON i.id = l.invoice_id
     WHERE l.status = 'OPEN' ORDER BY l.maturity_date, l.loan_ref`).map((l) => ({
    ...l,
    outstanding_cents: l.face_cents - l.received_cents,
    days_to_maturity: daysBetween(today, l.maturity_date),
    state: l.maturity_date < today ? 'Past due' : l.auto_debit ? 'Auto-debit set' : 'Expected',
  }));
}

export function benchmarkFor(svc: Services, program: any, date: string) {
  return fixingsFor(svc, program.rate_basis, date);
}
