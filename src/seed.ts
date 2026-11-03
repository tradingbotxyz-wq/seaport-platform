// Demo data, positioned relative to the business date so the dashboard always has something due
// today, in the next 7 days and past due. Names mirror the Seaport Global prototype screens.
//
//   npm run seed    load demo data into an empty database
//   npm run reset   delete the database and files, then reload demo data

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Services, User } from './core/context.ts';
import { now, addDays, addBusinessDays, daysBetween, nextRef } from './core/context.ts';
import * as ledger from './modules/ledger.ts';
import * as recon from './modules/recon.ts';
import * as audit from './core/audit.ts';

const BUCKETS: [string, number, number][] = [['1-30', 1, 30], ['31-90', 31, 90], ['91-180', 91, 180], ['181+', 181, 1e9]];
const bucketFor = (t: number) => BUCKETS.find(([, lo, hi]) => t >= lo && t <= hi)![0];
const roundDiv = (num: bigint, den: bigint) => Number((2n * num + den) / (2n * den)); // half-up, positive

const M = (millions: number) => Math.round(millions * 100_000_000); // major-unit millions -> cents

const USERS = [
  ['admin', 'Seaport Administrator', 'admin@seaportglobal.example', 'ADMIN'],
  ['rabuan', 'Rabuan', 'rabuan@seaportglobal.example', 'OPS_MAKER'],
  ['priya', 'Priya Nair', 'priya.nair@seaportglobal.example', 'OPS_CHECKER'],
  ['daniel', 'Daniel Okafor', 'daniel.okafor@seaportglobal.example', 'CREDIT'],
  ['meera', 'Meera Shah', 'meera.shah@seaportglobal.example', 'TREASURY'],
  ['tom', 'Tom Reyes', 'tom.reyes@seaportglobal.example', 'TREASURY'],
  ['audit', 'Internal Audit', 'audit@seaportglobal.example', 'VIEWER'],
] as const;

type Ob = { name: string; rating: string; role: string; limit: number; adv: number; margin: number; spread: number; auto?: boolean; usage: number };
const PROGRAMS: { code: string; deal: string; name: string; client: string; type: string; ccy: string; basis: string; dc: string; obligors: Ob[] }[] = [
  { code: 'PRG-1041', deal: 'SG-WC-1041', name: 'Harborview Foods SCF 2024-1', client: 'Harborview Foods Inc', type: 'SCF', ccy: 'USD', basis: 'SOFR', dc: 'ACT/360', obligors: [
    { name: 'Harborview Foods USA', rating: 'BBB', role: 'Obligor', limit: 40, adv: 9500, margin: 162, spread: 63, auto: true, usage: 0.84 },
    { name: 'Harborview Foods Canada', rating: 'BBB', role: 'Subsidiary', limit: 15, adv: 9000, margin: 180, spread: 70, usage: 0.613 },
    { name: 'Harborview Retail LLC', rating: 'BB+', role: 'Subsidiary', limit: 10, adv: 9000, margin: 216, spread: 84, usage: 1.04 },
  ] },
  { code: 'PRG-1052', deal: 'SG-WC-1052', name: 'Atlas Steelworks RPA 2023-2', client: 'Atlas Steelworks Ltd', type: 'RPA', ccy: 'USD', basis: 'SOFR', dc: 'ACT/360', obligors: [
    { name: 'Gulf Fabricators Inc', rating: 'BB', role: 'Obligor', limit: 12, adv: 9200, margin: 195, spread: 75, usage: 0.97 },
    { name: 'Atlas Steelworks West', rating: 'BBB-', role: 'Obligor', limit: 20, adv: 9300, margin: 170, spread: 65, auto: true, usage: 0.55 },
  ] },
  { code: 'PRG-1067', deal: 'SG-WC-1067', name: 'Brightline Distributors IF 2025-1', client: 'Brightline Distributors', type: 'IF', ccy: 'USD', basis: 'SOFR', dc: 'ACT/360', obligors: [
    { name: 'Pacific Parts Depot', rating: 'B+', role: 'Distributor', limit: 8, adv: 8500, margin: 240, spread: 95, usage: 0.9 },
    { name: 'Brightline West', rating: 'BB-', role: 'Distributor', limit: 14, adv: 8800, margin: 210, spread: 85, usage: 0.62 },
  ] },
  { code: 'PRG-1073', deal: 'SG-WC-1073', name: 'Kestrel Exports LC-Backed 2024-3', client: 'Kestrel Exports GmbH', type: 'LC_BACKED', ccy: 'EUR', basis: 'ESTR', dc: 'ACT/360', obligors: [
    { name: 'Nordhafen Trading GmbH', rating: 'A-', role: 'LC issuer', limit: 18, adv: 9700, margin: 110, spread: 45, auto: true, usage: 0.58 },
    { name: 'Lyon Agro SA', rating: 'BBB', role: 'Obligor', limit: 9, adv: 9400, margin: 150, spread: 60, usage: 0.71 },
  ] },
  { code: 'PRG-1088', deal: 'SG-WC-1088', name: 'Vantage Health Insured AR 2025-2', client: 'Vantage Health Group', type: 'INSURED_AR', ccy: 'GBP', basis: 'SONIA', dc: 'ACT/365', obligors: [
    { name: 'Caledonia Care Ltd', rating: 'BB+', role: 'Insured obligor', limit: 9, adv: 9500, margin: 175, spread: 70, usage: 0.97 },
    { name: 'Thames Clinics plc', rating: 'BBB', role: 'Insured obligor', limit: 12, adv: 9500, margin: 150, spread: 60, usage: 0.48 },
  ] },
];

const FIXINGS: Record<string, number[]> = { SOFR: [428, 435, 442, 455], ESTR: [212, 218, 224, 236], SONIA: [397, 402, 409, 421] };


const userOfSeed = (u: string): User => {
  const r = USERS.find((x) => x[0] === u)!;
  return { username: r[0], name: r[1], role: r[3] as any };
};

/** Create an APPROVED invoice file with funded loans + ledger entries (demo data, also used for aged delinquencies). */
export function seedFundedBatch(svc: Pick<Services, 'db' | 'filesDir'>, code: string, fundingDate: string, items: { ob: { id: number }; face: number; due: string; investor: number }[], tag: string) {
  const { db } = svc;
  const ts = now();
  const userOf = userOfSeed;
  const prog = db.get<any>('SELECT * FROM programs WHERE program_code = ?', [code])!;
  const pid = prog.id;
  const p = { ccy: prog.currency, basis: prog.rate_basis, dc: prog.day_count, client: prog.client_name };
  const fixingFor = (basis: string, date: string) => {
    const fd = db.get<{ d: string }>('SELECT MAX(fixing_date) d FROM rate_fixings WHERE benchmark = ? AND fixing_date <= ?', [basis, date])!.d
      ?? db.get<{ d: string }>('SELECT MIN(fixing_date) d FROM rate_fixings WHERE benchmark = ?', [basis])!.d;
    return Object.fromEntries(db.all('SELECT bucket, rate_bps FROM rate_fixings WHERE benchmark = ? AND fixing_date = ?', [basis, fd]).map((r) => [r.bucket, r.rate_bps]));
  };
  let invSeq = db.get<{ n: number | null }>("SELECT MAX(CAST(substr(invoice_number, 5) AS INTEGER)) n FROM invoices WHERE invoice_number LIKE 'INV-%'")!.n ?? 87100;
  mkdirSync(join(svc.filesDir, 'invoices'), { recursive: true });
  items = items.map((it) => {
    const o = db.get<any>('SELECT * FROM obligors WHERE id = ?', [it.ob.id])!;
    return { ...it, ob: { id: o.id, name: o.name, adv: o.advance_rate_bps, margin: o.investor_margin_bps, spread: o.sp_spread_bps } };
  });
    const filename = `inv_batch_${tag}_${code.slice(4)}.${items.length % 2 ? 'xlsx' : 'csv'}`;
  const sha = createHash('sha256').update(filename + fundingDate).digest('hex');
  const uploadedAt = addDays(fundingDate, -1) + 'T09:14:00.000Z';
  const { id: impId } = db.run(
    `INSERT INTO invoice_imports (program_id, filename, file_format, sha256, size_bytes, storage_key, funding_date, rows_read, accepted, rejected, parse_report, status, uploaded_by, uploaded_at, approved_by, approved_at)
     VALUES (?,?,?,?,?,?,?,?,?,0,'{"skipped":[],"warnings":[]}','APPROVED','rabuan',?,'priya',?)`,
    [pid, filename, filename.split('.').pop(), sha, 2048, `invoices/${sha}`, fundingDate, items.length, items.length, uploadedAt, uploadedAt.replace('T09', 'T15')]);
  writeFileSync(join(svc.filesDir, 'invoices', sha), 'Invoice No,Buyer,Invoice Date,Due Date,Invoice Amount,Currency\n' +
    items.map((it, k) => `INV-${invSeq + k + 1},${it.ob.name},${addDays(fundingDate, -20)},${it.due},${(it.face / 100).toFixed(2)},${p.ccy}`).join('\n') + '\n');
  const fix = fixingFor(p.basis, fundingDate);
  const basis = BigInt(p.dc === 'ACT/360' ? 360 : 365);
  const loans: number[] = [];
  for (const it of items) {
    const number = `INV-${++invSeq}`;
    const purchase = Math.floor((it.face * it.ob.adv + 5000) / 10000);
    const tenor = daysBetween(fundingDate, it.due);
    const bucket = bucketFor(tenor);
    const base = fix[bucket];
    const allIn = base + it.ob.margin + it.ob.spread;
    const interest = roundDiv(BigInt(purchase) * BigInt(allIn) * BigInt(tenor), basis * 10000n);
    const toInv = roundDiv(BigInt(purchase) * BigInt(base + it.ob.margin) * BigInt(tenor), basis * 10000n);
    const { id: invId } = db.run(
      `INSERT INTO invoices (import_id, program_id, obligor_id, buyer_name, invoice_number, invoice_date, due_date, face_cents, currency, investor_id, status,
         adv_bps, purchase_cents, tenor_days, bucket, base_bps, investor_margin_bps, sp_spread_bps, all_in_bps, interest_cents, investor_interest_cents, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'FUNDED',?,?,?,?,?,?,?,?,?,?,?,?)`,
      [impId, pid, it.ob.id, it.ob.name, number, addDays(fundingDate, -20), it.due, it.face, p.ccy, it.investor, it.ob.adv, purchase, tenor, bucket, base,
        it.ob.margin, it.ob.spread, allIn, interest, toInv, ts, ts]);
    const loanRef = nextRef(db, `L-${fundingDate.slice(0, 4)}`, 5);
    const { id: loanId } = db.run(
      `INSERT INTO loans (loan_ref, invoice_id, import_id, program_id, obligor_id, investor_id, currency, funding_date, maturity_date, face_cents, purchase_cents,
         interest_cents, investor_interest_cents, base_bps, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'OPEN',?)`,
      [loanRef, invId, impId, pid, it.ob.id, it.investor, p.ccy, fundingDate, it.due, it.face, purchase, interest, toInv, base, ts]);
    ledger.post(db, userOf('priya'), {
      date: fundingDate, description: `Funding ${loanRef} / ${number} (${it.ob.name})`, source_type: 'FUNDING', source_id: loanId, currency: p.ccy,
      lines: [
        { account: '1200', debit: purchase, program_id: pid, loan_id: loanId, investor_id: it.investor },
        { account: '2500', credit: purchase - interest, program_id: pid, loan_id: loanId },
        { account: '2100', credit: interest, program_id: pid, loan_id: loanId, investor_id: it.investor },
      ],
    });
    loans.push(loanId);
  }
  audit.record(db, userOf('priya'), 'funding.approved', 'invoice_import', impId, { filename, funding_date: fundingDate, seeded: true });
  // Historical disbursement to the seller (paid before the platform's payment module).
  const toSeller = db.get<{ s: number }>('SELECT SUM(purchase_cents - interest_cents) s FROM loans WHERE import_id = ?', [impId])!.s;
  const je = ledger.post(db, userOf('meera'), {
    date: fundingDate, description: `Disbursement to ${p.client} for ${filename}`, source_type: 'DISBURSEMENT', source_id: impId, currency: p.ccy,
    lines: [{ account: '2500', debit: toSeller, program_id: pid }, { account: '1000', credit: toSeller, program_id: pid }],
  });
  db.run(`INSERT INTO payments (purpose, source_type, source_id, beneficiary_name, amount_cents, currency, reference, status, journal_entry_id, created_at)
          VALUES ('FUNDING', 'invoice_import', ?, ?, ?, ?, ?, 'LEGACY', ?, ?)`, [impId, p.client, toSeller, p.ccy, filename, je, ts]);
  return loans;
}

export function seed(svc: Pick<Services, 'db' | 'today' | 'filesDir'>) {
  const { db } = svc;
  const today = svc.today();
  const d = (n: number) => addDays(today, n);
  const ts = now();
  const userOf = (u: string): User => {
    const r = USERS.find((x) => x[0] === u)!;
    return { username: r[0], name: r[1], role: r[3] as any };
  };
  mkdirSync(join(svc.filesDir, 'invoices'), { recursive: true });

  db.tx(() => {
    for (const [username, name, email, role] of USERS) db.run('INSERT INTO users (username, name, email, role, active, created_at) VALUES (?,?,?,?,1,?)', [username, name, email, role, ts]);
    for (const [code, name] of [['INV-0001', 'Pemberton SF I'], ['INV-0002', 'Cascade Credit'], ['INV-0003', 'Northgate Trade Fund']]) db.run('INSERT INTO investors (code, name) VALUES (?,?)', [code, name]);
    for (const [ccy, rate] of [['USD', '1'], ['EUR', '1.08'], ['GBP', '1.27']]) db.run('INSERT INTO fx_rates (currency, usd_rate, as_of) VALUES (?,?,?)', [ccy, rate, today]);
    for (const [bm, rates] of Object.entries(FIXINGS)) {
      for (const [offset, bump] of [[-150, 6], [-60, 3], [-3, 0]] as const) {
        BUCKETS.forEach(([b], i) => db.run('INSERT INTO rate_fixings (benchmark, fixing_date, bucket, rate_bps) VALUES (?,?,?,?)', [bm, d(offset), b, rates[i] + bump]));
      }
    }

    const admin = userOf('admin');
    const fixingFor = (basis: string, date: string) => {
      const fd = db.get<{ d: string }>('SELECT MAX(fixing_date) d FROM rate_fixings WHERE benchmark = ? AND fixing_date <= ?', [basis, date])!.d;
      return Object.fromEntries(db.all('SELECT bucket, rate_bps FROM rate_fixings WHERE benchmark = ? AND fixing_date = ?', [basis, fd]).map((r) => [r.bucket, r.rate_bps]));
    };

    let invSeq = 87100;
    const progIds: Record<string, any> = {};

    for (const p of PROGRAMS) {
      const { id: pid } = db.run(
        `INSERT INTO programs (program_code, deal_code, deal_name, client_name, program_type, currency, rate_basis, day_count, funding_lag_days, late_margin_bps, collection_account, created_at)
         VALUES (?,?,?,?,?,?,?,?,1,300,?,?)`, [p.code, p.deal, p.name, p.client, p.type, p.ccy, p.basis, p.dc, `VA-${p.code.slice(4)}`, ts]);
      const obs = p.obligors.map((o) => {
        const { id } = db.run(
          `INSERT INTO obligors (program_id, name, rating, role, limit_cents, advance_rate_bps, investor_margin_bps, sp_spread_bps, auto_debit, active) VALUES (?,?,?,?,?,?,?,?,?,1)`,
          [pid, o.name, o.rating, o.role, M(o.limit), o.adv, o.margin, o.spread, o.auto ? 1 : 0]);
        return { ...o, id };
      });
      progIds[p.code] = { id: pid, p, obs };
    }

    const fundedBatch = (code: string, fundingDate: string, items: { ob: any; face: number; due: string; investor: number }[], tag: string) => seedFundedBatch(svc, code, fundingDate, items, tag);

    // 1) Settled history: funded ~4 months ago, matured, advised and confirmed by the bank.
    const settledLoans: number[] = [];
    for (const code of Object.keys(progIds)) {
      const { obs } = progIds[code];
      const items = obs.flatMap((ob: any, i: number) => [
        { ob, face: Math.round(M(ob.limit) * 0.18 / 100) * 100, due: d(-48 - i * 3), investor: 1 + (i % 2) },
        { ob, face: Math.round(M(ob.limit) * 0.11 / 100) * 100, due: d(-33 - i * 2), investor: 2 - (i % 2) },
      ]);
      settledLoans.push(...fundedBatch(code, d(-110), items, 'hist'));
    }

    // 2) Open book sized to each obligor's target utilisation, maturities spread across the coming weeks.
    const offsets = [-9, -3, 0, 1, 2, 4, 5, 7, 15, 28, 44, 61, 75];
    let rot = 0;
    const openLoanIds: number[] = [];
    for (const code of Object.keys(progIds)) {
      const { obs } = progIds[code];
      const byDate = new Map<string, any[]>();
      for (const ob of obs) {
        const targetPurchase = M(ob.limit) * ob.usage;
        const n = 4;
        for (let k = 0; k < n; k++) {
          const offset = offsets[(rot++) % offsets.length];
          const funding = offset - 85 < -95 ? d(-95) : d(Math.min(offset - 60, -20));
          const face = Math.round((targetPurchase / n) * 10000 / ob.adv / 100) * 100;
          const list = byDate.get(funding) ?? [];
          list.push({ ob, face, due: d(offset), investor: 1 + ((rot + k) % 3) });
          byDate.set(funding, list);
        }
      }
      for (const [funding, items] of byDate) openLoanIds.push(...fundedBatch(code, funding, items, funding.slice(5).replace('-', '')));
    }

    // 3) Bank statement for the settled history, posted by a different treasury user (SoD-3).
    const hist = db.all(`SELECT l.*, p.collection_account FROM loans l JOIN programs p ON p.id = l.program_id WHERE l.id IN (${settledLoans.join(',')})`);
    const st = db.run('INSERT INTO bank_statements (program_id, account, filename, sha256, statement_date, uploaded_by, uploaded_at) VALUES (NULL, ?, ?, ?, ?, ?, ?)',
      ['ALL', `bank_statement_${d(-30)}.csv`, createHash('sha256').update('hist-stmt').digest('hex'), d(-30), 'meera', ts]);
    hist.forEach((l, i) => {
      db.run(`INSERT INTO bank_lines (statement_id, value_date, reference, bank_reference, amount_cents, currency, loan_id, match_status, match_note) VALUES (?,?,?,?,?,?,?, 'MATCHED', 'Matched on loan ID; full settlement')`,
        [st.id, l.maturity_date, `${l.loan_ref} INVOICE SETTLEMENT`, `${l.collection_account}-${String(i + 1).padStart(4, '0')}`, l.face_cents, l.currency, l.id]);
    });
    recon.postMatched({ db, today: svc.today } as any, userOf('tom'), st.id);

    // Settlement advices for the settled history (one file per program).
    for (const code of Object.keys(progIds)) {
      const { id: pid } = progIds[code];
      const loans = hist.filter((l) => l.program_id === pid);
      const { id: sid } = db.run(
        `INSERT INTO settlement_imports (program_id, filename, file_format, sha256, settlement_date, rows_read, matched, unmatched, parse_report, uploaded_by, uploaded_at)
         VALUES (?,?,?,?,?,?,?,0,'{"skipped":[],"warnings":[]}','rabuan',?)`,
        [pid, `settle_hist_${code.slice(4)}.csv`, 'csv', createHash('sha256').update('settle-hist' + code).digest('hex'), d(-33), loans.length, loans.length, ts]);
      for (const l of loans) {
        db.run(`INSERT INTO settlement_advices (settlement_import_id, loan_id, loan_ref_raw, amount_cents, value_date, bank_reference, match_status) VALUES (?,?,?,?,?,?, 'MATCHED')`,
          [sid, l.id, l.loan_ref, l.face_cents, l.maturity_date, db.get('SELECT bank_reference FROM loans WHERE id = ?', [l.id])!.bank_reference]);
      }
    }

    // 4) Recent advices for past-due loans: one fully advised, one short paid, one pending.
    const pastDue = db.all(`SELECT l.*, p.collection_account FROM loans l JOIN programs p ON p.id = l.program_id WHERE l.status = 'OPEN' AND l.maturity_date < ? ORDER BY l.program_id, l.maturity_date`, [today]);
    const byProg = new Map<number, any[]>();
    for (const l of pastDue) byProg.set(l.program_id, [...(byProg.get(l.program_id) ?? []), l]);
    let n = 0;
    for (const [pid, loans] of byProg) {
      const p = PROGRAMS.find((x) => progIds[x.code].id === pid)!;
      const { id: sid } = db.run(
        `INSERT INTO settlement_imports (program_id, filename, file_format, sha256, settlement_date, rows_read, matched, unmatched, parse_report, uploaded_by, uploaded_at)
         VALUES (?,?,?,?,?,?,?,0,'{"skipped":[],"warnings":[]}','rabuan',?)`,
        [pid, `settle_${d(-2).slice(5).replace('-', '')}_${p.code.slice(4)}.csv`, 'csv', createHash('sha256').update('settle-recent' + pid).digest('hex'), d(-2), loans.length, loans.length, ts]);
      loans.forEach((l, i) => {
        const kind = (n + i) % 3; // 0 full, 1 short, 2 pending
        const amount = kind === 0 ? l.face_cents : kind === 1 ? Math.round(l.face_cents * 0.62 / 100) * 100 : 0;
        db.run(`INSERT INTO settlement_advices (settlement_import_id, loan_id, loan_ref_raw, amount_cents, value_date, bank_reference, match_status) VALUES (?,?,?,?,?,?, 'MATCHED')`,
          [sid, l.id, l.loan_ref, amount, d(-2), amount ? `${l.collection_account}-${String(900 + n + i)}` : null]);
      });
      n += loans.length;
    }

    // 5) Today's bank statement, uploaded by Meera - awaiting posting by another treasury user.
    const fullAdvised = db.all(`SELECT a.*, l.loan_ref, l.currency FROM settlement_advices a JOIN loans l ON l.id = a.loan_id
      WHERE l.status = 'OPEN' AND a.amount_cents = l.face_cents AND a.amount_cents > 0`);
    const short = db.get(`SELECT a.*, l.loan_ref, l.currency, l.face_cents FROM settlement_advices a JOIN loans l ON l.id = a.loan_id
      WHERE l.status = 'OPEN' AND a.amount_cents > 0 AND a.amount_cents < l.face_cents LIMIT 1`);
    const st2 = db.run('INSERT INTO bank_statements (program_id, account, filename, sha256, statement_date, uploaded_by, uploaded_at) VALUES (NULL, ?, ?, ?, ?, ?, ?)',
      ['ALL', `bank_statement_${d(-1)}.csv`, createHash('sha256').update('today-stmt').digest('hex'), d(-1), 'meera', ts]);
    for (const a of fullAdvised.slice(0, 3)) {
      db.run(`INSERT INTO bank_lines (statement_id, value_date, reference, bank_reference, amount_cents, currency, loan_id, match_status, match_note) VALUES (?,?,?,?,?,?,?, 'MATCHED', 'Matched on loan ID; full settlement')`,
        [st2.id, d(-1), `PAYMENT ${a.loan_ref}`, a.bank_reference, a.amount_cents, a.currency, a.loan_id]);
    }
    if (short) {
      db.run(`INSERT INTO bank_lines (statement_id, value_date, reference, bank_reference, amount_cents, currency, loan_id, match_status, match_note) VALUES (?,?,?,?,?,?,?, 'AMOUNT_MISMATCH', ?)`,
        [st2.id, d(-1), `PART PAYMENT ${short.loan_ref}`, short.bank_reference, short.amount_cents - 1_500_000, short.currency, short.loan_id,
          `Partial payment ${((short.amount_cents - 1_500_000) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} vs advised ${(short.amount_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} - does not match the advice`]);
    }
    db.run(`INSERT INTO bank_lines (statement_id, value_date, reference, bank_reference, amount_cents, currency, loan_id, match_status, match_note) VALUES (?,?,?,?,?,?,NULL, 'UNMATCHED', 'No loan found for this reference')`,
      [st2.id, d(-1), 'REMIT 4471 HARBORVW OPS', 'BNK-0451', 18_250_000, 'USD']);

    // 6) Pipeline: today's uploads awaiting approval (matches the Purchase & Funding prototype).
    function pendingBatch(code: string, filename: string, rows: { ob: string; num: string; invDate: number; face: number; tenor: number; investor: number | null }[]) {
      const { id: pid, p, obs } = progIds[code];
      const funding = addBusinessDays(today, 1);
      const csv = 'Invoice No,Buyer,Invoice Date,Due Date,Invoice Amount,Currency\n' +
        rows.map((r) => `${r.num},${r.ob},${d(r.invDate)},${addDays(funding, r.tenor)},${(r.face / 100).toFixed(2)},${p.ccy}`).join('\n') + '\n';
      const sha = createHash('sha256').update(csv).digest('hex');
      writeFileSync(join(svc.filesDir, 'invoices', sha), csv);
      const { id: impId } = db.run(
        `INSERT INTO invoice_imports (program_id, filename, file_format, sha256, size_bytes, storage_key, funding_date, rows_read, accepted, rejected, parse_report, status, uploaded_by, uploaded_at)
         VALUES (?,?,?,?,?,?,?,?,?,0,'{"skipped":[],"warnings":[]}','UPLOADED','rabuan',?)`,
        [pid, filename, 'csv', sha, csv.length, `invoices/${sha}`, funding, rows.length, rows.length, today + 'T09:14:00.000Z']);
      for (const r of rows) {
        const ob = obs.find((o: any) => o.name === r.ob);
        db.run(`INSERT INTO invoices (import_id, program_id, obligor_id, buyer_name, invoice_number, invoice_date, due_date, face_cents, currency, investor_id, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,'PENDING',?,?)`, [impId, pid, ob.id, ob.name, r.num, d(r.invDate), addDays(funding, r.tenor), r.face, p.ccy, r.investor, ts, ts]);
      }
      // Limit holds: obligor already over limit -> hold.
      for (const ob of obs) {
        const cur = db.get<{ s: number }>("SELECT COALESCE(SUM(purchase_cents - received_cents),0) s FROM loans WHERE obligor_id = ? AND status = 'OPEN'", [ob.id])!.s;
        if (cur > M(ob.limit)) {
          db.run("UPDATE invoices SET status = 'HELD', status_reason = ? WHERE import_id = ? AND obligor_id = ?",
            [`Limit breach: ${ob.name} already at ${Math.round(cur * 1000 / M(ob.limit)) / 10}% of limit`, impId, ob.id]);
        }
      }
      audit.record(db, userOf('rabuan'), 'invoice_import.uploaded', 'invoice_import', impId, { filename, funding_date: funding, seeded: true });
      return impId;
    }
    const tag = today.slice(5).replace('-', '');
    pendingBatch('PRG-1067', `inv_batch_${tag}_1067.csv`, [
      { ob: 'Brightline West', num: 'BW-55102', invDate: -10, face: 92_000_000, tenor: 58, investor: 3 },
      { ob: 'Brightline West', num: 'BW-55107', invDate: -8, face: 64_500_000, tenor: 63, investor: 3 },
    ]);
    pendingBatch('PRG-1041', `inv_batch_${tag}_1041.csv`, [
      { ob: 'Harborview Foods USA', num: 'INV-88231', invDate: -24, face: 125_000_000, tenor: 66, investor: 1 },
      { ob: 'Harborview Foods USA', num: 'INV-88232', invDate: -19, face: 86_000_000, tenor: 71, investor: null },
      { ob: 'Harborview Foods Canada', num: 'INV-88240', invDate: -16, face: 147_500_000, tenor: 74, investor: 1 },
      { ob: 'Harborview Retail LLC', num: 'INV-88244', invDate: -12, face: 62_000_000, tenor: 48, investor: 2 },
    ]);

    audit.record(db, admin, 'system.seeded', 'system', null, { business_date: today });
  });
}

// CLI: npm run seed / npm run reset
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seed.ts')) {
  const { createServices, ROOT } = await import('./app.ts');
  const dbPath = process.env.DB_PATH ?? join(ROOT, 'data', 'seaport.db');
  if (process.argv.includes('--reset')) {
    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) if (existsSync(f)) rmSync(f);
    rmSync(process.env.FILES_DIR ?? join(ROOT, 'data', 'files'), { recursive: true, force: true });
    console.log('Database and files deleted.');
  }
  const { launchEngine } = await import('./integrations/engine.ts');
  const { seedModules } = await import('./seed-modules.ts');
  const { client, child } = await launchEngine(Number(process.env.ENGINE_PORT ?? 8001));
  const svc = createServices({ dbPath, engine: client, filesDir: process.env.FILES_DIR ?? join(ROOT, 'data', 'files') });
  if (svc.db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n) {
    console.log('Database already has data. Use "npm run reset" to start over.');
  } else {
    seed(svc);
    await seedModules(svc);
    console.log(`Demo data loaded (business date ${svc.today()}). Start the app with "npm start".`);
  }
  svc.db.close();
  child?.kill();
}
