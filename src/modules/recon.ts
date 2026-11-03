// RECONCILIATION (bank statements). The only place cash is applied to loans.
// Matching keys, strongest first: loan ID in the narrative, bank/VA reference from a settlement
// advice, invoice number. Amount must equal the outstanding balance or the advised amount;
// anything else is a break that Treasury must resolve. Posting is four-eyes vs the uploader.

import type { Services, User } from '../core/context.ts';
import { requirePermission, now } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { emit } from '../core/outbox.ts';
import { check } from '../lib/validate.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import * as ledger from './ledger.ts';

const LOAN_RE = /L-\d{4}-\d{5}/i;
const fmt = (cents: number) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function findLoan(svc: Services, line: { reference: string; bank_reference?: string | null }, programId: number | null) {
  const scope = programId ? ' AND l.program_id = ' + Number(programId) : '';
  const m = LOAN_RE.exec(line.reference) ?? (line.bank_reference ? LOAN_RE.exec(line.bank_reference) : null);
  if (m) {
    const loan = svc.db.get(`SELECT l.* FROM loans l WHERE l.loan_ref = ?${scope}`, [m[0].toUpperCase()]);
    if (loan) return { loan, via: 'loan ID' };
  }
  for (const ref of [line.bank_reference, ...line.reference.split(/[\s,;/|]+/)]) {
    if (!ref || ref.length < 5) continue;
    const adv = svc.db.get(
      `SELECT a.loan_id, a.amount_cents FROM settlement_advices a JOIN loans l ON l.id = a.loan_id
       WHERE a.match_status = 'MATCHED' AND upper(a.bank_reference) = upper(?)${scope} ORDER BY a.id DESC LIMIT 1`, [ref]);
    if (adv) return { loan: svc.db.get('SELECT * FROM loans WHERE id = ?', [adv.loan_id]), via: 'advised bank reference', advised: adv.amount_cents };
  }
  for (const token of line.reference.split(/[\s,;/|]+/)) {
    if (token.length < 4) continue;
    const loan = svc.db.get(`SELECT l.* FROM loans l JOIN invoices i ON i.id = l.invoice_id WHERE upper(i.invoice_number) = upper(?)${scope}`, [token]);
    if (loan) return { loan, via: 'invoice number' };
  }
  return null;
}

function classify(svc: Services, line: any, programId: number | null): { loan_id: number | null; status: string; note: string } {
  const hit = findLoan(svc, line, programId);
  if (!hit) return { loan_id: null, status: 'UNMATCHED', note: 'No loan found for this reference' };
  const { loan, via } = hit;
  if (loan.currency !== line.currency) return { loan_id: loan.id, status: 'AMOUNT_MISMATCH', note: `Currency ${line.currency} differs from loan currency ${loan.currency}` };
  if (loan.status === 'SETTLED') return { loan_id: loan.id, status: 'AMOUNT_MISMATCH', note: `${loan.loan_ref} is already settled - possible duplicate payment` };
  const outstanding = loan.face_cents - loan.received_cents;
  const advised = svc.db.get(
    "SELECT amount_cents FROM settlement_advices WHERE loan_id = ? AND match_status = 'MATCHED' ORDER BY id DESC LIMIT 1", [loan.id])?.amount_cents;
  if (line.amount_cents === outstanding) return { loan_id: loan.id, status: 'MATCHED', note: `Matched on ${via}; full settlement` };
  if (advised !== undefined && line.amount_cents === advised && line.amount_cents < outstanding) {
    return { loan_id: loan.id, status: 'MATCHED', note: `Matched on ${via}; partial payment equals advised amount` };
  }
  if (line.amount_cents > outstanding) return { loan_id: loan.id, status: 'AMOUNT_MISMATCH', note: `Over-payment: received ${fmt(line.amount_cents)} vs outstanding ${fmt(outstanding)}` };
  return { loan_id: loan.id, status: 'AMOUNT_MISMATCH', note: `Partial payment ${fmt(line.amount_cents)} vs outstanding ${fmt(outstanding)} with no matching advice` };
}

export async function uploadStatement(svc: Services, user: User, body: unknown) {
  requirePermission(user, 'recon.upload');
  const input = check<any>(body, {
    program_id: { type: 'int', min: 1 },
    statement_date: { type: 'date', required: true },
    filename: { type: 'string', required: true, maxLength: 200 },
    content_base64: { type: 'string', required: true },
  });
  const program = input.program_id ? svc.db.get('SELECT * FROM programs WHERE id = ?', [input.program_id]) : null;
  if (input.program_id && !program) throw badRequest('Unknown program');
  const parsed = await svc.engine.parse(input.filename, input.content_base64, 'bank');
  if (svc.db.get('SELECT id FROM bank_statements WHERE sha256 = ?', [parsed.sha256])) throw conflict('This bank statement has already been uploaded (checksum match)');
  if (!parsed.rows.length) throw badRequest(parsed.warnings[0] ?? 'No transactions found in the statement');
  return svc.db.tx(() => {
    const { id } = svc.db.run(
      'INSERT INTO bank_statements (program_id, account, filename, sha256, statement_date, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?,?)',
      [program?.id ?? null, program?.collection_account ?? 'ALL', input.filename, parsed.sha256, input.statement_date, user.username, now()],
    );
    const counts: Record<string, number> = { MATCHED: 0, AMOUNT_MISMATCH: 0, UNMATCHED: 0 };
    for (const row of parsed.rows) {
      const line = { reference: row.reference, bank_reference: row.bank_reference, amount_cents: row.amount_cents, currency: row.currency ?? program?.currency ?? 'USD' };
      const c = classify(svc, line, program?.id ?? null);
      counts[c.status]++;
      svc.db.run(
        `INSERT INTO bank_lines (statement_id, value_date, reference, bank_reference, amount_cents, currency, loan_id, match_status, match_note) VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, row.value_date ?? input.statement_date, row.reference, row.bank_reference, row.amount_cents, line.currency, c.loan_id, c.status, c.note],
      );
      if (c.status !== 'MATCHED') emit(svc.db, 'recon.break', 'bank_statement', id, { reference: row.reference, reason: c.note });
    }
    audit.record(svc.db, user, 'bank_statement.uploaded', 'bank_statement', id, { filename: input.filename, lines: parsed.rows.length, ...counts, skipped: parsed.skipped.length });
    return { status: 201, json: { id, lines: parsed.rows.length, ...counts, skipped: parsed.skipped } };
  });
}

export function listStatements(svc: Services) {
  return svc.db.all(`
    SELECT s.*, p.deal_name, p.program_code, u.name AS uploaded_by_name,
      (SELECT COUNT(*) FROM bank_lines WHERE statement_id = s.id) AS lines,
      (SELECT COUNT(*) FROM bank_lines WHERE statement_id = s.id AND match_status = 'POSTED') AS posted,
      (SELECT COUNT(*) FROM bank_lines WHERE statement_id = s.id AND match_status = 'MATCHED') AS matched,
      (SELECT COUNT(*) FROM bank_lines WHERE statement_id = s.id AND match_status IN ('UNMATCHED','AMOUNT_MISMATCH')) AS breaks,
      (SELECT COALESCE(SUM(amount_cents),0) FROM bank_lines WHERE statement_id = s.id) AS total_cents
    FROM bank_statements s LEFT JOIN programs p ON p.id = s.program_id JOIN users u ON u.username = s.uploaded_by
    ORDER BY s.statement_date DESC, s.id DESC`);
}

export function statementView(svc: Services, id: number) {
  const s = listStatements(svc).find((x) => x.id === id);
  if (!s) throw notFound('Bank statement');
  const lines = svc.db.all(
    `SELECT b.*, l.loan_ref, l.face_cents, l.received_cents, l.status AS loan_status, o.name AS buyer, je.ref AS journal_ref
     FROM bank_lines b LEFT JOIN loans l ON l.id = b.loan_id LEFT JOIN obligors o ON o.id = l.obligor_id LEFT JOIN journal_entries je ON je.id = b.journal_entry_id
     WHERE b.statement_id = ? ORDER BY b.id`, [id]);
  return { statement: s, lines };
}

export function openBreaks(svc: Services) {
  return svc.db.all(
    `SELECT b.*, s.filename, s.statement_date, l.loan_ref FROM bank_lines b JOIN bank_statements s ON s.id = b.statement_id LEFT JOIN loans l ON l.id = b.loan_id
     WHERE b.match_status IN ('UNMATCHED','AMOUNT_MISMATCH') ORDER BY b.value_date, b.id`);
}

/** Apply cash for one MATCHED line. Must run inside a transaction. */
function applyLine(svc: Services, user: User, line: any) {
  const loan = svc.db.get('SELECT * FROM loans WHERE id = ?', [line.loan_id]);
  if (!loan || loan.status !== 'OPEN') throw conflict(`Loan for line ${line.id} is not open`);
  const outstanding = loan.face_cents - loan.received_cents;
  if (line.amount_cents > outstanding) throw conflict(`Line ${line.id} exceeds the outstanding balance`);
  const principalLeft = Math.max(loan.purchase_cents - loan.received_cents, 0);
  const toPrincipal = Math.min(line.amount_cents, principalLeft);
  const toReserve = line.amount_cents - toPrincipal;
  const entryId = ledger.post(svc.db, user, {
    date: line.value_date, description: `Bank receipt ${line.reference} -> ${loan.loan_ref}`, source_type: 'BANK_RECEIPT', source_id: line.id, currency: loan.currency,
    lines: [
      { account: '1000', debit: line.amount_cents, program_id: loan.program_id, loan_id: loan.id },
      { account: '1200', credit: toPrincipal, program_id: loan.program_id, loan_id: loan.id, investor_id: loan.investor_id },
      { account: '2200', credit: toReserve, program_id: loan.program_id, loan_id: loan.id },
    ],
  });
  const received = loan.received_cents + line.amount_cents;
  const settled = received >= loan.face_cents;
  const bankRef = line.bank_reference || line.reference.slice(0, 40);
  svc.db.run('UPDATE loans SET received_cents = ?, status = ?, settled_at = ?, bank_reference = ? WHERE id = ?',
    [received, settled ? 'SETTLED' : 'OPEN', settled ? line.value_date : null, bankRef, loan.id]);
  if (settled) {
    ledger.post(svc.db, user, {
      date: line.value_date, description: `Interest recognised on settlement of ${loan.loan_ref}`, source_type: 'INTEREST_RECOGNITION', source_id: loan.id, currency: loan.currency,
      lines: [
        { account: '2100', debit: loan.interest_cents, program_id: loan.program_id, loan_id: loan.id, investor_id: loan.investor_id },
        { account: '2300', credit: loan.investor_interest_cents, program_id: loan.program_id, loan_id: loan.id, investor_id: loan.investor_id },
        { account: '4000', credit: loan.interest_cents - loan.investor_interest_cents, program_id: loan.program_id, loan_id: loan.id },
      ],
    });
    emit(svc.db, 'loan.settled', 'loan', loan.id, { loan_ref: loan.loan_ref, bank_reference: bankRef });
  }
  svc.db.run("UPDATE bank_lines SET match_status = 'POSTED', journal_entry_id = ?, resolved_by = ? WHERE id = ?", [entryId, user.username, line.id]);
  return { loan_ref: loan.loan_ref, settled };
}

export function postMatched(svc: Services, user: User, statementId: number) {
  requirePermission(user, 'recon.post');
  return svc.db.tx(() => {
    const s = svc.db.get('SELECT * FROM bank_statements WHERE id = ?', [statementId]);
    if (!s) throw notFound('Bank statement');
    if (s.uploaded_by === user.username) throw forbidden('Four-eyes: cash must be posted by a different user than the statement uploader');
    const lines = svc.db.all("SELECT * FROM bank_lines WHERE statement_id = ? AND match_status = 'MATCHED' ORDER BY id", [statementId]);
    if (!lines.length) throw conflict('No matched lines to post');
    const results = lines.map((l) => applyLine(svc, user, l));
    audit.record(svc.db, user, 'recon.posted', 'bank_statement', statementId, { lines: lines.length, settled: results.filter((r) => r.settled).map((r) => r.loan_ref) });
    return { posted: lines.length, settled: results.filter((r) => r.settled).length, results };
  });
}

export function matchLine(svc: Services, user: User, lineId: number, body: unknown) {
  requirePermission(user, 'recon.post');
  const { loan_ref, note } = check<any>(body, { loan_ref: { type: 'string', required: true, pattern: /^L-\d{4}-\d{5}$/i }, note: { type: 'string', required: true, maxLength: 500 } });
  return svc.db.tx(() => {
    const line = svc.db.get('SELECT * FROM bank_lines WHERE id = ?', [lineId]);
    if (!line) throw notFound('Bank line');
    if (!['UNMATCHED', 'AMOUNT_MISMATCH'].includes(line.match_status)) throw conflict(`Line is ${line.match_status}`);
    const loan = svc.db.get('SELECT * FROM loans WHERE loan_ref = ?', [loan_ref.toUpperCase()]);
    if (!loan) throw badRequest(`Loan ${loan_ref} not found`);
    if (loan.status !== 'OPEN') throw conflict(`Loan ${loan.loan_ref} is already settled`);
    if (loan.currency !== line.currency) throw conflict('Currency differs from the loan currency');
    if (line.amount_cents > loan.face_cents - loan.received_cents) throw conflict('Amount exceeds the loan outstanding balance');
    svc.db.run("UPDATE bank_lines SET loan_id = ?, match_status = 'MATCHED', match_note = ?, resolved_by = ?, resolved_note = ? WHERE id = ?",
      [loan.id, `Manually matched to ${loan.loan_ref}`, user.username, note, lineId]);
    audit.record(svc.db, user, 'recon.manual_match', 'bank_line', lineId, { loan_ref: loan.loan_ref, note, before: line.match_status });
    return svc.db.get('SELECT * FROM bank_lines WHERE id = ?', [lineId]);
  });
}

export function resolveLine(svc: Services, user: User, lineId: number, body: unknown) {
  requirePermission(user, 'recon.post');
  const { note } = check<any>(body, { note: { type: 'string', required: true, maxLength: 500 } });
  return svc.db.tx(() => {
    const line = svc.db.get('SELECT * FROM bank_lines WHERE id = ?', [lineId]);
    if (!line) throw notFound('Bank line');
    if (!['UNMATCHED', 'AMOUNT_MISMATCH'].includes(line.match_status)) throw conflict(`Line is ${line.match_status}`);
    svc.db.run("UPDATE bank_lines SET match_status = 'RESOLVED', resolved_by = ?, resolved_note = ? WHERE id = ?", [user.username, note, lineId]);
    audit.record(svc.db, user, 'recon.break_resolved', 'bank_line', lineId, { note, was: line.match_status, reference: line.reference });
    return svc.db.get('SELECT * FROM bank_lines WHERE id = ?', [lineId]);
  });
}
