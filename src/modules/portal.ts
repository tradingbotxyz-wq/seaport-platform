// INVESTOR PORTAL: self-service for investor users (role INVESTOR, linked to one investor record).
// Every query is scoped to the signed-in investor; the HTTP layer blocks investor users from all
// other APIs, and document downloads are checked against ownership.

import type { Services, User } from '../core/context.ts';
import { now, addDays } from '../core/context.ts';
import { check } from '../lib/validate.ts';
import { forbidden, notFound, validation } from '../lib/errors.ts';
import { listCommitments } from './fund.ts';
import { generatePdf } from './documents.ts';
import { createCase } from './service.ts';

function investorOf(svc: Services, user: User) {
  const u = svc.db.get('SELECT investor_id FROM users WHERE username = ?', [user.username]);
  const id = u?.investor_id;
  if (!id) throw forbidden('This user is not linked to an investor');
  return svc.db.get('SELECT * FROM investors WHERE id = ?', [id]);
}

const fmt = (c: number, ccy: string) => `${ccy} ${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function summary(svc: Services, user: User, investorId?: number) {
  const inv = investorId ? svc.db.get('SELECT * FROM investors WHERE id = ?', [investorId]) : investorOf(svc, user);
  if (!inv) throw notFound('Investor');
  const positions = listCommitments(svc, new URLSearchParams({ investor_id: String(inv.id) }));
  const calls = svc.db.all(`SELECT l.*, c.ref, c.due_date, c.purpose, c.tranche, c.currency, c.status AS call_status, p.ref AS pool_ref, d.filename AS notice_filename
    FROM capital_call_lines l JOIN capital_calls c ON c.id = l.call_id JOIN pools p ON p.id = c.pool_id LEFT JOIN documents d ON d.id = l.notice_document_id
    WHERE l.investor_id = ? AND c.status IN ('ISSUED','SETTLED') ORDER BY c.id DESC`, [inv.id]);
  const distributions = svc.db.all(`SELECT dl.amount_cents, d.ref, d.kind, d.payment_date, d.status, d.currency, d.tranche, p.ref AS pool_ref
    FROM distribution_lines dl JOIN distributions d ON d.id = dl.distribution_id JOIN pools p ON p.id = d.pool_id WHERE dl.investor_id = ? AND d.status IN ('APPROVED','PAID') ORDER BY d.payment_date DESC`, [inv.id]);
  const documents = svc.db.all(`SELECT id, doc_type, filename, created_at FROM documents WHERE (entity_type = 'investor' AND entity_id = ?)
    OR (entity_type = 'capital_call' AND doc_type = ?) ORDER BY id DESC`, [inv.id, `NOTICE_${inv.code}`]);
  const byCcy: Record<string, any> = {};
  for (const p of positions) {
    const t = (byCcy[p.currency] ??= { currency: p.currency, committed: 0, called: 0, paid_in: 0, unfunded: 0, income: 0, returned: 0, nav: 0 });
    t.committed += p.amount_cents; t.called += p.called_cents; t.paid_in += p.paid_in_cents; t.unfunded += p.unfunded_cents;
    t.income += p.income_cents; t.returned += p.returned_capital_cents; t.nav += p.nav_cents;
  }
  return { investor: inv, totals: Object.values(byCcy), positions, calls, distributions, documents };
}

export async function statement(svc: Services, user: User, body: any, investorId?: number) {
  const input = check<any>(body, { from: { type: 'date', required: true }, to: { type: 'date', required: true } });
  if (input.from > input.to) throw validation({ to: 'must be after from' });
  const s = summary(svc, user, investorId);
  const inv = s.investor;
  const sections: any[] = [];
  for (const t of s.totals) {
    const ccy = t.currency;
    const contrib = (from: string, to: string) => s.calls.filter((c) => c.currency === ccy && c.received_at && c.received_at >= from && c.received_at <= to).reduce((a, c) => a + c.received_cents, 0);
    const dist = (kind: string, from: string, to: string) => s.distributions.filter((d) => d.currency === ccy && d.kind === kind && d.payment_date >= from && d.payment_date <= to).reduce((a, d) => a + d.amount_cents, 0);
    const before = addDays(input.from, -1);
    const opening = contrib('0000-01-01', before) - dist('CAPITAL', '0000-01-01', before);
    const inContrib = contrib(input.from, input.to);
    const inReturn = dist('CAPITAL', input.from, input.to);
    const inIncome = dist('INCOME', input.from, input.to);
    sections.push({ heading: `Capital account (${ccy})`, kv: [
      ['Opening capital balance', fmt(opening, ccy)], ['Contributions (capital calls paid)', fmt(inContrib, ccy)], ['Return of capital', `(${fmt(inReturn, ccy)})`],
      ['Closing capital balance', fmt(opening + inContrib - inReturn, ccy)], ['Income distributed in period', fmt(inIncome, ccy)], ['Unfunded commitment at period end', fmt(t.unfunded, ccy)],
    ] });
  }
  sections.push({ heading: 'Positions', table: { columns: ['Pool', 'Tranche', 'Ccy', 'Committed', 'Paid in', 'Income to date', 'Unfunded'],
    rows: s.positions.map((p) => [p.pool_ref, p.tranche, p.currency, fmt(p.amount_cents, ''), fmt(p.paid_in_cents, ''), fmt(p.income_cents, ''), fmt(p.unfunded_cents, '')]) } });
  const tx = [
    ...s.calls.filter((c) => c.received_at && c.received_at >= input.from && c.received_at <= input.to).map((c) => [c.received_at, `Contribution ${c.ref}`, c.pool_ref, fmt(c.received_cents, c.currency)]),
    ...s.distributions.filter((d) => d.payment_date >= input.from && d.payment_date <= input.to).map((d) => [d.payment_date, `${d.kind === 'INCOME' ? 'Income' : 'Capital'} distribution ${d.ref}`, d.pool_ref, fmt(d.amount_cents, d.currency)]),
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  sections.push({ heading: 'Transactions in period', table: { columns: ['Date', 'Description', 'Pool', 'Amount'], rows: tx.length ? tx : [['—', 'No transactions in this period', '', '']] } });
  const filename = `${inv.code}_statement_${input.from}_${input.to}.pdf`;
  const id = await generatePdf(svc, user, 'investor', inv.id, 'STATEMENT', filename, {
    title: `Capital account statement`, subtitle: `${inv.name} (${inv.code}) · ${input.from} to ${input.to}`, footer: `${inv.code} · Seaport Global · prepared ${now().slice(0, 10)}`,
    meta: [['Investor', `${inv.name} (${inv.code})`], ['Period', `${input.from} to ${input.to}`]], sections,
  });
  return { document_id: id, filename };
}

export async function taxSummary(svc: Services, user: User, year: number, investorId?: number) {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) throw validation({ year: 'invalid' });
  const s = summary(svc, user, investorId);
  const inv = s.investor;
  const y = String(year);
  const rows = s.totals.map((t) => {
    const income = s.distributions.filter((d) => d.currency === t.currency && d.kind === 'INCOME' && d.payment_date.startsWith(y)).reduce((a, d) => a + d.amount_cents, 0);
    const capital = s.distributions.filter((d) => d.currency === t.currency && d.kind === 'CAPITAL' && d.payment_date.startsWith(y)).reduce((a, d) => a + d.amount_cents, 0);
    const contrib = s.calls.filter((c) => c.currency === t.currency && (c.received_at ?? '').startsWith(y)).reduce((a, c) => a + c.received_cents, 0);
    return [t.currency, fmt(contrib, ''), fmt(income, ''), fmt(capital, ''), fmt(0, '')];
  });
  const filename = `${inv.code}_tax_summary_${year}.pdf`;
  const id = await generatePdf(svc, user, 'investor', inv.id, 'TAX_SUMMARY', filename, {
    title: `Tax summary ${year}`, subtitle: `${inv.name} (${inv.code})`, footer: `${inv.code} · tax year ${year} · supporting schedule`,
    sections: [
      { heading: 'Amounts for the tax year', table: { columns: ['Currency', 'Capital contributed', 'Income (interest) distributed', 'Return of capital', 'Tax withheld'], rows } },
      { paragraphs: ['This schedule supports the preparation of Schedule K-1 / Form 1099 by the fund administrator and your tax adviser. Income distributions represent interest-type income from purchased receivables. Return of capital reduces your tax basis and is not income.',
        'Final tax forms (K-1) are issued by the fund administrator after year end and will appear in this portal when available.'] },
    ],
  });
  return { document_id: id, filename };
}

export function requests(svc: Services, user: User) {
  return svc.db.all("SELECT id, ref, case_type, subject, status, created_at, resolution FROM cases WHERE created_by = ? ORDER BY id DESC", [user.username]);
}

export function submitRequest(svc: Services, user: User, body: unknown) {
  const inv = investorOf(svc, user);
  const input = check<any>(body, {
    kind: { type: 'enum', required: true, values: ['QUESTION', 'DOCUMENT', 'REDEMPTION', 'TRANSFER', 'DETAILS_CHANGE'] },
    commitment_id: { type: 'int', min: 1 },
    message: { type: 'string', required: true, maxLength: 2000 },
  });
  if (input.commitment_id && !svc.db.get('SELECT id FROM commitments WHERE id = ? AND investor_id = ?', [input.commitment_id, inv.id])) throw forbidden('Not your commitment');
  const type = input.kind === 'REDEMPTION' ? 'REDEMPTION' : input.kind === 'TRANSFER' ? 'TRANSFER' : 'INVESTOR_REQUEST';
  const labels: Record<string, string> = { QUESTION: 'Question', DOCUMENT: 'Document request', REDEMPTION: 'Redemption request', TRANSFER: 'Transfer request', DETAILS_CHANGE: 'Change of details' };
  // Investors may create cases only through this endpoint. The case is opened by the portal on the
  // investor's behalf: the audit trail records the investor's own username and role.
  return createCase(svc, user, {
    case_type: type, priority: input.kind === 'REDEMPTION' ? 'HIGH' : 'MEDIUM', subject: `${labels[input.kind]} from ${inv.name} (${inv.code})`, description: input.message,
    entity_type: input.commitment_id ? 'commitment' : 'investor', entity_id: input.commitment_id ?? inv.id,
  }, true);
}

/** Can this investor user download this document? */
export function canInvestorSee(svc: Services, user: User, doc: any) {
  const inv = investorOf(svc, user);
  return (doc.entity_type === 'investor' && doc.entity_id === inv.id) || (doc.entity_type === 'capital_call' && doc.doc_type === `NOTICE_${inv.code}`);
}
