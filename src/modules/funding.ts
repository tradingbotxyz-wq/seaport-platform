// CLIENT ONBOARDING + PURCHASE & FUNDING
//
// Upload -> parse (Python) -> per-invoice checks -> limit check per obligor -> investor tagging
// -> four-eyes approval -> loans created + ledger posted.
//
// Invoice states: PENDING (eligible, in pipeline) | HELD (limit) | REJECTED (rule or user) | FUNDED | REMOVED

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Services, User } from '../core/context.ts';
import { requirePermission, now, nextRef, addBusinessDays, daysBetween } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { emit } from '../core/outbox.ts';
import { check } from '../lib/validate.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { currentUtilisation, pipeline, purchasePrice, limitStatus, pct } from './exposure.ts';
import { fixingsFor } from './master.ts';
import * as ledger from './ledger.ts';
import { queueFundingPayment } from './fund.ts';

const MAX_FILE = 10 * 1024 * 1024;
const USER_REJECT = 'Rejected by ';

// ---------- Upload ----------

export async function uploadInvoiceFile(svc: Services, user: User, body: unknown) {
  requirePermission(user, 'invoices.upload');
  const input = check<any>(body, {
    program_id: { type: 'int', required: true, min: 1 },
    funding_date: { type: 'date', required: true },
    filename: { type: 'string', required: true, maxLength: 200 },
    content_base64: { type: 'string', required: true },
  });
  const program = svc.db.get('SELECT * FROM programs WHERE id = ?', [input.program_id]);
  if (!program) throw badRequest('Unknown program');
  if (program.status !== 'ACTIVE') throw conflict(`Program ${program.program_code} is ${program.status}`);
  const bytes = Buffer.from(input.content_base64, 'base64');
  if (!bytes.length) throw badRequest('File is empty');
  if (bytes.length > MAX_FILE) throw badRequest('File exceeds 10 MB');

  const uploadDate = svc.today();
  const earliest = addBusinessDays(uploadDate, program.funding_lag_days);
  if (input.funding_date < earliest) {
    throw badRequest(`Funding date must be on or after ${earliest} (T+${program.funding_lag_days} from upload). Same-day funding is not permitted.`);
  }

  const parsed = await svc.engine.parse(input.filename, input.content_base64, 'invoice');
  if (svc.db.get("SELECT id FROM invoice_imports WHERE sha256 = ? AND program_id = ? AND status <> 'REMOVED'", [parsed.sha256, program.id])) {
    throw conflict('This exact file has already been uploaded to this program (checksum match)');
  }
  const safeName = input.filename.replace(/[\\/:*?"<>|]/g, '_');
  await mkdir(join(svc.filesDir, 'invoices'), { recursive: true });
  const storageKey = `invoices/${parsed.sha256}`;
  await writeFile(join(svc.filesDir, storageKey), bytes);

  return svc.db.tx(() => {
    const obligors = svc.db.all('SELECT * FROM obligors WHERE program_id = ?', [program.id]);
    const byName = new Map(obligors.map((o) => [o.name.trim().toLowerCase(), o]));
    const ts = now();
    const { id: importId } = svc.db.run(
      `INSERT INTO invoice_imports (program_id, filename, file_format, sha256, size_bytes, storage_key, funding_date, rows_read, accepted, rejected, parse_report, status, uploaded_by, uploaded_at)
       VALUES (?,?,?,?,?,?,?,?,0,0,?, 'UPLOADED', ?, ?)`,
      [program.id, safeName, parsed.format, parsed.sha256, bytes.length, storageKey, input.funding_date, parsed.rows_read,
        JSON.stringify({ skipped: parsed.skipped, warnings: parsed.warnings }), user.username, ts],
    );
    const seenInFile = new Set<string>();
    for (const row of parsed.rows) {
      const ob = byName.get(String(row.buyer).trim().toLowerCase());
      let status = 'PENDING';
      let reason: string | null = null;
      const key = `${row.buyer}|${row.invoice_number}`.toLowerCase();
      if (!ob) [status, reason] = ['REJECTED', `Buyer "${row.buyer}" is not an approved obligor in ${program.program_code}`];
      else if (!ob.active) [status, reason] = ['REJECTED', `Obligor ${ob.name} is inactive`];
      else if (row.currency && row.currency !== program.currency) [status, reason] = ['REJECTED', `Currency ${row.currency} does not match program currency ${program.currency}`];
      else if (row.due_date <= input.funding_date) [status, reason] = ['REJECTED', 'Due date is on or before the funding date'];
      else if (seenInFile.has(key)) [status, reason] = ['REJECTED', 'Duplicate row in this file'];
      else if (svc.db.get(
        "SELECT id FROM invoices WHERE program_id = ? AND lower(buyer_name) = lower(?) AND invoice_number = ? AND status NOT IN ('REJECTED','REMOVED')",
        [program.id, ob.name, row.invoice_number])) [status, reason] = ['REJECTED', 'Invoice already uploaded or funded (duplicate)'];
      seenInFile.add(key);
      svc.db.run(
        `INSERT INTO invoices (import_id, program_id, obligor_id, buyer_name, invoice_number, invoice_date, due_date, face_cents, currency, status, status_reason, source_line, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [importId, program.id, ob?.id ?? null, ob?.name ?? row.buyer, row.invoice_number, row.invoice_date ?? null, row.due_date, row.amount_cents,
          program.currency, status, reason, row.line, ts, ts],
      );
    }
    applyLimitHolds(svc, importId);
    const counts = refreshCounts(svc, importId);
    audit.record(svc.db, user, 'invoice_import.uploaded', 'invoice_import', importId, {
      filename: safeName, program: program.program_code, funding_date: input.funding_date, sha256: parsed.sha256, ...counts,
    });
    emit(svc.db, 'invoice_import.uploaded', 'invoice_import', importId, { id: importId, filename: safeName, deal_name: program.deal_name, ...counts });
    return { status: 201, json: { import: getImport(svc, importId), parse: { rows_read: parsed.rows_read, skipped: parsed.skipped, warnings: parsed.warnings } } };
  });
}

function refreshCounts(svc: Services, importId: number) {
  const imp = svc.db.get('SELECT rows_read, parse_report FROM invoice_imports WHERE id = ?', [importId])!;
  const skipped = JSON.parse(imp.parse_report).skipped.length;
  const ruleRejected = svc.db.get<{ n: number }>("SELECT COUNT(*) n FROM invoices WHERE import_id = ? AND status = 'REJECTED'", [importId])!.n;
  const accepted = svc.db.get<{ n: number }>("SELECT COUNT(*) n FROM invoices WHERE import_id = ? AND status IN ('PENDING','HELD','FUNDED')", [importId])!.n;
  svc.db.run('UPDATE invoice_imports SET accepted = ?, rejected = ? WHERE id = ?', [accepted, skipped + ruleRejected, importId]);
  return { rows_read: imp.rows_read, accepted, rejected: skipped + ruleRejected };
}

/**
 * Re-evaluate limit holds for a batch. For each obligor: if it is already over limit, all its invoices
 * are held; otherwise invoices are accepted in due-date order while the post-funding utilisation stays
 * within the limit, and the rest are held. User rejections are never overridden.
 */
function applyLimitHolds(svc: Services, importId: number) {
  const ts = now();
  svc.db.run("UPDATE invoices SET status = 'PENDING', status_reason = NULL, updated_at = ? WHERE import_id = ? AND status = 'HELD'", [ts, importId]);
  const obligorIds = svc.db.all<{ obligor_id: number }>("SELECT DISTINCT obligor_id FROM invoices WHERE import_id = ? AND status = 'PENDING'", [importId]).map((r) => r.obligor_id);
  for (const obId of obligorIds) {
    const ob = svc.db.get('SELECT * FROM obligors WHERE id = ?', [obId])!;
    const current = currentUtilisation(svc.db, obId);
    let running = current;
    const invoices = svc.db.all("SELECT * FROM invoices WHERE import_id = ? AND obligor_id = ? AND status = 'PENDING' ORDER BY due_date, id", [importId, obId]);
    for (const inv of invoices) {
      const price = purchasePrice(inv.face_cents, ob.advance_rate_bps);
      let reason: string | null = null;
      if (current > ob.limit_cents) reason = `Limit breach: ${ob.name} already at ${pct(current, ob.limit_cents)}% of limit`;
      else if (running + price > ob.limit_cents) reason = `Limit breach: funding would take ${ob.name} to ${pct(running + price, ob.limit_cents)}% of limit`;
      if (reason) svc.db.run("UPDATE invoices SET status = 'HELD', status_reason = ?, updated_at = ? WHERE id = ?", [reason, ts, inv.id]);
      else running += price;
    }
  }
}

// ---------- Queries ----------

export function listImports(svc: Services, query: URLSearchParams) {
  const params: any[] = [];
  let where = "WHERE f.status <> 'REMOVED'";
  if (query.get('program_id')) { where += ' AND f.program_id = ?'; params.push(Number(query.get('program_id'))); }
  if (query.get('status')) { where += ' AND f.status = ?'; params.push(query.get('status')); }
  const rows = svc.db.all(
    `SELECT f.*, p.program_code, p.deal_name, p.deal_code, p.currency, u.name AS uploaded_by_name, a.name AS approved_by_name
     FROM invoice_imports f JOIN programs p ON p.id = f.program_id
     JOIN users u ON u.username = f.uploaded_by LEFT JOIN users a ON a.username = f.approved_by
     ${where} ORDER BY f.funding_date DESC, f.id DESC LIMIT 500`, params);
  return rows.map((f) => ({ ...f, ...importTotals(svc, f.id) }));
}

/** Totals over eligible invoices: frozen pricing for funded batches, face x advance for open ones. */
function importTotals(svc: Services, importId: number) {
  const rows = svc.db.all(
    `SELECT i.face_cents, i.status, i.purchase_cents, o.advance_rate_bps FROM invoices i LEFT JOIN obligors o ON o.id = i.obligor_id
     WHERE i.import_id = ? AND i.status IN ('PENDING','FUNDED')`, [importId]);
  let face = 0, purchase = 0;
  for (const r of rows) {
    face += r.face_cents;
    purchase += r.status === 'FUNDED' ? r.purchase_cents : purchasePrice(r.face_cents, r.advance_rate_bps);
  }
  return { invoice_count: rows.length, face_cents: face, purchase_cents: purchase, discount_cents: face - purchase };
}

export function getImport(svc: Services, id: number) {
  const f = svc.db.get(
    `SELECT f.*, p.program_code, p.deal_name, p.deal_code, p.currency, p.rate_basis, p.day_count, p.funding_lag_days, p.status AS program_status
     FROM invoice_imports f JOIN programs p ON p.id = f.program_id WHERE f.id = ?`, [id]);
  if (!f) throw notFound('Invoice file');
  return { ...f, parse_report: JSON.parse(f.parse_report), earliest_funding: addBusinessDays(f.uploaded_at.slice(0, 10), f.funding_lag_days), ...importTotals(svc, id) };
}

export async function downloadImportFile(svc: Services, id: number) {
  const f = svc.db.get('SELECT * FROM invoice_imports WHERE id = ?', [id]);
  if (!f) throw notFound('Invoice file');
  const bytes = await readFile(join(svc.filesDir, f.storage_key));
  const types: Record<string, string> = { pdf: 'application/pdf', csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  return { text: bytes as any, contentType: types[f.file_format] ?? 'application/octet-stream', filename: f.filename };
}

/** Full working view of one batch: KPIs, limit check, priced invoices, blockers. */
export async function fundingView(svc: Services, user: User, id: number) {
  const f = getImport(svc, id);
  const invoices = svc.db.all(
    `SELECT i.*, o.rating, o.advance_rate_bps AS obligor_adv_bps, o.investor_margin_bps AS obligor_margin_bps, o.sp_spread_bps AS obligor_spread_bps,
            inv.code AS investor_code, inv.name AS investor_name, l.loan_ref
     FROM invoices i LEFT JOIN obligors o ON o.id = i.obligor_id LEFT JOIN investors inv ON inv.id = i.investor_id LEFT JOIN loans l ON l.invoice_id = i.id
     WHERE i.import_id = ? AND i.status <> 'REMOVED' ORDER BY i.id`, [id]);
  const fixing = fixingsFor(svc, f.rate_basis, f.funding_date);

  // Price everything that can be priced: frozen for funded, live (engine) for pending/held.
  const live = invoices.filter((i) => i.status === 'PENDING' || i.status === 'HELD');
  const priced = new Map<number, any>();
  let weightedTenor = 0;
  if (live.length && fixing) {
    const res = await svc.engine.price(f.funding_date, f.day_count, fixing.rates, live.map((i) => ({
      id: i.id, face_cents: i.face_cents, adv_bps: i.obligor_adv_bps, investor_margin_bps: i.obligor_margin_bps, sp_spread_bps: i.obligor_spread_bps, due_date: i.due_date,
    })));
    for (const r of res.invoices) priced.set(r.id, r);
  }
  const rows = invoices.map((i) => {
    if (i.status === 'FUNDED') {
      return { ...i, pricing: { purchase_cents: i.purchase_cents, adv_bps: i.adv_bps, tenor_days: i.tenor_days, bucket: i.bucket, base_bps: i.base_bps,
        investor_margin_bps: i.investor_margin_bps, sp_spread_bps: i.sp_spread_bps, all_in_bps: i.all_in_bps, interest_cents: i.interest_cents,
        investor_interest_cents: i.investor_interest_cents, seaport_interest_cents: i.interest_cents - i.investor_interest_cents, priceable: true } };
    }
    return { ...i, pricing: priced.get(i.id) ?? null };
  });

  const eligible = rows.filter((r) => r.status === 'PENDING' || r.status === 'FUNDED');
  const sum = (list: any[], k: string) => list.reduce((a, r) => a + (r.pricing?.[k] ?? 0), 0);
  const eligiblePurchase = sum(eligible, 'purchase_cents');
  if (eligiblePurchase) weightedTenor = Math.round(eligible.reduce((a, r) => a + (r.pricing?.purchase_cents ?? 0) * (r.pricing?.tenor_days ?? 0), 0) / eligiblePurchase);

  // Limit check across all active obligors of the program.
  const obligors = svc.db.all('SELECT * FROM obligors WHERE program_id = ? AND active = 1 ORDER BY limit_cents DESC', [f.program_id]);
  const limitRows = obligors.map((o) => {
    const current = currentUtilisation(svc.db, o.id);
    const funded = f.status === 'APPROVED';
    const requirement = funded ? 0 : pipeline(svc.db, o.id, id);
    const post = current + requirement;
    const status = limitStatus(current > o.limit_cents ? current : post, o.limit_cents);
    return {
      obligor_id: o.id, name: o.name, rating: o.rating, limit_cents: o.limit_cents,
      current_cents: current, current_pct: pct(current, o.limit_cents),
      pipeline_cents: pipeline(svc.db, o.id), requirement_cents: requirement,
      post_cents: post, post_pct: pct(post, o.limit_cents), headroom_cents: o.limit_cents - post, status,
    };
  });
  const totals = limitRows.reduce((a, r) => ({
    limit_cents: a.limit_cents + r.limit_cents, current_cents: a.current_cents + r.current_cents, pipeline_cents: a.pipeline_cents + r.pipeline_cents,
    requirement_cents: a.requirement_cents + r.requirement_cents, post_cents: a.post_cents + r.post_cents,
  }), { limit_cents: 0, current_cents: 0, pipeline_cents: 0, requirement_cents: 0, post_cents: 0 });

  const counts = {
    total: rows.length,
    pending: rows.filter((r) => r.status === 'PENDING').length,
    held: rows.filter((r) => r.status === 'HELD').length,
    rejected: rows.filter((r) => r.status === 'REJECTED').length,
    funded: rows.filter((r) => r.status === 'FUNDED').length,
  };
  return {
    import: f,
    fixing,
    kpis: {
      ...counts,
      face_cents: rows.filter((r) => r.status !== 'REJECTED').reduce((a, r) => a + r.face_cents, 0),
      purchase_cents: eligiblePurchase,
      interest_cents: sum(eligible, 'interest_cents'),
      investor_interest_cents: sum(eligible, 'investor_interest_cents'),
      seaport_interest_cents: sum(eligible, 'seaport_interest_cents'),
      weighted_tenor_days: weightedTenor,
      eligible_face_cents: eligible.reduce((a, r) => a + r.face_cents, 0),
    },
    limits: { rows: limitRows, totals: { ...totals, current_pct: pct(totals.current_cents, totals.limit_cents), post_pct: pct(totals.post_cents, totals.limit_cents), headroom_cents: totals.limit_cents - totals.post_cents }, breaches: limitRows.filter((r) => r.status === 'Breach').length },
    invoices: rows,
    blockers: blockers(svc, user, f, rows, fixing),
    investors: svc.db.all('SELECT id, code, name FROM investors WHERE active = 1 ORDER BY code'),
  };
}

function blockers(svc: Services, user: User, f: any, rows: any[], fixing: any) {
  const list: { code: string; message: string }[] = [];
  if (f.status !== 'UPLOADED') return [{ code: 'STATUS', message: `File is ${f.status}` }];
  if (f.program_status !== 'ACTIVE') list.push({ code: 'PROGRAM', message: `Program is ${f.program_status}` });
  if (f.uploaded_by === user.username) list.push({ code: 'FOUR_EYES', message: 'Approver must differ from uploader (four-eyes)' });
  if (f.funding_date < f.earliest_funding) list.push({ code: 'T_PLUS', message: `Funding date is before the earliest permitted date ${f.earliest_funding}` });
  if (f.funding_date < svc.today()) list.push({ code: 'PAST_DATE', message: 'Funding date is in the past - change the funding date' });
  if (!fixing) list.push({ code: 'FIXING', message: `No ${f.rate_basis} fixing available for the funding date` });
  const pending = rows.filter((r) => r.status === 'PENDING');
  if (!pending.length) list.push({ code: 'EMPTY', message: 'No eligible invoices in this funding' });
  if (rows.some((r) => r.status === 'HELD')) list.push({ code: 'LIMIT', message: 'Limit breach - reject or recheck held invoices' });
  const untagged = pending.filter((r) => !r.investor_id).length;
  if (untagged) list.push({ code: 'INVESTOR', message: `${untagged} eligible invoice(s) have no investor tagged` });
  if (pending.some((r) => r.pricing && !r.pricing.priceable)) list.push({ code: 'PRICING', message: 'Some invoices cannot be priced (due date on or before funding date)' });
  return list;
}

// ---------- Review actions (maker or checker) ----------

function openImport(svc: Services, id: number) {
  const f = svc.db.get('SELECT * FROM invoice_imports WHERE id = ?', [id]);
  if (!f) throw notFound('Invoice file');
  if (f.status !== 'UPLOADED') throw conflict(`File is ${f.status}; it can no longer be changed`);
  return f;
}

function ids(body: any): number[] {
  const list = body?.invoice_ids;
  if (!Array.isArray(list) || !list.length || !list.every((n: unknown) => Number.isSafeInteger(n))) throw badRequest('invoice_ids must be a non-empty array of ids');
  return list;
}

export function recheck(svc: Services, user: User, importId: number) {
  requirePermission(user, 'invoices.review');
  return svc.db.tx(() => {
    openImport(svc, importId);
    applyLimitHolds(svc, importId);
    const c = refreshCounts(svc, importId);
    audit.record(svc.db, user, 'invoice_import.rechecked', 'invoice_import', importId, c);
    return { ok: true, ...c };
  });
}

export function rejectInvoices(svc: Services, user: User, importId: number, body: any) {
  requirePermission(user, 'invoices.review');
  const list = ids(body);
  const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 300) : 'no reason given';
  return svc.db.tx(() => {
    openImport(svc, importId);
    let n = 0;
    for (const invId of list) {
      n += svc.db.run(`UPDATE invoices SET status = 'REJECTED', status_reason = ?, updated_at = ? WHERE id = ? AND import_id = ? AND status IN ('PENDING','HELD')`,
        [`${USER_REJECT}${user.name}: ${reason}`, now(), invId, importId]).changes;
    }
    applyLimitHolds(svc, importId);
    const c = refreshCounts(svc, importId);
    audit.record(svc.db, user, 'invoices.rejected', 'invoice_import', importId, { invoice_ids: list, reason, changed: n });
    return { ok: true, changed: n, ...c };
  });
}

export function restoreInvoices(svc: Services, user: User, importId: number, body: any) {
  requirePermission(user, 'invoices.review');
  const list = ids(body);
  return svc.db.tx(() => {
    const f = openImport(svc, importId);
    let n = 0;
    const skipped: string[] = [];
    for (const invId of list) {
      const inv = svc.db.get('SELECT * FROM invoices WHERE id = ? AND import_id = ?', [invId, importId]);
      if (!inv || inv.status !== 'REJECTED') continue;
      if (!String(inv.status_reason ?? '').startsWith(USER_REJECT)) { skipped.push(`${inv.invoice_number}: ${inv.status_reason}`); continue; }
      if (svc.db.get("SELECT id FROM invoices WHERE program_id = ? AND buyer_name = ? AND invoice_number = ? AND id <> ? AND status NOT IN ('REJECTED','REMOVED')",
        [f.program_id, inv.buyer_name, inv.invoice_number, inv.id])) { skipped.push(`${inv.invoice_number}: now a duplicate`); continue; }
      n += svc.db.run("UPDATE invoices SET status = 'PENDING', status_reason = NULL, updated_at = ? WHERE id = ?", [now(), invId]).changes;
    }
    applyLimitHolds(svc, importId);
    const c = refreshCounts(svc, importId);
    audit.record(svc.db, user, 'invoices.restored', 'invoice_import', importId, { invoice_ids: list, changed: n, skipped });
    return { ok: true, changed: n, skipped, ...c };
  });
}

export function tagInvestor(svc: Services, user: User, importId: number, body: any) {
  requirePermission(user, 'invoices.review');
  const list = ids(body);
  const investorId = body?.investor_id === null ? null : Number(body?.investor_id);
  if (investorId !== null && !svc.db.get('SELECT id FROM investors WHERE id = ? AND active = 1', [investorId])) throw badRequest('Unknown investor');
  return svc.db.tx(() => {
    openImport(svc, importId);
    let n = 0;
    for (const invId of list) {
      n += svc.db.run("UPDATE invoices SET investor_id = ?, updated_at = ? WHERE id = ? AND import_id = ? AND status IN ('PENDING','HELD')", [investorId, now(), invId, importId]).changes;
    }
    audit.record(svc.db, user, 'invoices.investor_tagged', 'invoice_import', importId, { invoice_ids: list, investor_id: investorId });
    return { ok: true, changed: n };
  });
}

export function changeFundingDate(svc: Services, user: User, importId: number, body: unknown) {
  requirePermission(user, 'invoices.upload');
  const { funding_date } = check<any>(body, { funding_date: { type: 'date', required: true } });
  return svc.db.tx(() => {
    const f = openImport(svc, importId);
    const p = svc.db.get('SELECT funding_lag_days FROM programs WHERE id = ?', [f.program_id])!;
    const earliest = addBusinessDays(f.uploaded_at.slice(0, 10), p.funding_lag_days);
    const floor = earliest > svc.today() ? earliest : svc.today();
    if (funding_date < floor) throw badRequest(`Funding date must be on or after ${floor}`);
    svc.db.run('UPDATE invoice_imports SET funding_date = ? WHERE id = ?', [funding_date, importId]);
    // Invoices maturing on/before the new date become ineligible.
    svc.db.run("UPDATE invoices SET status = 'REJECTED', status_reason = 'Due date is on or before the funding date', updated_at = ? WHERE import_id = ? AND status IN ('PENDING','HELD') AND due_date <= ?",
      [now(), importId, funding_date]);
    applyLimitHolds(svc, importId);
    refreshCounts(svc, importId);
    audit.record(svc.db, user, 'invoice_import.funding_date_changed', 'invoice_import', importId, { from: f.funding_date, to: funding_date });
    return getImport(svc, importId);
  });
}

export function removeImport(svc: Services, user: User, importId: number, body: any) {
  requirePermission(user, 'invoices.upload');
  const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 300) : 'Removed by user';
  return svc.db.tx(() => {
    openImport(svc, importId);
    svc.db.run("UPDATE invoice_imports SET status = 'REMOVED', removed_by = ?, removed_reason = ? WHERE id = ?", [user.username, reason, importId]);
    svc.db.run("UPDATE invoices SET status = 'REMOVED', updated_at = ? WHERE import_id = ? AND status <> 'FUNDED'", [now(), importId]);
    audit.record(svc.db, user, 'invoice_import.removed', 'invoice_import', importId, { reason });
    return { ok: true };
  });
}

// ---------- Approval (checker) ----------

export async function approveFunding(svc: Services, user: User, importId: number) {
  requirePermission(user, 'funding.approve');
  const view = await fundingView(svc, user, importId);
  if (view.import.uploaded_by === user.username) throw forbidden('Four-eyes: the approver must differ from the uploader');
  if (view.blockers.length) throw conflict('Funding cannot be approved', view.blockers.map((b) => b.message));
  const f = view.import;
  const pending = view.invoices.filter((r: any) => r.status === 'PENDING');
  const snapshot = pending.map((r: any) => r.id).sort((a: number, b: number) => a - b).join(',');

  return svc.db.tx(() => {
    // Re-verify inside the transaction: nothing changed since pricing, and limits still hold.
    const nowPending = svc.db.all<{ id: number }>("SELECT id FROM invoices WHERE import_id = ? AND status = 'PENDING' ORDER BY id", [importId]).map((r) => r.id).join(',');
    if (nowPending !== snapshot) throw conflict('The batch changed while you were reviewing it - reload and try again');
    applyLimitHolds(svc, importId);
    if (svc.db.get("SELECT id FROM invoices WHERE import_id = ? AND status = 'HELD'", [importId])) throw conflict('Limit position changed - invoices are now held; reload and review');
    const status = svc.db.run("UPDATE invoice_imports SET status = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ? AND status = 'UPLOADED'", [user.username, now(), importId]);
    if (status.changes !== 1) throw conflict('File was already approved or removed');

    const year = f.funding_date.slice(0, 4);
    const loans: string[] = [];
    for (const r of pending) {
      const p = r.pricing;
      svc.db.run(
        `UPDATE invoices SET status = 'FUNDED', adv_bps = ?, purchase_cents = ?, tenor_days = ?, bucket = ?, base_bps = ?, investor_margin_bps = ?, sp_spread_bps = ?,
           all_in_bps = ?, interest_cents = ?, investor_interest_cents = ?, updated_at = ? WHERE id = ?`,
        [p.adv_bps, p.purchase_cents, p.tenor_days, p.bucket, p.base_bps, p.investor_margin_bps, p.sp_spread_bps, p.all_in_bps, p.interest_cents, p.investor_interest_cents, now(), r.id],
      );
      const loanRef = nextRef(svc.db, `L-${year}`, 5);
      const { id: loanId } = svc.db.run(
        `INSERT INTO loans (loan_ref, invoice_id, import_id, program_id, obligor_id, investor_id, currency, funding_date, maturity_date, face_cents, purchase_cents,
           interest_cents, investor_interest_cents, base_bps, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'OPEN', ?)`,
        [loanRef, r.id, importId, f.program_id, r.obligor_id, r.investor_id, f.currency, f.funding_date, r.due_date, r.face_cents, p.purchase_cents,
          p.interest_cents, p.investor_interest_cents, p.base_bps, now()],
      );
      ledger.post(svc.db, user, {
        date: f.funding_date, description: `Funding ${loanRef} / ${r.invoice_number} (${r.buyer_name})`, source_type: 'FUNDING', source_id: loanId, currency: f.currency,
        lines: [
          { account: '1200', debit: p.purchase_cents, program_id: f.program_id, loan_id: loanId, investor_id: r.investor_id },
          { account: '2500', credit: p.purchase_cents - p.interest_cents, program_id: f.program_id, loan_id: loanId },
          { account: '2100', credit: p.interest_cents, program_id: f.program_id, loan_id: loanId, investor_id: r.investor_id },
        ],
      });
      loans.push(loanRef);
    }
    queueFundingPayment(svc, importId);
    audit.record(svc.db, user, 'funding.approved', 'invoice_import', importId, {
      filename: f.filename, funding_date: f.funding_date, loans, purchase_cents: view.kpis.purchase_cents, interest_cents: view.kpis.interest_cents, uploaded_by: f.uploaded_by,
    });
    emit(svc.db, 'funding.approved', 'invoice_import', importId, { id: importId, filename: f.filename, loans: loans.length });
    return { ok: true, loans, funding_date: f.funding_date };
  });
}

export function tenor(fundingDate: string, dueDate: string) {
  return daysBetween(fundingDate, dueDate);
}
