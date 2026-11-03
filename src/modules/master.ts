// MASTER TABLE (Programs): programs/deals, obligors with limits & pricing, investors,
// benchmark rate fixings and reference FX. All changes are audit-logged with before/after.

import type { Services, User } from '../core/context.ts';
import { requirePermission, now } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { emit } from '../core/outbox.ts';
import { check } from '../lib/validate.ts';
import { conflict, notFound, validation } from '../lib/errors.ts';
import { obligorUsage } from './exposure.ts';

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

export function createProgram(svc: Services, user: User, body: unknown) {
  requirePermission(user, 'master.edit');
  const input = check<any>(body, programSchema as any);
  return svc.db.tx(() => {
    const { id } = svc.db.run(
      `INSERT INTO programs (program_code, deal_code, deal_name, client_name, program_type, currency, rate_basis, day_count, funding_lag_days, late_margin_bps, collection_account, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [input.program_code, input.deal_code, input.deal_name, input.client_name, input.program_type, input.currency, input.rate_basis, input.day_count,
        input.funding_lag_days ?? 1, input.late_margin_bps ?? 300, input.collection_account, now()],
    );
    audit.record(svc.db, user, 'program.created', 'program', id, input);
    return { status: 201, json: getProgram(svc, id) };
  });
}

export function updateProgram(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'master.edit');
  const before = svc.db.get('SELECT * FROM programs WHERE id = ?', [id]);
  if (!before) throw notFound('Program');
  const input = check<any>({ ...before, ...body }, { ...programSchema, status: { type: 'enum', values: ['ACTIVE', 'SUSPENDED', 'CLOSED'] } } as any);
  if (input.currency !== before.currency && svc.db.get('SELECT id FROM invoice_imports WHERE program_id = ? LIMIT 1', [id])) {
    throw conflict('Currency cannot change once invoices have been uploaded to the program');
  }
  return svc.db.tx(() => {
    svc.db.run(
      `UPDATE programs SET program_code=?, deal_code=?, deal_name=?, client_name=?, program_type=?, currency=?, rate_basis=?, day_count=?, funding_lag_days=?, late_margin_bps=?, collection_account=?, status=? WHERE id=?`,
      [input.program_code, input.deal_code, input.deal_name, input.client_name, input.program_type, input.currency, input.rate_basis, input.day_count,
        input.funding_lag_days ?? 1, input.late_margin_bps ?? 300, input.collection_account, input.status ?? before.status, id],
    );
    audit.record(svc.db, user, 'program.updated', 'program', id, { before, after: input });
    return getProgram(svc, id);
  });
}

export function createObligor(svc: Services, user: User, programId: number, body: unknown) {
  requirePermission(user, 'master.edit');
  if (!svc.db.get('SELECT id FROM programs WHERE id = ?', [programId])) throw notFound('Program');
  const o = check<any>(body, obligorSchema as any);
  return svc.db.tx(() => {
    const { id } = svc.db.run(
      `INSERT INTO obligors (program_id, name, rating, role, limit_cents, advance_rate_bps, investor_margin_bps, sp_spread_bps, auto_debit, active)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [programId, o.name, o.rating, o.role, o.limit_cents, o.advance_rate_bps, o.investor_margin_bps, o.sp_spread_bps, o.auto_debit ? 1 : 0, o.active === false ? 0 : 1],
    );
    audit.record(svc.db, user, 'obligor.created', 'obligor', id, { program_id: programId, ...o });
    return { status: 201, json: svc.db.get('SELECT * FROM obligors WHERE id = ?', [id]) };
  });
}

export function updateObligor(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'master.edit');
  const before = svc.db.get('SELECT * FROM obligors WHERE id = ?', [id]);
  if (!before) throw notFound('Obligor');
  const merged = { ...before, auto_debit: !!before.auto_debit, active: !!before.active, ...body };
  const o = check<any>(merged, obligorSchema as any);
  return svc.db.tx(() => {
    svc.db.run(
      `UPDATE obligors SET name=?, rating=?, role=?, limit_cents=?, advance_rate_bps=?, investor_margin_bps=?, sp_spread_bps=?, auto_debit=?, active=? WHERE id=?`,
      [o.name, o.rating, o.role, o.limit_cents, o.advance_rate_bps, o.investor_margin_bps, o.sp_spread_bps, o.auto_debit ? 1 : 0, o.active === false ? 0 : 1, id],
    );
    const after = svc.db.get('SELECT * FROM obligors WHERE id = ?', [id]);
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    audit.record(svc.db, user, 'obligor.updated', 'obligor', id, { changed, before, after });
    const usage = obligorUsage(svc.db).find((u) => u.id === id);
    if (usage?.status === 'Breach') emit(svc.db, 'limit.breach', 'obligor', id, { obligor: after.name, pct: usage.used_pct });
    return after;
  });
}

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

/** Latest fixing on or before `date` for each bucket of a benchmark. */
export function fixingsFor(svc: Services, benchmark: string, date: string): { fixing_date: string; rates: Record<string, number> } | null {
  const row = svc.db.get<{ d: string }>('SELECT MAX(fixing_date) d FROM rate_fixings WHERE benchmark = ? AND fixing_date <= ?', [benchmark, date]);
  const fixingDate = row?.d ?? svc.db.get<{ d: string }>('SELECT MIN(fixing_date) d FROM rate_fixings WHERE benchmark = ?', [benchmark])?.d;
  if (!fixingDate) return null;
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
  if (Object.keys(errors).length) throw validation(errors);
  return svc.db.tx(() => {
    for (const b of BUCKETS) {
      svc.db.run('INSERT INTO rate_fixings (benchmark, fixing_date, bucket, rate_bps) VALUES (?,?,?,?) ON CONFLICT(benchmark, fixing_date, bucket) DO UPDATE SET rate_bps = excluded.rate_bps',
        [input.benchmark, input.fixing_date, b, rates[b]]);
    }
    audit.record(svc.db, user, 'fixing.saved', 'fixing', `${input.benchmark}:${input.fixing_date}`, rates);
    return { status: 201, json: fixingsFor(svc, input.benchmark, input.fixing_date) };
  });
}

export function listFx(svc: Services) {
  return svc.db.all('SELECT * FROM fx_rates ORDER BY currency');
}

export function setFx(svc: Services, user: User, body: unknown) {
  requirePermission(user, 'master.rates');
  const input = check<any>(body, {
    currency: { type: 'string', required: true, pattern: /^[A-Z]{3}$/ },
    usd_rate: { type: 'string', required: true, pattern: /^\d{1,6}(\.\d{1,8})?$/ },
  });
  return svc.db.tx(() => {
    svc.db.run('INSERT INTO fx_rates (currency, usd_rate, as_of) VALUES (?,?,?) ON CONFLICT(currency) DO UPDATE SET usd_rate = excluded.usd_rate, as_of = excluded.as_of',
      [input.currency, input.usd_rate, svc.today()]);
    audit.record(svc.db, user, 'fx.saved', 'fx', input.currency, input);
    return listFx(svc);
  });
}
