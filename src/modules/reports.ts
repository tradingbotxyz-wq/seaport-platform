// PORTFOLIO DASHBOARD, REVENUE & FEES, SEARCH.
// Portfolio totals are shown in USD at reference FX (master table); per-obligor figures stay in program currency.

import type { Services } from '../core/context.ts';
import { addDays, daysBetween } from '../core/context.ts';
import { obligorUsage, fxToUsd } from './exposure.ts';
import { openLoans } from './settlement.ts';

export async function revenue(svc: Services) {
  const today = svc.today();
  const programs = svc.db.all('SELECT * FROM programs ORDER BY program_code');
  const byProgram = programs.map((p) => {
    const agg = svc.db.get(
      `SELECT COUNT(*) AS loans,
         COALESCE(SUM(purchase_cents),0) AS purchased_cents,
         COALESCE(SUM(interest_cents),0) AS interest_cents,
         COALESCE(SUM(investor_interest_cents),0) AS investor_cents,
         COALESCE(SUM(CASE WHEN status='SETTLED' THEN interest_cents - investor_interest_cents END),0) AS earned_cents,
         COALESCE(SUM(CASE WHEN status='OPEN' THEN interest_cents - investor_interest_cents END),0) AS unearned_cents
       FROM loans WHERE program_id = ?`, [p.id])!;
    return { program_id: p.id, program_code: p.program_code, deal_name: p.deal_name, currency: p.currency, day_count: p.day_count, late_margin_bps: p.late_margin_bps, ...agg };
  });

  // Late charges accrued (memo) on past-due open loans, priced by the Python engine per program.
  for (const row of byProgram) {
    const past = svc.db.all("SELECT id, loan_ref, face_cents - received_cents AS shortfall_cents, base_bps, maturity_date FROM loans WHERE program_id = ? AND status = 'OPEN' AND maturity_date < ?", [row.program_id, today]);
    (row as any).late_accrued_cents = 0;
    if (past.length) {
      const res = await svc.engine.lateCharges(today, row.day_count, row.late_margin_bps, past.map((l) => ({ id: l.id, shortfall_cents: l.shortfall_cents, base_bps: l.base_bps, maturity_date: l.maturity_date })));
      (row as any).late_accrued_cents = res.total_cents;
    }
  }

  const monthly = svc.db.all(
    `SELECT substr(je.entry_date, 1, 7) AS month, je.currency, SUM(l.credit_cents) AS spread_income_cents
     FROM ledger_lines l JOIN journal_entries je ON je.id = l.entry_id WHERE l.account_code = '4000'
     GROUP BY month, je.currency ORDER BY month`);
  const booked = svc.db.all(
    `SELECT substr(funding_date, 1, 7) AS month, currency, SUM(interest_cents) AS interest_cents, SUM(investor_interest_cents) AS investor_cents
     FROM loans GROUP BY month, currency ORDER BY month`);
  const usd = fxToUsd(svc.db);
  const totalsUsd = byProgram.reduce((a, r: any) => ({
    interest: a.interest + usd(r.interest_cents, r.currency),
    investor: a.investor + usd(r.investor_cents, r.currency),
    earned: a.earned + usd(r.earned_cents, r.currency),
    unearned: a.unearned + usd(r.unearned_cents, r.currency),
    late: a.late + usd(r.late_accrued_cents, r.currency),
  }), { interest: 0, investor: 0, earned: 0, unearned: 0, late: 0 });
  return { as_of: today, totals_usd_cents: totalsUsd, programs: byProgram, monthly_recognised: monthly, monthly_booked: booked };
}

export function search(svc: Services, q: string) {
  const like = `%${q}%`;
  return {
    loans: svc.db.all('SELECT l.id, l.loan_ref, l.status, l.currency, l.face_cents, o.name AS buyer FROM loans l JOIN obligors o ON o.id = l.obligor_id WHERE l.loan_ref LIKE ? LIMIT 10', [like]),
    invoices: svc.db.all("SELECT i.id, i.invoice_number, i.status, i.import_id, i.buyer_name FROM invoices i WHERE i.invoice_number LIKE ? AND i.status <> 'REMOVED' LIMIT 10", [like]),
    obligors: svc.db.all('SELECT o.id, o.name, o.rating, p.deal_name FROM obligors o JOIN programs p ON p.id = o.program_id WHERE o.name LIKE ? LIMIT 10', [like]),
    programs: svc.db.all('SELECT id, program_code, deal_name, deal_code FROM programs WHERE program_code LIKE ? OR deal_name LIKE ? OR deal_code LIKE ? LIMIT 10', [like, like, like]),
    files: svc.db.all("SELECT id, filename, status FROM invoice_imports WHERE filename LIKE ? AND status <> 'REMOVED' LIMIT 10", [like]),
  };
}

export function loanDetail(svc: Services, id: number) {
  const loan = svc.db.get(
    `SELECT l.*, o.name AS buyer, o.rating, p.deal_name, p.program_code, i.invoice_number, i.invoice_date, inv.code AS investor_code, inv.name AS investor_name
     FROM loans l JOIN obligors o ON o.id = l.obligor_id JOIN programs p ON p.id = l.program_id JOIN invoices i ON i.id = l.invoice_id JOIN investors inv ON inv.id = l.investor_id
     WHERE l.id = ?`, [id]);
  if (!loan) return null;
  return {
    ...loan,
    advices: svc.db.all('SELECT a.*, s.filename FROM settlement_advices a JOIN settlement_imports s ON s.id = a.settlement_import_id WHERE a.loan_id = ? ORDER BY a.id', [id]),
    bank_lines: svc.db.all('SELECT b.*, s.filename FROM bank_lines b JOIN bank_statements s ON s.id = b.statement_id WHERE b.loan_id = ? ORDER BY b.id', [id]),
    journal: svc.db.all(
      `SELECT je.ref, je.entry_date, je.description, l.account_code, a.name AS account_name, l.debit_cents, l.credit_cents
       FROM ledger_lines l JOIN journal_entries je ON je.id = l.entry_id JOIN ledger_accounts a ON a.code = l.account_code WHERE l.loan_id = ? ORDER BY je.id, l.id`, [id]),
  };
}
