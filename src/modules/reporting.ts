// REPORT: executive BI, ad-hoc report builder (whitelisted datasets, parameterised SQL),
// Excel / PDF / CSV export and regulatory / audit exports.

import type { Services, User } from '../core/context.ts';
import { requirePermission, now, addDays } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { check } from '../lib/validate.ts';
import { badRequest, notFound, validation } from '../lib/errors.ts';
import { fxToUsd } from './exposure.ts';
import { storeBytes, recordDocument } from './documents.ts';

type ColType = 'text' | 'money' | 'number' | 'percent' | 'date';
interface Col { key: string; label: string; type: ColType; expr: string }
interface Dataset { key: string; label: string; description: string; from: string; columns: Col[] }

const c = (key: string, label: string, type: ColType, expr: string): Col => ({ key, label, type, expr });

/** Every dataset is a fixed FROM clause plus a whitelist of column expressions; user input never reaches SQL text. */
export const DATASETS: Dataset[] = [
  { key: 'loans', label: 'Loans', description: 'Every funded loan (purchased receivable) with pricing, status and ageing.',
    from: `loans l JOIN obligors o ON o.id = l.obligor_id JOIN programs p ON p.id = l.program_id JOIN invoices i ON i.id = l.invoice_id
           JOIN investors inv ON inv.id = l.investor_id LEFT JOIN pool_loans pl ON pl.loan_id = l.id AND pl.removed_at IS NULL LEFT JOIN pools po ON po.id = pl.pool_id`,
    columns: [
      c('loan_ref', 'Loan ID', 'text', 'l.loan_ref'), c('status', 'Status', 'text', 'l.status'), c('currency', 'Currency', 'text', 'l.currency'),
      c('program', 'Program', 'text', 'p.program_code'), c('deal_name', 'Deal name', 'text', 'p.deal_name'), c('obligor', 'Obligor', 'text', 'o.name'),
      c('rating', 'Rating', 'text', 'o.rating'), c('country', 'Country', 'text', 'o.country'), c('investor', 'Investor', 'text', 'inv.code'), c('pool', 'Pool', 'text', 'po.ref'),
      c('invoice', 'Invoice', 'text', 'i.invoice_number'), c('funding_date', 'Funding date', 'date', 'l.funding_date'), c('maturity_date', 'Maturity', 'date', 'l.maturity_date'),
      c('face', 'Face amount', 'money', 'l.face_cents / 100.0'), c('purchase', 'Purchase price', 'money', 'l.purchase_cents / 100.0'),
      c('interest', 'Interest', 'money', 'l.interest_cents / 100.0'), c('received', 'Received', 'money', 'l.received_cents / 100.0'),
      c('outstanding', 'Outstanding', 'money', "CASE WHEN l.status = 'OPEN' THEN (l.face_cents - l.received_cents) / 100.0 ELSE 0 END"),
      c('all_in', 'All-in rate', 'percent', 'i.all_in_bps / 10000.0'), c('tenor_days', 'Tenor (days)', 'number', 'i.tenor_days'),
      c('days_past_due', 'Days past due', 'number', "CASE WHEN l.status = 'OPEN' AND l.maturity_date < :today THEN CAST(julianday(:today) - julianday(l.maturity_date) AS INTEGER) ELSE 0 END"),
      c('fees', 'Fees charged', 'money', 'l.fees_cents / 100.0'),
    ] },
  { key: 'invoices', label: 'Invoices', description: 'Uploaded invoices with eligibility outcome and reasons.',
    from: 'invoices i JOIN invoice_imports f ON f.id = i.import_id JOIN programs p ON p.id = i.program_id',
    columns: [
      c('invoice', 'Invoice', 'text', 'i.invoice_number'), c('buyer', 'Buyer', 'text', 'i.buyer_name'), c('program', 'Program', 'text', 'p.program_code'),
      c('file', 'File', 'text', 'f.filename'), c('status', 'Status', 'text', 'i.status'), c('reason', 'Reason', 'text', 'i.status_reason'),
      c('currency', 'Currency', 'text', 'i.currency'), c('face', 'Face amount', 'money', 'i.face_cents / 100.0'), c('due_date', 'Due date', 'date', 'i.due_date'),
      c('uploaded_by', 'Uploaded by', 'text', 'f.uploaded_by'), c('funding_date', 'Funding date', 'date', 'f.funding_date'),
    ] },
  { key: 'obligors', label: 'Obligors & limits', description: 'Obligor limits, ratings and funded exposure.',
    from: `obligors o JOIN programs p ON p.id = o.program_id
           LEFT JOIN (SELECT obligor_id, SUM(CASE WHEN status = 'OPEN' AND purchase_cents > received_cents THEN purchase_cents - received_cents ELSE 0 END) AS funded FROM loans GROUP BY obligor_id) x ON x.obligor_id = o.id`,
    columns: [
      c('obligor', 'Obligor', 'text', 'o.name'), c('program', 'Program', 'text', 'p.program_code'), c('currency', 'Currency', 'text', 'p.currency'),
      c('rating', 'Rating', 'text', 'o.rating'), c('country', 'Country', 'text', 'o.country'), c('limit', 'Limit', 'money', 'o.limit_cents / 100.0'),
      c('funded', 'Funded', 'money', 'COALESCE(x.funded, 0) / 100.0'), c('utilisation', 'Utilisation', 'percent', 'CASE WHEN o.limit_cents > 0 THEN COALESCE(x.funded, 0) * 1.0 / o.limit_cents ELSE 0 END'),
      c('advance', 'Advance rate', 'percent', 'o.advance_rate_bps / 10000.0'), c('margin', 'Investor margin', 'percent', 'o.investor_margin_bps / 10000.0'), c('spread', 'SP spread', 'percent', 'o.sp_spread_bps / 10000.0'),
      c('active', 'Active', 'number', 'o.active'),
    ] },
  { key: 'commitments', label: 'Investor positions', description: 'Commitments, called, paid-in and distributions per investor and tranche.',
    from: `commitments cm JOIN investors i ON i.id = cm.investor_id JOIN pools po ON po.id = cm.pool_id
           LEFT JOIN (SELECT commitment_id, SUM(amount_cents) called, SUM(received_cents) paid FROM capital_call_lines l JOIN capital_calls cc ON cc.id = l.call_id WHERE cc.status IN ('ISSUED','SETTLED') GROUP BY commitment_id) k ON k.commitment_id = cm.id
           LEFT JOIN (SELECT dl.commitment_id, SUM(CASE WHEN d.kind = 'INCOME' THEN dl.amount_cents ELSE 0 END) inc, SUM(CASE WHEN d.kind = 'CAPITAL' THEN dl.amount_cents ELSE 0 END) cap
                      FROM distribution_lines dl JOIN distributions d ON d.id = dl.distribution_id WHERE d.status IN ('APPROVED','PAID') GROUP BY dl.commitment_id) dd ON dd.commitment_id = cm.id`,
    columns: [
      c('investor', 'Investor', 'text', "i.code || ' ' || i.name"), c('pool', 'Pool', 'text', 'po.ref'), c('tranche', 'Tranche', 'text', 'cm.tranche'), c('currency', 'Currency', 'text', 'cm.currency'),
      c('committed', 'Committed', 'money', 'cm.amount_cents / 100.0'), c('called', 'Called', 'money', 'COALESCE(k.called, 0) / 100.0'), c('paid_in', 'Paid in', 'money', 'COALESCE(k.paid, 0) / 100.0'),
      c('income', 'Income distributed', 'money', 'COALESCE(dd.inc, 0) / 100.0'), c('capital_returned', 'Capital returned', 'money', 'COALESCE(dd.cap, 0) / 100.0'),
      c('unfunded', 'Unfunded', 'money', '(cm.amount_cents - COALESCE(k.called, 0)) / 100.0'),
    ] },
  { key: 'journal', label: 'Ledger lines', description: 'Double-entry journal lines with accounts.',
    from: 'ledger_lines ll JOIN journal_entries je ON je.id = ll.entry_id JOIN ledger_accounts a ON a.code = ll.account_code LEFT JOIN loans l ON l.id = ll.loan_id',
    columns: [
      c('entry', 'Entry', 'text', 'je.ref'), c('date', 'Date', 'date', 'je.entry_date'), c('type', 'Source', 'text', 'je.source_type'), c('currency', 'Currency', 'text', 'je.currency'),
      c('account', 'Account', 'text', "a.code || ' ' || a.name"), c('account_type', 'Account type', 'text', 'a.account_type'), c('loan', 'Loan', 'text', 'l.loan_ref'),
      c('debit', 'Debit', 'money', 'll.debit_cents / 100.0'), c('credit', 'Credit', 'money', 'll.credit_cents / 100.0'), c('net', 'Net (Dr - Cr)', 'money', '(ll.debit_cents - ll.credit_cents) / 100.0'),
      c('description', 'Description', 'text', 'je.description'), c('created_by', 'Posted by', 'text', 'je.created_by'),
    ] },
  { key: 'cases', label: 'Service cases', description: 'Servicing cases with SLA outcome.',
    from: 'cases cs',
    columns: [
      c('case', 'Case', 'text', 'cs.ref'), c('type', 'Type', 'text', 'cs.case_type'), c('priority', 'Priority', 'text', 'cs.priority'), c('status', 'Status', 'text', 'cs.status'),
      c('subject', 'Subject', 'text', 'cs.subject'), c('assignee', 'Assignee', 'text', 'cs.assignee'), c('opened', 'Opened', 'date', 'substr(cs.created_at, 1, 10)'),
      c('sla_breached', 'SLA breached', 'number', "CASE WHEN COALESCE(cs.resolved_at, :now) > cs.sla_due_at THEN 1 ELSE 0 END"),
    ] },
  { key: 'credit', label: 'Credit applications', description: 'Underwriting outcomes, scores and overrides.',
    from: 'credit_applications ca JOIN programs p ON p.id = ca.program_id',
    columns: [
      c('ref', 'Ref', 'text', 'ca.ref'), c('obligor', 'Obligor', 'text', 'ca.obligor_name'), c('type', 'Type', 'text', 'ca.application_type'), c('program', 'Program', 'text', 'p.program_code'),
      c('status', 'Status', 'text', 'ca.status'), c('requested', 'Requested limit', 'money', 'ca.requested_limit_cents / 100.0'), c('approved', 'Approved limit', 'money', 'ca.approved_limit_cents / 100.0'),
      c('score', 'Score', 'number', "CAST(json_extract(ca.engine, '$.score') AS REAL)"), c('rating', 'Engine rating', 'text', "json_extract(ca.engine, '$.rating')"),
      c('engine', 'Engine outcome', 'text', "json_extract(ca.engine, '$.outcome')"), c('override', 'Override', 'number', 'ca.override'), c('prepared_by', 'Prepared by', 'text', 'ca.prepared_by'), c('decided_by', 'Decided by', 'text', 'ca.decided_by'),
    ] },
];

const OPS: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const AGGS = ['sum', 'avg', 'min', 'max', 'count'];

export function datasets() {
  return DATASETS.map((d) => ({ key: d.key, label: d.label, description: d.description, columns: d.columns.map(({ key, label, type }) => ({ key, label, type })) }));
}

export interface ReportDef {
  dataset: string; columns: string[]; filters?: { column: string; op: string; value: any }[];
  group_by?: string[]; aggregates?: { column: string; fn: string }[]; sort?: { column: string; dir: 'asc' | 'desc' }; limit?: number;
}

export function runReport(svc: Services, def: ReportDef) {
  const ds = DATASETS.find((d) => d.key === def?.dataset);
  if (!ds) throw validation({ dataset: 'unknown dataset' });
  const col = (k: string) => {
    const x = ds.columns.find((cc) => cc.key === k);
    if (!x) throw validation({ columns: `unknown column ${k}` });
    return x;
  };
  const params: any[] = [];
  const sub = (expr: string) => expr.replaceAll(':today', `'${svc.today()}'`).replaceAll(':now', `'${now()}'`);
  const groups = (def.group_by ?? []).map(col);
  const aggs = (def.aggregates ?? []).map((a) => {
    if (!AGGS.includes(a.fn)) throw validation({ aggregates: `unknown function ${a.fn}` });
    const x = col(a.column);
    if (a.fn !== 'count' && x.type === 'text') throw validation({ aggregates: `${x.label} is not numeric` });
    return { ...x, fn: a.fn, key: `${a.fn}_${x.key}`, label: `${a.fn === 'count' ? 'Count' : a.fn[0].toUpperCase() + a.fn.slice(1)} of ${x.label}`, type: (a.fn === 'count' ? 'number' : x.type) as ColType };
  });
  const cols = groups.length || aggs.length ? groups : (def.columns?.length ? def.columns.map(col) : ds.columns.slice(0, 8));
  const select = [
    ...cols.map((x) => `${sub(x.expr)} AS "${x.key}"`),
    ...aggs.map((a) => `${a.fn.toUpperCase()}(${sub(a.expr)}) AS "${a.key}"`),
  ];
  if (!select.length) throw validation({ columns: 'choose at least one column' });
  const where: string[] = [];
  for (const f of def.filters ?? []) {
    const x = col(f.column);
    if (f.op === 'contains') { where.push(`${sub(x.expr)} LIKE ?`); params.push(`%${f.value}%`); }
    else if (f.op === 'in') { const vals = String(f.value).split(',').map((v) => v.trim()).filter(Boolean); where.push(`${sub(x.expr)} IN (${vals.map(() => '?').join(',')})`); params.push(...vals); }
    else if (OPS[f.op]) { where.push(`${sub(x.expr)} ${OPS[f.op]} ?`); params.push(x.type === 'text' || x.type === 'date' ? String(f.value) : Number(f.value)); }
    else throw validation({ filters: `unknown operator ${f.op}` });
  }
  let sql = `SELECT ${select.join(', ')} FROM ${ds.from}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
  if (groups.length) sql += ` GROUP BY ${groups.map((g) => sub(g.expr)).join(', ')}`;
  const outCols = [...cols, ...aggs];
  if (def.sort) {
    const s = outCols.find((x) => x.key === def.sort!.column);
    if (s) sql += ` ORDER BY "${s.key}" ${def.sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
  }
  const limit = Math.min(Math.max(Number(def.limit) || 1000, 1), 20000);
  sql += ` LIMIT ${limit}`;
  const rows = svc.db.all(sql, params);
  return { dataset: ds.label, columns: outCols.map(({ key, label, type }) => ({ key, label, type })), rows, truncated: rows.length === limit };
}

// ---------- Exports ----------

export async function exportTable(svc: Services, user: User, title: string, table: { columns: { key: string; label: string; type: string }[]; rows: any[] }, format: string) {
  const stamp = now().slice(0, 16).replace(/[-:T]/g, '');
  const safe = title.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 60) || 'report';
  let bytes: Buffer;
  let filename: string;
  let contentType: string;
  if (format === 'xlsx') {
    const r = await svc.engine.call('/export/xlsx', { sheets: [{ name: title.slice(0, 31), columns: table.columns.map((x) => ({ label: x.label, type: x.type })), rows: table.rows.map((row) => table.columns.map((x) => row[x.key])) }] });
    bytes = Buffer.from(r.content_base64, 'base64');
    filename = `${safe}_${stamp}.xlsx`;
    contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else if (format === 'pdf') {
    const fmt = (v: any, t: string) => (v == null ? '' : t === 'money' ? Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : t === 'percent' ? `${(Number(v) * 100).toFixed(2)}%` : String(v));
    const r = await svc.engine.pdf({
      title, subtitle: `${table.rows.length} rows · generated ${now().slice(0, 16).replace('T', ' ')} UTC by ${user.name}`, footer: `${title} · Seaport Global · Confidential`,
      sections: [{ table: { columns: table.columns.map((x) => x.label), rows: table.rows.slice(0, 2000).map((row) => table.columns.map((x) => fmt(row[x.key], x.type))), align: table.columns.map((x) => (['money', 'number', 'percent'].includes(x.type) ? 'r' : 'l')) } }],
    });
    bytes = Buffer.from(r.content_base64, 'base64');
    filename = `${safe}_${stamp}.pdf`;
    contentType = 'application/pdf';
  } else if (format === 'csv') {
    const esc = (v: any) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    bytes = Buffer.from('﻿' + [table.columns.map((x) => esc(x.label)).join(','), ...table.rows.map((row) => table.columns.map((x) => esc(row[x.key])).join(','))].join('\r\n') + '\r\n', 'utf8');
    filename = `${safe}_${stamp}.csv`;
    contentType = 'text/csv';
  } else throw validation({ format: 'xlsx, pdf or csv' });
  const stored = await storeBytes(svc, bytes);
  const id = svc.db.tx(() => recordDocument(svc, user, { entity_type: 'report', entity_id: 0, doc_type: 'EXPORT', filename, content_type: contentType, stored, generated: true }));
  return { document_id: id, filename, size_bytes: bytes.length };
}

export async function exportReport(svc: Services, user: User, body: any) {
  requirePermission(user, 'reports.view');
  const result = runReport(svc, body?.definition);
  const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : result.dataset;
  return exportTable(svc, user, title, result, body?.format ?? 'xlsx');
}

export function listSaved(svc: Services, user: User) {
  return svc.db.all('SELECT * FROM saved_reports WHERE owner = ? OR shared = 1 ORDER BY name', [user.username]).map((r) => ({ ...r, definition: JSON.parse(r.definition), mine: r.owner === user.username }));
}

export function saveReport(svc: Services, user: User, body: any) {
  requirePermission(user, 'reports.view');
  const input = check<any>(body, { name: { type: 'string', required: true, maxLength: 120 }, shared: { type: 'bool' } });
  runReport(svc, { ...body.definition, limit: 1 }); // validates
  return svc.db.tx(() => {
    const r = svc.db.run('INSERT INTO saved_reports (name, definition, owner, shared, created_at, updated_at) VALUES (?,?,?,?,?,?)', [input.name, JSON.stringify(body.definition), user.username, input.shared ? 1 : 0, now(), now()]);
    audit.record(svc.db, user, 'report.saved', 'report', r.id, { name: input.name, dataset: body.definition.dataset });
    return { status: 201, json: { id: r.id } };
  });
}

// ---------- Executive BI ----------

export function executive(svc: Services) {
  const today = svc.today();
  const usd = fxToUsd(svc.db);
  const open = svc.db.all(`SELECT l.*, i.all_in_bps, o.name AS obligor, o.rating, p.program_code FROM loans l JOIN invoices i ON i.id = l.invoice_id JOIN obligors o ON o.id = l.obligor_id JOIN programs p ON p.id = l.program_id WHERE l.status = 'OPEN'`);
  const princ = (l: any) => usd(Math.max(l.purchase_cents - l.received_cents, 0), l.currency);
  const total = open.reduce((a, l) => a + princ(l), 0) || 1;
  const wa = (f: (l: any) => number) => open.reduce((a, l) => a + f(l) * princ(l), 0) / total;
  const dpd = (l: any) => (l.maturity_date < today ? Math.round((Date.parse(today) - Date.parse(l.maturity_date)) / 864e5) : 0);
  const npl = open.filter((l) => dpd(l) > 90).reduce((a, l) => a + princ(l), 0);
  const del30 = open.filter((l) => dpd(l) > 30).reduce((a, l) => a + princ(l), 0);
  const pastDue = open.filter((l) => dpd(l) > 0).reduce((a, l) => a + princ(l), 0);
  // LTV for collateralised obligors (approved credit applications with collateral values).
  const coll = svc.db.all(`SELECT ca.obligor_id, ca.collateral_value_cents, p.currency FROM credit_applications ca JOIN programs p ON p.id = ca.program_id
    WHERE ca.status = 'APPROVED' AND ca.collateral_value_cents > 0 AND ca.id IN (SELECT MAX(id) FROM credit_applications WHERE status = 'APPROVED' GROUP BY obligor_id)`);
  let ltvNum = 0, ltvDen = 0;
  for (const c of coll) {
    const exp = open.filter((l) => l.obligor_id === c.obligor_id).reduce((a, l) => a + princ(l), 0);
    if (exp) { ltvNum += exp; ltvDen += usd(c.collateral_value_cents, c.currency); }
  }
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(Date.parse(today) - (11 - i) * 30.44 * 864e5); return d.toISOString().slice(0, 7); });
  const trend = months.map((m) => {
    const funded = svc.db.all(`SELECT l.purchase_cents, l.currency, i.all_in_bps FROM loans l JOIN invoices i ON i.id = l.invoice_id WHERE substr(l.funding_date, 1, 7) = ?`, [m]);
    const vol = funded.reduce((a, l) => a + usd(l.purchase_cents, l.currency), 0);
    const collected = svc.db.all(`SELECT received_cents, currency FROM loans WHERE status = 'SETTLED' AND substr(settled_at, 1, 7) = ?`, [m]).reduce((a, l) => a + usd(l.received_cents, l.currency), 0);
    return { month: m, funded_usd_cents: vol, collected_usd_cents: collected, wa_yield_bps: vol ? Math.round(funded.reduce((a, l) => a + l.all_in_bps * usd(l.purchase_cents, l.currency), 0) / vol) : null };
  });
  const by = (key: (l: any) => string) => Object.entries(open.reduce((a: Record<string, number>, l) => ({ ...a, [key(l)]: (a[key(l)] ?? 0) + princ(l) }), {}))
    .map(([label, cents]) => ({ label, usd_cents: cents, pct: Math.round((cents * 1000) / total) / 10 })).sort((a, b) => b.usd_cents - a.usd_cents);
  const spread = svc.db.all(`SELECT je.currency, SUM(l.credit_cents) s FROM ledger_lines l JOIN journal_entries je ON je.id = l.entry_id WHERE l.account_code IN ('4000','4100','4200') AND je.entry_date >= ? GROUP BY je.currency`, [addDays(today, -90)])
    .reduce((a, r) => a + usd(r.s, r.currency), 0);
  return {
    as_of: today,
    kpis: {
      outstanding_usd_cents: total === 1 ? 0 : total, loans: open.length,
      portfolio_yield_bps: Math.round(wa((l) => l.all_in_bps ?? 0)), wa_days_remaining: Math.round(wa((l) => Math.max(0, (Date.parse(l.maturity_date) - Date.parse(today)) / 864e5))),
      npl_ratio_pct: Math.round((npl * 10000) / total) / 100, delinquency_30_pct: Math.round((del30 * 10000) / total) / 100, past_due_pct: Math.round((pastDue * 10000) / total) / 100,
      ltv_pct: ltvDen ? Math.round((ltvNum * 10000) / ltvDen) / 100 : null, ltv_coverage_obligors: coll.length,
      revenue_90d_usd_cents: spread,
    },
    trend,
    top_obligors: by((l) => l.obligor).slice(0, 10),
    by_rating: by((l) => l.rating),
    by_program: by((l) => l.program_code),
  };
}

// ---------- Regulatory / audit exports ----------

export const REGULATORY = [
  { key: 'audit-trail', label: 'Audit trail (SOC 1 / SEC 17a-4 support)', description: 'Every recorded action with actor, timestamp and the hash chain; includes the chain verification result.' },
  { key: 'loan-tape', label: 'Asset-level loan tape', description: 'Loan-level data for investors and regulators (Reg AB II style subset): obligor, dates, amounts, rate, status, delinquency.' },
  { key: 'tax-summary', label: 'Investor tax summary (1099 / K-1 support)', description: 'Per investor and tax year: contributions, income distributions, return of capital.' },
  { key: 'large-exposures', label: 'Large exposures and concentration', description: 'Exposure per obligor against limit and as a share of the funded book.' },
  { key: 'sod-evidence', label: 'Segregation-of-duties evidence', description: 'Maker / checker pairs for fundings, credit decisions, cash postings and payment batches.' },
  { key: 'aml-screening', label: 'KYC / AML screening log', description: 'Screening and bureau results for every credit application.' },
];

export async function regulatoryExport(svc: Services, user: User, key: string, body: any) {
  requirePermission(user, 'reports.regulatory');
  const from = body?.from ?? addDays(svc.today(), -365);
  const to = body?.to ?? svc.today();
  const year = Number(body?.year) || Number(svc.today().slice(0, 4));
  const format = body?.format ?? 'xlsx';
  let table: { columns: { key: string; label: string; type: string }[]; rows: any[] };
  let title: string;
  const col = (key: string, label: string, type = 'text') => ({ key, label, type });
  if (key === 'audit-trail') {
    const v = audit.verify(svc.db);
    title = `Audit trail ${from} to ${to}`;
    table = { columns: [col('id', 'Seq', 'number'), col('ts', 'Timestamp (UTC)'), col('actor', 'Actor'), col('role', 'Role'), col('action', 'Action'), col('entity', 'Entity'), col('details', 'Details'), col('prev_hash', 'Previous hash'), col('hash', 'Hash')],
      rows: svc.db.all('SELECT * FROM audit_log WHERE substr(ts, 1, 10) BETWEEN ? AND ? ORDER BY id', [from, to]).map((r) => ({ ...r, entity: `${r.entity_type}:${r.entity_id ?? ''}` })) };
    table.rows.push({ id: null, ts: now(), actor: 'system', role: '', action: `CHAIN VERIFICATION: ${v.valid ? 'VALID' : `BROKEN at ${v.brokenAt}`}`, entity: '', details: `${v.checked} records checked`, prev_hash: '', hash: '' });
  } else if (key === 'loan-tape') {
    title = `Loan tape as of ${svc.today()}`;
    table = runReport(svc, { dataset: 'loans', columns: ['loan_ref', 'status', 'currency', 'program', 'obligor', 'rating', 'country', 'pool', 'funding_date', 'maturity_date', 'face', 'purchase', 'interest', 'received', 'outstanding', 'all_in', 'tenor_days', 'days_past_due', 'fees'], limit: 20000 });
  } else if (key === 'tax-summary') {
    title = `Investor tax summary ${year}`;
    const rows = svc.db.all(`SELECT i.code, i.name, cm.currency,
        COALESCE((SELECT SUM(l.received_cents) FROM capital_call_lines l WHERE l.investor_id = i.id AND substr(l.received_at, 1, 4) = ?), 0) / 100.0 AS contributions,
        COALESCE((SELECT SUM(dl.amount_cents) FROM distribution_lines dl JOIN distributions d ON d.id = dl.distribution_id WHERE dl.investor_id = i.id AND d.kind = 'INCOME' AND d.status IN ('APPROVED','PAID') AND substr(d.payment_date, 1, 4) = ?), 0) / 100.0 AS income,
        COALESCE((SELECT SUM(dl.amount_cents) FROM distribution_lines dl JOIN distributions d ON d.id = dl.distribution_id WHERE dl.investor_id = i.id AND d.kind = 'CAPITAL' AND d.status IN ('APPROVED','PAID') AND substr(d.payment_date, 1, 4) = ?), 0) / 100.0 AS capital
      FROM investors i JOIN commitments cm ON cm.investor_id = i.id GROUP BY i.id, cm.currency ORDER BY i.code`, [String(year), String(year), String(year)]);
    table = { columns: [col('code', 'Investor ID'), col('name', 'Investor'), col('currency', 'Currency'), col('contributions', 'Capital contributed', 'money'), col('income', 'Income distributed (ordinary)', 'money'), col('capital', 'Return of capital', 'money')], rows };
  } else if (key === 'large-exposures') {
    title = `Large exposures as of ${svc.today()}`;
    const usd = fxToUsd(svc.db);
    const ob = runReport(svc, { dataset: 'obligors', columns: ['obligor', 'program', 'currency', 'rating', 'country', 'limit', 'funded', 'utilisation'], limit: 5000 }).rows;
    const tot = ob.reduce((a, r) => a + usd(Math.round(r.funded * 100), r.currency), 0) || 1;
    table = { columns: [col('obligor', 'Obligor'), col('program', 'Program'), col('currency', 'Ccy'), col('rating', 'Rating'), col('country', 'Country'), col('limit', 'Limit', 'money'), col('funded', 'Funded', 'money'), col('utilisation', 'Utilisation', 'percent'), col('share', 'Share of book (USD eq.)', 'percent')],
      rows: ob.map((r) => ({ ...r, share: usd(Math.round(r.funded * 100), r.currency) / tot })).sort((a, b) => b.share - a.share) };
  } else if (key === 'sod-evidence') {
    title = 'Segregation of duties evidence';
    const rows = [
      ...svc.db.all("SELECT 'Funding approval' AS control, filename AS item, uploaded_by AS maker, approved_by AS checker, approved_at AS at FROM invoice_imports WHERE status = 'APPROVED'"),
      ...svc.db.all("SELECT 'Credit decision' AS control, ref || ' ' || obligor_name AS item, prepared_by AS maker, decided_by AS checker, decided_at AS at FROM credit_applications WHERE decided_by IS NOT NULL"),
      ...svc.db.all("SELECT 'Payment batch' AS control, ref AS item, created_by AS maker, approved_by AS checker, approved_at AS at FROM payment_batches WHERE approved_by IS NOT NULL"),
      ...svc.db.all("SELECT 'Capital call' AS control, ref AS item, created_by AS maker, approved_by AS checker, issued_at AS at FROM capital_calls WHERE approved_by IS NOT NULL"),
      ...svc.db.all("SELECT 'Amendment' AS control, amendment_type || ' #' || id AS item, requested_by AS maker, decided_by AS checker, decided_at AS at FROM amendments WHERE decided_by IS NOT NULL"),
      ...svc.db.all("SELECT 'Pool activation' AS control, ref AS item, created_by AS maker, activated_by AS checker, activated_at AS at FROM pools WHERE activated_by IS NOT NULL"),
    ].map((r) => ({ ...r, compliant: r.maker !== r.checker ? 'Yes' : 'NO' }));
    table = { columns: [col('control', 'Control'), col('item', 'Item'), col('maker', 'Maker'), col('checker', 'Checker'), col('at', 'Approved at'), col('compliant', 'Maker ≠ checker')], rows };
  } else if (key === 'aml-screening') {
    title = 'KYC / AML screening log';
    table = { columns: [col('ref', 'Application'), col('obligor', 'Obligor'), col('country', 'Country'), col('provider', 'Provider'), col('reference', 'Screening ref'), col('sanctions', 'Sanctions'), col('pep', 'PEP'), col('adverse', 'Adverse media'), col('bureau', 'Bureau score', 'number'), col('status', 'Status')],
      rows: svc.db.all('SELECT ref, obligor_name, country, screening, bureau, status FROM credit_applications WHERE screening IS NOT NULL ORDER BY id').map((r) => {
        const s = JSON.parse(r.screening); const b = JSON.parse(r.bureau ?? '{}');
        return { ref: r.ref, obligor: r.obligor_name, country: r.country, provider: s.provider, reference: s.reference, sanctions: s.sanctions_hit ? 'MATCH' : 'clear', pep: s.pep_hit ? 'MATCH' : 'clear', adverse: s.adverse_media ? 'found' : 'none', bureau: b.bureau_score ?? null, status: r.status };
      }) };
  } else throw notFound('Export');
  const r = await exportTable(svc, user, title, table, format);
  svc.db.tx(() => audit.record(svc.db, user, 'regulatory_export.generated', 'report', null, { export: key, rows: table.rows.length, filename: r.filename, from, to }));
  return r;
}

export function exportHistory(svc: Services) {
  return svc.db.all("SELECT id, filename, content_type, size_bytes, created_by, created_at FROM documents WHERE entity_type = 'report' ORDER BY id DESC LIMIT 50");
}

export function assertDataset(key: string) {
  if (!DATASETS.some((d) => d.key === key)) throw badRequest('Unknown dataset');
}
