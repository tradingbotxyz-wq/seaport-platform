// End-to-end API tests: real Node API + real Python engine + in-memory SQLite with demo data.
// Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices, createApp } from '../src/app.ts';
import { launchEngine } from '../src/integrations/engine.ts';
import { seed } from '../src/seed.ts';
import { seedModules } from '../src/seed-modules.ts';
import { dispatchPending } from '../src/core/outbox.ts';
import * as audit from '../src/core/audit.ts';
import type { Services } from '../src/core/context.ts';
import { addBusinessDays } from '../src/core/context.ts';

const TODAY = '2026-11-03'; // Tuesday
let server: Server;
let base = '';
let svc: Services;
let kill: () => void;
let dir = '';

async function api(method: string, path: string, user: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'X-User': user, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seaport-test-'));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const { client, child } = await launchEngine(port);
  kill = () => child?.kill();
  svc = createServices({ dbPath: ':memory:', engine: client, filesDir: join(dir, 'files'), today: () => TODAY, auth: { mode: 'demo' } });
  seed(svc);
  await seedModules(svc);
  server = createServer(createApp(svc, { log: false }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  server?.close();
  kill?.();
  svc?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function harborviewBatch() {
  const list = (await api('GET', '/api/imports?status=UPLOADED', 'priya')).json;
  return list.find((f: any) => f.program_code === 'PRG-1041');
}

test('authentication is required and unknown users are rejected', async () => {
  assert.equal((await fetch(base + '/api/dashboard')).status, 401);
  assert.equal((await api('GET', '/api/dashboard', 'nobody')).status, 401);
  assert.equal((await api('GET', '/api/health', '')).status, 200);
});

test('pricing matches the prototype screen (SOFR, ACT/360)', async () => {
  const f = await harborviewBatch();
  const v = (await api('GET', `/api/imports/${f.id}`, 'priya')).json;
  const inv = Object.fromEntries(v.invoices.map((i: any) => [i.invoice_number, i]));
  assert.equal(inv['INV-88231'].pricing.purchase_cents, 118_750_000);
  assert.equal(inv['INV-88231'].pricing.tenor_days, 66);
  assert.equal(Math.round(inv['INV-88231'].pricing.interest_cents / 100), 14_369);
  assert.equal(inv['INV-88244'].status, 'HELD');
  assert.equal(v.kpis.purchase_cents, 333_200_000);
  assert.equal(Math.round(v.kpis.interest_cents / 100), 43_695);
  assert.equal(Math.round(v.kpis.investor_interest_cents / 100), 39_398);
  assert.equal(v.kpis.weighted_tenor_days, 70);
  const retail = v.limits.rows.find((r: any) => r.name === 'Harborview Retail LLC');
  assert.equal(retail.status, 'Breach');
  assert.deepEqual(v.blockers.map((b: any) => b.code).sort(), ['INVESTOR', 'LIMIT']);
});

test('funding: role checks, four-eyes, blockers, approval, ledger and idempotency', async () => {
  const f = await harborviewBatch();
  // Maker cannot approve (role), and the checker is blocked while invoices are held/untagged.
  assert.equal((await api('POST', `/api/imports/${f.id}/approve`, 'rabuan')).status, 403);
  const blocked = await api('POST', `/api/imports/${f.id}/approve`, 'priya');
  assert.equal(blocked.status, 409);

  const v = (await api('GET', `/api/imports/${f.id}`, 'priya')).json;
  const held = v.invoices.filter((i: any) => i.status === 'HELD').map((i: any) => i.id);
  const untagged = v.invoices.filter((i: any) => i.status === 'PENDING' && !i.investor_id).map((i: any) => i.id);
  assert.equal((await api('POST', `/api/imports/${f.id}/reject`, 'priya', { invoice_ids: held, reason: 'over limit' })).status, 200);
  // Investor tagging is the maker's job; a checker who tags is barred from approving (SoD-1).
  assert.equal((await api('POST', `/api/imports/${f.id}/investor`, 'rabuan', { invoice_ids: untagged, investor_id: 2 })).status, 200);

  // Admin uploaded nothing, but the uploader rule is enforced for anyone approving their own file.
  svc.db.run("UPDATE invoice_imports SET uploaded_by = 'admin' WHERE id = ?", [f.id]);
  const own = await api('POST', `/api/imports/${f.id}/approve`, 'admin');
  assert.equal(own.status, 403);
  svc.db.run("UPDATE invoice_imports SET uploaded_by = 'rabuan' WHERE id = ?", [f.id]);

  const ok = await api('POST', `/api/imports/${f.id}/approve`, 'priya', undefined, { 'Idempotency-Key': 'fund-1' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.loans.length, 3);
  const replay = await api('POST', `/api/imports/${f.id}/approve`, 'priya', undefined, { 'Idempotency-Key': 'fund-1' });
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.deepEqual(replay.json, ok.json);
  assert.equal((await api('POST', `/api/imports/${f.id}/approve`, 'priya')).status, 409); // no double funding

  const tb = (await api('GET', '/api/ledger/trial-balance', 'admin')).json;
  for (const t of Object.values<any>(tb.totals)) assert.equal(t.balanced, true);
});

test('upload: parsing, rule rejections, T+1 and duplicate checksum', async () => {
  const funding = addBusinessDays(TODAY, 1);
  const csv = [
    'Invoice No,Buyer,Invoice Date,Due Date,Invoice Amount,Currency',
    'T-1,Atlas Steelworks West,20/10/2026,15/01/2027,"450,000.00",USD',
    'T-2,Unknown Buyer,20/10/2026,15/01/2027,1000,USD',
    'T-3,Atlas Steelworks West,20/10/2026,15/01/2027,1000,EUR',
    'T-4,Atlas Steelworks West,20/10/2026,,1000,USD',
  ].join('\n');
  const body = { program_id: 2, funding_date: funding, filename: 'test_1052.csv', content_base64: b64(csv) };
  assert.equal((await api('POST', '/api/imports', 'priya', body)).status, 403); // checker cannot upload
  assert.equal((await api('POST', '/api/imports', 'rabuan', { ...body, funding_date: TODAY })).status, 400); // same-day
  const r = await api('POST', '/api/imports', 'rabuan', body);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.import.rows_read, 4);
  assert.equal(r.json.import.accepted, 1);
  assert.equal(r.json.import.rejected, 3);
  assert.equal((await api('POST', '/api/imports', 'rabuan', body)).status, 409); // same file again
});

test('settlement advices never settle loans; only bank matches do (with four-eyes)', async () => {
  const open = (await api('GET', '/api/loans/open', 'admin')).json.filter((l: any) => l.program_code === 'PRG-1052').slice(0, 2);
  const csv = 'Loan ID,Amount Received,Value Date,Bank Reference\n' +
    `${open[0].loan_ref},${open[0].face_cents / 100},03/11/2026,VA-T-1\n${open[1].loan_ref},0,03/11/2026,\n`;
  const up = await api('POST', '/api/settlements', 'rabuan', { program_id: 2, settlement_date: TODAY, filename: 's.csv', content_base64: b64(csv) });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  const view = (await api('GET', `/api/settlements/${up.json.id}`, 'admin')).json;
  assert.equal(view.kpis.received, 1);
  assert.equal(view.kpis.pending, 1);
  assert.ok(view.advices.every((a: any) => a.loan_status === 'OPEN'), 'advice must not settle');

  const bank = 'Value Date,Narrative,Amount,Currency,Bank Reference\n' +
    `03/11/2026,PAYMENT ${open[0].loan_ref},${open[0].face_cents / 100},USD,VA-T-1\n03/11/2026,MYSTERY,99.00,USD,X\n`;
  const st = await api('POST', '/api/bank-statements', 'meera', { program_id: 2, statement_date: TODAY, filename: 'b.csv', content_base64: b64(bank) });
  assert.equal(st.status, 201, JSON.stringify(st.json));
  assert.equal(st.json.MATCHED, 1);
  assert.equal(st.json.UNMATCHED, 1);
  assert.equal((await api('POST', `/api/bank-statements/${st.json.id}/post`, 'meera')).status, 403); // uploader
  const posted = await api('POST', `/api/bank-statements/${st.json.id}/post`, 'tom');
  assert.equal(posted.json.settled, 1);
  const after = (await api('GET', `/api/settlements/${up.json.id}`, 'admin')).json;
  assert.equal(after.advices.find((a: any) => a.loan_ref === open[0].loan_ref).loan_status, 'SETTLED');

  // Break resolution
  const line = (await api('GET', `/api/bank-statements/${st.json.id}`, 'tom')).json.lines.find((l: any) => l.match_status === 'UNMATCHED');
  assert.equal((await api('POST', `/api/bank-lines/${line.id}/resolve`, 'tom', { note: 'Returned to remitter' })).status, 200);
  const tb = (await api('GET', '/api/ledger/trial-balance', 'admin')).json;
  for (const t of Object.values<any>(tb.totals)) assert.equal(t.balanced, true);
});

test('master table: credit can change limits (audited); others cannot', async () => {
  const p = (await api('GET', '/api/programs', 'admin')).json.find((x: any) => x.program_code === 'PRG-1041');
  const retail = p.obligors.find((o: any) => o.name === 'Harborview Retail LLC');
  assert.equal((await api('PUT', `/api/obligors/${retail.id}`, 'rabuan', { limit_cents: 1_200_000_000 })).status, 403);
  // A limit change is a request; it does nothing until a second credit user approves it (SoD-5).
  const r = await api('PUT', `/api/obligors/${retail.id}`, 'daniel', { limit_cents: 1_200_000_000, reason: 'Annual review' });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const crId = r.json.change_request.id;
  const still = (await api('GET', '/api/programs', 'admin')).json.find((x: any) => x.program_code === 'PRG-1041').obligors.find((o: any) => o.id === retail.id);
  assert.equal(still.limit_cents, retail.limit_cents);
  assert.equal((await api('PUT', `/api/obligors/${retail.id}`, 'daniel', { limit_cents: 1_300_000_000 })).status, 409); // one pending change per record
  assert.equal((await api('POST', `/api/approvals/${crId}/decide`, 'daniel', { decision: 'APPROVE' })).status, 403); // own request
  assert.equal((await api('POST', `/api/approvals/${crId}/decide`, 'meera', { decision: 'APPROVE' })).status, 403); // wrong role
  const ok = await api('POST', `/api/approvals/${crId}/decide`, 'sara', { decision: 'APPROVE' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await api('POST', `/api/approvals/${crId}/decide`, 'sara', { decision: 'APPROVE' })).status, 409); // only once
  const log = (await api('GET', `/api/audit?entity_type=obligor&entity_id=${retail.id}`, 'admin')).json;
  assert.deepEqual(log[0].details.changed, ['limit_cents']);
  assert.equal(log[0].details.requested_by, 'daniel');
  // Above delegated authority: only the credit committee (ADMIN) can approve.
  const big = await api('PUT', `/api/obligors/${retail.id}`, 'daniel', { limit_cents: 900_000_000_000 });
  assert.equal(big.status, 202);
  assert.equal((await api('POST', `/api/approvals/${big.json.change_request.id}/decide`, 'sara', { decision: 'APPROVE' })).status, 403);
  assert.equal((await api('POST', `/api/approvals/${big.json.change_request.id}/decide`, 'sara', { decision: 'REJECT', note: 'Above authority' })).status, 200);
  // FX: Credit can no longer move rates; Treasury requests, a second Treasury/Compliance user approves.
  assert.equal((await api('POST', '/api/fx', 'daniel', { currency: 'EUR', usd_rate: '0.0001' })).status, 403);
  const fx = await api('POST', '/api/fx', 'meera', { currency: 'EUR', usd_rate: '1.09' });
  assert.equal(fx.status, 202);
  assert.equal((await api('POST', `/api/approvals/${fx.json.change_request.id}/decide`, 'meera', { decision: 'APPROVE' })).status, 403);
  assert.equal((await api('POST', `/api/approvals/${fx.json.change_request.id}/decide`, 'tom', { decision: 'APPROVE' })).status, 200);
  assert.equal((await api('GET', '/api/fx', 'admin')).json.find((x: any) => x.currency === 'EUR').usd_rate, '1.09');
});

test('dashboard aggregates and notifications from the outbox', async () => {
  const d = (await api('GET', '/api/dashboard', 'admin')).json;
  assert.ok(d.kpis.approved_limits_usd_cents > 0);
  assert.equal(d.next7.length, 8);
  assert.ok(d.buyers.length >= 10);
  // Past due: every bucket populated, aged from maturity, with a last collection action; totals tie to the KPI.
  assert.ok(d.past_due.buckets.filter((b: any) => b.count > 0).length >= 3, JSON.stringify(d.past_due.buckets));
  assert.equal(d.past_due.buckets.reduce((a: number, b: any) => a + b.amount_usd_cents, 0), d.kpis.past_due_usd_cents);
  assert.ok(d.past_due.loans.every((l: any) => l.days_past_due > 0 && l.last_action !== 'No action yet'));
  assert.ok(d.due_loans.every((l: any) => l.days >= 0 && l.days <= 7));
  // 36 months of month-end history, current month live.
  assert.equal(d.history.points.length, 36);
  assert.equal(d.history.points.at(-1).live, true);
  // Filters narrow every panel.
  const scf = (await api('GET', '/api/dashboard?products=SCF&from=2026-01&to=2026-11', 'admin')).json;
  assert.equal(scf.deals_in_scope, 1);
  assert.ok(scf.buyers.every((b: any) => b.deal_name.includes('SCF')));
  assert.ok(scf.kpis.approved_limits_usd_cents < d.kpis.approved_limits_usd_cents);
  assert.equal(scf.history.points.length, 11);
  const deal = d.options.programs.find((p: any) => p.program_type === 'IF');
  const one = (await api('GET', `/api/dashboard?program_id=${deal.id}`, 'admin')).json;
  assert.ok(one.past_due.loans.every((l: any) => l.deal_name === deal.deal_name));
  assert.equal((await api('GET', '/api/dashboard?from=2026-13', 'admin')).status, 422);
  // Collection log: append-only, audited, becomes the last action.
  const pd = d.past_due.loans[0];
  assert.equal((await api('POST', `/api/loans/${pd.id}/collection-actions`, 'audit', { action: 'Called buyer' })).status, 403);
  assert.equal((await api('POST', `/api/loans/${pd.id}/collection-actions`, 'rabuan', { action: 'Called buyer AP; payment promised Friday' })).status, 201);
  assert.equal((await api('GET', '/api/dashboard', 'admin')).json.past_due.loans.find((l: any) => l.id === pd.id).last_action, 'Called buyer AP; payment promised Friday');
  assert.throws(() => svc.db.run('DELETE FROM collection_actions'), /append-only/);
  // Month-end job is idempotent.
  const { snapshotMonthEnds } = await import('../src/modules/dashboard.ts');
  assert.equal(snapshotMonthEnds(svc).written, 0);
  dispatchPending(svc.db);
  assert.ok((await api('GET', '/api/notifications', 'admin')).json.length > 0);
});

test('SoD: users cannot change their own role; at least one admin remains', async () => {
  assert.equal((await api('PUT', '/api/access/users/admin', 'admin', { role: 'VIEWER' })).status, 403);
  assert.equal((await api('PUT', '/api/access/users/rabuan', 'daniel', { role: 'ADMIN' })).status, 403);
  const ov = (await api('GET', '/api/access', 'audit')).json;
  assert.ok(ov.sod_evidence.every((e: any) => e.violations === 0));
});

test('append-only ledger/audit and tamper-evident audit chain', async () => {
  assert.throws(() => svc.db.run('UPDATE ledger_lines SET debit_cents = 1 WHERE id = 1'), /append-only/);
  assert.throws(() => svc.db.run('DELETE FROM audit_log WHERE id = 1'), /append-only/);
  assert.equal(audit.verify(svc.db).valid, true);
  svc.db.exec('DROP TRIGGER audit_no_update');
  svc.db.run("UPDATE audit_log SET details = '{}' WHERE id = 2");
  const v = audit.verify(svc.db);
  assert.equal(v.valid, false);
  assert.equal(v.brokenAt, 2);
});

test('underwriting: maker-checker, committee authority, override reason, limit written to master table', async () => {
  const list = (await api('GET', '/api/underwriting', 'daniel')).json;
  const retail = list.find((a: any) => a.obligor_name === 'Harborview Retail LLC');
  assert.equal(retail.status, 'REFERRED');
  // Preparer cannot decide; ops checker has no credit authority.
  assert.equal((await api('POST', `/api/underwriting/${retail.id}/decide`, 'sara', { decision: 'APPROVE', reason: 'x'.repeat(30) })).status, 403);
  assert.equal((await api('POST', `/api/underwriting/${retail.id}/decide`, 'priya', { decision: 'APPROVE', reason: 'x'.repeat(30) })).status, 403);
  // Override of a REFER needs a substantive reason.
  assert.equal((await api('POST', `/api/underwriting/${retail.id}/decide`, 'daniel', { decision: 'APPROVE', reason: 'ok' })).status, 422);
  const ok = await api('POST', `/api/underwriting/${retail.id}/decide`, 'daniel', { decision: 'APPROVE', approved_limit_cents: 1_200_000_000, reason: 'Parent guarantee covers the seasonal peak; approved below request.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const detail = (await api('GET', `/api/underwriting/${retail.id}`, 'daniel')).json;
  assert.equal(detail.status, 'APPROVED');
  assert.equal(detail.override, true);
  assert.deepEqual(detail.documents.map((d: any) => d.doc_type).sort(), ['CREDIT_MEMO', 'TERM_SHEET']);
  const pdf = await fetch(`${base}/api/documents/${detail.documents[0].id}/file`, { headers: { 'X-User': 'daniel' } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const ob = (await api('GET', '/api/programs', 'admin')).json.flatMap((p: any) => p.obligors).find((o: any) => o.name === 'Harborview Retail LLC');
  assert.equal(ob.limit_cents, 1_200_000_000);

  // New application above delegated authority: credit can't approve, committee (admin) can.
  const body = {
    program_id: 1, application_type: 'NEW', obligor_name: 'Bigco Foods Inc', legal_name: 'Bigco Foods Inc', country: 'US', years_trading: 30,
    requested_limit_cents: 4_000_000_000, proposed_adv_bps: 9500, proposed_margin_bps: 140, proposed_spread_bps: 55,
    financials: [2024, 2025].map((year) => ({ year, revenue_cents: 9e11, ebitda_cents: 1.2e11, interest_expense_cents: 1e10, total_debt_cents: 2e11,
      current_assets_cents: 3e11, current_liabilities_cents: 1.5e11, net_worth_cents: 5e11, debt_service_cents: 4e10 })),
  };
  const created = await api('POST', '/api/underwriting', 'sara', body);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const sub = await api('POST', `/api/underwriting/${created.json.id}/submit`, 'sara');
  assert.equal(sub.json.status, 'REFERRED');
  assert.ok(sub.json.engine.committee_required);
  assert.equal((await api('POST', `/api/underwriting/${created.json.id}/decide`, 'daniel', { decision: 'APPROVE', reason: 'Strong credit, large limit approved.' })).status, 403);
  assert.equal((await api('POST', `/api/underwriting/${created.json.id}/decide`, 'admin', { decision: 'APPROVE', reason: 'Credit committee approval of the full amount.' })).status, 200);

  // Sanctions hit can never be approved.
  const s = list.find((a: any) => a.obligor_name === 'Sanctioned Holdings Ltd');
  assert.equal(s.status, 'DECLINED');
});

test('pools: eligibility, concentration blocking, four-eyes activation, stress test', async () => {
  const list = (await api('GET', '/api/pools', 'olivia')).json;
  assert.ok(list.find((p: any) => p.status === 'ACTIVE'));
  const created = await api('POST', '/api/pools', 'olivia', {
    name: 'Test pool', currency: 'USD', target_size_cents: 5_000_000_000,
    criteria: { min_rating: 'B+', min_remaining_days: 1 }, limits: { max_obligor_bps: 1000 },
    tranches: [{ name: 'SENIOR', pct_bps: 9000, coupon_bps: 500 }, { name: 'EQUITY', pct_bps: 1000 }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal((await api('POST', '/api/pools', 'priya', { name: 'x', currency: 'USD', target_size_cents: 100_000_00 })).status, 403);
  const id = created.json.id;
  const eligible = (await api('GET', `/api/pools/${id}/eligible`, 'olivia')).json;
  if (eligible.length >= 1) {
    // One obligor's loans together exceed a 10% single-obligor limit of a 50m target only if > 5m; force a breach with a tiny target.
    await api('PUT', `/api/pools/${id}`, 'olivia', { name: 'Test pool', target_size_cents: eligible[0].principal_cents, limits: { max_obligor_bps: 1000 }, criteria: { min_remaining_days: 1 },
      tranches: [{ name: 'SENIOR', pct_bps: 9000, coupon_bps: 500 }, { name: 'EQUITY', pct_bps: 1000 }] });
    const breach = await api('POST', `/api/pools/${id}/loans`, 'olivia', { loan_ids: [eligible[0].id] });
    assert.equal(breach.status, 409);
    assert.match(JSON.stringify(breach.json), /Single obligor/);
  }
  // Activation is four-eyes and blocked when empty.
  assert.equal((await api('POST', `/api/pools/${id}/activate`, 'olivia')).status, 403);
  assert.equal((await api('POST', `/api/pools/${id}/activate`, 'daniel')).status, 409);
  const active = list.find((p: any) => p.status === 'ACTIVE');
  const st = await api('POST', `/api/pools/${active.id}/stress`, 'olivia', {});
  assert.equal(st.status, 200, JSON.stringify(st.json));
  const sev = st.json.results.find((r: any) => r.scenario.name === 'Severe stress');
  const base = st.json.results.find((r: any) => r.scenario.name === 'Base');
  assert.ok(sev.pool.loss_cents > base.pool.loss_cents);
  assert.ok(sev.pool.excess_spread_cents <= base.pool.excess_spread_cents);
  const detail = (await api('GET', `/api/pools/${active.id}`, 'olivia')).json;
  assert.equal(detail.reconciliation.reconciled, true);
});

test('fund: funding queues seller payment; batch four-eyes, ACH file, cash posting; capital call pro-rata', async () => {
  const queue = (await api('GET', '/api/payments/queue', 'meera')).json;
  const funding = queue.find((p: any) => p.purpose === 'FUNDING' && p.currency === 'USD');
  assert.ok(funding, 'approved funding in an earlier test should queue a seller payment');
  assert.ok(funding.beneficiary_account_id);
  const batch = await api('POST', '/api/payment-batches', 'rabuan', { payment_ids: [funding.id], rail: 'ACH', value_date: '2026-11-04' });
  assert.equal(batch.status, 201, JSON.stringify(batch.json));
  assert.equal((await api('POST', `/api/payment-batches/${batch.json.id}/approve`, 'rabuan')).status, 403); // role
  const pv = (await api('GET', `/api/payment-batches/${batch.json.id}/preview`, 'meera')).json;
  assert.deepEqual(pv.errors, []);
  const ap = await api('POST', `/api/payment-batches/${batch.json.id}/approve`, 'meera');
  assert.equal(ap.status, 200, JSON.stringify(ap.json));
  const b = (await api('GET', `/api/payment-batches/${batch.json.id}`, 'meera')).json;
  const file = await (await fetch(`${base}/api/documents/${b.file_document_id}/file`, { headers: { 'X-User': 'meera' } })).text();
  const lines = file.trim().split('\r\n');
  assert.ok(lines.every((l) => l.length === 94));
  assert.equal(lines.length % 10, 0);
  assert.equal(b.sagas[0].status, 'COMPLETED');
  assert.equal((await api('POST', `/api/payment-batches/${batch.json.id}/release`, 'meera')).status, 200);
  const tb = (await api('GET', '/api/ledger/trial-balance', 'admin')).json;
  for (const t of Object.values<any>(tb.totals)) assert.equal(t.balanced, true);
  const seller2500 = tb.accounts.filter((a: any) => a.code === '2500' && a.currency === 'USD')[0];
  assert.ok(seller2500.balance_cents <= 0);

  // Capital call: pro-rata split sums exactly; preparer cannot issue.
  const pool = (await api('GET', '/api/pools', 'olivia')).json.find((p: any) => p.status === 'ACTIVE' && p.currency === 'USD');
  const call = await api('POST', '/api/capital-calls', 'olivia', { pool_id: pool.id, tranche: 'SENIOR', amount_cents: 100_000_01, purpose: 'Top-up', due_date: '2026-11-20' });
  assert.equal(call.status, 201, JSON.stringify(call.json));
  const detail = (await api('GET', `/api/capital-calls/${call.json.id}`, 'tom')).json;
  assert.equal(detail.lines.reduce((a: number, l: any) => a + l.amount_cents, 0), 100_000_01);
  assert.equal((await api('POST', `/api/capital-calls/${call.json.id}/issue`, 'olivia')).status, 403);
  const issued = await api('POST', `/api/capital-calls/${call.json.id}/issue`, 'tom');
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  const after = (await api('GET', `/api/capital-calls/${call.json.id}`, 'tom')).json;
  assert.ok(after.lines.every((l: any) => l.notice_document_id));
});

test('servicing: cases, four-eyes extension with fee, delinquency sweep, restructure schedule', async () => {
  const cases = (await api('GET', '/api/cases?status=open', 'priya')).json;
  const ext = cases.find((c: any) => c.case_type === 'MATURITY_EXTENSION');
  const detail = (await api('GET', `/api/cases/${ext.id}`, 'rabuan')).json;
  const am = detail.amendments[0];
  assert.equal(am.status, 'PROPOSED');
  assert.equal((await api('POST', `/api/amendments/${am.id}/decide`, 'rabuan', { decision: 'APPLY' })).status, 403); // requester
  const applied = await api('POST', `/api/amendments/${am.id}/decide`, 'priya', { decision: 'APPLY' });
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.ok(applied.json.result.fee_cents > 0);
  const loan = (await api('GET', `/api/servicing/loans/${am.payload.loan_id}`, 'priya')).json;
  assert.equal(loan.loan.maturity_date, am.payload.new_maturity_date);
  assert.ok(loan.components.find((c: any) => c.label.startsWith('Fee income')).credit_cents >= applied.json.result.fee_cents);

  // Sweep: move the business date 45 days ahead -> delinquency cases are opened once.
  const original = svc.today;
  svc.today = () => '2026-12-18';
  const first = (await api('POST', '/api/servicing/sweep', 'priya')).json;
  const second = (await api('POST', '/api/servicing/sweep', 'priya')).json;
  svc.today = original;
  assert.ok(first.opened > 0);
  assert.equal(second.opened, 0);

  // Restructure: variable-rate plan proposed by credit, applied by checker; schedule ties out.
  const past = (await api('GET', '/api/servicing/delinquency', 'daniel')).json.loans[0];
  const c = (await api('POST', '/api/cases', 'daniel', { case_type: 'RESTRUCTURE', priority: 'HIGH', subject: 'test', entity_type: 'loan', entity_id: past.id })).json;
  const prop = await api('POST', `/api/cases/${c.id}/amendments`, 'daniel', { amendment_type: 'RESTRUCTURE', payload: { loan_id: past.id, periods: 6, margin_bps: 300, rate_path: [{ from_period: 1, base_bps: 435 }, { from_period: 4, base_bps: 485 }] } });
  assert.equal(prop.status, 201, JSON.stringify(prop.json));
  const sched = prop.json.preview.schedule;
  assert.equal(sched.reduce((a: number, r: any) => a + r.principal_cents, 0), past.outstanding_cents);
  assert.equal((await api('POST', `/api/amendments/${prop.json.id}/decide`, 'priya', { decision: 'APPLY' })).status, 200);
  const wo = await api('POST', '/api/servicing/workout', 'daniel', { loan_id: past.id, assumptions: {} });
  assert.equal(wo.json.options.length, 3);
  const tb = (await api('GET', '/api/ledger/trial-balance', 'admin')).json;
  for (const t of Object.values<any>(tb.totals)) assert.equal(t.balanced, true);
});

test('reports: builder (grouping, injection-safe filters), exports, regulatory, investor portal isolation', async () => {
  const r = await api('POST', '/api/reports/run', 'priya', { dataset: 'loans', group_by: ['currency'], aggregates: [{ column: 'outstanding', fn: 'sum' }, { column: 'loan_ref', fn: 'count' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.rows.find((x: any) => x.currency === 'USD').sum_outstanding > 0);
  const inj = await api('POST', '/api/reports/run', 'priya', { dataset: 'loans', columns: ['loan_ref'], filters: [{ column: 'obligor', op: 'eq', value: "x' OR 1=1 --" }] });
  assert.equal(inj.json.rows.length, 0);
  assert.equal((await api('POST', '/api/reports/run', 'priya', { dataset: 'loans', columns: ['password_hash'] })).status, 422);
  const x = await api('POST', '/api/reports/export', 'priya', { definition: { dataset: 'obligors', columns: ['obligor', 'limit', 'utilisation'] }, format: 'xlsx' });
  assert.equal(x.status, 200, JSON.stringify(x.json));
  const xbytes = Buffer.from(await (await fetch(`${base}/api/documents/${x.json.document_id}/file`, { headers: { 'X-User': 'priya' } })).arrayBuffer());
  assert.equal(xbytes.subarray(0, 2).toString(), 'PK');
  assert.equal((await api('POST', '/api/reports/regulatory/audit-trail', 'priya', {})).status, 403);
  const reg = await api('POST', '/api/reports/regulatory/sod-evidence', 'kenji', { format: 'csv' });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  const csv = await (await fetch(`${base}/api/documents/${reg.json.document_id}/file`, { headers: { 'X-User': 'kenji' } })).text();
  assert.ok(!csv.includes(',NO\r\n'), 'every maker/checker pair should be compliant');
  assert.equal((await api('GET', '/api/reports/executive', 'priya')).status, 200);

  // Investor portal: scoped data, blocked elsewhere, documents checked for ownership.
  const p = await api('GET', '/api/portal', 'pemberton');
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.investor.code, 'INV-0001');
  assert.ok(p.json.positions.every((x: any) => x.investor_code === 'INV-0001'));
  assert.equal((await api('GET', '/api/dashboard', 'pemberton')).status, 403);
  assert.equal((await api('GET', '/api/loans/open', 'pemberton')).status, 403);
  const st = await api('POST', '/api/portal/statements', 'pemberton', { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.equal((await fetch(`${base}/api/documents/${st.json.document_id}/file`, { headers: { 'X-User': 'pemberton' } })).status, 200);
  assert.equal((await fetch(`${base}/api/documents/${x.json.document_id}/file`, { headers: { 'X-User': 'pemberton' } })).status, 404);
  const rq = await api('POST', '/api/portal/requests', 'pemberton', { kind: 'QUESTION', message: 'When is the next distribution?' });
  assert.equal(rq.status, 201, JSON.stringify(rq.json));
  assert.equal((await api('GET', '/api/portal/requests', 'pemberton')).json.length, 1);
});

test('brokerage: pre-trade checks, best execution, confirmations, SoD on settlement, balanced ledger', async () => {
  const inst = (await api('GET', '/api/brokerage/instruments', 'lucas')).json;
  const tbill = inst.find((i: any) => i.type === 'TBILL');
  const restricted = inst.find((i: any) => i.restricted);
  assert.ok(restricted, 'seed restricts one security');
  const inv = (await api('GET', '/api/investors', 'lucas')).json[0];

  // Only traders can trade.
  assert.equal((await api('POST', '/api/brokerage/orders', 'priya', { investor_id: inv.id, instrument_id: tbill.id, side: 'BUY', quantity: 1_000_000, order_type: 'MARKET' })).status, 403);
  // Restricted security and fat-finger limit are rejected with recorded checks.
  const r1 = await api('POST', '/api/brokerage/orders', 'lucas', { investor_id: inv.id, instrument_id: restricted.id, side: 'BUY', quantity: 1_000_000, order_type: 'MARKET' });
  assert.equal(r1.json.status, 'REJECTED');
  assert.ok(r1.json.checks.some((c: any) => c.check === 'Restricted list' && !c.ok));
  const m = (await api('GET', '/api/brokerage/market', 'lucas')).json.instruments.find((i: any) => i.id === tbill.id);
  const r2 = await api('POST', '/api/brokerage/orders', 'lucas', { investor_id: inv.id, instrument_id: tbill.id, side: 'BUY', quantity: 1_000_000, order_type: 'LIMIT', limit_price: Math.round(m.best_ask * 0.9) });
  assert.equal(r2.json.status, 'REJECTED');

  // A large order sweeps several venues, best effective price first.
  const ok = await api('POST', '/api/brokerage/orders', 'lucas', { investor_id: inv.id, instrument_id: tbill.id, side: 'BUY', quantity: 40_000_000, order_type: 'MARKET' });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.status, 'FILLED');
  assert.ok(ok.json.trades.length >= 1);
  const trades = (await api('GET', '/api/brokerage/trades', 'lucas')).json.filter((t: any) => ok.json.trades.includes(t.ref));
  assert.equal(trades.reduce((a: number, t: any) => a + t.quantity, 0), 40_000_000);
  // The commission tier is set by the whole order (40m -> 8 bps), never per venue fill.
  assert.ok(trades.every((t: any) => t.commission_bps === 8), JSON.stringify(trades.map((t: any) => t.commission_bps)));
  for (const t of trades) {
    assert.ok(t.confirmation_document_id, 'confirmation PDF generated');
    assert.equal(t.net_cents, t.principal_cents + t.accrued_cents + t.commission_cents + t.venue_fee_cents);
  }
  // Settlement: not before settlement date, not by the trader.
  const t = trades[0];
  assert.equal((await api('POST', `/api/brokerage/trades/${t.id}/settle`, 'priya')).status, 409);
  svc.db.run('UPDATE trades SET settlement_date = ? WHERE id = ?', [TODAY, t.id]);
  assert.equal((await api('POST', `/api/brokerage/trades/${t.id}/settle`, 'lucas')).status, 403);
  assert.equal((await api('POST', `/api/brokerage/trades/${t.id}/settle`, 'priya')).status, 200);
  assert.equal((await api('POST', `/api/brokerage/trades/${t.id}/settle`, 'priya')).status, 409);

  // Broker onboarding: maker cannot approve; compliance can.
  const b = await api('POST', '/api/brokerage/brokers', 'kenji', { name: 'Test Introducer Ltd', kind: 'INTRODUCER', country: 'GB', rebate_bps_of_commission: 1000 });
  assert.equal(b.status, 201, JSON.stringify(b.json));
  assert.equal((await api('POST', `/api/brokerage/brokers/${b.json.id}/decide`, 'kenji', { status: 'APPROVED' })).status, 403);
  // Pending introducer fails pre-trade.
  const r3 = await api('POST', '/api/brokerage/orders', 'lucas', { investor_id: inv.id, instrument_id: tbill.id, side: 'BUY', quantity: 1_000_000, order_type: 'MARKET', introducer_id: b.json.id });
  assert.equal(r3.json.status, 'REJECTED');

  // Commission totals reconcile with ledger account 4300 and every journal balances.
  const c = svc.db.get<any>("SELECT COALESCE(SUM(commission_cents),0) s FROM trades WHERE status <> 'CANCELLED' AND currency = 'USD'");
  const l = svc.db.get<any>("SELECT COALESCE(SUM(l.credit_cents - l.debit_cents),0) s FROM ledger_lines l JOIN journal_entries j ON j.id = l.entry_id WHERE l.account_code = '4300' AND j.currency = 'USD'");
  assert.equal(l.s, c.s);
  const tb = (await api('GET', '/api/ledger/trial-balance', 'admin')).json;
  for (const x of Object.values<any>(tb.totals)) assert.equal(x.balanced, true);
});
