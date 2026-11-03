// UNDERWRITE: credit applications for obligors (new limit, increase, renewal).
//
// DRAFT -> (submit: KYC/AML screening + bureau + Python scoring) -> IN_REVIEW | REFERRED
//       -> decide (maker-checker, delegated authority, override with reason) -> APPROVED | DECLINED
// Approval writes the approved limit, rating and pricing to the Master Table obligor and
// generates a credit memo and term sheet (PDF). Every step is audit-logged.

import type { Services, User } from '../core/context.ts';
import { assertNotRecentlyReset } from '../core/cooldown.ts';
import { requirePermission, can, now, nextRef, addDays } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { emit } from '../core/outbox.ts';
import { check } from '../lib/validate.ts';
import { badRequest, conflict, forbidden, notFound, validation } from '../lib/errors.ts';
import { fxToUsd, obligorUsage } from './exposure.ts';
import { generatePdf, listDocuments } from './documents.ts';

const FIN_FIELDS = ['revenue_cents', 'ebitda_cents', 'interest_expense_cents', 'total_debt_cents', 'current_assets_cents', 'current_liabilities_cents', 'net_worth_cents', 'debt_service_cents'];
const SIGNED = new Set(['ebitda_cents', 'net_worth_cents']);
const RATING_RE = /^(AAA|AA[+-]?|A[+-]?|BBB[+-]?|BB[+-]?|B[+-]?|CCC[+-]?|CC|C|D)$/;

const appSchema = {
  program_id: { type: 'int', required: true, min: 1 },
  obligor_id: { type: 'int', min: 1 },
  application_type: { type: 'enum', required: true, values: ['NEW', 'INCREASE', 'RENEWAL'] },
  obligor_name: { type: 'string', required: true, maxLength: 120 },
  obligor_role: { type: 'string', maxLength: 40 },
  legal_name: { type: 'string', required: true, maxLength: 160 },
  registration_no: { type: 'string', maxLength: 40 },
  country: { type: 'string', required: true, pattern: /^[A-Z]{2}$/ },
  industry: { type: 'string', maxLength: 80 },
  years_trading: { type: 'int', min: 0, max: 300 },
  requested_limit_cents: { type: 'int', required: true, min: 100_000, max: 1e13 },
  proposed_adv_bps: { type: 'int', required: true, min: 1, max: 10000 },
  proposed_margin_bps: { type: 'int', required: true, min: 0, max: 5000 },
  proposed_spread_bps: { type: 'int', required: true, min: 0, max: 5000 },
  max_tenor_days: { type: 'int', min: 1, max: 720 },
  collateral_type: { type: 'string', maxLength: 60 },
  collateral_value_cents: { type: 'int', min: 0 },
  rationale: { type: 'string', maxLength: 4000 },
} as const;

function validateExtras(body: any) {
  const errors: Record<string, string> = {};
  const owners = body?.beneficial_owners ?? [];
  if (!Array.isArray(owners)) errors.beneficial_owners = 'must be a list';
  else owners.forEach((o: any, i: number) => {
    if (!o || typeof o.name !== 'string' || !o.name.trim()) errors[`beneficial_owners[${i}].name`] = 'is required';
    if (o?.ownership_pct !== undefined && (typeof o.ownership_pct !== 'number' || o.ownership_pct < 0 || o.ownership_pct > 100)) errors[`beneficial_owners[${i}].ownership_pct`] = 'must be 0-100';
  });
  const fin = body?.financials ?? [];
  if (!Array.isArray(fin) || fin.length > 5) errors.financials = 'must be a list of up to 5 fiscal years';
  else fin.forEach((f: any, i: number) => {
    if (!Number.isSafeInteger(f?.year) || f.year < 1990 || f.year > 2100) errors[`financials[${i}].year`] = 'must be a year';
    for (const k of FIN_FIELDS) {
      const v = f?.[k];
      if (!Number.isSafeInteger(v) || (!SIGNED.has(k) && v < 0)) errors[`financials[${i}].${k}`] = SIGNED.has(k) ? 'must be a whole number' : 'must be a whole number >= 0';
    }
  });
  if (Array.isArray(fin) && new Set(fin.map((f: any) => f?.year)).size !== fin.length) errors.financials = 'each fiscal year can appear only once';
  if (Object.keys(errors).length) throw validation(errors);
  return {
    owners: owners.map((o: any) => ({ name: o.name.trim(), ownership_pct: o.ownership_pct ?? null, role: o.role ?? null })),
    financials: [...fin].sort((a: any, b: any) => a.year - b.year).map((f: any) => Object.fromEntries([['year', f.year], ...FIN_FIELDS.map((k) => [k, f[k]])])),
  };
}

// ---------- Scorecard (versioned policy) ----------

export async function ensureScorecard(svc: Services) {
  if (svc.db.get('SELECT version FROM scorecard_versions LIMIT 1')) return;
  const model = await svc.engine.defaultModel();
  svc.db.run('INSERT INTO scorecard_versions (version, model, note, created_by, created_at) VALUES (1, ?, ?, ?, ?)', [JSON.stringify(model), 'Initial policy', 'system', now()]);
}

export function currentScorecard(svc: Services) {
  const row = svc.db.get('SELECT * FROM scorecard_versions ORDER BY version DESC LIMIT 1');
  if (!row) throw conflict('No credit scorecard configured');
  return { ...row, model: JSON.parse(row.model) };
}

export function scorecardHistory(svc: Services) {
  return svc.db.all('SELECT version, note, created_by, created_at FROM scorecard_versions ORDER BY version DESC');
}

export function publishScorecard(svc: Services, user: User, body: any) {
  requirePermission(user, 'underwrite.policy');
  const model = body?.model;
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 300) : '';
  if (!note) throw validation({ note: 'describe what changed' });
  const errors: Record<string, string> = {};
  if (!model || !Array.isArray(model.factors) || !model.factors.length) errors.factors = 'at least one factor is required';
  else model.factors.forEach((f: any, i: number) => {
    if (!Number.isFinite(f?.weight) || f.weight < 0 || f.weight > 100) errors[`factors[${i}].weight`] = 'must be 0-100';
    if (!Array.isArray(f?.bands) || !f.bands.length) errors[`factors[${i}].bands`] = 'required';
  });
  if (!Array.isArray(model?.rating_scale) || !model.rating_scale.length) errors.rating_scale = 'required';
  if (!model?.rules || typeof model.rules !== 'object') errors.rules = 'required';
  if (Object.keys(errors).length) throw validation(errors);
  return svc.db.tx(() => {
    const version = currentScorecard(svc).version + 1;
    svc.db.run('INSERT INTO scorecard_versions (version, model, note, created_by, created_at) VALUES (?,?,?,?,?)', [version, JSON.stringify(model), note, user.username, now()]);
    audit.record(svc.db, user, 'scorecard.published', 'scorecard', version, { note, rules: model.rules, weights: model.factors.map((f: any) => [f.key, f.weight]) });
    return currentScorecard(svc);
  });
}

// ---------- Applications ----------

function load(svc: Services, id: number) {
  const a = svc.db.get('SELECT * FROM credit_applications WHERE id = ?', [id]);
  if (!a) throw notFound('Credit application');
  return a;
}

function parse(a: any) {
  return {
    ...a,
    beneficial_owners: JSON.parse(a.beneficial_owners),
    financials: JSON.parse(a.financials),
    screening: a.screening ? JSON.parse(a.screening) : null,
    bureau: a.bureau ? JSON.parse(a.bureau) : null,
    engine: a.engine ? JSON.parse(a.engine) : null,
    override: !!a.override,
  };
}

export function listApplications(svc: Services, query: URLSearchParams) {
  const status = query.get('status');
  const rows = svc.db.all(
    `SELECT a.id, a.ref, a.application_type, a.obligor_name, a.status, a.requested_limit_cents, a.current_limit_cents, a.approved_limit_cents,
            a.decision, a.override, a.engine, a.prepared_by, a.decided_by, a.submitted_at, a.decided_at, a.created_at, a.updated_at,
            p.program_code, p.deal_name, p.currency, u.name AS prepared_by_name
     FROM credit_applications a JOIN programs p ON p.id = a.program_id JOIN users u ON u.username = a.prepared_by
     ${status ? 'WHERE a.status IN (' + status.split(',').map(() => '?').join(',') + ')' : ''}
     ORDER BY CASE a.status WHEN 'REFERRED' THEN 0 WHEN 'IN_REVIEW' THEN 1 WHEN 'DRAFT' THEN 2 ELSE 3 END, a.updated_at DESC LIMIT 500`,
    status ? status.split(',') : []);
  return rows.map((r) => {
    const e = r.engine ? JSON.parse(r.engine) : null;
    return { ...r, engine: undefined, override: !!r.override, score: e?.score ?? null, rating: e?.rating ?? null, engine_outcome: e?.outcome ?? null };
  });
}

export function getApplication(svc: Services, user: User, id: number) {
  const a = parse(load(svc, id));
  const program = svc.db.get('SELECT id, program_code, deal_name, deal_code, currency, rate_basis FROM programs WHERE id = ?', [a.program_id]);
  const usd = fxToUsd(svc.db);
  const usage = a.obligor_id ? obligorUsage(svc.db).find((o) => o.id === a.obligor_id) ?? null : null;
  return {
    ...a,
    program,
    obligor: usage,
    requested_usd_cents: usd(a.requested_limit_cents, program.currency),
    prepared_by_name: svc.db.get('SELECT name FROM users WHERE username = ?', [a.prepared_by])?.name,
    decided_by_name: a.decided_by ? svc.db.get('SELECT name FROM users WHERE username = ?', [a.decided_by])?.name : null,
    documents: listDocuments(svc, 'credit_application', id),
    history: svc.db.all("SELECT ts, actor, action, details FROM audit_log WHERE entity_type = 'credit_application' AND entity_id = ? ORDER BY id", [String(id)])
      .map((h) => ({ ...h, details: JSON.parse(h.details) })),
    permissions: decisionRights(svc, user, a, usd(a.requested_limit_cents, program.currency)),
  };
}

function decisionRights(svc: Services, user: User, a: any, usdCents: number) {
  const rules = (() => { try { return currentScorecard(svc).model.rules; } catch { return {}; } })();
  const aboveAuthority = !Number.isFinite(usdCents) || usdCents > (rules.authority_limit_usd_cents ?? 0);
  const knockout = a.engine?.outcome === 'DECLINE';
  const reasons: string[] = [];
  if (!['IN_REVIEW', 'REFERRED'].includes(a.status)) reasons.push(`Application is ${a.status}`);
  if (!can(user, 'underwrite.decide') && !can(user, 'underwrite.committee')) reasons.push('Your role cannot decide credit applications');
  const editors: string[] = (() => { try { return JSON.parse(a.editors || '[]'); } catch { return []; } })();
  if (a.prepared_by === user.username || editors.includes(user.username)) reasons.push('Maker-checker: you prepared, edited or submitted this application (SoD-6)');
  return {
    can_edit: a.status === 'DRAFT' && can(user, 'underwrite.prepare'),
    can_submit: a.status === 'DRAFT' && can(user, 'underwrite.prepare'),
    can_return: ['IN_REVIEW', 'REFERRED'].includes(a.status) && (a.prepared_by === user.username || can(user, 'underwrite.decide')),
    can_decide: reasons.length === 0,
    decide_blockers: reasons,
    committee_required: aboveAuthority,
    approve_needs_committee: aboveAuthority || knockout,
    is_committee: can(user, 'underwrite.committee'),
  };
}

export function createApplication(svc: Services, user: User, body: any) {
  requirePermission(user, 'underwrite.prepare');
  const input = check<any>(body, appSchema as any);
  const extras = validateExtras(body);
  const program = svc.db.get('SELECT * FROM programs WHERE id = ?', [input.program_id]);
  if (!program) throw badRequest('Unknown program');
  let current = 0;
  if (input.application_type === 'NEW') {
    if (input.obligor_id) throw validation({ obligor_id: 'leave empty for a new obligor' });
    if (svc.db.get('SELECT id FROM obligors WHERE program_id = ? AND lower(name) = lower(?)', [program.id, input.obligor_name])) {
      throw conflict(`${input.obligor_name} already exists in ${program.program_code}; use a limit increase or renewal`);
    }
  } else {
    if (!input.obligor_id) throw validation({ obligor_id: 'choose the existing obligor' });
    const ob = svc.db.get('SELECT * FROM obligors WHERE id = ? AND program_id = ?', [input.obligor_id, program.id]);
    if (!ob) throw badRequest('Obligor does not belong to this program');
    current = ob.limit_cents;
    input.obligor_name = ob.name;
    if (input.application_type === 'INCREASE' && input.requested_limit_cents <= current) throw validation({ requested_limit_cents: `must exceed the current limit (${current / 100})` });
  }
  if (svc.db.get("SELECT ref FROM credit_applications WHERE program_id = ? AND lower(obligor_name) = lower(?) AND status IN ('DRAFT','IN_REVIEW','REFERRED')", [program.id, input.obligor_name])) {
    throw conflict(`There is already an open credit application for ${input.obligor_name}`);
  }
  return svc.db.tx(() => {
    const ref = nextRef(svc.db, 'UW');
    const ts = now();
    const { id } = svc.db.run(
      `INSERT INTO credit_applications (ref, program_id, obligor_id, application_type, obligor_name, obligor_role, legal_name, registration_no, country, industry, years_trading,
         beneficial_owners, current_limit_cents, requested_limit_cents, proposed_adv_bps, proposed_margin_bps, proposed_spread_bps, max_tenor_days, collateral_type,
         collateral_value_cents, financials, rationale, status, prepared_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?)`,
      [ref, program.id, input.obligor_id ?? null, input.application_type, input.obligor_name, input.obligor_role ?? 'Obligor', input.legal_name, input.registration_no ?? null,
        input.country, input.industry ?? null, input.years_trading ?? null, JSON.stringify(extras.owners), current, input.requested_limit_cents, input.proposed_adv_bps,
        input.proposed_margin_bps, input.proposed_spread_bps, input.max_tenor_days ?? 120, input.collateral_type ?? null, input.collateral_value_cents ?? null,
        JSON.stringify(extras.financials), input.rationale ?? null, user.username, ts, ts],
    );
    audit.record(svc.db, user, 'credit_application.created', 'credit_application', id, { ref, program: program.program_code, obligor: input.obligor_name, type: input.application_type, requested_limit_cents: input.requested_limit_cents });
    return { status: 201, json: { id, ref } };
  });
}

/** Everyone who edited or submitted an application is barred from deciding it (SoD-6). */
function addEditor(svc: Services, id: number, username: string) {
  const row = svc.db.get<any>('SELECT editors, prepared_by FROM credit_applications WHERE id = ?', [id]);
  const list: string[] = JSON.parse(row?.editors || '[]');
  for (const u of [row?.prepared_by, username]) if (u && !list.includes(u)) list.push(u);
  svc.db.run('UPDATE credit_applications SET editors = ? WHERE id = ?', [JSON.stringify(list), id]);
}

export function updateApplication(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'underwrite.prepare');
  const a = load(svc, id);
  if (a.status !== 'DRAFT') throw conflict(`Only drafts can be edited (application is ${a.status})`);
  const input = check<any>({ ...body, program_id: a.program_id, application_type: a.application_type, obligor_id: a.obligor_id ?? undefined, obligor_name: body?.obligor_name ?? a.obligor_name }, appSchema as any);
  const extras = validateExtras(body);
  return svc.db.tx(() => {
    const r = svc.db.run(
      `UPDATE credit_applications SET obligor_name = ?, obligor_role = ?, legal_name = ?, registration_no = ?, country = ?, industry = ?, years_trading = ?, beneficial_owners = ?,
         requested_limit_cents = ?, proposed_adv_bps = ?, proposed_margin_bps = ?, proposed_spread_bps = ?, max_tenor_days = ?, collateral_type = ?, collateral_value_cents = ?,
         financials = ?, rationale = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ? AND status = 'DRAFT'`,
      [a.application_type === 'NEW' ? input.obligor_name : a.obligor_name, input.obligor_role ?? a.obligor_role, input.legal_name, input.registration_no ?? null, input.country, input.industry ?? null,
        input.years_trading ?? null, JSON.stringify(extras.owners), input.requested_limit_cents, input.proposed_adv_bps, input.proposed_margin_bps, input.proposed_spread_bps,
        input.max_tenor_days ?? 120, input.collateral_type ?? null, input.collateral_value_cents ?? null, JSON.stringify(extras.financials), input.rationale ?? null, now(), id],
    );
    if (r.changes !== 1) throw conflict('Application changed - reload and try again');
    addEditor(svc, id, user.username);
    audit.record(svc.db, user, 'credit_application.updated', 'credit_application', id, { requested_limit_cents: input.requested_limit_cents, years: extras.financials.map((f: any) => f.year) });
    return { ok: true };
  });
}

/** Screening + bureau + engine scoring. Shared by submit and rescore. */
async function score(svc: Services, a: any) {
  const owners = JSON.parse(a.beneficial_owners);
  const subject = { legal_name: a.legal_name, country: a.country, registration_no: a.registration_no, owners };
  const [screening, bureau] = await Promise.all([svc.kyc.screen(subject), svc.bureau.report(subject)]);
  const scorecard = currentScorecard(svc);
  const program = svc.db.get('SELECT currency FROM programs WHERE id = ?', [a.program_id]);
  const engine = await svc.engine.underwrite({
    financials: JSON.parse(a.financials),
    profile: { bureau_score: bureau.bureau_score, payment_dbt: bureau.payment_dbt, years_trading: a.years_trading },
    screening: { sanctions_hit: screening.sanctions_hit, pep_hit: screening.pep_hit, adverse_media: screening.adverse_media || screening.high_risk_country },
    requested_limit_cents: a.requested_limit_cents,
    requested_usd_cents: fxToUsd(svc.db)(a.requested_limit_cents, program.currency),
    collateral_value_cents: a.collateral_value_cents ?? 0,
    model: scorecard.model,
  });
  if (screening.high_risk_country) engine.refers.push(`High-risk jurisdiction (${a.country}) - enhanced due diligence`);
  if (engine.outcome === 'APPROVE' && engine.refers.length) engine.outcome = 'REFER';
  return { screening, bureau, engine, scorecard_version: scorecard.version };
}

export async function submitApplication(svc: Services, user: User, id: number, rescore = false) {
  requirePermission(user, rescore ? 'underwrite.decide' : 'underwrite.prepare');
  const a = load(svc, id);
  if (!rescore && a.status !== 'DRAFT') throw conflict(`Application is ${a.status}`);
  if (rescore && !['IN_REVIEW', 'REFERRED'].includes(a.status)) throw conflict(`Application is ${a.status}`);
  if (!JSON.parse(a.financials).length) throw validation({ financials: 'add at least one fiscal year before submitting' });
  const r = await score(svc, a);
  return svc.db.tx(() => {
    const status = r.engine.outcome === 'APPROVE' ? 'IN_REVIEW' : 'REFERRED';
    const upd = svc.db.run(
      `UPDATE credit_applications SET status = ?, screening = ?, bureau = ?, engine = ?, scorecard_version = ?, submitted_at = COALESCE(submitted_at, ?), updated_at = ?, row_version = row_version + 1
       WHERE id = ? AND row_version = ?`,
      [status, JSON.stringify(r.screening), JSON.stringify(r.bureau), JSON.stringify(r.engine), r.scorecard_version, now(), now(), id, a.row_version],
    );
    if (upd.changes !== 1) throw conflict('Application changed while scoring - reload and try again');
    if (!rescore) addEditor(svc, id, user.username);
    audit.record(svc.db, user, rescore ? 'credit_application.rescored' : 'credit_application.submitted', 'credit_application', id, {
      score: r.engine.score, rating: r.engine.rating, outcome: r.engine.outcome, knockouts: r.engine.knockouts, refers: r.engine.refers,
      scorecard_version: r.scorecard_version, screening_ref: r.screening.reference, bureau_ref: r.bureau.reference,
    });
    emit(svc.db, 'underwriting.scored', 'credit_application', id, { id, ref: a.ref, obligor: a.obligor_name, outcome: r.engine.outcome, rating: r.engine.rating });
    return { ok: true, status, engine: r.engine };
  });
}

export function returnToDraft(svc: Services, user: User, id: number, body: any) {
  const a = load(svc, id);
  if (!['IN_REVIEW', 'REFERRED'].includes(a.status)) throw conflict(`Application is ${a.status}`);
  if (a.prepared_by !== user.username) requirePermission(user, 'underwrite.decide');
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (!note) throw validation({ note: 'say what needs to change' });
  return svc.db.tx(() => {
    svc.db.run("UPDATE credit_applications SET status = 'DRAFT', updated_at = ?, row_version = row_version + 1 WHERE id = ?", [now(), id]);
    audit.record(svc.db, user, 'credit_application.returned', 'credit_application', id, { note });
    return { ok: true };
  });
}

export function withdrawApplication(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'underwrite.prepare');
  const a = load(svc, id);
  if (!['DRAFT', 'IN_REVIEW', 'REFERRED'].includes(a.status)) throw conflict(`Application is ${a.status}`);
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (!note) throw validation({ note: 'give a reason' });
  return svc.db.tx(() => {
    svc.db.run("UPDATE credit_applications SET status = 'WITHDRAWN', updated_at = ?, row_version = row_version + 1 WHERE id = ?", [now(), id]);
    audit.record(svc.db, user, 'credit_application.withdrawn', 'credit_application', id, { note });
    return { ok: true };
  });
}

export async function decide(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, can(user, 'underwrite.decide') ? 'underwrite.decide' : 'underwrite.committee');
  assertNotRecentlyReset(svc, user);
  const input = check<any>(body, {
    decision: { type: 'enum', required: true, values: ['APPROVE', 'DECLINE'] },
    reason: { type: 'string', required: true, maxLength: 4000 },
    approved_limit_cents: { type: 'int', min: 100_000 },
    approved_rating: { type: 'string', pattern: RATING_RE },
    approved_margin_bps: { type: 'int', min: 0, max: 5000 },
    approved_spread_bps: { type: 'int', min: 0, max: 5000 },
    approved_adv_bps: { type: 'int', min: 1, max: 10000 },
    conditions: { type: 'string', maxLength: 4000 },
    review_months: { type: 'int', min: 1, max: 36 },
  });
  const a = parse(load(svc, id));
  if (!['IN_REVIEW', 'REFERRED'].includes(a.status)) throw conflict(`Application is ${a.status}`);
  const editors: string[] = JSON.parse(svc.db.get<any>('SELECT editors FROM credit_applications WHERE id = ?', [id])?.editors || '[]');
  if (a.prepared_by === user.username || editors.includes(user.username)) {
    throw forbidden('Maker-checker: the decision must be made by someone who did not prepare, edit or submit this application (SoD-6)');
  }
  const engine = a.engine;
  if (!engine) throw conflict('Application has not been scored');
  const program = svc.db.get('SELECT * FROM programs WHERE id = ?', [a.program_id]);
  const limit = input.decision === 'APPROVE' ? input.approved_limit_cents ?? a.requested_limit_cents : null;
  if (limit && limit > a.requested_limit_cents) throw validation({ approved_limit_cents: 'cannot exceed the requested limit' });
  const rawUsd = limit ? fxToUsd(svc.db)(limit, program.currency) : 0;
  // No FX rate for the currency: fail closed and treat the limit as above authority.
  const usdLimit = Number.isFinite(rawUsd) ? rawUsd : Number.MAX_SAFE_INTEGER;
  const authority = currentScorecard(svc).model.rules.authority_limit_usd_cents ?? 0;
  const override = (input.decision === 'APPROVE' && engine.outcome !== 'APPROVE') || (input.decision === 'DECLINE' && engine.outcome === 'APPROVE');
  if (input.decision === 'APPROVE' && (engine.outcome === 'DECLINE' || usdLimit > authority) && !can(user, 'underwrite.committee')) {
    throw forbidden(engine.outcome === 'DECLINE'
      ? 'The engine declined this application (knock-out). Only the credit committee can approve it (SoD-7).'
      : 'The approved limit exceeds delegated credit authority. Credit committee approval is required (SoD-7).');
  }
  if (override && input.reason.length < 20) throw validation({ reason: 'an override needs a substantive reason (20+ characters)' });
  if (input.decision === 'APPROVE' && engine.knockouts?.some((k: string) => k.startsWith('Sanctions'))) {
    throw forbidden('Sanctions match: approval is blocked until compliance clears the screening result');
  }
  const rating = input.approved_rating ?? engine.rating;
  const margin = input.approved_margin_bps ?? a.proposed_margin_bps;
  const spread = input.approved_spread_bps ?? a.proposed_spread_bps;
  const adv = input.approved_adv_bps ?? a.proposed_adv_bps;
  const reviewDate = input.decision === 'APPROVE' ? addDays(svc.today(), 30 * (input.review_months ?? 12)) : null;

  const result = svc.db.tx(() => {
    const r = svc.db.run(
      `UPDATE credit_applications SET status = ?, decision = ?, override = ?, decision_reason = ?, approved_limit_cents = ?, approved_rating = ?, conditions = ?, review_date = ?,
         decided_by = ?, decided_at = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ? AND row_version = ?`,
      [input.decision === 'APPROVE' ? 'APPROVED' : 'DECLINED', input.decision, override ? 1 : 0, input.reason, limit, input.decision === 'APPROVE' ? rating : null,
        input.conditions ?? null, reviewDate, user.username, now(), now(), id, a.row_version],
    );
    if (r.changes !== 1) throw conflict('Application changed - reload and try again');
    let obligorId = a.obligor_id;
    if (input.decision === 'APPROVE') {
      if (obligorId) {
        const before = svc.db.get('SELECT * FROM obligors WHERE id = ?', [obligorId]);
        svc.db.run('UPDATE obligors SET limit_cents = ?, rating = ?, advance_rate_bps = ?, investor_margin_bps = ?, sp_spread_bps = ?, active = 1 WHERE id = ?',
          [limit, rating, adv, margin, spread, obligorId]);
        audit.record(svc.db, user, 'obligor.updated', 'obligor', obligorId, { source: a.ref, before, after: svc.db.get('SELECT * FROM obligors WHERE id = ?', [obligorId]) });
      } else {
        obligorId = svc.db.run(
          `INSERT INTO obligors (program_id, name, rating, role, limit_cents, advance_rate_bps, investor_margin_bps, sp_spread_bps, auto_debit, active) VALUES (?,?,?,?,?,?,?,?,0,1)`,
          [a.program_id, a.obligor_name, rating, a.obligor_role, limit, adv, margin, spread]).id;
        svc.db.run('UPDATE credit_applications SET obligor_id = ? WHERE id = ?', [obligorId, id]);
        audit.record(svc.db, user, 'obligor.created', 'obligor', obligorId, { source: a.ref, name: a.obligor_name, limit_cents: limit, rating });
      }
    }
    audit.record(svc.db, user, 'credit_application.decided', 'credit_application', id, {
      decision: input.decision, override, engine_outcome: engine.outcome, reason: input.reason, approved_limit_cents: limit, rating, conditions: input.conditions ?? null,
      committee: usdLimit > authority || (override && engine.outcome === 'DECLINE'),
    });
    emit(svc.db, 'underwriting.decided', 'credit_application', id, { id, ref: a.ref, obligor: a.obligor_name, decision: input.decision, override });
    return { ok: true, decision: input.decision, obligor_id: obligorId };
  });

  // Generated documents (outside the transaction: they call the Python engine).
  const fresh = getApplication(svc, user, id);
  await generatePdf(svc, user, 'credit_application', id, 'CREDIT_MEMO', `${a.ref}_credit_memo.pdf`, creditMemoSpec(fresh));
  if (input.decision === 'APPROVE') {
    await generatePdf(svc, user, 'credit_application', id, 'TERM_SHEET', `${a.ref}_term_sheet.pdf`, termSheetSpec(fresh, { adv, margin, spread }));
  }
  return result;
}

export async function regenerateMemo(svc: Services, user: User, id: number) {
  requirePermission(user, 'underwrite.prepare');
  const a = getApplication(svc, user, id);
  if (!a.engine) throw conflict('Submit the application for scoring first');
  const docId = await generatePdf(svc, user, 'credit_application', id, 'CREDIT_MEMO', `${a.ref}_credit_memo.pdf`, creditMemoSpec(a));
  return { ok: true, document_id: docId };
}

// ---------- Document content ----------

const fmt = (cents: number | null | undefined, ccy?: string) => (cents == null ? '—' : `${ccy ? ccy + ' ' : ''}${Math.round(cents / 100).toLocaleString('en-US')}`);
const pctBps = (b: number | null | undefined) => (b == null ? '—' : `${(b / 100).toFixed(2)}%`);
const ratio = (s: string | null | undefined, digits = 2) => (s == null ? 'n/a' : Number(s).toFixed(digits));
const pctRatio = (s: string | null | undefined) => (s == null ? 'n/a' : `${(Number(s) * 100).toFixed(1)}%`);

function creditMemoSpec(a: any) {
  const ccy = a.program.currency;
  const e = a.engine;
  const fin = a.financials;
  const decided = a.decision ? `${a.decision === 'APPROVE' ? 'Approved' : 'Declined'} by ${a.decided_by_name} on ${a.decided_at.slice(0, 10)}${a.override ? ' (override of engine recommendation)' : ''}` : 'Pending decision';
  return {
    title: `Credit memo — ${a.obligor_name}`,
    subtitle: `${a.ref} · ${a.application_type === 'NEW' ? 'New obligor' : a.application_type === 'INCREASE' ? 'Limit increase' : 'Renewal'} · ${a.program.deal_name} (${a.program.program_code})`,
    footer: `${a.ref} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · scorecard v${a.scorecard_version} · Confidential`,
    meta: [
      ['Legal name', a.legal_name], ['Registration', a.registration_no ?? '—'], ['Country / industry', `${a.country} · ${a.industry ?? '—'}`],
      ['Years trading', String(a.years_trading ?? '—')], ['Prepared by', a.prepared_by_name], ['Status', `${a.status} — ${decided}`],
    ],
    sections: [
      { heading: 'Request', kv: [
        ['Current limit', fmt(a.current_limit_cents, ccy)], ['Requested limit', fmt(a.requested_limit_cents, ccy)],
        ['Approved limit', a.approved_limit_cents ? fmt(a.approved_limit_cents, ccy) : '—'],
        ['Proposed pricing', `Advance ${pctBps(a.proposed_adv_bps)} · investor margin ${pctBps(a.proposed_margin_bps)} · SP spread ${pctBps(a.proposed_spread_bps)}`],
        ['Maximum tenor', `${a.max_tenor_days} days`],
        ['Collateral', a.collateral_type ? `${a.collateral_type} · ${fmt(a.collateral_value_cents, ccy)}${e?.ltv ? ` · LTV ${pctRatio(e.ltv)}` : ''}` : 'None (unsecured receivables)'],
      ], paragraphs: a.rationale ? [`Rationale: ${a.rationale}`] : [] },
      { heading: 'Engine recommendation', kv: [
        ['Score', `${e.score} / 100`], ['Risk rating', e.rating], ['Recommendation', e.outcome],
        ['Pricing guidance', e.pricing_guidance ? `investor margin ${pctBps(e.pricing_guidance.investor_margin_bps)} · SP spread ${pctBps(e.pricing_guidance.sp_spread_bps)}` : '—'],
      ], bullets: [...e.knockouts.map((k: string) => `Knock-out: ${k}`), ...e.refers.map((r: string) => `Refer: ${r}`)] },
      { heading: 'Financial spreading', table: {
        columns: ['', ...fin.map((f: any) => `FY${f.year}`)],
        rows: [
          ['Revenue', ...fin.map((f: any) => fmt(f.revenue_cents))], ['EBITDA', ...fin.map((f: any) => fmt(f.ebitda_cents))],
          ['Interest expense', ...fin.map((f: any) => fmt(f.interest_expense_cents))], ['Total debt', ...fin.map((f: any) => fmt(f.total_debt_cents))],
          ['Annual debt service', ...fin.map((f: any) => fmt(f.debt_service_cents))], ['Net worth', ...fin.map((f: any) => fmt(f.net_worth_cents))],
          ['DSCR', ...e.spreads.map((s: any) => ratio(s.dscr))], ['Debt / EBITDA', ...e.spreads.map((s: any) => ratio(s.leverage))],
          ['Interest cover', ...e.spreads.map((s: any) => ratio(s.interest_cover))], ['Current ratio', ...e.spreads.map((s: any) => ratio(s.current_ratio))],
          ['EBITDA margin', ...e.spreads.map((s: any) => pctRatio(s.ebitda_margin))], ['Revenue growth', ...e.spreads.map((s: any) => pctRatio(s.revenue_growth))],
        ],
      } },
      { heading: 'Scorecard', table: {
        columns: ['Factor', 'Value', 'Points', 'Weight', 'Contribution'],
        rows: e.factors.map((f: any) => [f.label, f.value == null ? 'n/a' : Number(f.value).toFixed(2), String(f.points), `${f.weight}%`, Number(f.contribution).toFixed(2)]),
      } },
      { heading: 'KYC / AML and bureau', kv: [
        ['Screening', `${a.screening.provider} · ref ${a.screening.reference} · ${a.screening.sanctions_hit ? 'SANCTIONS MATCH' : 'no sanctions match'} · ${a.screening.pep_hit ? 'PEP match' : 'no PEP'} · ${a.screening.adverse_media ? 'adverse media' : 'no adverse media'}`],
        ['Beneficial owners', a.beneficial_owners.map((o: any) => `${o.name}${o.ownership_pct != null ? ` (${o.ownership_pct}%)` : ''}`).join(', ') || '—'],
        ['Bureau', `${a.bureau.provider} · ref ${a.bureau.reference} · score ${a.bureau.bureau_score} · ${a.bureau.payment_dbt} days beyond terms · ${a.bureau.public_records} public records`],
      ] },
      ...(a.decision ? [{ heading: 'Decision', kv: [
        ['Decision', `${a.decision}${a.override ? ' (override)' : ''}`], ['Decided by', `${a.decided_by_name} · ${a.decided_at.slice(0, 10)}`],
        ['Reason', a.decision_reason], ['Conditions', a.conditions ?? '—'], ['Next review', a.review_date ?? '—'],
      ] }] : []),
    ],
  };
}

function termSheetSpec(a: any, p: { adv: number; margin: number; spread: number }) {
  const ccy = a.program.currency;
  return {
    title: `Indicative term sheet — ${a.obligor_name}`,
    subtitle: `${a.program.deal_name} · ${a.ref}`,
    footer: `${a.ref} · subject to documentation and the conditions below · Confidential`,
    sections: [
      { heading: 'Facility', kv: [
        ['Program', `${a.program.deal_name} (${a.program.program_code} / ${a.program.deal_code})`], ['Obligor', `${a.obligor_name} (${a.legal_name})`],
        ['Facility type', 'Uncommitted receivables purchase facility'], ['Facility limit', fmt(a.approved_limit_cents, ccy)], ['Currency', ccy],
        ['Advance rate', pctBps(p.adv)], ['Maximum invoice tenor', `${a.max_tenor_days} days`],
      ] },
      { heading: 'Pricing', kv: [
        ['Benchmark', `${a.program.rate_basis}, tenor-bucketed (1–30 / 31–90 / 91–180 / 181+ days), fixed at funding`],
        ['Investor margin', pctBps(p.margin)], ['Seaport spread', pctBps(p.spread)],
        ['Discount', 'Purchase price × (benchmark + investor margin + Seaport spread) × tenor ÷ day count, deducted at funding'],
        ['Late payment', 'Shortfall × (benchmark + late margin) × days past maturity ÷ day count'],
      ] },
      { heading: 'Conditions', bullets: (a.conditions ? a.conditions.split(/\n+/) : []).concat(['Satisfactory KYC/AML refresh before first funding', `Annual review by ${a.review_date}`]) },
      { heading: 'Approval', kv: [['Risk rating', a.approved_rating], ['Approved by', `${a.decided_by_name} · ${a.decided_at.slice(0, 10)}`]] },
    ],
  };
}

export function underwritingSummary(svc: Services) {
  const since = addDays(svc.today(), -30);
  const c = (sql: string, p: any[] = []) => svc.db.get<{ n: number }>(sql, p)!.n;
  return {
    drafts: c("SELECT COUNT(*) n FROM credit_applications WHERE status = 'DRAFT'"),
    in_review: c("SELECT COUNT(*) n FROM credit_applications WHERE status = 'IN_REVIEW'"),
    referred: c("SELECT COUNT(*) n FROM credit_applications WHERE status = 'REFERRED'"),
    approved_30d: c("SELECT COUNT(*) n FROM credit_applications WHERE status = 'APPROVED' AND decided_at >= ?", [since]),
    declined_30d: c("SELECT COUNT(*) n FROM credit_applications WHERE status = 'DECLINED' AND decided_at >= ?", [since]),
    overrides: c('SELECT COUNT(*) n FROM credit_applications WHERE override = 1'),
    reviews_due: svc.db.all("SELECT id, ref, obligor_name, review_date FROM credit_applications WHERE status = 'APPROVED' AND review_date <= ? ORDER BY review_date", [addDays(svc.today(), 60)]),
  };
}
