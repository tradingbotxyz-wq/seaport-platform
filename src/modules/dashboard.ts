// PORTFOLIO DASHBOARD with filters (product, deal, date range), past-due ageing with the last
// collection action, and the month-end utilisation history.
//
// Filters: ?products=SCF,RPA&program_id=3&from=2023-11&to=2026-11
//   products / program_id narrow every panel; from / to set the utilisation-history window.

import type { Services, User } from '../core/context.ts';
import { addDays, daysBetween, now, requirePermission } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { obligorUsage, fxToUsd } from './exposure.ts';
import { openLoans } from './settlement.ts';
import { notFound, validation } from '../lib/errors.ts';

export const PRODUCTS = [
  { code: 'SCF', label: 'Payables / SCF' },
  { code: 'RPA', label: 'Receivables discounting' },
  { code: 'IF', label: 'Inventory / distributor' },
  { code: 'LC_BACKED', label: 'LC-backed' },
  { code: 'INSURED_AR', label: 'Credit-mitigated' },
];

export const AGE_BUCKETS = [
  { key: '1-30', label: '1–30 days', lo: 1, hi: 30 },
  { key: '31-60', label: '31–60 days', lo: 31, hi: 60 },
  { key: '61-90', label: '61–90 days', lo: 61, hi: 90 },
  { key: '90+', label: 'Over 90 days', lo: 91, hi: Infinity },
];

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const monthOf = (iso: string) => iso.slice(0, 7);
export function addMonths(month: string, n: number) {
  const [y, m] = month.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
export function monthEnd(month: string) {
  return addDays(`${addMonths(month, 1)}-01`, -1);
}

/** Funded principal (finance amount) per program as of a date, from the loan book. */
function fundedAsOf(svc: Services, programId: number, date: string) {
  return svc.db.get<{ s: number }>(`SELECT COALESCE(SUM(purchase_cents), 0) s FROM loans WHERE program_id = ? AND funding_date <= ?
    AND (status = 'OPEN' OR substr(COALESCE(settled_at, '9999'), 1, 10) > ?)`, [programId, date, date])!.s;
}

/** Month-end job: write a snapshot for every completed month that has none. Idempotent. */
export function snapshotMonthEnds(svc: Services) {
  const lastClosed = addMonths(monthOf(svc.today()), -1);
  const programs = svc.db.all<any>("SELECT p.id, p.currency, p.created_at, (SELECT COALESCE(SUM(limit_cents), 0) FROM obligors o WHERE o.program_id = p.id AND o.active = 1) AS limit_cents FROM programs p WHERE p.status <> 'CLOSED'");
  let written = 0;
  for (const p of programs) {
    const latest = svc.db.get<{ m: string | null }>('SELECT MAX(month) m FROM utilisation_snapshots WHERE program_id = ?', [p.id])!.m;
    let month = latest ? addMonths(latest, 1) : lastClosed;
    for (; month <= lastClosed; month = addMonths(month, 1)) {
      svc.db.run('INSERT OR IGNORE INTO utilisation_snapshots (month, program_id, currency, limit_cents, used_cents, source, created_at) VALUES (?,?,?,?,?,?,?)',
        [month, p.id, p.currency, p.limit_cents, fundedAsOf(svc, p.id, monthEnd(month)), 'MONTH_END_JOB', now()]);
      written++;
    }
  }
  return { written };
}

export function logCollectionAction(svc: Services, user: User, loanId: number, body: any) {
  requirePermission(user, 'service.cases');
  const loan = svc.db.get<any>('SELECT id, loan_ref, status FROM loans WHERE id = ?', [loanId]);
  if (!loan) throw notFound('Loan');
  const action = typeof body?.action === 'string' ? body.action.trim() : '';
  if (!action || action.length > 120) throw validation({ action: 'describe the action (max 120 characters)' });
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 1000) : null;
  return svc.db.tx(() => {
    const r = svc.db.run('INSERT INTO collection_actions (loan_id, action, note, actor, at) VALUES (?,?,?,?,?)', [loanId, action, note, user.username, now()]);
    audit.record(svc.db, user, 'collection.action', 'loan', loanId, { loan_ref: loan.loan_ref, action });
    return { status: 201, json: { id: r.id } };
  });
}

export function collectionActions(svc: Services, loanId: number) {
  return svc.db.all('SELECT c.*, u.name AS actor_name FROM collection_actions c LEFT JOIN users u ON u.username = c.actor WHERE loan_id = ? ORDER BY at DESC, id DESC', [loanId]);
}

function lastAction(svc: Services, loanId: number) {
  const ca = svc.db.get<any>('SELECT action, at FROM collection_actions WHERE loan_id = ? ORDER BY at DESC, id DESC LIMIT 1', [loanId]);
  const ce = svc.db.get<any>(`SELECT e.body, e.at FROM case_events e JOIN cases c ON c.id = e.case_id
    WHERE c.entity_type = 'loan' AND c.entity_id = ? ORDER BY e.at DESC, e.id DESC LIMIT 1`, [loanId]);
  if (ca) return { text: ca.action, at: ca.at }; // the collection log is the primary record
  if (ce) return { text: ce.body.length > 60 ? ce.body.slice(0, 57) + '…' : ce.body, at: ce.at };
  return null;
}

export function dashboard(svc: Services, query: URLSearchParams = new URLSearchParams()) {
  const today = svc.today();
  const usd = fxToUsd(svc.db);
  const allPrograms = svc.db.all<any>("SELECT id, program_code, deal_name, program_type, currency FROM programs WHERE status = 'ACTIVE' ORDER BY deal_name");

  // ---- filters
  const products = (query.get('products') ?? '').split(',').map((s) => s.trim()).filter((s) => PRODUCTS.some((p) => p.code === s));
  const programId = Number(query.get('program_id')) || null;
  const thisMonth = monthOf(today);
  let to = query.get('to') ?? thisMonth;
  let from = query.get('from') ?? addMonths(thisMonth, -35);
  if (!MONTH.test(from) || !MONTH.test(to)) throw validation({ from: 'use YYYY-MM', to: 'use YYYY-MM' });
  if (to > thisMonth) to = thisMonth;
  if (from > to) [from, to] = [to, from];
  const programs = allPrograms.filter((p) => (!products.length || products.includes(p.program_type)) && (!programId || p.id === programId));
  const ids = new Set(programs.map((p) => p.id));

  const usage = obligorUsage(svc.db).filter((o) => ids.has(o.program_id));
  const limits = usage.reduce((a, o) => a + usd(o.limit_cents, o.currency), 0);
  const funded = usage.reduce((a, o) => a + usd(o.funded_cents, o.currency), 0);
  const pipe = usage.reduce((a, o) => a + usd(o.pipeline_cents, o.currency), 0);
  const loans = openLoans(svc).filter((l) => ids.has(l.program_id));
  const window = loans.filter((l) => l.maturity_date >= today && l.maturity_date <= addDays(today, 7));
  const pastDue = loans.filter((l) => l.maturity_date < today);
  const days = Array.from({ length: 8 }, (_, d) => {
    const date = addDays(today, d);
    const due = window.filter((l) => l.maturity_date === date);
    return { day: d, date, label: d === 0 ? 'Today' : `D+${d}`, amount_usd_cents: due.reduce((a, l) => a + usd(l.outstanding_cents, l.currency), 0), count: due.length };
  });

  // ---- past due, aged from the (adjusted) maturity date
  const pastRows = pastDue.map((l) => {
    const dpd = daysBetween(l.maturity_date, today);
    const la = lastAction(svc, l.id);
    return { id: l.id, loan_ref: l.loan_ref, buyer: l.buyer, deal_name: l.deal_name, maturity_date: l.maturity_date, days_past_due: dpd,
      bucket: AGE_BUCKETS.find((b) => dpd >= b.lo && dpd <= b.hi)!.key, currency: l.currency, outstanding_cents: l.outstanding_cents,
      outstanding_usd_cents: usd(l.outstanding_cents, l.currency), last_action: la?.text ?? 'No action yet', last_action_at: la?.at ?? null };
  }).sort((a, b) => b.days_past_due - a.days_past_due);
  const buckets = AGE_BUCKETS.map((b) => {
    const rows = pastRows.filter((r) => r.bucket === b.key);
    return { key: b.key, label: b.label, count: rows.length, amount_usd_cents: rows.reduce((a, r) => a + r.outstanding_usd_cents, 0) };
  });

  // ---- month-end utilisation history (+ live point for the current month)
  const snaps = programs.length ? svc.db.all<any>(`SELECT month, currency, limit_cents, used_cents FROM utilisation_snapshots
    WHERE month BETWEEN ? AND ? AND program_id IN (${programs.map(() => '?').join(',')})`, [from, to, ...programs.map((p) => p.id)]) : [];
  const byMonth = new Map<string, { lim: number; used: number }>();
  for (const s of snaps) {
    const m = byMonth.get(s.month) ?? { lim: 0, used: 0 };
    m.lim += usd(s.limit_cents, s.currency); m.used += usd(s.used_cents, s.currency);
    byMonth.set(s.month, m);
  }
  const history: { month: string; pct: number; live?: boolean }[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) {
    if (m === thisMonth) { if (limits) history.push({ month: m, pct: Math.round((funded * 1000) / limits) / 10, live: true }); continue; }
    const v = byMonth.get(m);
    if (v && v.lim) history.push({ month: m, pct: Math.round((v.used * 1000) / v.lim) / 10 });
  }
  const vals = history.map((h) => h.pct);
  const breaks = svc.db.get<{ n: number }>("SELECT COUNT(*) n FROM bank_lines WHERE match_status IN ('UNMATCHED','AMOUNT_MISMATCH')")!.n;

  return {
    as_of: today,
    refreshed_at: now(),
    filters: { products, program_id: programId, from, to },
    options: { products: PRODUCTS, programs: allPrograms },
    deals_in_scope: programs.length,
    utilisation: {
      pct: limits ? Math.round(((funded + pipe) * 1000) / limits) / 10 : 0,
      funded_usd_cents: funded, pipeline_usd_cents: pipe, headroom_usd_cents: Math.max(limits - funded - pipe, 0),
    },
    kpis: {
      approved_limits_usd_cents: limits,
      buyers_in_scope: usage.length,
      outstanding_usd_cents: funded,
      pipeline_usd_cents: pipe,
      limit_breaches: usage.filter((o) => o.status === 'Breach').length,
      limit_tight: usage.filter((o) => o.status === 'Tight').length,
      due_7d_usd_cents: window.reduce((a, l) => a + usd(l.outstanding_cents, l.currency), 0),
      due_7d_count: window.length,
      past_due_usd_cents: pastRows.reduce((a, r) => a + r.outstanding_usd_cents, 0),
      past_due_count: pastRows.length,
      recon_breaks: breaks,
      files_awaiting_approval: svc.db.get<{ n: number }>("SELECT COUNT(*) n FROM invoice_imports WHERE status = 'UPLOADED'")!.n,
      credit_awaiting_decision: svc.db.get<{ n: number }>("SELECT COUNT(*) n FROM credit_applications WHERE status IN ('IN_REVIEW','REFERRED')")!.n,
      cases_attention: svc.db.get<{ n: number }>("SELECT COUNT(*) n FROM cases WHERE status NOT IN ('RESOLVED','REJECTED') AND (sla_due_at < ? OR priority = 'URGENT' OR status = 'PENDING_APPROVAL')", [new Date().toISOString()])!.n,
    },
    buyers: usage
      .map((o) => ({ id: o.id, name: o.name, rating: o.rating, role: o.role, deal_name: o.deal_name, currency: o.currency, limit_cents: o.limit_cents,
        funded_cents: o.funded_cents, pipeline_cents: o.pipeline_cents, used_cents: o.used_cents, used_pct: o.used_pct,
        funded_pct: o.limit_cents ? Math.round((o.funded_cents * 1000) / o.limit_cents) / 10 : 0,
        pipeline_pct: o.limit_cents ? Math.round((o.pipeline_cents * 1000) / o.limit_cents) / 10 : 0,
        headroom_cents: o.headroom_cents, status: o.status }))
      .sort((a, b) => b.used_pct - a.used_pct),
    next7: days,
    due_loans: window.map((l) => ({
      id: l.id, loan_ref: l.loan_ref, buyer: l.buyer, deal_name: l.deal_name, maturity_date: l.maturity_date, days: daysBetween(today, l.maturity_date),
      currency: l.currency, outstanding_cents: l.outstanding_cents, outstanding_usd_cents: usd(l.outstanding_cents, l.currency), state: l.state,
    })),
    past_due: { buckets, loans: pastRows },
    history: { points: history, peak: vals.length ? Math.max(...vals) : null, average: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null,
      trough: vals.length ? Math.min(...vals) : null, threshold_pct: 90 },
  };
}
