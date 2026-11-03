// Double-entry ledger. Every financial event posts a balanced journal entry (debits = credits),
// per currency. Entries are append-only (DB triggers); corrections are reversing entries.
//
// Postings used by the platform:
//   Funding approved   Dr 1200 Purchased receivables (purchase price)
//                      Cr 2500 Seller payable (purchase price - interest); Dr 2500 / Cr 1000 when the disbursement is sent
//                      Cr 2100 Unearned interest (interest)
//   Bank receipt       Dr 1000 Cash (amount)
//                      Cr 1200 Purchased receivables (up to remaining purchase price)
//                      Cr 2200 Seller reserve payable (anything above the purchase price)
//   Loan settled       Dr 2100 Unearned interest (interest)
//                      Cr 2300 Investor interest payable (investor share)
//                      Cr 4000 Seaport spread income (Seaport share)

import type { Db } from '../lib/db.ts';
import type { User } from '../core/context.ts';
import { now, nextRef } from '../core/context.ts';
import { notFound, conflict } from '../lib/errors.ts';

export interface Line {
  account: string;
  debit?: number;
  credit?: number;
  program_id?: number | null;
  loan_id?: number | null;
  investor_id?: number | null;
}

export function post(db: Db, user: User, e: { date: string; description: string; source_type: string; source_id?: number | null; currency: string; lines: Line[]; reverses_id?: number }): number {
  const lines = e.lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
  if (lines.length < 2) throw new Error('A journal entry needs at least two non-zero lines');
  let dr = 0;
  let cr = 0;
  for (const l of lines) {
    const d = l.debit ?? 0;
    const c = l.credit ?? 0;
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c) || d < 0 || c < 0 || (d > 0 && c > 0)) throw new Error(`Invalid ledger line ${JSON.stringify(l)}`);
    dr += d;
    cr += c;
  }
  if (dr !== cr) throw new Error(`Unbalanced journal entry: debits ${dr} != credits ${cr}`);
  const ref = nextRef(db, 'JE', 7);
  const { id } = db.run(
    'INSERT INTO journal_entries (ref, entry_date, description, source_type, source_id, currency, reverses_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [ref, e.date, e.description, e.source_type, e.source_id ?? null, e.currency, e.reverses_id ?? null, user.username, now()],
  );
  for (const l of lines) {
    db.run('INSERT INTO ledger_lines (entry_id, account_code, program_id, loan_id, investor_id, debit_cents, credit_cents) VALUES (?,?,?,?,?,?,?)',
      [id, l.account, l.program_id ?? null, l.loan_id ?? null, l.investor_id ?? null, l.debit ?? 0, l.credit ?? 0]);
  }
  return id;
}

export function reverse(db: Db, user: User, entryId: number, reason: string): number {
  const e = db.get('SELECT * FROM journal_entries WHERE id = ?', [entryId]);
  if (!e) throw notFound('Journal entry');
  if (e.reverses_id) throw conflict('A reversal cannot itself be reversed');
  if (db.get('SELECT id FROM journal_entries WHERE reverses_id = ?', [entryId])) throw conflict('Entry already reversed');
  const lines = db.all('SELECT * FROM ledger_lines WHERE entry_id = ?', [entryId]);
  return post(db, user, {
    date: now().slice(0, 10), description: `Reversal of ${e.ref}: ${reason}`, source_type: 'REVERSAL', source_id: entryId, currency: e.currency, reverses_id: entryId,
    lines: lines.map((l) => ({ account: l.account_code, debit: l.credit_cents, credit: l.debit_cents, program_id: l.program_id, loan_id: l.loan_id, investor_id: l.investor_id })),
  });
}

export function trialBalance(db: Db) {
  const rows = db.all(`
    SELECT je.currency, a.code, a.name, a.account_type,
           SUM(l.debit_cents) AS debit_cents, SUM(l.credit_cents) AS credit_cents
    FROM ledger_lines l JOIN journal_entries je ON je.id = l.entry_id JOIN ledger_accounts a ON a.code = l.account_code
    GROUP BY je.currency, a.code ORDER BY je.currency, a.code`);
  const byCurrency: Record<string, { debit_cents: number; credit_cents: number; balanced: boolean }> = {};
  for (const r of rows) {
    const t = (byCurrency[r.currency] ??= { debit_cents: 0, credit_cents: 0, balanced: true });
    t.debit_cents += r.debit_cents;
    t.credit_cents += r.credit_cents;
    t.balanced = t.debit_cents === t.credit_cents;
  }
  return { accounts: rows.map((r) => ({ ...r, balance_cents: r.debit_cents - r.credit_cents })), totals: byCurrency };
}

export function entries(db: Db, filter: { loan_id?: number; program_id?: number; limit?: number } = {}) {
  const where: string[] = [];
  const params: any[] = [];
  if (filter.loan_id) { where.push('je.id IN (SELECT entry_id FROM ledger_lines WHERE loan_id = ?)'); params.push(filter.loan_id); }
  if (filter.program_id) { where.push('je.id IN (SELECT entry_id FROM ledger_lines WHERE program_id = ?)'); params.push(filter.program_id); }
  const list = db.all(`SELECT je.* FROM journal_entries je ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY je.id DESC LIMIT ?`, [...params, filter.limit ?? 200]);
  return list.map((e) => ({
    ...e,
    lines: db.all('SELECT l.*, a.name AS account_name FROM ledger_lines l JOIN ledger_accounts a ON a.code = l.account_code WHERE entry_id = ? ORDER BY l.id', [e.id]),
  }));
}
