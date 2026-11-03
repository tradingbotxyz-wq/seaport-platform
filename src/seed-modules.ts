// Demo data for the extended modules. Each block runs only when its tables are empty, so it is
// safe on an existing database (an upgrade keeps your data and adds the new modules' demo data).

import type { Services, User } from './core/context.ts';
import { now } from './core/context.ts';
import * as uw from './modules/underwrite.ts';
import * as pools from './modules/pool.ts';
import * as fund from './modules/fund.ts';
import * as ledger from './modules/ledger.ts';
import * as service from './modules/service.ts';
import * as brokerage from './modules/brokerage.ts';
import * as approvals from './modules/approvals.ts';
import { seedFundedBatch } from './seed.ts';
import { obligorUsage } from './modules/exposure.ts';
import { addMonths, monthOf } from './modules/dashboard.ts';
import { createHash } from 'node:crypto';

const M = (millions: number) => Math.round(millions * 100_000_000);

function fin(year: number, rev: number, ebitda: number, interest: number, debt: number, ca: number, cl: number, nw: number, ds: number) {
  return {
    year, revenue_cents: M(rev), ebitda_cents: M(ebitda), interest_expense_cents: M(interest), total_debt_cents: M(debt),
    current_assets_cents: M(ca), current_liabilities_cents: M(cl), net_worth_cents: M(nw), debt_service_cents: M(ds),
  };
}

const EXTRA_USERS: [string, string, string, string][] = [
  ['sara', 'Sara Lindqvist', 'sara.lindqvist@seaportglobal.example', 'CREDIT'],
  ['olivia', 'Olivia Grant', 'olivia.grant@seaportglobal.example', 'PORTFOLIO'],
  ['kenji', 'Kenji Watanabe', 'kenji.watanabe@seaportglobal.example', 'COMPLIANCE'],
  ['lucas', 'Lucas Moreau', 'lucas.moreau@seaportglobal.example', 'TRADER'],
];

/** The built-in demo accounts (base seed + modules + investor). */
export const DEMO_USERNAMES = ['admin', 'rabuan', 'priya', 'daniel', 'meera', 'tom', 'audit', ...EXTRA_USERS.map((u) => u[0]), 'pemberton'];

function user(svc: Services, username: string): User {
  const u = svc.db.get<User>('SELECT username, name, role FROM users WHERE username = ?', [username]);
  if (!u) throw new Error(`seed user ${username} missing`);
  return u;
}

export async function seedModules(svc: Services) {
  for (const [username, name, email, role] of EXTRA_USERS) {
    svc.db.run('INSERT OR IGNORE INTO users (username, name, email, role, active, created_at) VALUES (?,?,?,?,1,?)', [username, name, email, role, now()]);
  }
  const inv1 = svc.db.get<{ id: number }>("SELECT id FROM investors WHERE code = 'INV-0001'");
  if (inv1) svc.db.run("INSERT OR IGNORE INTO users (username, name, email, role, active, investor_id, created_at) VALUES ('pemberton', 'Pemberton SF I (investor)', 'ir@pemberton.example', 'INVESTOR', 1, ?, ?)", [inv1.id, now()]);
  // Obligor domicile (used for geography grouping and country concentration limits).
  svc.db.run("UPDATE obligors SET country = 'DE' WHERE country = 'US' AND program_id IN (SELECT id FROM programs WHERE currency = 'EUR') AND name LIKE '%GmbH%'");
  svc.db.run("UPDATE obligors SET country = 'FR' WHERE country = 'US' AND name LIKE '% SA'");
  svc.db.run("UPDATE obligors SET country = 'GB' WHERE country = 'US' AND program_id IN (SELECT id FROM programs WHERE currency = 'GBP')");
  svc.db.run("UPDATE obligors SET country = 'CA' WHERE country = 'US' AND name LIKE '%Canada%'");
  await uw.ensureScorecard(svc);
  if (!svc.db.get('SELECT id FROM credit_applications LIMIT 1') && svc.db.get('SELECT id FROM programs LIMIT 1')) await seedUnderwriting(svc);
  if (!svc.db.get('SELECT id FROM pools LIMIT 1') && svc.db.get("SELECT id FROM loans WHERE status = 'OPEN' LIMIT 1")) await seedPools(svc);
  if (!svc.db.get('SELECT id FROM bank_accounts LIMIT 1') && svc.db.get('SELECT id FROM programs LIMIT 1')) await seedFund(svc);
  if (!svc.db.get('SELECT id FROM cases LIMIT 1') && svc.db.get("SELECT id FROM loans WHERE status = 'OPEN' LIMIT 1")) await seedService(svc);
  if (!svc.db.get('SELECT 1 FROM utilisation_snapshots LIMIT 1') && svc.db.get('SELECT id FROM programs LIMIT 1')) seedHistory(svc);
  if (!svc.db.get('SELECT 1 FROM collection_actions LIMIT 1') && svc.db.get("SELECT id FROM loans WHERE status = 'OPEN' LIMIT 1")) seedCollections(svc);
  if (!svc.db.get('SELECT id FROM instruments LIMIT 1') && svc.db.get('SELECT id FROM investors LIMIT 1')) await seedBrokerage(svc);
}

async function seedUnderwriting(svc: Services) {
  const sara = user(svc, 'sara');
  const daniel = user(svc, 'daniel');
  const prog = (code: string) => svc.db.get<{ id: number }>('SELECT id FROM programs WHERE program_code = ?', [code])!.id;
  const ob = (name: string) => svc.db.get<{ id: number }>('SELECT id FROM obligors WHERE name = ?', [name])?.id;
  const create = (body: any) => (uw.createApplication(svc, sara, body) as any).json.id as number;

  // 1. Limit increase for the obligor that is in breach - waiting for a credit decision.
  if (ob('Harborview Retail LLC')) {
    const id = create({
      program_id: prog('PRG-1041'), obligor_id: ob('Harborview Retail LLC'), application_type: 'INCREASE', obligor_name: 'Harborview Retail LLC',
      legal_name: 'Harborview Retail LLC', registration_no: 'DE-5521874', country: 'US', industry: 'Food retail', years_trading: 9,
      beneficial_owners: [{ name: 'Harborview Foods Inc', ownership_pct: 100 }],
      requested_limit_cents: M(14), proposed_adv_bps: 9000, proposed_margin_bps: 216, proposed_spread_bps: 84, max_tenor_days: 90,
      financials: [fin(2023, 118, 9.1, 2.1, 38, 31, 26, 41, 7.9), fin(2024, 126, 9.4, 2.3, 41, 33, 28, 43, 8.2), fin(2025, 131, 9.6, 2.4, 43, 34, 29.5, 45, 8.4)],
      rationale: 'Seasonal peak (Thanksgiving / holiday) volumes exceed the current USD 10m limit; utilisation is 104%. Parent guarantee from Harborview Foods Inc available.',
    });
    await uw.submitApplication(svc, sara, id);
  }

  // 2. New obligor, approved last month with credit memo and term sheet.
  const coastal = create({
    program_id: prog('PRG-1041'), application_type: 'NEW', obligor_name: 'Coastal Grocers Inc', obligor_role: 'Obligor',
    legal_name: 'Coastal Grocers Incorporated', registration_no: 'FL-P0931177', country: 'US', industry: 'Grocery wholesale', years_trading: 17,
    beneficial_owners: [{ name: 'Alvarez Family Trust', ownership_pct: 62 }, { name: 'Gulfstream Capital LP', ownership_pct: 38 }],
    requested_limit_cents: M(8), proposed_adv_bps: 9500, proposed_margin_bps: 150, proposed_spread_bps: 60, max_tenor_days: 120,
    financials: [fin(2023, 212, 21.5, 2.2, 31, 58, 33, 77, 9.8), fin(2024, 229, 24.1, 2.3, 30, 61, 34, 84, 10.1), fin(2025, 246, 26.3, 2.2, 29, 66, 35, 92, 10.4)],
    rationale: 'New buyer added to the Harborview SCF programme; strong cash generation and low leverage.',
  });
  await uw.submitApplication(svc, sara, coastal);
  await uw.decide(svc, daniel, coastal, {
    decision: 'APPROVE', approved_limit_cents: M(8), reason: 'Strong DSCR and low leverage; within delegated authority. Approved as requested.',
    conditions: 'Signed buyer acknowledgement of assignment\nQuarterly management accounts within 45 days of quarter end', review_months: 12,
  });

  // 3. Sanctions knock-out, declined.
  const sanctioned = create({
    program_id: prog('PRG-1052'), application_type: 'NEW', obligor_name: 'Sanctioned Holdings Ltd', legal_name: 'Sanctioned Holdings Ltd', registration_no: 'CY-HE441902',
    country: 'CY', industry: 'Metals trading', years_trading: 4, beneficial_owners: [{ name: 'Undisclosed nominee', ownership_pct: 100 }],
    requested_limit_cents: M(5), proposed_adv_bps: 9000, proposed_margin_bps: 200, proposed_spread_bps: 80,
    financials: [fin(2024, 40, 3.1, 0.9, 11, 9, 7, 6, 2.6), fin(2025, 44, 3.3, 1.0, 12, 10, 8, 6.5, 2.9)],
  });
  await uw.submitApplication(svc, sara, sanctioned);
  await uw.decide(svc, daniel, sanctioned, { decision: 'DECLINE', reason: 'Sanctions screening match on the legal entity. Declined; referred to Compliance.' });

  // 4. Renewal in review (clean engine approve, awaiting decision).
  if (ob('Thames Clinics plc')) {
    const id = create({
      program_id: prog('PRG-1088'), obligor_id: ob('Thames Clinics plc'), application_type: 'RENEWAL', obligor_name: 'Thames Clinics plc',
      legal_name: 'Thames Clinics plc', registration_no: 'GB-08812345', country: 'GB', industry: 'Private healthcare', years_trading: 22,
      beneficial_owners: [{ name: 'Listed - LSE (free float)', ownership_pct: 100 }],
      requested_limit_cents: M(12), proposed_adv_bps: 9500, proposed_margin_bps: 150, proposed_spread_bps: 60, max_tenor_days: 120,
      collateral_type: 'Credit insurance (Atradius)', collateral_value_cents: M(18),
      financials: [fin(2024, 310, 44, 5.2, 96, 88, 51, 140, 21), fin(2025, 334, 49, 5.4, 95, 93, 52, 151, 22)],
      rationale: 'Annual renewal; insured receivables, stable payer behaviour.',
    });
    await uw.submitApplication(svc, sara, id);
    await uw.decide(svc, daniel, id, { decision: 'APPROVE', reason: 'Renewal approved as requested; credit insurance in place.', conditions: 'Credit insurance policy to remain in force', review_months: 12 });
  }

  // 5. Draft being prepared.
  create({
    program_id: prog('PRG-1088'), application_type: 'NEW', obligor_name: 'Meridian Pharma Ltd', legal_name: 'Meridian Pharma Limited', registration_no: 'GB-11920384',
    country: 'GB', industry: 'Pharmaceutical distribution', years_trading: 6, beneficial_owners: [{ name: 'Meridian Holdings Ltd', ownership_pct: 100 }],
    requested_limit_cents: M(6), proposed_adv_bps: 9000, proposed_margin_bps: 180, proposed_spread_bps: 70,
    financials: [fin(2025, 72, 6.8, 1.1, 14, 21, 15, 19, 4.4)],
  });
}

async function seedPools(svc: Services) {
  const olivia = user(svc, 'olivia');
  const daniel = user(svc, 'daniel');
  const a = (pools.createPool(svc, olivia, {
    name: 'SCF Receivables Pool 2026-A', currency: 'USD', target_size_cents: M(90),
    strategy: 'Short-dated USD supply-chain and receivables-purchase assets; senior notes placed with institutional investors.',
    criteria: { programs: [], min_rating: 'B+', min_remaining_days: 5, max_remaining_days: 180 },
    limits: { max_obligor_bps: 2500, max_program_bps: 6000, max_sub_ig_bps: 6000 },
    tranches: [{ name: 'SENIOR', pct_bps: 8000, coupon_bps: 520 }, { name: 'MEZZANINE', pct_bps: 1200, coupon_bps: 780 }, { name: 'EQUITY', pct_bps: 800, coupon_bps: 0 }],
  }) as any).json.id;
  await pools.autoBuild(svc, olivia, a, true);
  try { await pools.activate(svc, daniel, a); } catch (e) { console.warn('[seed] pool activation skipped:', (e as Error).message); }

  const b = (pools.createPool(svc, olivia, {
    name: 'UK Insured Receivables Pool 2026-1', currency: 'GBP', target_size_cents: M(20),
    strategy: 'Credit-insured UK healthcare receivables.',
    criteria: { programs: ['PRG-1088'], min_rating: 'BB+', min_remaining_days: 10 },
    limits: { max_obligor_bps: 8000, max_sub_ig_bps: 8000 },
    tranches: [{ name: 'SENIOR', pct_bps: 8500, coupon_bps: 480 }, { name: 'EQUITY', pct_bps: 1500, coupon_bps: 0 }],
  }) as any).json.id;
  await pools.autoBuild(svc, olivia, b, true);
  await pools.stressTest(svc, olivia, a, {});
}

async function seedFund(svc: Services) {
  const meera = user(svc, 'meera');
  const tom = user(svc, 'tom');
  const olivia = user(svc, 'olivia');
  const rabuan = user(svc, 'rabuan');
  if (!svc.db.get("SELECT id FROM investors WHERE code = 'INV-0004'")) svc.db.run("INSERT INTO investors (code, name) VALUES ('INV-0004', 'Seaport Global (risk retention)')");
  const inv = (code: string) => svc.db.get<{ id: number }>('SELECT id FROM investors WHERE code = ?', [code])!.id;
  const prog = (code: string) => svc.db.get<{ id: number }>('SELECT id FROM programs WHERE program_code = ?', [code])?.id;
  const kenji = user(svc, 'kenji');
  const acct = (b: any) => {
    const r = fund.saveBankAccount(svc, rabuan, null, b) as any;
    approvals.decideChange(svc, kenji, r.json.change_request.id, { decision: 'APPROVE', note: 'Verified by call-back to the account holder' });
  };
  acct({ owner_type: 'SEAPORT', account_name: 'Seaport Global LLP - USD operating', bank_name: 'JPMorgan Chase Bank', routing_number: '021000021', account_number: '000123456789', currency: 'USD', country: 'US' });
  acct({ owner_type: 'SEAPORT', account_name: 'Seaport Global LLP - EUR operating', bank_name: 'Deutsche Bank AG', bic: 'DEUTDEFF', iban: 'DE89370400440532013000', currency: 'EUR', country: 'DE' });
  acct({ owner_type: 'SEAPORT', account_name: 'Seaport Global LLP - GBP operating', bank_name: 'Barclays Bank plc', bic: 'BARCGB22', iban: 'GB33BUKB20201555555555', currency: 'GBP', country: 'GB' });
  const sellers: [string, any][] = [
    ['PRG-1041', { account_name: 'Harborview Foods Inc', bank_name: 'Bank of America', routing_number: '026009593', account_number: '4400118822', currency: 'USD', country: 'US' }],
    ['PRG-1052', { account_name: 'Atlas Steelworks Ltd', bank_name: 'Wells Fargo Bank', routing_number: '121000248', account_number: '7781203344', currency: 'USD', country: 'US' }],
    ['PRG-1067', { account_name: 'Brightline Distributors', bank_name: 'Citibank NA', routing_number: '011000138', account_number: '3209981100', currency: 'USD', country: 'US' }],
    ['PRG-1073', { account_name: 'Kestrel Exports GmbH', bank_name: 'Commerzbank AG', bic: 'COBADEFFXXX', iban: 'DE44500105175407324931', currency: 'EUR', country: 'DE' }],
    ['PRG-1088', { account_name: 'Vantage Health Group', bank_name: 'NatWest', bic: 'NWBKGB2L', iban: 'GB29NWBK60161331926819', currency: 'GBP', country: 'GB' }],
  ];
  for (const [code, b] of sellers) if (prog(code)) acct({ owner_type: 'PROGRAM', owner_id: prog(code), ...b });
  acct({ owner_type: 'INVESTOR', owner_id: inv('INV-0001'), account_name: 'Pemberton SF I LP', bank_name: 'State Street Bank', routing_number: '011000028', account_number: '5501239981', currency: 'USD', country: 'US' });
  acct({ owner_type: 'INVESTOR', owner_id: inv('INV-0002'), account_name: 'Cascade Credit Fund', bank_name: 'BNY Mellon', routing_number: '021000018', account_number: '8890012345', currency: 'USD', country: 'US' });
  acct({ owner_type: 'INVESTOR', owner_id: inv('INV-0003'), account_name: 'Northgate Trade Fund', bank_name: 'US Bank', routing_number: '091000022', account_number: '1022334455', currency: 'USD', country: 'US' });
  acct({ owner_type: 'INVESTOR', owner_id: inv('INV-0004'), account_name: 'Seaport Global LLP - retention', bank_name: 'JPMorgan Chase Bank', routing_number: '021000021', account_number: '000987654321', currency: 'USD', country: 'US' });

  const pool = svc.db.get<{ id: number; ref: string }>("SELECT id, ref FROM pools WHERE status = 'ACTIVE' AND currency = 'USD' ORDER BY id LIMIT 1");
  if (pool) {
    const d = svc.today();
    const signed = new Date(Date.parse(d) - 40 * 864e5).toISOString().slice(0, 10);
    for (const [code, tranche, m] of [['INV-0001', 'SENIOR', 18], ['INV-0002', 'SENIOR', 10], ['INV-0003', 'MEZZANINE', 4.5], ['INV-0004', 'EQUITY', 3]] as const) {
      fund.createCommitment(svc, olivia, { investor_id: inv(code), pool_id: pool.id, tranche, amount_cents: M(m), signed_at: signed });
    }
    const p = await pools.getPool(svc, pool.id);
    const size = (t: string) => p.tranches.find((x: any) => x.name === t)?.size_cents ?? 0;
    const due = new Date(Date.parse(d) + 5 * 864e5).toISOString().slice(0, 10);
    for (const t of ['SENIOR', 'EQUITY', 'MEZZANINE']) {
      const c = (fund.createCall(svc, olivia, { pool_id: pool.id, tranche: t, amount_cents: size(t), purpose: `Initial funding of ${t.toLowerCase()} notes`, due_date: due }) as any).json;
      await fund.issueCall(svc, tom, c.id);
      const call = fund.getCall(svc, c.id);
      for (const l of call.lines) {
        const amt = t === 'MEZZANINE' ? Math.round(l.amount_cents * 0.6) : l.amount_cents;
        fund.recordReceipt(svc, meera, c.id, { line_id: l.id, amount_cents: amt, received_at: d });
      }
    }
    // Warehouse facility funds the rest of the book (keeps cash positive in every currency).
    for (const ccy of ['USD', 'EUR', 'GBP']) {
      const cash = svc.db.get<{ b: number }>(`SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) b FROM ledger_lines l JOIN journal_entries je ON je.id = l.entry_id WHERE l.account_code = '1000' AND je.currency = ?`, [ccy])!.b;
      const book = svc.db.get<{ s: number }>("SELECT COALESCE(SUM(purchase_cents), 0) s FROM loans WHERE status = 'OPEN' AND currency = ?", [ccy])!.s;
      const draw = Math.max(0, Math.round(book * 0.08) - cash);
      if (draw > 0) svc.db.tx(() => ledger.post(svc.db, meera, {
        date: d, description: `Warehouse facility drawdown (${ccy})`, source_type: 'FACILITY', currency: ccy,
        lines: [{ account: '1000', debit: draw }, { account: '2700', credit: draw }],
      }));
    }
    // Income distribution to senior noteholders: approved, payments queued for disbursement.
    const dist = (fund.createDistribution(svc, olivia, { pool_id: pool.id, tranche: 'SENIOR', kind: 'INCOME', amount_cents: M(0.05), payment_date: due }) as any).json;
    fund.approveDistribution(svc, tom, dist.id);
    fund.createDistribution(svc, olivia, { pool_id: pool.id, tranche: 'EQUITY', kind: 'INCOME', amount_cents: M(0.02), payment_date: due });
  }
}

async function seedService(svc: Services) {
  const rabuan = user(svc, 'rabuan');
  const olivia = user(svc, 'olivia');
  const today = svc.today();
  // A past-due loan with a payment-date promise -> extension request awaiting checker approval.
  const pd = svc.db.get<any>("SELECT l.id, l.loan_ref, l.maturity_date, o.name FROM loans l JOIN obligors o ON o.id = l.obligor_id WHERE l.status = 'OPEN' AND l.maturity_date < ? ORDER BY l.maturity_date DESC LIMIT 1", [today]);
  if (pd) {
    const c = (service.createCase(svc, rabuan, { case_type: 'MATURITY_EXTENSION', priority: 'HIGH', subject: `${pd.name} requests 30-day extension on ${pd.loan_ref}`,
      description: 'Buyer confirmed a receiving dispute on part of the shipment; payment promised within 30 days of the original maturity.', entity_type: 'loan', entity_id: pd.id, assignee: 'rabuan' }) as any).json;
    service.updateCase(svc, rabuan, c.id, { comment: 'Called AP at buyer: dispute resolved, payment run scheduled. Proposing 30-day extension with fee.' });
    const newDate = new Date(Date.parse(pd.maturity_date) + 30 * 864e5).toISOString().slice(0, 10);
    await service.proposeAmendment(svc, rabuan, c.id, { amendment_type: 'LOAN_EXTENSION', payload: { loan_id: pd.id, new_maturity_date: newDate } });
  }
  const cm = svc.db.get<any>("SELECT id FROM commitments WHERE tranche = 'SENIOR' ORDER BY amount_cents DESC LIMIT 1");
  if (cm) service.createCase(svc, olivia, { case_type: 'INVESTOR_REQUEST', priority: 'MEDIUM', subject: 'Pemberton SF I asks for Q4 capital account statement and K-1 timing',
    entity_type: 'commitment', entity_id: cm.id, assignee: 'olivia' });
  service.createCase(svc, rabuan, { case_type: 'PAYMENT_QUERY', priority: 'LOW', subject: 'Atlas Steelworks West remittance missing loan references', description: 'Ask the buyer to quote loan IDs on remittances to improve auto-matching.' });
  await service.sweep(svc);
}

async function seedBrokerage(svc: Services) {
  const lucas = user(svc, 'lucas');
  const kenji = user(svc, 'kenji');
  const priya = user(svc, 'priya');
  const today = svc.today();
  const y = Number(today.slice(0, 4));
  const ins = (isin: string, name: string, type: string, ccy: string, issuer: string, coupon: number, mat: string, spread: number, sd: number) =>
    svc.db.run('INSERT INTO instruments (isin, name, type, currency, issuer, coupon_bps, maturity_date, spread_bps, settlement_days) VALUES (?,?,?,?,?,?,?,?,?)', [isin, name, type, ccy, issuer, coupon, mat, spread, sd]);
  const d = (days: number) => new Date(Date.parse(today) + days * 864e5).toISOString().slice(0, 10);
  ins('US912797MT10', 'US Treasury Bill 13-week', 'TBILL', 'USD', 'US Treasury', 0, d(91), 0, 1);
  ins('US912797NK45', 'US Treasury Bill 26-week', 'TBILL', 'USD', 'US Treasury', 0, d(182), 0, 1);
  ins('US43851CP093', 'Harborview Foods CP 90-day', 'CP', 'USD', 'Harborview Foods Inc', 0, d(90), 35, 1);
  ins('US04621XAB12', 'Atlas Steelworks 5.25% Senior Notes', 'BOND', 'USD', 'Atlas Steelworks Ltd', 525, `${y + 3}-06-15`, 140, 1);
  ins('XS2671234567', 'SCF Receivables 2026-A Class A (floating)', 'POOL_NOTE', 'USD', 'Seaport SCF Receivables 2026-A', 520, `${y + 1}-12-15`, 20, 2);
  ins('DE000A3E5MZ9', 'Kestrel Exports 3.75% Notes', 'BOND', 'EUR', 'Kestrel Exports GmbH', 375, `${y + 4}-03-01`, 110, 2);
  ins('GB00BMV7TC88', 'UK Gilt 4.25% 2030', 'BOND', 'GBP', 'UK Debt Management Office', 425, '2030-12-07', -30, 1);
  const restricted = svc.db.get<{ id: number }>("SELECT id FROM instruments WHERE isin = 'US43851CP093'")!.id;
  brokerage.setRestricted(svc, kenji, restricted, { restricted: true, reason: 'Seaport holds non-public information as funder of the issuer (Harborview SCF programme)' });

  const b1 = (await brokerage.onboardBroker(svc, lucas, { name: 'Meridian Capital Introductions LLP', kind: 'INTRODUCER', lei: '5493001KJTIIGC8Y1R12', country: 'GB', regulator: 'FCA', agreement_date: d(-200), rebate_bps_of_commission: 2000 }) as any).json;
  brokerage.decideBroker(svc, kenji, b1.id, { status: 'APPROVED' });
  const b2 = (await brokerage.onboardBroker(svc, lucas, { name: 'Northshore Securities Inc', kind: 'BROKER', lei: '549300TRUWO2CD2G5692', country: 'US', regulator: 'FINRA', agreement_date: d(-90) }) as any).json;
  brokerage.decideBroker(svc, kenji, b2.id, { status: 'APPROVED' });
  await brokerage.onboardBroker(svc, lucas, { name: 'Harbour Lane Advisory', kind: 'INTRODUCER', country: 'SG', regulator: 'MAS', rebate_bps_of_commission: 1500 });

  const inv = (code: string) => svc.db.get<{ id: number }>('SELECT id FROM investors WHERE code = ?', [code])!.id;
  const inst = (isin: string) => svc.db.get<{ id: number }>('SELECT id FROM instruments WHERE isin = ?', [isin])!.id;
  await brokerage.placeOrder(svc, lucas, { investor_id: inv('INV-0002'), instrument_id: inst('US912797MT10'), side: 'BUY', quantity: 15_000_000, order_type: 'MARKET', introducer_id: b1.id });
  await brokerage.placeOrder(svc, lucas, { investor_id: inv('INV-0001'), instrument_id: inst('XS2671234567'), side: 'BUY', quantity: 4_000_000, order_type: 'MARKET' });
  await brokerage.placeOrder(svc, lucas, { investor_id: inv('INV-0003'), instrument_id: inst('US04621XAB12'), side: 'BUY', quantity: 30_000_000, order_type: 'MARKET', introducer_id: b1.id });
  await brokerage.placeOrder(svc, lucas, { investor_id: inv('INV-0003'), instrument_id: inst('US43851CP093'), side: 'BUY', quantity: 2_000_000, order_type: 'MARKET' }); // rejected: restricted
  const first = svc.db.get<{ id: number }>("SELECT id FROM trades ORDER BY id LIMIT 1");
  if (first) { svc.db.run('UPDATE trades SET settlement_date = ? WHERE id = ?', [today, first.id]); brokerage.settleTrade(svc, priya, first.id); }
}

/** Three years of month-end utilisation per program, as migrated from the legacy system at go-live. */
function seedHistory(svc: Services) {
  const thisMonth = monthOf(svc.today());
  const usage = obligorUsage(svc.db);
  const programs = svc.db.all<any>('SELECT id, program_code, currency FROM programs');
  const noise = (...k: unknown[]) => (createHash('sha256').update(k.join('|')).digest().readUInt32BE(0) / 2 ** 32) - 0.5;
  const ts = new Date().toISOString();
  svc.db.tx(() => {
    for (const p of programs) {
      const obs = usage.filter((o) => o.program_id === p.id);
      const limit = obs.reduce((a, o) => a + o.limit_cents, 0);
      if (!limit) continue;
      const end = Math.max(0.2, obs.reduce((a, o) => a + o.funded_cents, 0) / limit - 0.04);
      const start = 0.36 + noise(p.program_code, 'start') * 0.1;
      for (let k = 0; k < 36; k++) {
        const t = k / 35;
        const v = start + (end - start) * Math.pow(t, 1.4) + Math.sin(k / 2.3 + p.id) * 0.02 + noise(p.program_code, k) * 0.035;
        svc.db.run("INSERT INTO utilisation_snapshots (month, program_id, currency, limit_cents, used_cents, source, created_at) VALUES (?,?,?,?,?, 'MIGRATED', ?)",
          [addMonths(thisMonth, k - 36), p.id, p.currency, limit, Math.round(limit * Math.min(1.05, Math.max(0.05, v))), ts]);
      }
    }
  });
}

/** Aged delinquencies across the buckets plus the collection log behind "last action". */
function seedCollections(svc: Services) {
  const today = svc.today();
  const d = (n: number) => new Date(Date.parse(today) + n * 864e5).toISOString().slice(0, 10);
  const ob = (name: string) => svc.db.get<{ id: number }>('SELECT id FROM obligors WHERE name = ?', [name]);
  const aged: [string, string, number, number, [string, number][]][] = [
    ['PRG-1067', 'Brightline West', 360_000_00, 104, [['Reminder sent', 3], ['Escalated to credit', 35], ['Formal demand issued', 62], ['With legal', 90]]],
    ['PRG-1088', 'Thames Clinics plc', 420_000_00, 71, [['Reminder sent', 2], ['Escalated to credit', 33], ['Insurance claim initiated', 64]]],
    ['PRG-1052', 'Atlas Steelworks West', 780_000_00, 44, [['Auto-debit returned (R01)', 1], ['Reminder sent', 5], ['Escalated to credit', 38]]],
    ['PRG-1073', 'Lyon Agro SA', 650_000_00, 18, [['Reminder sent', 2], ['Dispute raised by buyer', 12]]],
  ];
  for (const [code, name, face, dpd, actions] of aged) {
    const o = ob(name);
    if (!o) continue;
    const [loanId] = seedFundedBatch(svc, code, d(-dpd - 75), [{ ob: o, face, due: d(-dpd), investor: 1 }], `aged${dpd}`);
    for (const [action, after] of actions) {
      const label = action === 'Reminder sent' ? `Reminder sent ${new Date(d(-dpd + after)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}` : action;
      svc.db.run('INSERT INTO collection_actions (loan_id, action, note, actor, at) VALUES (?,?,?,?,?)', [loanId, label, null, 'rabuan', `${d(-dpd + after)}T10:00:00.000Z`]);
    }
  }
  // Existing past-due loans: first-line collection activity.
  for (const l of svc.db.all<any>(`SELECT l.id, l.maturity_date, o.auto_debit FROM loans l JOIN obligors o ON o.id = l.obligor_id
      WHERE l.status = 'OPEN' AND l.maturity_date < ? AND NOT EXISTS (SELECT 1 FROM collection_actions c WHERE c.loan_id = l.id)`, [today])) {
    const at = new Date(Date.parse(l.maturity_date) + 864e5).toISOString().slice(0, 10);
    const action = l.auto_debit ? 'Auto-debit returned (R01)' : `Reminder sent ${new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
    svc.db.run('INSERT INTO collection_actions (loan_id, action, note, actor, at) VALUES (?,?,?,?,?)', [l.id, action, null, 'rabuan', `${at}T10:00:00.000Z`]);
  }
}
