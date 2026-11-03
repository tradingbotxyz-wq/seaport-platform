// POOL: pools of funded loans for funding / securitisation.
// DRAFT (build: criteria, limits, tranches, allocate loans) -> ACTIVE (four-eyes, no breaches) -> CLOSED.
// Concentration checks, loan selection and stress testing run in the Python engine.

import type { Services, User } from '../core/context.ts';
import { assertNotRecentlyReset } from '../core/cooldown.ts';
import { requirePermission, now, nextRef, daysBetween } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { emit } from '../core/outbox.ts';
import { check } from '../lib/validate.ts';
import { badRequest, conflict, forbidden, notFound, validation } from '../lib/errors.ts';

const TRANCHES = ['SENIOR', 'MEZZANINE', 'EQUITY'];
const RATING_ORDER = ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'BB-', 'B+', 'B', 'B-', 'CCC'];
const YIELD_BUCKETS: [number, string][] = [[500, '< 5.00%'], [600, '5.00–5.99%'], [700, '6.00–6.99%'], [800, '7.00–7.99%'], [Infinity, '≥ 8.00%']];
const MATURITY_BUCKETS: [number, string][] = [[-1, 'Past due'], [30, '0–30 days'], [60, '31–60 days'], [90, '61–90 days'], [180, '91–180 days'], [Infinity, '180+ days']];

export interface PoolLoan {
  id: number; loan_ref: string; obligor: string; obligor_id: number; program: string; country: string; rating: string;
  principal_cents: number; outstanding_cents: number; face_cents: number; yield_bps: number; days: number; maturity_date: string;
  status: string; currency: string; invoice_number: string;
}

function loanRows(svc: Services, where: string, params: any[]): PoolLoan[] {
  const today = svc.today();
  return svc.db.all(
    `SELECT l.id, l.loan_ref, l.status, l.currency, l.maturity_date, l.face_cents, l.purchase_cents, l.received_cents, l.obligor_id,
            o.name AS obligor, o.country, o.rating, p.program_code AS program, i.all_in_bps, i.invoice_number
     FROM loans l JOIN obligors o ON o.id = l.obligor_id JOIN programs p ON p.id = l.program_id JOIN invoices i ON i.id = l.invoice_id
     WHERE ${where} ORDER BY l.maturity_date, l.id`, params).map((r) => ({
    id: r.id, loan_ref: r.loan_ref, obligor: r.obligor, obligor_id: r.obligor_id, program: r.program, country: r.country,
    rating: RATING_ORDER.includes(r.rating) ? r.rating : 'CCC', currency: r.currency, status: r.status, invoice_number: r.invoice_number,
    principal_cents: r.status === 'OPEN' ? Math.max(r.purchase_cents - r.received_cents, 0) : 0,
    outstanding_cents: r.status === 'OPEN' ? r.face_cents - r.received_cents : 0, face_cents: r.face_cents,
    yield_bps: r.all_in_bps ?? 0, days: daysBetween(today, r.maturity_date), maturity_date: r.maturity_date,
  }));
}

const poolLoans = (svc: Services, poolId: number) =>
  loanRows(svc, 'l.id IN (SELECT loan_id FROM pool_loans WHERE pool_id = ? AND removed_at IS NULL)', [poolId]);

function load(svc: Services, id: number) {
  const p = svc.db.get('SELECT * FROM pools WHERE id = ?', [id]);
  if (!p) throw notFound('Pool');
  return { ...p, criteria: JSON.parse(p.criteria), limits: JSON.parse(p.limits) };
}

function candidates(svc: Services, pool: any): PoolLoan[] {
  const c = pool.criteria;
  const rows = loanRows(svc, `l.status = 'OPEN' AND l.currency = ? AND l.id NOT IN (SELECT loan_id FROM pool_loans WHERE removed_at IS NULL)`, [pool.currency]);
  return rows.filter((l) =>
    (!c.programs?.length || c.programs.includes(l.program))
    && (!c.min_rating || RATING_ORDER.indexOf(l.rating) <= RATING_ORDER.indexOf(c.min_rating))
    && l.days >= (c.min_remaining_days ?? 1)
    && (!c.max_remaining_days || l.days <= c.max_remaining_days)
    && (!c.min_yield_bps || l.yield_bps >= c.min_yield_bps)
    && l.principal_cents > 0);
}

function eligibilityIssues(pool: any, l: PoolLoan): string[] {
  const c = pool.criteria;
  const out: string[] = [];
  if (l.status !== 'OPEN') out.push(`${l.loan_ref} is ${l.status}`);
  if (l.currency !== pool.currency) out.push(`${l.loan_ref} currency ${l.currency} differs from pool currency ${pool.currency}`);
  if (c.programs?.length && !c.programs.includes(l.program)) out.push(`${l.loan_ref} program ${l.program} not eligible`);
  if (c.min_rating && RATING_ORDER.indexOf(l.rating) > RATING_ORDER.indexOf(c.min_rating)) out.push(`${l.loan_ref} rating ${l.rating} below ${c.min_rating}`);
  if (l.days < (c.min_remaining_days ?? 1)) out.push(`${l.loan_ref} has ${l.days} days remaining (min ${c.min_remaining_days ?? 1})`);
  if (c.max_remaining_days && l.days > c.max_remaining_days) out.push(`${l.loan_ref} matures beyond ${c.max_remaining_days} days`);
  if (c.min_yield_bps && l.yield_bps < c.min_yield_bps) out.push(`${l.loan_ref} yield below minimum`);
  return out;
}

function weighted(loans: PoolLoan[], f: (l: PoolLoan) => number) {
  const w = loans.reduce((a, l) => a + l.principal_cents, 0);
  return w ? loans.reduce((a, l) => a + f(l) * l.principal_cents, 0) / w : 0;
}

function group(loans: PoolLoan[], key: (l: PoolLoan) => string) {
  const total = loans.reduce((a, l) => a + l.principal_cents, 0) || 1;
  const m = new Map<string, { label: string; amount_cents: number; count: number; yield: number[] }>();
  for (const l of loans) {
    const k = key(l);
    const g = m.get(k) ?? { label: k, amount_cents: 0, count: 0, yield: [] };
    g.amount_cents += l.principal_cents;
    g.count++;
    m.set(k, g);
  }
  return [...m.values()].map((g) => ({ label: g.label, amount_cents: g.amount_cents, count: g.count, pct: Math.round((g.amount_cents * 1000) / total) / 10 }));
}

const sortBy = (order: string[]) => (a: { label: string }, b: { label: string }) => order.indexOf(a.label) - order.indexOf(b.label);

function metrics(loans: PoolLoan[]) {
  const open = loans.filter((l) => l.status === 'OPEN');
  const waRatingIdx = Math.round(weighted(open, (l) => RATING_ORDER.indexOf(l.rating)));
  return {
    loans: loans.length,
    open_loans: open.length,
    principal_cents: open.reduce((a, l) => a + l.principal_cents, 0),
    outstanding_cents: open.reduce((a, l) => a + l.outstanding_cents, 0),
    wa_yield_bps: Math.round(weighted(open, (l) => l.yield_bps)),
    wa_days: Math.round(weighted(open, (l) => Math.max(l.days, 0))),
    wa_rating: open.length ? RATING_ORDER[waRatingIdx] : null,
    obligors: new Set(open.map((l) => l.obligor)).size,
    past_due_cents: open.filter((l) => l.days < 0).reduce((a, l) => a + l.principal_cents, 0),
    groups: {
      yield: group(open, (l) => YIELD_BUCKETS.find(([t]) => l.yield_bps < t)![1]).sort(sortBy(YIELD_BUCKETS.map((b) => b[1]))),
      maturity: group(open, (l) => MATURITY_BUCKETS.find(([t]) => l.days <= t)![1]).sort(sortBy(MATURITY_BUCKETS.map((b) => b[1]))),
      country: group(open, (l) => l.country).sort((a, b) => b.amount_cents - a.amount_cents),
      rating: group(open, (l) => l.rating).sort(sortBy(RATING_ORDER)),
      obligor: group(open, (l) => l.obligor).sort((a, b) => b.amount_cents - a.amount_cents),
      program: group(open, (l) => l.program).sort((a, b) => b.amount_cents - a.amount_cents),
    },
  };
}

const engineLoan = (l: PoolLoan) => ({ id: l.id, obligor: l.obligor, program: l.program, country: l.country, rating: l.rating,
  principal_cents: l.principal_cents, outstanding_cents: l.outstanding_cents, yield_bps: l.yield_bps, days: l.days });

/**
 * Concentration on the pool's actual principal. While a DRAFT pool is being filled, additions are
 * checked against its target size (projected); activation and any change to an ACTIVE pool use actual size.
 */
async function concentrationFor(svc: Services, pool: any, loans: PoolLoan[], projected = false) {
  const r = await svc.engine.call('/pool/concentration', { loans: loans.filter((l) => l.status === 'OPEN').map(engineLoan), limits: pool.limits, target_size_cents: pool.target_size_cents, against_target: projected });
  return r.concentration as { key: string; label: string; limit_bps: number; largest: string; amount_cents: number; bps: number; status: string }[];
}

/** Ledger check: principal on account 1200 for the pool's open loans vs the pool's own principal figure. */
function reconcile(svc: Services, poolId: number, loans: PoolLoan[]) {
  const open = loans.filter((l) => l.status === 'OPEN');
  const ids = open.map((l) => l.id);
  const ledger = ids.length
    ? svc.db.get<{ b: number }>(`SELECT COALESCE(SUM(debit_cents - credit_cents), 0) b FROM ledger_lines WHERE account_code = '1200' AND loan_id IN (${ids.map(() => '?').join(',')})`, ids)!.b
    : 0;
  const pool = open.reduce((a, l) => a + l.principal_cents, 0);
  return { pool_principal_cents: pool, ledger_principal_cents: ledger, difference_cents: ledger - pool, reconciled: ledger === pool, pool_id: poolId };
}

export async function listPools(svc: Services) {
  const pools = svc.db.all('SELECT * FROM pools ORDER BY CASE status WHEN \'ACTIVE\' THEN 0 WHEN \'DRAFT\' THEN 1 ELSE 2 END, id DESC');
  const out = [];
  for (const p of pools) {
    const pool = { ...p, criteria: JSON.parse(p.criteria), limits: JSON.parse(p.limits) };
    const loans = poolLoans(svc, p.id);
    const m = metrics(loans);
    const conc = await concentrationFor(svc, pool, loans);
    out.push({
      id: p.id, ref: p.ref, name: p.name, currency: p.currency, status: p.status, target_size_cents: p.target_size_cents, created_by: p.created_by,
      ...Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'groups')),
      tranches: svc.db.all('SELECT name, pct_bps FROM pool_tranches WHERE pool_id = ? ORDER BY pct_bps DESC', [p.id]),
      concentration_status: conc.some((c) => c.status === 'Breach') ? 'Breach' : conc.some((c) => c.status === 'Tight') ? 'Tight' : 'Good',
    });
  }
  return out;
}

export async function getPool(svc: Services, id: number) {
  const pool = load(svc, id);
  const loans = poolLoans(svc, id);
  const tranches = svc.db.all('SELECT * FROM pool_tranches WHERE pool_id = ? ORDER BY CASE name WHEN \'SENIOR\' THEN 0 WHEN \'MEZZANINE\' THEN 1 ELSE 2 END', [id]);
  const m = metrics(loans);
  let attach = 100;
  return {
    ...pool,
    metrics: m,
    loans,
    tranches: tranches.map((t) => {
      const detach = attach;
      attach -= t.pct_bps / 100;
      return { ...t, size_cents: Math.round((m.principal_cents * t.pct_bps) / 10000), attach_pct: Math.round(attach * 100) / 100, detach_pct: detach };
    }),
    concentration: await concentrationFor(svc, pool, loans),
    reconciliation: reconcile(svc, id, loans),
    eligible_count: pool.status === 'CLOSED' ? 0 : candidates(svc, pool).length,
    last_stress: (() => {
      const r = svc.db.get('SELECT * FROM stress_runs WHERE pool_id = ? ORDER BY id DESC LIMIT 1', [id]);
      return r ? { ...r, inputs: JSON.parse(r.inputs), results: JSON.parse(r.results) } : null;
    })(),
    history: svc.db.all("SELECT ts, actor, action, details FROM audit_log WHERE entity_type = 'pool' AND entity_id = ? ORDER BY id DESC LIMIT 50", [String(id)])
      .map((h) => ({ ...h, details: JSON.parse(h.details) })),
  };
}

export function eligibleLoans(svc: Services, id: number) {
  return candidates(svc, load(svc, id));
}

function validatePool(body: any) {
  const input = check<any>(body, {
    name: { type: 'string', required: true, maxLength: 120 },
    currency: { type: 'string', required: true, pattern: /^[A-Z]{3}$/ },
    strategy: { type: 'string', maxLength: 500 },
    target_size_cents: { type: 'int', required: true, min: 100_000 },
  });
  const errors: Record<string, string> = {};
  const c = body?.criteria ?? {};
  const criteria = {
    programs: Array.isArray(c.programs) ? c.programs.filter((x: unknown) => typeof x === 'string') : [],
    min_rating: c.min_rating || null,
    min_remaining_days: Number.isSafeInteger(c.min_remaining_days) ? c.min_remaining_days : 5,
    max_remaining_days: Number.isSafeInteger(c.max_remaining_days) ? c.max_remaining_days : null,
    min_yield_bps: Number.isSafeInteger(c.min_yield_bps) ? c.min_yield_bps : null,
  };
  if (criteria.min_rating && !RATING_ORDER.includes(criteria.min_rating)) errors['criteria.min_rating'] = 'unknown rating';
  const l = body?.limits ?? {};
  const limits: Record<string, number> = {};
  for (const k of ['max_obligor_bps', 'max_program_bps', 'max_country_bps', 'max_sub_ig_bps']) {
    if (l[k] === undefined || l[k] === null || l[k] === '') continue;
    if (!Number.isSafeInteger(l[k]) || l[k] < 0 || l[k] > 10000) errors[`limits.${k}`] = 'must be 0-10000 bps';
    else limits[k] = l[k];
  }
  const tranches = Array.isArray(body?.tranches) ? body.tranches : [];
  const seen = new Set();
  tranches.forEach((t: any, i: number) => {
    if (!TRANCHES.includes(t?.name) || seen.has(t.name)) errors[`tranches[${i}].name`] = 'must be a distinct SENIOR, MEZZANINE or EQUITY';
    seen.add(t?.name);
    if (!Number.isSafeInteger(t?.pct_bps) || t.pct_bps <= 0 || t.pct_bps > 10000) errors[`tranches[${i}].pct_bps`] = 'must be 1-10000';
    if (t?.coupon_bps !== undefined && (!Number.isSafeInteger(t.coupon_bps) || t.coupon_bps < 0 || t.coupon_bps > 5000)) errors[`tranches[${i}].coupon_bps`] = 'must be 0-5000';
  });
  if (tranches.length && !Object.keys(errors).some((k) => k.startsWith('tranches')) && tranches.reduce((a: number, t: any) => a + t.pct_bps, 0) !== 10000) errors.tranches = 'tranche percentages must total 100%';
  if (Object.keys(errors).length) throw validation(errors);
  return { input, criteria, limits, tranches };
}

export function createPool(svc: Services, user: User, body: any) {
  requirePermission(user, 'pool.manage');
  const v = validatePool(body);
  return svc.db.tx(() => {
    const ref = nextRef(svc.db, 'POOL', 4);
    const { id } = svc.db.run(
      `INSERT INTO pools (ref, name, currency, strategy, target_size_cents, criteria, limits, status, created_by, created_at) VALUES (?,?,?,?,?,?,?, 'DRAFT', ?, ?)`,
      [ref, v.input.name, v.input.currency, v.input.strategy ?? null, v.input.target_size_cents, JSON.stringify(v.criteria), JSON.stringify(v.limits), user.username, now()]);
    for (const t of v.tranches) svc.db.run('INSERT INTO pool_tranches (pool_id, name, pct_bps, coupon_bps) VALUES (?,?,?,?)', [id, t.name, t.pct_bps, t.coupon_bps ?? 0]);
    audit.record(svc.db, user, 'pool.created', 'pool', id, { ref, ...v.input, criteria: v.criteria, limits: v.limits, tranches: v.tranches });
    return { status: 201, json: { id, ref } };
  });
}

export function updatePool(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'pool.manage');
  const before = load(svc, id);
  if (before.status !== 'DRAFT') throw conflict('Only draft pools can be restructured');
  const v = validatePool({ ...body, currency: before.currency });
  return svc.db.tx(() => {
    svc.db.run('UPDATE pools SET name = ?, strategy = ?, target_size_cents = ?, criteria = ?, limits = ? WHERE id = ?',
      [v.input.name, v.input.strategy ?? null, v.input.target_size_cents, JSON.stringify(v.criteria), JSON.stringify(v.limits), id]);
    svc.db.run('DELETE FROM pool_tranches WHERE pool_id = ?', [id]);
    for (const t of v.tranches) svc.db.run('INSERT INTO pool_tranches (pool_id, name, pct_bps, coupon_bps) VALUES (?,?,?,?)', [id, t.name, t.pct_bps, t.coupon_bps ?? 0]);
    audit.record(svc.db, user, 'pool.updated', 'pool', id, { before: { target: before.target_size_cents, criteria: before.criteria, limits: before.limits }, after: { target: v.input.target_size_cents, criteria: v.criteria, limits: v.limits, tranches: v.tranches } });
    return { ok: true };
  });
}

export async function addLoans(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'pool.manage');
  const pool = load(svc, id);
  if (pool.status === 'CLOSED') throw conflict('Pool is closed');
  const ids: number[] = Array.isArray(body?.loan_ids) ? body.loan_ids.filter(Number.isSafeInteger) : [];
  if (!ids.length) throw badRequest('loan_ids must be a non-empty array');
  const loans = loanRows(svc, `l.id IN (${ids.map(() => '?').join(',')})`, ids);
  if (loans.length !== ids.length) throw badRequest('Some loans do not exist');
  const issues = loans.flatMap((l) => eligibilityIssues(pool, l));
  const taken = svc.db.all(`SELECT l.loan_ref FROM pool_loans pl JOIN loans l ON l.id = pl.loan_id WHERE pl.removed_at IS NULL AND pl.loan_id IN (${ids.map(() => '?').join(',')})`, ids);
  issues.push(...taken.map((t) => `${t.loan_ref} is already in a pool`));
  if (issues.length) throw conflict('Some loans are not eligible for this pool', issues);
  const current = poolLoans(svc, id).filter((l) => l.status === 'OPEN');
  const size = current.concat(loans).reduce((a, l) => a + l.principal_cents, 0);
  if (size > pool.target_size_cents) throw conflict(`Pool would exceed its target size (${(size / 100).toLocaleString('en-US')} > ${(pool.target_size_cents / 100).toLocaleString('en-US')})`);
  const conc = await concentrationFor(svc, pool, current.concat(loans), pool.status === 'DRAFT');
  const breaches = conc.filter((c) => c.status === 'Breach');
  if (breaches.length && (pool.status !== 'DRAFT' || !body?.allow_breach)) throw conflict(pool.status === 'DRAFT' ? 'Adding these loans breaches concentration limits' : 'An active pool cannot take loans that breach its concentration limits', breaches.map((b) => `${b.label}: ${b.largest} ${(b.bps / 100).toFixed(1)}% > ${(b.limit_bps / 100).toFixed(1)}%`));
  return svc.db.tx(() => {
    for (const l of loans) svc.db.run('INSERT INTO pool_loans (pool_id, loan_id, added_by, added_at) VALUES (?,?,?,?)', [id, l.id, user.username, now()]);
    audit.record(svc.db, user, 'pool.loans_added', 'pool', id, { loans: loans.map((l) => l.loan_ref), principal_cents: loans.reduce((a, l) => a + l.principal_cents, 0) });
    return { ok: true, added: loans.length };
  });
}

export function removeLoans(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'pool.manage');
  const pool = load(svc, id);
  if (pool.status !== 'DRAFT') throw conflict('Loans can only be removed while the pool is a draft');
  const ids: number[] = Array.isArray(body?.loan_ids) ? body.loan_ids.filter(Number.isSafeInteger) : [];
  if (!ids.length) throw badRequest('loan_ids must be a non-empty array');
  return svc.db.tx(() => {
    let n = 0;
    for (const lid of ids) n += svc.db.run('UPDATE pool_loans SET removed_at = ?, removed_by = ? WHERE pool_id = ? AND loan_id = ? AND removed_at IS NULL', [now(), user.username, id, lid]).changes;
    audit.record(svc.db, user, 'pool.loans_removed', 'pool', id, { loan_ids: ids, removed: n });
    return { ok: true, removed: n };
  });
}

/** Engine proposes loans (highest yield first) that fit the target and every concentration limit. */
export async function autoBuild(svc: Services, user: User, id: number, apply: boolean) {
  requirePermission(user, 'pool.manage');
  const pool = load(svc, id);
  if (pool.status === 'CLOSED') throw conflict('Pool is closed');
  const current = poolLoans(svc, id).filter((l) => l.status === 'OPEN');
  const cands = candidates(svc, pool);
  const r = await svc.engine.call('/pool/select', { candidates: cands.map(engineLoan), current: current.map(engineLoan), target_size_cents: pool.target_size_cents, limits: pool.limits });
  const byId = new Map(cands.map((l) => [l.id, l]));
  const proposal = { selected: r.selected.map((x: number) => byId.get(x)), skipped: r.skipped.map((s: any) => ({ ...s, loan_ref: byId.get(s.id)?.loan_ref })), size_cents: r.size_cents, concentration: r.concentration };
  if (!apply || !r.selected.length) return proposal;
  await addLoans(svc, user, id, { loan_ids: r.selected });
  return { ...proposal, applied: true };
}

export async function activate(svc: Services, user: User, id: number) {
  requirePermission(user, 'pool.activate');
  assertNotRecentlyReset(svc, user);
  const p = await getPool(svc, id);
  if (p.status !== 'DRAFT') throw conflict(`Pool is ${p.status}`);
  if (p.created_by === user.username) throw forbidden('Four-eyes: a pool must be activated by someone other than the person who built it (SoD-8)');
  const problems: string[] = [];
  if (!p.metrics.open_loans) problems.push('Pool has no loans');
  if (p.tranches.reduce((a: number, t: any) => a + t.pct_bps, 0) !== 10000) problems.push('Tranche structure must total 100%');
  for (const c of p.concentration.filter((x: any) => x.status === 'Breach')) problems.push(`${c.label} limit breached (${c.largest})`);
  if (!p.reconciliation.reconciled) problems.push('Pool principal does not reconcile to the ledger');
  if (problems.length) throw conflict('Pool cannot be activated', problems);
  return svc.db.tx(() => {
    svc.db.run("UPDATE pools SET status = 'ACTIVE', activated_by = ?, activated_at = ? WHERE id = ? AND status = 'DRAFT'", [user.username, now(), id]);
    audit.record(svc.db, user, 'pool.activated', 'pool', id, { principal_cents: p.metrics.principal_cents, loans: p.metrics.open_loans, tranches: p.tranches.map((t: any) => [t.name, t.pct_bps]) });
    emit(svc.db, 'pool.activated', 'pool', id, { id, ref: p.ref, name: p.name });
    return { ok: true };
  });
}

export function closePool(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'pool.activate');
  const p = load(svc, id);
  if (p.status === 'CLOSED') throw conflict('Pool is already closed');
  const open = poolLoans(svc, id).filter((l) => l.status === 'OPEN').length;
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (!note) throw validation({ note: 'give a reason' });
  if (open && !body?.release_open_loans) throw conflict(`${open} loan(s) are still open; release them to close the pool`);
  return svc.db.tx(() => {
    if (open) svc.db.run("UPDATE pool_loans SET removed_at = ?, removed_by = ? WHERE pool_id = ? AND removed_at IS NULL AND loan_id IN (SELECT id FROM loans WHERE status = 'OPEN')", [now(), user.username, id]);
    svc.db.run("UPDATE pools SET status = 'CLOSED', closed_by = ?, closed_at = ? WHERE id = ?", [user.username, now(), id]);
    audit.record(svc.db, user, 'pool.closed', 'pool', id, { note, released_open_loans: open });
    return { ok: true };
  });
}

export async function stressTest(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'pool.stress');
  const p = await getPool(svc, id);
  const loans = p.loans.filter((l: PoolLoan) => l.status === 'OPEN');
  if (!loans.length) throw conflict('Pool has no open loans to model');
  const scenarios = Array.isArray(body?.scenarios) && body.scenarios.length ? body.scenarios : undefined;
  const tranches = p.tranches.map((t: any) => ({ name: t.name, pct_bps: t.pct_bps, coupon_bps: t.coupon_bps }));
  const result = await svc.engine.call('/pool/stress', { loans: loans.map(engineLoan), tranches, scenarios });
  svc.db.tx(() => {
    svc.db.run('INSERT INTO stress_runs (pool_id, inputs, results, run_by, run_at) VALUES (?,?,?,?,?)', [id, JSON.stringify({ scenarios: scenarios ?? 'default', loans: loans.length }), JSON.stringify(result), user.username, now()]);
    audit.record(svc.db, user, 'pool.stress_tested', 'pool', id, { scenarios: result.results.map((r: any) => [r.scenario.name, r.pool.loss_pct]), breakeven: result.breakeven_pd_multiple });
  });
  return result;
}

export function poolMembership(svc: Services) {
  return new Map(svc.db.all("SELECT pl.loan_id, p.ref FROM pool_loans pl JOIN pools p ON p.id = pl.pool_id WHERE pl.removed_at IS NULL").map((r) => [r.loan_id, r.ref]));
}
