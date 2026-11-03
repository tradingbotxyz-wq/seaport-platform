// FUND: investor commitments, capital calls (pro-rata), distributions, beneficiary bank accounts,
// disbursement batches with bank files (ACH / Fedwire / SWIFT MT103 / ISO 20022 pain.001) and liquidity.
//
// Ledger:
//   Capital call issued     Dr 1100 Capital call receivable   / Cr 3000 Investor contributed capital
//   Capital received        Dr 1000 Cash                      / Cr 1100
//   Distribution approved   Dr 3000 (capital) or 2300 (income) / Cr 2600 Distributions payable
//   Payment sent            Dr 2500 (funding) or 2600 (distribution) / Cr 1000 Cash
// Calls and payment releases run as sagas (see core/saga.ts) so partial failures are compensated.

import type { Services, User } from '../core/context.ts';
import { requirePermission, now, nextRef, addDays } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { emit } from '../core/outbox.ts';
import { runSaga, sagaRuns } from '../core/saga.ts';
import { check } from '../lib/validate.ts';
import { badRequest, conflict, forbidden, notFound, validation } from '../lib/errors.ts';
import * as ledger from './ledger.ts';
import { generatePdf, storeBytes, recordDocument } from './documents.ts';
import { pipeline } from './exposure.ts';

const TRANCHES = ['SENIOR', 'MEZZANINE', 'EQUITY'];

/** Split `total` across `weights` with the largest-remainder method; parts always sum to total. */
export function proRata(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error('weights must sum to a positive amount');
  const T = BigInt(total);
  const S = BigInt(sum);
  const parts = weights.map((w) => ({ floor: (T * BigInt(w)) / S, rem: (T * BigInt(w)) % S }));
  let left = T - parts.reduce((a, p) => a + p.floor, 0n);
  const order = parts.map((_, i) => i).sort((a, b) => (parts[b].rem > parts[a].rem ? 1 : parts[b].rem < parts[a].rem ? -1 : a - b));
  const out = parts.map((p) => p.floor);
  for (const i of order) { if (left === 0n) break; if (weights[i] > 0) { out[i] += 1n; left -= 1n; } }
  return out.map(Number);
}

// ---------- Bank accounts ----------

export function abaValid(rtn?: string | null) {
  if (!rtn || !/^\d{9}$/.test(rtn)) return false;
  const d = [...rtn].map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}
export function ibanValid(iban?: string | null) {
  if (!iban) return false;
  const s = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let mod = 0;
  for (const ch of r) mod = (mod * 10 + Number(ch)) % 97;
  return mod === 1;
}
const BIC_RE = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

export function listBankAccounts(svc: Services) {
  return svc.db.all(`
    SELECT b.*, CASE b.owner_type WHEN 'PROGRAM' THEN (SELECT client_name || ' (' || program_code || ')' FROM programs WHERE id = b.owner_id)
                                  WHEN 'INVESTOR' THEN (SELECT code || ' · ' || name FROM investors WHERE id = b.owner_id)
                                  ELSE 'Seaport Global (originator)' END AS owner_name
    FROM bank_accounts b ORDER BY b.owner_type, owner_name, b.currency`).map(maskAccount);
}

function maskAccount(b: any) {
  const mask = (s?: string | null) => (s && s.length > 4 ? `••••${s.slice(-4)}` : s);
  return { ...b, account_number_masked: mask(b.account_number), iban_masked: b.iban ? `${b.iban.slice(0, 4)}••••${b.iban.slice(-4)}` : null };
}

export function saveBankAccount(svc: Services, user: User, id: number | null, body: any) {
  requirePermission(user, 'payments.accounts');
  const input = check<any>(body, {
    owner_type: { type: 'enum', required: true, values: ['SEAPORT', 'PROGRAM', 'INVESTOR'] },
    owner_id: { type: 'int', min: 1 },
    account_name: { type: 'string', required: true, maxLength: 120 },
    bank_name: { type: 'string', required: true, maxLength: 120 },
    routing_number: { type: 'string', pattern: /^\d{9}$/ },
    account_number: { type: 'string', maxLength: 34 },
    bic: { type: 'string', pattern: BIC_RE },
    iban: { type: 'string', maxLength: 42 },
    currency: { type: 'string', required: true, pattern: /^[A-Z]{3}$/ },
    country: { type: 'string', required: true, pattern: /^[A-Z]{2}$/ },
    active: { type: 'bool' },
  });
  const errors: Record<string, string> = {};
  if (input.owner_type !== 'SEAPORT' && !input.owner_id) errors.owner_id = 'is required';
  if (input.currency === 'USD' && input.country === 'US') {
    if (!abaValid(input.routing_number)) errors.routing_number = 'ABA routing number fails the checksum';
    if (!input.account_number) errors.account_number = 'is required for US accounts';
  } else {
    if (!input.bic) errors.bic = 'is required for non-US accounts';
    if (!ibanValid(input.iban)) errors.iban = 'IBAN fails the mod-97 check';
  }
  if (Object.keys(errors).length) throw validation(errors);
  return svc.db.tx(() => {
    const ts = now();
    const vals = [input.owner_type, input.owner_id ?? null, input.account_name, input.bank_name, input.routing_number ?? null, input.account_number ?? null,
      input.bic ?? null, input.iban ? input.iban.replace(/\s+/g, '').toUpperCase() : null, input.currency, input.country, input.active === false ? 0 : 1];
    if (id) {
      const before = svc.db.get('SELECT * FROM bank_accounts WHERE id = ?', [id]);
      if (!before) throw notFound('Bank account');
      svc.db.run(`UPDATE bank_accounts SET owner_type=?, owner_id=?, account_name=?, bank_name=?, routing_number=?, account_number=?, bic=?, iban=?, currency=?, country=?, active=?, updated_by=?, updated_at=? WHERE id=?`, [...vals, user.username, ts, id]);
      audit.record(svc.db, user, 'bank_account.updated', 'bank_account', id, { before: maskAccount(before), after: { ...input, account_number: undefined, iban: undefined } });
      return { ok: true, id };
    }
    const r = svc.db.run(`INSERT INTO bank_accounts (owner_type, owner_id, account_name, bank_name, routing_number, account_number, bic, iban, currency, country, active, created_by, updated_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [...vals, user.username, user.username, ts, ts]);
    audit.record(svc.db, user, 'bank_account.created', 'bank_account', r.id, { owner_type: input.owner_type, owner_id: input.owner_id, bank: input.bank_name, currency: input.currency });
    return { status: 201, json: { id: r.id } };
  });
}

// ---------- Commitments ----------

function commitmentRows(svc: Services, where = '1=1', params: any[] = []) {
  return svc.db.all(`
    SELECT c.*, i.code AS investor_code, i.name AS investor_name, p.ref AS pool_ref, p.name AS pool_name,
      COALESCE((SELECT SUM(l.amount_cents) FROM capital_call_lines l JOIN capital_calls cc ON cc.id = l.call_id WHERE l.commitment_id = c.id AND cc.status IN ('ISSUED','SETTLED')), 0) AS called_cents,
      COALESCE((SELECT SUM(l.received_cents) FROM capital_call_lines l WHERE l.commitment_id = c.id), 0) AS paid_in_cents,
      COALESCE((SELECT SUM(d.amount_cents) FROM distribution_lines d JOIN distributions x ON x.id = d.distribution_id WHERE d.commitment_id = c.id AND x.status IN ('APPROVED','PAID') AND x.kind = 'CAPITAL'), 0) AS returned_capital_cents,
      COALESCE((SELECT SUM(d.amount_cents) FROM distribution_lines d JOIN distributions x ON x.id = d.distribution_id WHERE d.commitment_id = c.id AND x.status IN ('APPROVED','PAID') AND x.kind = 'INCOME'), 0) AS income_cents
    FROM commitments c JOIN investors i ON i.id = c.investor_id JOIN pools p ON p.id = c.pool_id
    WHERE ${where} ORDER BY p.id, CASE c.tranche WHEN 'SENIOR' THEN 0 WHEN 'MEZZANINE' THEN 1 ELSE 2 END, c.amount_cents DESC`, params)
    .map((c) => ({ ...c, unfunded_cents: c.status === 'ACTIVE' ? c.amount_cents - c.called_cents : 0, nav_cents: c.paid_in_cents - c.returned_capital_cents }));
}

export function listCommitments(svc: Services, query: URLSearchParams) {
  const params: any[] = [];
  let where = '1=1';
  if (query.get('pool_id')) { where += ' AND c.pool_id = ?'; params.push(Number(query.get('pool_id'))); }
  if (query.get('investor_id')) { where += ' AND c.investor_id = ?'; params.push(Number(query.get('investor_id'))); }
  return commitmentRows(svc, where, params);
}

export function createCommitment(svc: Services, user: User, body: unknown) {
  requirePermission(user, 'fund.commit');
  const input = check<any>(body, {
    investor_id: { type: 'int', required: true, min: 1 },
    pool_id: { type: 'int', required: true, min: 1 },
    tranche: { type: 'enum', required: true, values: TRANCHES },
    amount_cents: { type: 'int', required: true, min: 100_000 },
    signed_at: { type: 'date', required: true },
  });
  const pool = svc.db.get('SELECT * FROM pools WHERE id = ?', [input.pool_id]);
  if (!pool) throw badRequest('Unknown pool');
  if (pool.status === 'CLOSED') throw conflict('Pool is closed');
  if (!svc.db.get('SELECT id FROM pool_tranches WHERE pool_id = ? AND name = ?', [pool.id, input.tranche])) throw validation({ tranche: `${pool.ref} has no ${input.tranche} tranche` });
  if (!svc.db.get('SELECT id FROM investors WHERE id = ? AND active = 1', [input.investor_id])) throw badRequest('Unknown investor');
  return svc.db.tx(() => {
    const r = svc.db.run('INSERT INTO commitments (investor_id, pool_id, tranche, currency, amount_cents, signed_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [input.investor_id, input.pool_id, input.tranche, pool.currency, input.amount_cents, input.signed_at, user.username, now()]);
    audit.record(svc.db, user, 'commitment.created', 'pool', pool.id, { commitment_id: r.id, investor_id: input.investor_id, tranche: input.tranche, amount_cents: input.amount_cents });
    return { status: 201, json: { id: r.id } };
  });
}

// ---------- Capital calls ----------

export function listCalls(svc: Services) {
  return svc.db.all(`
    SELECT cc.*, p.ref AS pool_ref, p.name AS pool_name,
      COALESCE((SELECT SUM(received_cents) FROM capital_call_lines WHERE call_id = cc.id), 0) AS received_cents,
      (SELECT COUNT(*) FROM capital_call_lines WHERE call_id = cc.id) AS investors
    FROM capital_calls cc JOIN pools p ON p.id = cc.pool_id ORDER BY cc.id DESC`);
}

export function getCall(svc: Services, id: number) {
  const c = svc.db.get('SELECT cc.*, p.ref AS pool_ref, p.name AS pool_name FROM capital_calls cc JOIN pools p ON p.id = cc.pool_id WHERE cc.id = ?', [id]);
  if (!c) throw notFound('Capital call');
  return {
    ...c,
    lines: svc.db.all(`SELECT l.*, i.code AS investor_code, i.name AS investor_name, cm.amount_cents AS commitment_cents, d.filename AS notice_filename
      FROM capital_call_lines l JOIN investors i ON i.id = l.investor_id JOIN commitments cm ON cm.id = l.commitment_id LEFT JOIN documents d ON d.id = l.notice_document_id
      WHERE l.call_id = ? ORDER BY l.amount_cents DESC`, [id]),
    sagas: sagaRuns(svc, c.ref),
  };
}

export function createCall(svc: Services, user: User, body: unknown) {
  requirePermission(user, 'fund.call');
  const input = check<any>(body, {
    pool_id: { type: 'int', required: true, min: 1 },
    tranche: { type: 'enum', required: true, values: TRANCHES },
    amount_cents: { type: 'int', required: true, min: 100 },
    purpose: { type: 'string', required: true, maxLength: 300 },
    due_date: { type: 'date', required: true },
  });
  if (input.due_date < svc.today()) throw validation({ due_date: 'cannot be in the past' });
  const pool = svc.db.get('SELECT * FROM pools WHERE id = ?', [input.pool_id]);
  if (!pool) throw badRequest('Unknown pool');
  if (pool.status !== 'ACTIVE') throw conflict('Capital can only be called for an active pool');
  const cms = commitmentRows(svc, "c.pool_id = ? AND c.tranche = ? AND c.status = 'ACTIVE'", [pool.id, input.tranche]);
  if (!cms.length) throw conflict(`No active ${input.tranche} commitments in ${pool.ref}`);
  const unfunded = cms.reduce((a, c) => a + c.unfunded_cents, 0);
  if (input.amount_cents > unfunded) throw conflict(`Amount exceeds unfunded commitments (${(unfunded / 100).toLocaleString('en-US')} ${pool.currency})`);
  const alloc = proRata(input.amount_cents, cms.map((c) => c.amount_cents));
  const over = cms.filter((c, i) => alloc[i] > c.unfunded_cents);
  if (over.length) throw conflict('Pro-rata allocation exceeds some investors\' unfunded commitment', over.map((c) => `${c.investor_name}: unfunded ${(c.unfunded_cents / 100).toLocaleString('en-US')}`));
  return svc.db.tx(() => {
    const ref = nextRef(svc.db, 'CC', 5);
    const { id } = svc.db.run(`INSERT INTO capital_calls (ref, pool_id, tranche, currency, amount_cents, purpose, due_date, status, created_by, created_at) VALUES (?,?,?,?,?,?,?, 'DRAFT', ?, ?)`,
      [ref, pool.id, input.tranche, pool.currency, input.amount_cents, input.purpose, input.due_date, user.username, now()]);
    cms.forEach((c, i) => svc.db.run('INSERT INTO capital_call_lines (call_id, commitment_id, investor_id, amount_cents) VALUES (?,?,?,?)', [id, c.id, c.investor_id, alloc[i]]));
    audit.record(svc.db, user, 'capital_call.created', 'capital_call', id, { ref, pool: pool.ref, tranche: input.tranche, amount_cents: input.amount_cents, allocation: cms.map((c, i) => [c.investor_code, alloc[i]]) });
    return { status: 201, json: { id, ref } };
  });
}

export async function issueCall(svc: Services, user: User, id: number) {
  requirePermission(user, 'fund.approve');
  const call = getCall(svc, id);
  if (call.status !== 'DRAFT') throw conflict(`Capital call is ${call.status}`);
  if (call.created_by === user.username) throw forbidden('Four-eyes: a capital call must be approved by someone other than its preparer (SoD-9)');
  const ctx: { entryId?: number } = {};
  const result = await runSaga(svc, user, 'capital_call.issue', call.ref, ctx, [
    {
      name: 'Approve call and post receivable',
      run: () => svc.db.tx(() => {
        const r = svc.db.run("UPDATE capital_calls SET status = 'ISSUED', approved_by = ?, issued_at = ? WHERE id = ? AND status = 'DRAFT'", [user.username, now(), id]);
        if (r.changes !== 1) throw conflict('Capital call changed');
        ctx.entryId = ledger.post(svc.db, user, {
          date: svc.today(), description: `Capital call ${call.ref} (${call.pool_ref} ${call.tranche})`, source_type: 'CAPITAL_CALL', source_id: id, currency: call.currency,
          lines: [
            ...call.lines.map((l: any) => ({ account: '1100', debit: l.amount_cents, investor_id: l.investor_id })),
            ...call.lines.map((l: any) => ({ account: '3000', credit: l.amount_cents, investor_id: l.investor_id })),
          ],
        });
        svc.db.run('UPDATE capital_calls SET journal_entry_id = ? WHERE id = ?', [ctx.entryId, id]);
        audit.record(svc.db, user, 'capital_call.issued', 'capital_call', id, { ref: call.ref, amount_cents: call.amount_cents, journal: ctx.entryId });
      }),
      compensate: () => svc.db.tx(() => {
        if (ctx.entryId) ledger.reverse(svc.db, user, ctx.entryId, 'capital call issue failed - compensated');
        svc.db.run("UPDATE capital_calls SET status = 'DRAFT', approved_by = NULL, issued_at = NULL, journal_entry_id = NULL WHERE id = ?", [id]);
        audit.record(svc.db, user, 'capital_call.issue_compensated', 'capital_call', id, {});
      }),
    },
    {
      name: 'Generate investor notices (PDF)',
      run: async () => {
        for (const l of call.lines) {
          const docId = await generatePdf(svc, user, 'capital_call', id, `NOTICE_${l.investor_code}`, `${call.ref}_${l.investor_code}_notice.pdf`, noticeSpec(svc, call, l));
          svc.db.run('UPDATE capital_call_lines SET notice_document_id = ? WHERE id = ?', [docId, l.id]);
        }
      },
    },
    {
      name: 'Notify investors',
      run: () => svc.db.tx(() => emit(svc.db, 'capital_call.issued', 'capital_call', id, { id, ref: call.ref, pool_ref: call.pool_ref, investors: call.lines.length })),
    },
  ]);
  return { ok: true, ...result };
}

function noticeSpec(svc: Services, call: any, line: any) {
  const fmt = (c: number) => `${call.currency} ${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const acct = svc.db.get("SELECT * FROM bank_accounts WHERE owner_type = 'SEAPORT' AND currency = ? AND active = 1 LIMIT 1", [call.currency]);
  return {
    title: `Capital call notice — ${call.ref}`,
    subtitle: `${line.investor_name} (${line.investor_code}) · ${call.pool_name} (${call.pool_ref}) · ${call.tranche} tranche`,
    footer: `${call.ref} · ${line.investor_code} · issued ${svc.today()}`,
    meta: [['Investor', `${line.investor_name} (${line.investor_code})`], ['Pool / tranche', `${call.pool_ref} · ${call.tranche}`], ['Notice date', svc.today()], ['Due date', call.due_date]],
    sections: [
      { heading: 'Amount called', kv: [['Your commitment', fmt(line.commitment_cents)], ['This call', fmt(line.amount_cents)], ['Purpose', call.purpose],
        ['Allocation', 'Pro rata to commitments in this tranche']] },
      { heading: 'Payment instructions', kv: acct ? [['Pay to', acct.account_name], ['Bank', acct.bank_name], ...(acct.iban ? [['IBAN', acct.iban], ['BIC', acct.bic]] : [['ABA', acct.routing_number], ['Account', acct.account_number]]), ['Reference', `${call.ref} ${line.investor_code}`]] : [['Pay to', 'See subscription agreement']] },
      { paragraphs: ['Funds must be received by the due date. Late payment may incur default interest under the subscription agreement.'] },
    ],
  };
}

export function recordReceipt(svc: Services, user: User, callId: number, body: unknown) {
  requirePermission(user, 'fund.receive');
  const input = check<any>(body, { line_id: { type: 'int', required: true, min: 1 }, amount_cents: { type: 'int', required: true, min: 1 }, received_at: { type: 'date', required: true } });
  const call = getCall(svc, callId);
  if (call.status !== 'ISSUED') throw conflict(`Capital call is ${call.status}`);
  const line = call.lines.find((l: any) => l.id === input.line_id);
  if (!line) throw notFound('Call line');
  if (line.received_cents + input.amount_cents > line.amount_cents) throw conflict('Receipt exceeds the amount called from this investor');
  return svc.db.tx(() => {
    svc.db.run('UPDATE capital_call_lines SET received_cents = received_cents + ?, received_at = ? WHERE id = ?', [input.amount_cents, input.received_at, line.id]);
    ledger.post(svc.db, user, {
      date: input.received_at, description: `Capital received ${call.ref} from ${line.investor_code}`, source_type: 'CAPITAL_RECEIPT', source_id: line.id, currency: call.currency,
      lines: [{ account: '1000', debit: input.amount_cents, investor_id: line.investor_id }, { account: '1100', credit: input.amount_cents, investor_id: line.investor_id }],
    });
    const open = svc.db.get<{ n: number }>('SELECT COUNT(*) n FROM capital_call_lines WHERE call_id = ? AND received_cents < amount_cents', [callId])!.n;
    if (!open) svc.db.run("UPDATE capital_calls SET status = 'SETTLED' WHERE id = ?", [callId]);
    audit.record(svc.db, user, 'capital_call.receipt', 'capital_call', callId, { investor: line.investor_code, amount_cents: input.amount_cents, settled: !open });
    if (!open) emit(svc.db, 'capital_call.settled', 'capital_call', callId, { id: callId, ref: call.ref, pool_ref: call.pool_ref });
    return { ok: true, settled: !open };
  });
}

export function cancelCall(svc: Services, user: User, id: number) {
  requirePermission(user, 'fund.call');
  return svc.db.tx(() => {
    const r = svc.db.run("UPDATE capital_calls SET status = 'CANCELLED' WHERE id = ? AND status = 'DRAFT'", [id]);
    if (!r.changes) throw conflict('Only draft calls can be cancelled');
    audit.record(svc.db, user, 'capital_call.cancelled', 'capital_call', id, {});
    return { ok: true };
  });
}

// ---------- Distributions ----------

export function listDistributions(svc: Services) {
  return svc.db.all('SELECT d.*, p.ref AS pool_ref, p.name AS pool_name, (SELECT COUNT(*) FROM distribution_lines WHERE distribution_id = d.id) AS investors FROM distributions d JOIN pools p ON p.id = d.pool_id ORDER BY d.id DESC')
    .map((d) => ({ ...d, lines: svc.db.all('SELECT l.*, i.code AS investor_code, i.name AS investor_name FROM distribution_lines l JOIN investors i ON i.id = l.investor_id WHERE distribution_id = ?', [d.id]) }));
}

export function createDistribution(svc: Services, user: User, body: unknown) {
  requirePermission(user, 'fund.call');
  return createDistributionInternal(svc, user, body);
}

/** Also used by Servicing for investor redemptions (body.commitment_id limits it to one investor). */
export function createDistributionInternal(svc: Services, user: User, body: any) {
  const only = Number.isSafeInteger(body?.commitment_id) ? body.commitment_id : null;
  const input = check<any>(body, {
    pool_id: { type: 'int', required: true, min: 1 },
    tranche: { type: 'enum', required: true, values: TRANCHES },
    kind: { type: 'enum', required: true, values: ['CAPITAL', 'INCOME'] },
    amount_cents: { type: 'int', required: true, min: 100 },
    payment_date: { type: 'date', required: true },
  });
  const pool = svc.db.get('SELECT * FROM pools WHERE id = ?', [input.pool_id]);
  if (!pool) throw badRequest('Unknown pool');
  const cms = commitmentRows(svc, "c.pool_id = ? AND c.tranche = ? AND c.status = 'ACTIVE'", [pool.id, input.tranche]).filter((c) => c.nav_cents > 0 && (!only || c.id === only));
  if (!cms.length) throw conflict('No paid-in capital in this tranche to distribute against');
  if (input.kind === 'CAPITAL') {
    const nav = cms.reduce((a, c) => a + c.nav_cents, 0);
    if (input.amount_cents > nav) throw conflict(`Return of capital exceeds net paid-in capital (${(nav / 100).toLocaleString('en-US')})`);
  }
  const alloc = proRata(input.amount_cents, cms.map((c) => c.nav_cents));
  return svc.db.tx(() => {
    const ref = nextRef(svc.db, 'DIST', 5);
    const { id } = svc.db.run(`INSERT INTO distributions (ref, pool_id, tranche, currency, kind, amount_cents, payment_date, status, created_by, created_at) VALUES (?,?,?,?,?,?,?, 'DRAFT', ?, ?)`,
      [ref, pool.id, input.tranche, pool.currency, input.kind, input.amount_cents, input.payment_date, user.username, now()]);
    cms.forEach((c, i) => svc.db.run('INSERT INTO distribution_lines (distribution_id, commitment_id, investor_id, amount_cents) VALUES (?,?,?,?)', [id, c.id, c.investor_id, alloc[i]]));
    audit.record(svc.db, user, 'distribution.created', 'distribution', id, { ref, pool: pool.ref, kind: input.kind, amount_cents: input.amount_cents });
    return { status: 201, json: { id, ref } };
  });
}

export function approveDistribution(svc: Services, user: User, id: number) {
  requirePermission(user, 'fund.approve');
  const d = svc.db.get('SELECT d.*, p.ref AS pool_ref FROM distributions d JOIN pools p ON p.id = d.pool_id WHERE d.id = ?', [id]);
  if (!d) throw notFound('Distribution');
  if (d.status !== 'DRAFT') throw conflict(`Distribution is ${d.status}`);
  if (d.created_by === user.username) throw forbidden('Four-eyes: a distribution must be approved by someone other than its preparer (SoD-9)');
  const lines = svc.db.all('SELECT l.*, i.code, i.name FROM distribution_lines l JOIN investors i ON i.id = l.investor_id WHERE distribution_id = ?', [id]);
  return svc.db.tx(() => {
    const debit = d.kind === 'CAPITAL' ? '3000' : '2300';
    const je = ledger.post(svc.db, user, {
      date: d.payment_date, description: `Distribution ${d.ref} (${d.kind.toLowerCase()}) ${d.pool_ref} ${d.tranche}`, source_type: 'DISTRIBUTION', source_id: id, currency: d.currency,
      lines: [...lines.map((l) => ({ account: debit, debit: l.amount_cents, investor_id: l.investor_id })), ...lines.map((l) => ({ account: '2600', credit: l.amount_cents, investor_id: l.investor_id }))],
    });
    svc.db.run("UPDATE distributions SET status = 'APPROVED', approved_by = ?, approved_at = ?, journal_entry_id = ? WHERE id = ?", [user.username, now(), je, id]);
    for (const l of lines) {
      if (!l.amount_cents) continue;
      svc.db.run(`INSERT INTO payments (purpose, source_type, source_id, beneficiary_account_id, beneficiary_name, amount_cents, currency, reference, status, created_at)
        VALUES ('DISTRIBUTION', 'distribution_line', ?, (SELECT id FROM bank_accounts WHERE owner_type = 'INVESTOR' AND owner_id = ? AND currency = ? AND active = 1 ORDER BY id DESC LIMIT 1), ?, ?, ?, ?, 'PENDING', ?)`,
        [l.id, l.investor_id, d.currency, l.name, l.amount_cents, d.currency, `${d.ref}-${l.code}`, now()]);
    }
    audit.record(svc.db, user, 'distribution.approved', 'distribution', id, { ref: d.ref, amount_cents: d.amount_cents, journal: je });
    return { ok: true };
  });
}

// ---------- Payments & disbursement batches ----------

/** Funding approval queues the seller payment (called from funding.ts inside its transaction). */
export function queueFundingPayment(svc: Services, importId: number) {
  const f = svc.db.get('SELECT f.*, p.client_name, p.currency, p.id AS pid FROM invoice_imports f JOIN programs p ON p.id = f.program_id WHERE f.id = ?', [importId]);
  const amount = svc.db.get<{ s: number }>('SELECT COALESCE(SUM(purchase_cents - interest_cents), 0) s FROM loans WHERE import_id = ?', [importId])!.s;
  if (!amount) return;
  svc.db.run(`INSERT INTO payments (purpose, source_type, source_id, beneficiary_account_id, beneficiary_name, amount_cents, currency, reference, status, created_at)
    VALUES ('FUNDING', 'invoice_import', ?, (SELECT id FROM bank_accounts WHERE owner_type = 'PROGRAM' AND owner_id = ? AND currency = ? AND active = 1 ORDER BY id DESC LIMIT 1), ?, ?, ?, ?, 'PENDING', ?)`,
    [importId, f.pid, f.currency, f.client_name, amount, f.currency, `${f.filename}`.slice(0, 60), now()]);
}

function paymentRows(svc: Services, where: string, params: any[] = []) {
  return svc.db.all(`SELECT pm.*, b.bank_name, b.account_name, b.routing_number, b.account_number, b.bic, b.iban, b.country,
      CASE pm.source_type WHEN 'invoice_import' THEN (SELECT funding_date FROM invoice_imports WHERE id = pm.source_id)
                          WHEN 'distribution_line' THEN (SELECT d.payment_date FROM distribution_lines l JOIN distributions d ON d.id = l.distribution_id WHERE l.id = pm.source_id) END AS due_date
    FROM payments pm LEFT JOIN bank_accounts b ON b.id = pm.beneficiary_account_id WHERE ${where} ORDER BY due_date, pm.id`, params).map(maskAccount);
}

export function paymentQueue(svc: Services) {
  return paymentRows(svc, "pm.status = 'PENDING' AND pm.batch_id IS NULL");
}

export function listBatches(svc: Services) {
  return svc.db.all(`SELECT b.*, (SELECT COUNT(*) FROM payments WHERE batch_id = b.id) AS payments, (SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE batch_id = b.id) AS total_cents,
      d.filename AS file_name FROM payment_batches b LEFT JOIN documents d ON d.id = b.file_document_id ORDER BY b.id DESC`);
}

export function getBatch(svc: Services, id: number) {
  const b = svc.db.get('SELECT b.*, d.filename AS file_name FROM payment_batches b LEFT JOIN documents d ON d.id = b.file_document_id WHERE b.id = ?', [id]);
  if (!b) throw notFound('Payment batch');
  return { ...b, payments: paymentRows(svc, 'pm.batch_id = ?', [id]), sagas: sagaRuns(svc, b.ref) };
}

export function createBatch(svc: Services, user: User, body: any) {
  requirePermission(user, 'payments.prepare');
  const input = check<any>(body, {
    rail: { type: 'enum', required: true, values: ['ACH', 'FEDWIRE', 'SWIFT_MT103', 'PAIN001'] },
    value_date: { type: 'date', required: true },
  });
  const ids: number[] = Array.isArray(body?.payment_ids) ? body.payment_ids.filter(Number.isSafeInteger) : [];
  if (!ids.length) throw badRequest('payment_ids must be a non-empty array');
  if (input.value_date < svc.today()) throw validation({ value_date: 'cannot be in the past' });
  const pays = paymentRows(svc, `pm.id IN (${ids.map(() => '?').join(',')})`, ids);
  if (pays.length !== ids.length || pays.some((p) => p.status !== 'PENDING' || p.batch_id)) throw conflict('Some payments are not available (already batched or sent)');
  const ccys = new Set(pays.map((p) => p.currency));
  if (ccys.size !== 1) throw conflict('A batch must be in a single currency');
  const currency = [...ccys][0];
  if ((input.rail === 'ACH' || input.rail === 'FEDWIRE') && currency !== 'USD') throw validation({ rail: `${input.rail} only carries USD; use SWIFT MT103 or pain.001` });
  const missing = pays.filter((p) => !p.beneficiary_account_id);
  if (missing.length) throw conflict('Some beneficiaries have no bank account on file', missing.map((p) => `${p.beneficiary_name} (${p.currency})`));
  return svc.db.tx(() => {
    const ref = nextRef(svc.db, 'PAY', 6);
    const { id } = svc.db.run(`INSERT INTO payment_batches (ref, currency, rail, value_date, status, created_by, created_at) VALUES (?,?,?,?, 'DRAFT', ?, ?)`, [ref, currency, input.rail, input.value_date, user.username, now()]);
    for (const p of pays) svc.db.run('UPDATE payments SET batch_id = ? WHERE id = ?', [id, p.id]);
    audit.record(svc.db, user, 'payment_batch.created', 'payment_batch', id, { ref, rail: input.rail, currency, payments: pays.length, total_cents: pays.reduce((a, p) => a + p.amount_cents, 0) });
    return { status: 201, json: { id, ref } };
  });
}

function filePayload(svc: Services, b: any) {
  const orig = svc.db.get("SELECT * FROM bank_accounts WHERE owner_type = 'SEAPORT' AND currency = ? AND active = 1 ORDER BY id LIMIT 1", [b.currency]);
  if (!orig) throw conflict(`No Seaport originating account for ${b.currency}`);
  const pays = svc.db.all('SELECT pm.*, ba.* , pm.id AS pid FROM payments pm JOIN bank_accounts ba ON ba.id = pm.beneficiary_account_id WHERE pm.batch_id = ? ORDER BY pm.id', [b.id]);
  return {
    rail: b.rail, batch_ref: b.ref, value_date: b.value_date, created_at: now(), currency: b.currency,
    originator: { name: 'Seaport Global LLP', bank_name: orig.bank_name, routing_number: orig.routing_number, account_number: orig.account_number, bic: orig.bic, iban: orig.iban, company_id: '1987654321' },
    payments: pays.map((p) => ({ reference: p.reference.replace(/\.[a-z]+$/i, '').slice(0, 15), amount_cents: p.amount_cents, remittance: p.reference,
      beneficiary: { name: p.account_name, bank_name: p.bank_name, routing_number: p.routing_number, account_number: p.account_number, bic: p.bic, iban: p.iban, country: p.country } })),
  };
}

export async function previewBatch(svc: Services, id: number) {
  const b = getBatch(svc, id);
  const r = await svc.engine.call('/payments/file', filePayload(svc, b));
  return { errors: r.errors, count: r.count, total_cents: r.total_cents, filename: r.filename, preview: r.content ? r.content.slice(0, 4000) : null };
}

export async function approveBatch(svc: Services, user: User, id: number) {
  requirePermission(user, 'payments.approve');
  const b = getBatch(svc, id);
  if (b.status !== 'DRAFT') throw conflict(`Batch is ${b.status}`);
  if (b.created_by === user.username) throw forbidden('Four-eyes: a disbursement batch must be approved by someone other than its preparer (SoD-10)');
  const changed = svc.db.all(`SELECT DISTINCT ba.account_name FROM payments pm JOIN bank_accounts ba ON ba.id = pm.beneficiary_account_id WHERE pm.batch_id = ? AND (ba.updated_by = ? OR ba.created_by = ?)`, [id, user.username, user.username]);
  if (changed.length) throw forbidden(`SoD-10: you created or changed bank details for ${changed.map((c) => c.account_name).join(', ')} - another approver is required`);
  const ctx: { file?: any; docId?: number } = {};
  const result = await runSaga(svc, user, 'payment_batch.approve', b.ref, ctx, [
    {
      name: 'Generate and validate bank file',
      run: async () => {
        ctx.file = await svc.engine.call('/payments/file', filePayload(svc, b));
        if (ctx.file.errors.length) throw new Error(`Bank file validation failed: ${ctx.file.errors.join('; ')}`);
      },
    },
    {
      name: 'Store file (document store)',
      run: async () => {
        const stored = await storeBytes(svc, Buffer.from(ctx.file.content, 'utf8'));
        ctx.docId = svc.db.tx(() => recordDocument(svc, user, { entity_type: 'payment_batch', entity_id: id, doc_type: 'BANK_FILE', filename: ctx.file.filename, content_type: ctx.file.content_type, stored, generated: true }));
      },
    },
    {
      name: 'Approve batch',
      run: () => svc.db.tx(() => {
        const r = svc.db.run("UPDATE payment_batches SET status = 'APPROVED', approved_by = ?, approved_at = ?, file_document_id = ? WHERE id = ? AND status = 'DRAFT'", [user.username, now(), ctx.docId, id]);
        if (r.changes !== 1) throw conflict('Batch changed');
        audit.record(svc.db, user, 'payment_batch.approved', 'payment_batch', id, { ref: b.ref, file: ctx.file.filename, total_cents: ctx.file.total_cents, count: ctx.file.count });
      }),
    },
  ]);
  return { ok: true, file: ctx.file.filename, ...result };
}

/** Mark the batch as transmitted to the bank: cash leaves account 1000. */
export async function releaseBatch(svc: Services, user: User, id: number) {
  requirePermission(user, 'payments.approve');
  const b = getBatch(svc, id);
  if (b.status !== 'APPROVED') throw conflict(`Batch is ${b.status}; approve it first`);
  const ctx: { entries: number[] } = { entries: [] };
  const result = await runSaga(svc, user, 'payment_batch.release', b.ref, ctx, [{
    name: 'Post cash and mark payments sent',
    run: () => svc.db.tx(() => {
      for (const p of b.payments) {
        const liability = p.purpose === 'FUNDING' ? '2500' : '2600';
        const program = p.purpose === 'FUNDING' ? svc.db.get('SELECT program_id FROM invoice_imports WHERE id = ?', [p.source_id])?.program_id ?? null : null;
        const je = ledger.post(svc.db, user, {
          date: b.value_date, description: `${b.ref} ${p.purpose.toLowerCase()} payment to ${p.beneficiary_name} (${p.reference})`, source_type: 'DISBURSEMENT', source_id: p.id, currency: b.currency,
          lines: [{ account: liability, debit: p.amount_cents, program_id: program }, { account: '1000', credit: p.amount_cents, program_id: program }],
        });
        svc.db.run("UPDATE payments SET status = 'SENT', journal_entry_id = ? WHERE id = ?", [je, p.id]);
      }
      svc.db.run("UPDATE payment_batches SET status = 'SENT', sent_by = ?, sent_at = ? WHERE id = ?", [user.username, now(), id]);
      svc.db.run(`UPDATE distributions SET status = 'PAID' WHERE status = 'APPROVED' AND id IN (SELECT l.distribution_id FROM distribution_lines l)
        AND NOT EXISTS (SELECT 1 FROM distribution_lines l JOIN payments pm ON pm.source_type = 'distribution_line' AND pm.source_id = l.id WHERE l.distribution_id = distributions.id AND pm.status <> 'SENT')`);
      audit.record(svc.db, user, 'payment_batch.sent', 'payment_batch', id, { ref: b.ref, payments: b.payments.length });
      emit(svc.db, 'payment_batch.sent', 'payment_batch', id, { ref: b.ref, count: b.payments.length });
    }),
  }]);
  return { ok: true, ...result };
}

export function cancelBatch(svc: Services, user: User, id: number) {
  requirePermission(user, 'payments.prepare');
  return svc.db.tx(() => {
    const r = svc.db.run("UPDATE payment_batches SET status = 'CANCELLED' WHERE id = ? AND status IN ('DRAFT','APPROVED')", [id]);
    if (!r.changes) throw conflict('Only draft or approved (not yet sent) batches can be cancelled');
    svc.db.run('UPDATE payments SET batch_id = NULL WHERE batch_id = ?', [id]);
    audit.record(svc.db, user, 'payment_batch.cancelled', 'payment_batch', id, {});
    return { ok: true };
  });
}

// ---------- Liquidity / dry powder ----------

export function liquidity(svc: Services) {
  const today = svc.today();
  const currencies = svc.db.all<{ c: string }>('SELECT DISTINCT currency c FROM programs UNION SELECT DISTINCT currency FROM pools ORDER BY 1').map((r) => r.c);
  return currencies.map((ccy) => {
    const cash = svc.db.get<{ b: number }>(`SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) b FROM ledger_lines l JOIN journal_entries je ON je.id = l.entry_id WHERE l.account_code = '1000' AND je.currency = ?`, [ccy])!.b;
    const unfunded = commitmentRows(svc, "c.currency = ? AND c.status = 'ACTIVE'", [ccy]).reduce((a, c) => a + c.unfunded_cents, 0);
    const callsOutstanding = svc.db.get<{ s: number }>(`SELECT COALESCE(SUM(l.amount_cents - l.received_cents), 0) s FROM capital_call_lines l JOIN capital_calls c ON c.id = l.call_id WHERE c.status = 'ISSUED' AND c.currency = ?`, [ccy])!.s;
    const pendingPayments = svc.db.get<{ s: number }>(`SELECT COALESCE(SUM(amount_cents), 0) s FROM payments WHERE status = 'PENDING' AND currency = ?`, [ccy])!.s;
    const obligors = svc.db.all<{ id: number }>('SELECT o.id FROM obligors o JOIN programs p ON p.id = o.program_id WHERE p.currency = ?', [ccy]);
    const pipelineCents = obligors.reduce((a, o) => a + pipeline(svc.db, o.id), 0);
    const facility = -svc.db.get<{ b: number }>(`SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) b FROM ledger_lines l JOIN journal_entries je ON je.id = l.entry_id WHERE l.account_code = '2700' AND je.currency = ?`, [ccy])!.b;
    const weeks = Array.from({ length: 8 }, (_, w) => {
      const from = addDays(today, w * 7);
      const to = addDays(today, w * 7 + 6);
      const inflow = svc.db.get<{ s: number }>(`SELECT COALESCE(SUM(face_cents - received_cents), 0) s FROM loans WHERE status = 'OPEN' AND currency = ? AND maturity_date BETWEEN ? AND ?`, [ccy, from, to])!.s
        + svc.db.get<{ s: number }>(`SELECT COALESCE(SUM(l.amount_cents - l.received_cents), 0) s FROM capital_call_lines l JOIN capital_calls c ON c.id = l.call_id WHERE c.status = 'ISSUED' AND c.currency = ? AND c.due_date BETWEEN ? AND ?`, [ccy, from, to])!.s;
      const outflow = paymentRows(svc, "pm.status = 'PENDING' AND pm.currency = ?", [ccy]).filter((p) => (p.due_date ?? today) <= to && (w === 0 || (p.due_date ?? today) >= from)).reduce((a, p) => a + p.amount_cents, 0)
        + (w === 0 ? pipelineCents : 0);
      return { week: w + 1, from, to, inflow_cents: inflow, outflow_cents: outflow };
    });
    let running = cash;
    for (const w of weeks) { running += w.inflow_cents - w.outflow_cents; (w as any).closing_cents = running; }
    const pastDue = svc.db.get<{ s: number }>(`SELECT COALESCE(SUM(face_cents - received_cents), 0) s FROM loans WHERE status = 'OPEN' AND currency = ? AND maturity_date < ?`, [ccy, today])!.s;
    return {
      currency: ccy, cash_cents: cash, facility_drawn_cents: facility, unfunded_commitments_cents: unfunded, capital_calls_outstanding_cents: callsOutstanding,
      pending_payments_cents: pendingPayments, funding_pipeline_cents: pipelineCents, past_due_collections_cents: pastDue,
      dry_powder_cents: cash + unfunded + callsOutstanding - pendingPayments - pipelineCents,
      weeks,
    };
  });
}
