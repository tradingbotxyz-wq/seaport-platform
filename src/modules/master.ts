// MASTER TABLE (Programs): programs/deals, obligors with limits & pricing, investors,
// benchmark rate fixings and reference FX. All changes are audit-logged with before/after.

import type { Services, User } from '../core/context.ts';
import { requirePermission, now } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { emit } from '../core/outbox.ts';
import { check } from '../lib/validate.ts';
import { conflict, forbidden, notFound, validation } from '../lib/errors.ts';
import { obligorUsage } from './exposure.ts';
import { requestChange, registerApplier, assertUnchanged, limitNeedsCommittee } from './approvals.ts';

const BUCKETS = ['1-30', '31-90', '91-180', '181+'];

const programSchema = {
  program_code: { type: 'string', required: true, pattern: /^PRG-\d{3,6}$/ },
  deal_code: { type: 'string', required: true, pattern: /^[A-Z]{2}-[A-Z]{2}-\d{3,6}$/ },
  deal_name: { type: 'string', required: true, maxLength: 120 },
  client_name: { type: 'string', required: true, maxLength: 120 },
  program_type: { type: 'enum', required: true, values: ['SCF', 'IF', 'RPA', 'LC_BACKED', 'INSURED_AR'] },
  currency: { type: 'string', required: true, pattern: /^[A-Z]{3}$/ },
  rate_basis: { type: 'string', required: true, maxLength: 20 },
  day_count: { type: 'enum', required: true, values: ['ACT/360', 'ACT/365'] },
  funding_lag_days: { type: 'int', min: 1, max: 10 },
  late_margin_bps: { type: 'int', min: 0, max: 2000 },
  collection_account: { type: 'string', required: true, maxLength: 60 },
} as const;

const obligorSchema = {
  name: { type: 'string', required: true, maxLength: 120 },
  rating: { type: 'string', required: true, pattern: /^(AAA|AA[+-]?|A[+-]?|BBB[+-]?|BB[+-]?|B[+-]?|CCC[+-]?|CC|C|D|NR)$/ },
  role: { type: 'string', required: true, maxLength: 40 },
  limit_cents: { type: 'int', required: true, min: 0 },
  advance_rate_bps: { type: 'int', required: true, min: 1, max: 10000 },
  investor_margin_bps: { type: 'int', required: true, min: 0, max: 5000 },
  sp_spread_bps: { type: 'int', required: true, min: 0, max: 5000 },
  auto_debit: { type: 'bool' },
  active: { type: 'bool' },
} as const;

export function listPrograms(svc: Services) {
  const usage = obligorUsage(svc.db);
  return svc.db.all('SELECT * FROM programs ORDER BY program_code').map((p) => {
    const obligors = svc.db.all('SELECT * FROM obligors WHERE program_id = ? ORDER BY name', [p.id]).map((o) => {
      const u = usage.find((x) => x.id === o.id);
      return { ...o, funded_cents: u?.funded_cents ?? 0, pipeline_cents: u?.pipeline_cents ?? 0, used_pct: u?.used_pct ?? 0, status: u?.status ?? 'Good' };
    });
    return {
      ...p,
      obligors,
      limit_cents: obligors.filter((o) => o.active).reduce((a, o) => a + o.limit_cents, 0),
      funded_cents: obligors.reduce((a, o) => a + o.funded_cents, 0),
      pipeline_cents: obligors.reduce((a, o) => a + o.pipeline_cents, 0),
      open_loans: svc.db.get<{ n: number }>("SELECT COUNT(*) n FROM loans WHERE program_id = ? AND status = 'OPEN'", [p.id])!.n,
    };
  });
}

export function getProgram(svc: Services, id: number) {
  const p = listPrograms(svc).find((x) => x.id === id);
  if (!p) throw notFound('Program');
  return p;
}

// Program and obligor changes are requests: a second authorised user approves them (SoD-5).

function authorityUsdCents(svc: Services) {
  const row = svc.db.get<{ model: string }>('SELECT model FROM scorecard_versions ORDER BY version DESC LIMIT 1');
  const v = row ? JSON.parse(row.model)?.rules?.authority_limit_usd_cents : undefined;
  return Number.isFinite(v) ? v : 0; // no policy configured: everything goes to the committee
}

export function createProgram(svc: Services, user: User, body: unknown) {
  requirePermission(user, 'master.edit');
  const input = check<any>(body, programSchema as any);
  if (svc.db.get('SELECT id FROM programs WHERE program_code = ? OR deal_code = ?', [input.program_code, input.deal_code])) throw conflict('Program or deal code already exists');
  return requestChange(svc, user, { kind: 'PROGRAM_CREATE', entity_type: 'program', entity_id: input.program_code, summary: `New program ${input.program_code} ${input.deal_name} (${input.currency})`, payload: input, reason: (body as any)?.reason });
}

registerApplier('PROGRAM_CREATE', (svc, approver, cr, input) => {
  const { id } = svc.db.run(
    `INSERT INTO programs (program_code, deal_code, deal_name, client_name, program_type, currency, rate_basis, day_count, funding_lag_days, late_margin_bps, collection_account, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [input.program_code, input.deal_code, input.deal_name, input.client_name, input.program_type, input.currency, input.rate_basis, input.day_count,
      input.funding_lag_days ?? 1, input.late_margin_bps ?? 300, input.collection_account, now()],
  );
  audit.record(svc.db, approver, 'program.created', 'program', id, { ...input, requested_by: cr.requested_by, change_request: cr.ref });
  return { id };
});

export function updateProgram(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'master.edit');
  const before = svc.db.get('SELECT * FROM programs WHERE id = ?', [id]);
  if (!before) throw notFound('Program');
  const input = check<any>({ ...before, ...body }, { ...programSchema, status: { type: 'enum', values: ['ACTIVE', 'SUSPENDED', 'CLOSED'] } } as any);
  if (input.currency !== before.currency && (svc.db.get('SELECT id FROM invoice_imports WHERE program_id = ? LIMIT 1', [id]) || svc.db.get('SELECT id FROM obligors WHERE program_id = ? LIMIT 1', [id]))) {
    // Limits are approved in the program currency; switching currency would re-value them without credit approval.
    throw conflict('Currency cannot change once a program has obligors or invoices. Set up a new program instead.');
  }
  const fields = ['program_code', 'deal_code', 'deal_name', 'client_name', 'program_type', 'currency', 'rate_basis', 'day_count', 'funding_lag_days', 'late_margin_bps', 'collection_account', 'status'];
  const changed = fields.filter((f) => String(input[f] ?? '') !== String(before[f] ?? ''));
  if (!changed.length) return getProgram(svc, id);
  return requestChange(svc, user, { kind: 'PROGRAM_UPDATE', entity_type: 'program', entity_id: id, summary: `${before.program_code}: change ${changed.join(', ')}`,
    payload: Object.fromEntries(fields.map((f) => [f, input[f] ?? before[f]])), before: Object.fromEntries(fields.map((f) => [f, before[f]])), reason: body?.reason });
}

registerApplier('PROGRAM_UPDATE', (svc, approver, cr, input) => {
  const id = Number(cr.entity_id);
  const before = svc.db.get('SELECT * FROM programs WHERE id = ?', [id]);
  if (!before) throw notFound('Program');
  assertUnchanged(before, cr, Object.keys(input));
  if (input.currency !== before.currency && (svc.db.get('SELECT id FROM invoice_imports WHERE program_id = ? LIMIT 1', [id]) || svc.db.get('SELECT id FROM obligors WHERE program_id = ? LIMIT 1', [id]))) {
    throw conflict('Currency cannot change once a program has obligors or invoices');
  }
  svc.db.run(
    `UPDATE programs SET program_code=?, deal_code=?, deal_name=?, client_name=?, program_type=?, currency=?, rate_basis=?, day_count=?, funding_lag_days=?, late_margin_bps=?, collection_account=?, status=? WHERE id=?`,
    [input.program_code, input.deal_code, input.deal_name, input.client_name, input.program_type, input.currency, input.rate_basis, input.day_count,
      input.funding_lag_days ?? 1, input.late_margin_bps ?? 300, input.collection_account, input.status ?? before.status, id],
  );
  audit.record(svc.db, approver, 'program.updated', 'program', id, { before, after: input, requested_by: cr.requested_by, change_request: cr.ref });
  return { id };
});

export function createObligor(svc: Services, user: User, programId: number, body: unknown) {
  requirePermission(user, 'master.edit');
  const program = svc.db.get<any>('SELECT * FROM programs WHERE id = ?', [programId]);
  if (!program) throw notFound('Program');
  const o = check<any>(body, obligorSchema as any);
  if (svc.db.get('SELECT id FROM obligors WHERE program_id = ? AND name = ?', [programId, o.name])) throw conflict('This program already has an obligor with that name');
  const committee = limitNeedsCommittee(svc, o.limit_cents, program.currency, authorityUsdCents(svc));
  return requestChange(svc, user, { kind: 'OBLIGOR_CREATE', entity_type: 'program', entity_id: null,
    summary: `New obligor ${o.name} on ${program.program_code}, limit ${program.currency} ${(o.limit_cents / 100).toLocaleString('en-US')}`,
    payload: { program_id: programId, ...o }, reason: (body as any)?.reason, requires_role: committee ? 'ADMIN' : null });
}

/** Re-checked at approval time: FX or policy may have moved since the request was raised. */
function assertAuthority(svc: Services, approver: User, limitCents: number, programId: number) {
  const ccy = svc.db.get<{ currency: string }>('SELECT currency FROM programs WHERE id = ?', [programId])!.currency;
  if (approver.role !== 'ADMIN' && limitNeedsCommittee(svc, limitCents, ccy, authorityUsdCents(svc))) {
    throw forbidden('This limit is now above delegated credit authority and needs the credit committee (SoD-7)');
  }
}

registerApplier('OBLIGOR_CREATE', (svc, approver, cr, o) => {
  assertAuthority(svc, approver, o.limit_cents, o.program_id);
  const { id } = svc.db.run(
    `INSERT INTO obligors (program_id, name, rating, role, limit_cents, advance_rate_bps, investor_margin_bps, sp_spread_bps, auto_debit, active)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [o.program_id, o.name, o.rating, o.role, o.limit_cents, o.advance_rate_bps, o.investor_margin_bps, o.sp_spread_bps, o.auto_debit ? 1 : 0, o.active === false ? 0 : 1],
  );
  audit.record(svc.db, approver, 'obligor.created', 'obligor', id, { ...o, requested_by: cr.requested_by, change_request: cr.ref });
  return { id };
});

const OBLIGOR_FIELDS = ['name', 'rating', 'role', 'limit_cents', 'advance_rate_bps', 'investor_margin_bps', 'sp_spread_bps', 'auto_debit', 'active'];

export function updateObligor(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'master.edit');
  const before = svc.db.get<any>('SELECT o.*, p.currency, p.program_code FROM obligors o JOIN programs p ON p.id = o.program_id WHERE o.id = ?', [id]);
  if (!before) throw notFound('Obligor');
  const merged = { ...before, auto_debit: !!before.auto_debit, active: !!before.active, ...body };
  const o = check<any>(merged, obligorSchema as any);
  const norm = (k: string, v: any) => (k === 'auto_debit' || k === 'active' ? (v ? 1 : 0) : v);
  const changed = OBLIGOR_FIELDS.filter((f) => String(norm(f, o[f])) !== String(before[f]));
  if (!changed.length) return svc.db.get('SELECT * FROM obligors WHERE id = ?', [id]);
  // Committee for any increase in effective exposure: a higher limit, or reactivating an inactive obligor.
  const raises = o.limit_cents > before.limit_cents || (!before.active && o.active !== false);
  const committee = raises && limitNeedsCommittee(svc, o.limit_cents, before.currency, authorityUsdCents(svc));
  return requestChange(svc, user, { kind: 'OBLIGOR_UPDATE', entity_type: 'obligor', entity_id: id,
    summary: `${before.name} (${before.program_code}): ${changed.map((f) => f === 'limit_cents' ? `limit ${before.currency} ${(before.limit_cents / 100).toLocaleString('en-US')} → ${(o.limit_cents / 100).toLocaleString('en-US')}` : f.replace(/_/g, ' ')).join(', ')}`,
    payload: Object.fromEntries(OBLIGOR_FIELDS.map((f) => [f, norm(f, o[f])])), before: Object.fromEntries(OBLIGOR_FIELDS.map((f) => [f, before[f]])),
    reason: body?.reason, requires_role: committee ? 'ADMIN' : null });
}

registerApplier('OBLIGOR_UPDATE', (svc, approver, cr, o) => {
  const id = Number(cr.entity_id);
  const before = svc.db.get<any>('SELECT * FROM obligors WHERE id = ?', [id]);
  if (!before) throw notFound('Obligor');
  assertUnchanged(before, cr, OBLIGOR_FIELDS);
  if (o.limit_cents > before.limit_cents || (!before.active && o.active)) assertAuthority(svc, approver, o.limit_cents, before.program_id);
  svc.db.run(
    `UPDATE obligors SET name=?, rating=?, role=?, limit_cents=?, advance_rate_bps=?, investor_margin_bps=?, sp_spread_bps=?, auto_debit=?, active=? WHERE id=?`,
    [o.name, o.rating, o.role, o.limit_cents, o.advance_rate_bps, o.investor_margin_bps, o.sp_spread_bps, o.auto_debit ? 1 : 0, o.active ? 1 : 0, id],
  );
  const after = svc.db.get<any>('SELECT * FROM obligors WHERE id = ?', [id])!;
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  audit.record(svc.db, approver, 'obligor.updated', 'obligor', id, { changed, before, after, requested_by: cr.requested_by, change_request: cr.ref });
  const usage = obligorUsage(svc.db).find((u) => u.id === id);
  if (usage?.status === 'Breach') emit(svc.db, 'limit.breach', 'obligor', id, { obligor: after.name, pct: usage.used_pct });
  return { id };
});

// ---------- Investors ----------

export function listInvestors(svc: Services) {
  return svc.db.all(`
    SELECT i.*, COUNT(l.id) AS loans,
      COALESCE(SUM(CASE WHEN l.status = 'OPEN' THEN l.purchase_cents END), 0) AS open_purchase_cents
    FROM investors i LEFT JOIN loans l ON l.investor_id = i.id GROUP BY i.id ORDER BY i.code`);
}

export function createInvestor(svc: Services, user: User, body: unknown) {
  requirePermission(user, 'master.edit');
  const input = check<any>(body, {
    code: { type: 'string', required: true, pattern: /^INV-\d{4}$/ },
    name: { type: 'string', required: true, maxLength: 120 },
  });
  return svc.db.tx(() => {
    const { id } = svc.db.run('INSERT INTO investors (code, name) VALUES (?,?)', [input.code, input.name]);
    audit.record(svc.db, user, 'investor.created', 'investor', id, input);
    return { status: 201, json: svc.db.get('SELECT * FROM investors WHERE id = ?', [id]) };
  });
}

// ---------- Benchmark fixings & FX ----------

/** Most recent complete fixing on or before `date`, at most FIXING_MAX_AGE_DAYS old (10 in production). Never a later fixing. */
export const MAX_FIXING_AGE_DAYS = Number(process.env.FIXING_MAX_AGE_DAYS ?? (process.env.NODE_ENV === 'production' ? 10 : 45));
export function fixingsFor(svc: Services, benchmark: string, date: string): { fixing_date: string; rates: Record<string, number> } | null {
  const fixingDate = svc.db.get<{ d: string }>('SELECT MAX(fixing_date) d FROM rate_fixings WHERE benchmark = ? AND fixing_date <= ?', [benchmark, date])?.d;
  if (!fixingDate) return null;
  if ((Date.parse(date) - Date.parse(fixingDate)) / 864e5 > MAX_FIXING_AGE_DAYS) return null;
  const rates: Record<string, number> = {};
  for (const r of svc.db.all('SELECT bucket, rate_bps FROM rate_fixings WHERE benchmark = ? AND fixing_date = ?', [benchmark, fixingDate])) rates[r.bucket] = r.rate_bps;
  if (BUCKETS.some((b) => rates[b] === undefined)) return null;
  return { fixing_date: fixingDate, rates };
}

export function listFixings(svc: Services) {
  return svc.db.all('SELECT * FROM rate_fixings ORDER BY fixing_date DESC, benchmark, bucket LIMIT 400');
}

export function addFixing(svc: Services, user: User, body: any) {
  requirePermission(user, 'master.rates');
  const input = check<any>(body, {
    benchmark: { type: 'string', required: true, pattern: /^[A-Z]{3,10}$/ },
    fixing_date: { type: 'date', required: true },
  });
  const rates = body?.rates ?? {};
  const errors: Record<string, string> = {};
  for (const b of BUCKETS) if (!Number.isSafeInteger(rates[b]) || rates[b] < -500 || rates[b] > 5000) errors[`rates.${b}`] = 'must be whole basis points (-500..5000)';
  if (input.fixing_date > svc.today()) errors.fixing_date = 'cannot be in the future';
  if (Object.keys(errors).length) throw validation(errors);
  const existing = svc.db.all('SELECT bucket, rate_bps FROM rate_fixings WHERE benchmark = ? AND fixing_date = ?', [input.benchmark, input.fixing_date]);
  return requestChange(svc, user, { kind: 'RATE_FIXING', entity_type: 'fixing', entity_id: `${input.benchmark}:${input.fixing_date}`,
    summary: `${existing.length ? 'Correct' : 'Add'} ${input.benchmark} fixing ${input.fixing_date}: ${BUCKETS.map((b) => `${b} ${rates[b]}bp`).join(', ')}`,
    payload: { benchmark: input.benchmark, fixing_date: input.fixing_date, rates: Object.fromEntries(BUCKETS.map((b) => [b, rates[b]])) },
    before: existing.length ? Object.fromEntries(existing.map((r) => [r.bucket, r.rate_bps])) : undefined, reason: body?.reason });
}

registerApplier('RATE_FIXING', (svc, approver, cr, p) => {
  const before = svc.db.all('SELECT bucket, rate_bps FROM rate_fixings WHERE benchmark = ? AND fixing_date = ?', [p.benchmark, p.fixing_date]);
  assertUnchanged(Object.fromEntries(before.map((r) => [r.bucket, r.rate_bps])), cr, BUCKETS);
  for (const b of BUCKETS) {
    svc.db.run('INSERT INTO rate_fixings (benchmark, fixing_date, bucket, rate_bps) VALUES (?,?,?,?) ON CONFLICT(benchmark, fixing_date, bucket) DO UPDATE SET rate_bps = excluded.rate_bps',
      [p.benchmark, p.fixing_date, b, p.rates[b]]);
  }
  audit.record(svc.db, approver, 'fixing.saved', 'fixing', `${p.benchmark}:${p.fixing_date}`, { before: Object.fromEntries(before.map((r) => [r.bucket, r.rate_bps])), after: p.rates, requested_by: cr.requested_by, change_request: cr.ref });
  return { ok: true };
});

export function listFx(svc: Services) {
  return svc.db.all('SELECT * FROM fx_rates ORDER BY currency');
}

export function setFx(svc: Services, user: User, body: unknown) {
  requirePermission(user, 'master.rates');
  const input = check<any>(body, {
    currency: { type: 'string', required: true, pattern: /^[A-Z]{3}$/ },
    usd_rate: { type: 'string', required: true, pattern: /^\d{1,6}(\.\d{1,8})?$/ },
  });
  if (input.currency === 'USD' && Number(input.usd_rate) !== 1) throw validation({ usd_rate: 'USD is always 1' });
  if (!(Number(input.usd_rate) > 0)) throw validation({ usd_rate: 'must be greater than zero' });
  const before = svc.db.get<any>('SELECT * FROM fx_rates WHERE currency = ?', [input.currency]);
  const move = before ? Math.abs(Number(input.usd_rate) / Number(before.usd_rate) - 1) : 0;
  return requestChange(svc, user, { kind: 'FX_RATE', entity_type: 'fx', entity_id: input.currency,
    summary: `${input.currency}/USD ${before ? `${before.usd_rate} → ` : ''}${input.usd_rate}${move > 0.1 ? ` (moves ${(move * 100).toFixed(1)}%: check the source)` : ''}`,
    payload: input, before: before ? { usd_rate: before.usd_rate } : undefined, reason: (body as any)?.reason });
}

registerApplier('FX_RATE', (svc, approver, cr, input) => {
  const before = svc.db.get<any>('SELECT * FROM fx_rates WHERE currency = ?', [input.currency]);
  assertUnchanged(before, cr, ['usd_rate']);
  svc.db.run('INSERT INTO fx_rates (currency, usd_rate, as_of) VALUES (?,?,?) ON CONFLICT(currency) DO UPDATE SET usd_rate = excluded.usd_rate, as_of = excluded.as_of',
    [input.currency, input.usd_rate, svc.today()]);
  audit.record(svc.db, approver, 'fx.saved', 'fx', input.currency, { before: before?.usd_rate ?? null, after: input.usd_rate, requested_by: cr.requested_by, change_request: cr.ref });
  return { ok: true };
});
