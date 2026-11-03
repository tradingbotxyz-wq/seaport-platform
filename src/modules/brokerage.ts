// BROKERAGE: broker / introducer onboarding, securities master and restricted list, market data,
// order management with pre-trade compliance, best-execution routing, trade capture, confirmations,
// settlement and commissions / rebates.
//
// Ledger (agency model - Seaport earns commission; client cash moves at the custodian):
//   Trade booked     Dr 1310 Commission receivable / Cr 4300 Commission income
//                    Dr 5100 Introducer rebates   / Cr 2800 Rebates payable      (if introduced)
//   Trade settled    Dr 1000 Cash / Cr 1310

import type { Services, User } from '../core/context.ts';
import { requirePermission, now, nextRef, addBusinessDays } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { emit } from '../core/outbox.ts';
import { check } from '../lib/validate.ts';
import { badRequest, conflict, forbidden, notFound, validation } from '../lib/errors.ts';
import * as ledger from './ledger.ts';
import { generatePdf } from './documents.ts';
import { fxToUsd } from './exposure.ts';

const MAX_ORDER_USD_CENTS = 50_000_000_00; // single-order limit per client (pre-trade check)
const FAT_FINGER_BPS = 300;                 // limit price more than 3% away from market is rejected

const px = (p: number) => (p / 10000).toFixed(4);

// ---------- Brokers & introducers ----------

export function listBrokers(svc: Services) {
  return svc.db.all(`SELECT b.*,
      (SELECT COUNT(*) FROM orders o WHERE o.introducer_id = b.id) AS orders,
      (SELECT COALESCE(SUM(t.commission_cents), 0) FROM trades t JOIN orders o ON o.id = t.order_id WHERE o.introducer_id = b.id AND t.status <> 'CANCELLED') AS commission_cents,
      (SELECT COALESCE(SUM(t.rebate_cents), 0) FROM trades t JOIN orders o ON o.id = t.order_id WHERE o.introducer_id = b.id AND t.status <> 'CANCELLED') AS rebate_cents
    FROM brokers b ORDER BY b.status, b.name`);
}

export async function onboardBroker(svc: Services, user: User, body: unknown) {
  requirePermission(user, 'brokerage.onboard');
  const input = check<any>(body, {
    name: { type: 'string', required: true, maxLength: 120 },
    kind: { type: 'enum', required: true, values: ['BROKER', 'INTRODUCER'] },
    lei: { type: 'string', pattern: /^[A-Z0-9]{18}\d{2}$/ },
    country: { type: 'string', required: true, pattern: /^[A-Z]{2}$/ },
    regulator: { type: 'string', maxLength: 80 },
    agreement_date: { type: 'date' },
    rebate_bps_of_commission: { type: 'int', min: 0, max: 5000 },
    notes: { type: 'string', maxLength: 1000 },
  });
  const screening = await svc.kyc.screen({ legal_name: input.name, country: input.country, owners: [] });
  return svc.db.tx(() => {
    const code = nextRef(svc.db, input.kind === 'BROKER' ? 'BRK' : 'INT', 4);
    const r = svc.db.run(`INSERT INTO brokers (code, name, kind, lei, country, regulator, agreement_date, rebate_bps_of_commission, status, kyc_reference, created_by, created_at, notes)
      VALUES (?,?,?,?,?,?,?,?, 'PENDING', ?, ?, ?, ?)`,
      [code, input.name, input.kind, input.lei ?? null, input.country, input.regulator ?? null, input.agreement_date ?? null, input.rebate_bps_of_commission ?? 0,
        `${screening.reference}${screening.sanctions_hit ? ' (SANCTIONS MATCH)' : ''}`, user.username, now(), input.notes ?? null]);
    audit.record(svc.db, user, 'broker.onboarded', 'broker', r.id, { code, name: input.name, kind: input.kind, screening: { sanctions: screening.sanctions_hit, pep: screening.pep_hit } });
    return { status: 201, json: { id: r.id, code, screening } };
  });
}

export function decideBroker(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'brokerage.approve');
  const b = svc.db.get('SELECT * FROM brokers WHERE id = ?', [id]);
  if (!b) throw notFound('Broker');
  const status = body?.status;
  if (!['APPROVED', 'REJECTED', 'SUSPENDED'].includes(status)) throw validation({ status: 'APPROVED, REJECTED or SUSPENDED' });
  if (b.created_by === user.username) throw forbidden('SoD-12: the person who onboarded a broker cannot approve it');
  if (status === 'APPROVED' && String(b.kyc_reference).includes('SANCTIONS')) throw forbidden('Sanctions match - cannot approve');
  return svc.db.tx(() => {
    svc.db.run('UPDATE brokers SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?', [status, user.username, now(), id]);
    audit.record(svc.db, user, `broker.${status.toLowerCase()}`, 'broker', id, { code: b.code, note: body?.note ?? null });
    return { ok: true };
  });
}

// ---------- Instruments & market data ----------

export function listInstruments(svc: Services) {
  return svc.db.all('SELECT * FROM instruments WHERE active = 1 ORDER BY type, maturity_date');
}

function instrument(svc: Services, id: number) {
  const i = svc.db.get('SELECT * FROM instruments WHERE id = ?', [id]);
  if (!i) throw notFound('Instrument');
  return i;
}

export async function market(svc: Services) {
  const instruments = listInstruments(svc);
  const r = await svc.engine.call('/brokerage/market', { instruments, ts: now() });
  const byIsin = new Map(r.instruments.map((x: any) => [x.isin, x]));
  return { ts: r.ts, venues: r.venues, instruments: instruments.map((i) => ({ ...i, ...(byIsin.get(i.isin) as any) })) };
}

export function setRestricted(svc: Services, user: User, id: number, body: any) {
  requirePermission(user, 'brokerage.approve');
  const restricted = !!body?.restricted;
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (restricted && !reason) throw validation({ reason: 'give a reason (e.g. inside information, conflict)' });
  instrument(svc, id);
  return svc.db.tx(() => {
    svc.db.run('UPDATE instruments SET restricted = ?, restricted_reason = ? WHERE id = ?', [restricted ? 1 : 0, restricted ? reason : null, id]);
    audit.record(svc.db, user, restricted ? 'instrument.restricted' : 'instrument.unrestricted', 'instrument', id, { reason });
    return { ok: true };
  });
}

// ---------- Orders ----------

export function listOrders(svc: Services) {
  return svc.db.all(`SELECT o.*, i.isin, i.name AS instrument, i.currency, inv.code AS investor_code, inv.name AS investor_name, b.code AS introducer_code
    FROM orders o JOIN instruments i ON i.id = o.instrument_id JOIN investors inv ON inv.id = o.investor_id LEFT JOIN brokers b ON b.id = o.introducer_id ORDER BY o.id DESC LIMIT 300`)
    .map((o) => ({ ...o, checks: JSON.parse(o.checks), best_ex: o.best_ex ? JSON.parse(o.best_ex) : null }));
}

export async function placeOrder(svc: Services, user: User, body: unknown) {
  requirePermission(user, 'brokerage.trade');
  const input = check<any>(body, {
    investor_id: { type: 'int', required: true, min: 1 },
    instrument_id: { type: 'int', required: true, min: 1 },
    introducer_id: { type: 'int', min: 1 },
    side: { type: 'enum', required: true, values: ['BUY', 'SELL'] },
    quantity: { type: 'int', required: true, min: 1000, max: 1_000_000_000 },
    order_type: { type: 'enum', required: true, values: ['MARKET', 'LIMIT'] },
    limit_price: { type: 'int', min: 1, max: 2_000_000 },
    time_in_force: { type: 'enum', values: ['DAY', 'GTC'] },
  });
  if (input.order_type === 'LIMIT' && !input.limit_price) throw validation({ limit_price: 'required for a limit order' });
  const inst = instrument(svc, input.instrument_id);
  const inv = svc.db.get('SELECT * FROM investors WHERE id = ?', [input.investor_id]);
  if (!inv) throw badRequest('Unknown client');
  const intro = input.introducer_id ? svc.db.get('SELECT * FROM brokers WHERE id = ?', [input.introducer_id]) : null;
  const ts = now();
  const mkt = await svc.engine.call('/brokerage/market', { instruments: [inst], ts });
  const m = mkt.instruments[0];
  const ref_px = input.side === 'BUY' ? m.best_ask : m.best_bid;
  const estUsd = fxToUsd(svc.db)(Math.round((input.quantity * 100 * ref_px) / 1_000_000), inst.currency);

  // Pre-trade compliance checks (each recorded with the order).
  const checks: { check: string; ok: boolean; detail: string }[] = [
    { check: 'Client active (KYC)', ok: !!inv.active, detail: inv.active ? 'Client is active' : 'Client is inactive' },
    { check: 'Restricted list', ok: !inst.restricted, detail: inst.restricted ? `Restricted: ${inst.restricted_reason}` : 'Not restricted' },
    { check: 'Instrument not matured', ok: inst.maturity_date > svc.today(), detail: `Matures ${inst.maturity_date}` },
    { check: 'Order size limit', ok: estUsd <= MAX_ORDER_USD_CENTS, detail: `Est. USD ${(estUsd / 100).toLocaleString('en-US')} vs limit ${(MAX_ORDER_USD_CENTS / 100).toLocaleString('en-US')}` },
    { check: 'Introducer approved', ok: !intro || intro.status === 'APPROVED', detail: intro ? `${intro.code} is ${intro.status}` : 'No introducer' },
  ];
  if (input.order_type === 'LIMIT') {
    const away = Math.abs(input.limit_price - ref_px) * 10000 / ref_px;
    checks.push({ check: 'Price reasonableness (fat finger)', ok: away <= FAT_FINGER_BPS, detail: `Limit ${px(input.limit_price)} vs market ${px(ref_px)} (${(away / 100).toFixed(2)}% away, max ${FAT_FINGER_BPS / 100}%)` });
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    return svc.db.tx(() => {
      const ref = nextRef(svc.db, 'ORD', 6);
      const r = svc.db.run(`INSERT INTO orders (ref, investor_id, instrument_id, introducer_id, side, quantity, order_type, limit_price, time_in_force, status, checks, reject_reason, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?, 'REJECTED', ?, ?, ?, ?, ?)`, [ref, inv.id, inst.id, intro?.id ?? null, input.side, input.quantity, input.order_type, input.limit_price ?? null, input.time_in_force ?? 'DAY',
        JSON.stringify(checks), failed.map((f) => f.check).join('; '), user.username, ts, ts]);
      audit.record(svc.db, user, 'order.rejected', 'order', r.id, { ref, failed: failed.map((f) => f.detail) });
      return { status: 201, json: { id: r.id, ref, status: 'REJECTED', checks } };
    });
  }

  // Route for best execution, then compute economics per fill.
  const routed = await svc.engine.call('/brokerage/route', { instrument: inst, side: input.side, quantity: input.quantity, limit_price: input.order_type === 'LIMIT' ? input.limit_price : null, ts });
  const tradeDate = svc.today();
  const settle = addBusinessDays(tradeDate, inst.settlement_days);
  const econ = [];
  for (const f of routed.fills) {
    econ.push(await svc.engine.call('/brokerage/economics', { instrument: inst, side: input.side, quantity: f.quantity, price: f.price, settlement_date: settle, fee_bps: f.fee_bps, rebate_bps_of_commission: intro?.rebate_bps_of_commission ?? 0 }));
  }
  const result = svc.db.tx(() => {
    const ref = nextRef(svc.db, 'ORD', 6);
    const filled = routed.fills.reduce((a: number, f: any) => a + f.quantity, 0);
    const o = svc.db.run(`INSERT INTO orders (ref, investor_id, instrument_id, introducer_id, side, quantity, order_type, limit_price, time_in_force, status, filled_quantity, checks, best_ex, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [ref, inv.id, inst.id, intro?.id ?? null, input.side, input.quantity, input.order_type, input.limit_price ?? null, input.time_in_force ?? 'DAY',
      routed.status, filled, JSON.stringify(checks), JSON.stringify({ rationale: routed.rationale, quotes: routed.quotes }), user.username, ts, ts]);
    const trades: string[] = [];
    routed.fills.forEach((f: any, i: number) => {
      const e = econ[i];
      const tref = nextRef(svc.db, 'TRD', 6);
      const t = svc.db.run(`INSERT INTO trades (ref, order_id, venue, side, quantity, price, currency, trade_date, settlement_date, principal_cents, accrued_cents, commission_cents, commission_bps, venue_fee_cents, rebate_cents, net_cents, status, executed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'CONFIRMED', ?)`, [tref, o.id, f.venue, input.side, f.quantity, f.price, inst.currency, tradeDate, settle, e.principal_cents, e.accrued_cents, e.commission_cents,
        e.commission_bps, e.venue_fee_cents, e.rebate_cents, e.net_cents, ts]);
      const lines: any[] = [{ account: '1310', debit: e.commission_cents, investor_id: inv.id }, { account: '4300', credit: e.commission_cents, investor_id: inv.id }];
      if (e.rebate_cents > 0) lines.push({ account: '5100', debit: e.rebate_cents }, { account: '2800', credit: e.rebate_cents });
      ledger.post(svc.db, user, { date: tradeDate, description: `Commission ${tref} ${input.side} ${inst.isin} @ ${px(f.price)} (${f.venue})`, source_type: 'TRADE', source_id: t.id, currency: inst.currency, lines });
      trades.push(tref);
    });
    audit.record(svc.db, user, 'order.executed', 'order', o.id, { ref, status: routed.status, trades, best_ex: routed.rationale });
    emit(svc.db, 'order.executed', 'order', o.id, { ref, status: routed.status });
    return { id: o.id, ref, status: routed.status, trades, best_ex: routed.rationale, checks };
  });
  // Trade confirmations (PDF) for the client.
  for (const tref of result.trades) await confirmation(svc, user, tref);
  return { status: 201, json: result };
}

async function confirmation(svc: Services, user: User, tref: string) {
  const t = svc.db.get(`SELECT t.*, o.ref AS order_ref, o.investor_id, i.isin, i.name AS instrument, i.type, inv.code, inv.name AS investor_name
    FROM trades t JOIN orders o ON o.id = t.order_id JOIN instruments i ON i.id = o.instrument_id JOIN investors inv ON inv.id = o.investor_id WHERE t.ref = ?`, [tref]);
  const f = (c: number) => `${t.currency} ${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const id = await generatePdf(svc, user, 'investor', t.investor_id, 'TRADE_CONFIRMATION', `${tref}_confirmation.pdf`, {
    title: `Trade confirmation ${tref}`, subtitle: `${t.investor_name} (${t.code}) · order ${t.order_ref}`, footer: `${tref} · executed ${t.executed_at.slice(0, 19).replace('T', ' ')} UTC · Seaport Global acting as agent`,
    sections: [{ heading: 'Trade', kv: [['Side', t.side === 'BUY' ? 'You bought' : 'You sold'], ['Instrument', `${t.instrument} (${t.isin})`], ['Nominal', `${t.currency} ${t.quantity.toLocaleString('en-US')}`],
      ['Price', px(t.price)], ['Venue', t.venue], ['Trade date', t.trade_date], ['Settlement date', t.settlement_date]] },
    { heading: 'Settlement amount', kv: [['Principal', f(t.principal_cents)], ['Accrued interest', f(t.accrued_cents)], ['Commission', `${f(t.commission_cents)} (${t.commission_bps} bps)`],
      ['Venue fees', f(t.venue_fee_cents)], [t.side === 'BUY' ? 'Total payable' : 'Total receivable', f(t.net_cents)]] },
    { paragraphs: ['This trade was executed under our order execution policy. Best-execution evidence (all venue quotes at the time of routing) is retained for at least five years.'] }],
  });
  svc.db.run('UPDATE trades SET confirmation_document_id = ? WHERE ref = ?', [id, tref]);
}

export function listTrades(svc: Services) {
  return svc.db.all(`SELECT t.*, o.ref AS order_ref, o.created_by AS trader, i.isin, i.name AS instrument, inv.code AS investor_code, d.filename AS confirmation_filename
    FROM trades t JOIN orders o ON o.id = t.order_id JOIN instruments i ON i.id = o.instrument_id JOIN investors inv ON inv.id = o.investor_id
    LEFT JOIN documents d ON d.id = t.confirmation_document_id ORDER BY t.id DESC LIMIT 300`);
}

export function settleTrade(svc: Services, user: User, id: number) {
  requirePermission(user, 'brokerage.settle');
  const t = svc.db.get('SELECT t.*, o.created_by AS trader, o.investor_id FROM trades t JOIN orders o ON o.id = t.order_id WHERE t.id = ?', [id]);
  if (!t) throw notFound('Trade');
  if (t.status !== 'CONFIRMED') throw conflict(`Trade is ${t.status}`);
  if (t.trader === user.username) throw forbidden('SoD-12: a trade must be settled by operations, not by the trader');
  if (t.settlement_date > svc.today()) throw conflict(`Settlement date is ${t.settlement_date}`);
  return svc.db.tx(() => {
    svc.db.run("UPDATE trades SET status = 'SETTLED', settled_by = ?, settled_at = ? WHERE id = ?", [user.username, now(), id]);
    ledger.post(svc.db, user, { date: svc.today(), description: `Commission collected ${t.ref}`, source_type: 'TRADE_SETTLEMENT', source_id: id, currency: t.currency,
      lines: [{ account: '1000', debit: t.commission_cents, investor_id: t.investor_id }, { account: '1310', credit: t.commission_cents, investor_id: t.investor_id }] });
    audit.record(svc.db, user, 'trade.settled', 'trade', id, { ref: t.ref });
    return { ok: true };
  });
}

export function commissions(svc: Services) {
  const usd = fxToUsd(svc.db);
  const rows = svc.db.all(`SELECT t.currency, COUNT(*) n, SUM(t.principal_cents) principal, SUM(t.commission_cents) commission, SUM(t.rebate_cents) rebate, SUM(t.venue_fee_cents) fees
    FROM trades t WHERE t.status <> 'CANCELLED' GROUP BY t.currency`);
  const byVenue = svc.db.all(`SELECT venue, COUNT(*) n, SUM(principal_cents) principal, currency FROM trades WHERE status <> 'CANCELLED' GROUP BY venue, currency`);
  return {
    totals_usd: rows.reduce((a, r) => ({ trades: a.trades + r.n, principal: a.principal + usd(r.principal, r.currency), commission: a.commission + usd(r.commission, r.currency), rebate: a.rebate + usd(r.rebate, r.currency), fees: a.fees + usd(r.fees, r.currency) }),
      { trades: 0, principal: 0, commission: 0, rebate: 0, fees: 0 }),
    by_currency: rows, by_venue: byVenue,
    schedule: [{ up_to: 1_000_000, bps: 25 }, { up_to: 5_000_000, bps: 15 }, { up_to: null, bps: 8 }], minimum_cents: 25_000,
  };
}
