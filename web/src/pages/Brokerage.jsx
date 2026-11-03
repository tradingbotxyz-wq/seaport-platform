import { useEffect, useState } from 'react';
import { useApi, post, money, moneyShort, dateShort, dateTime, download } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Field, Button, Pill, Modal, ErrorBox, Loading, Empty, Icon, useUi, useAction } from '../ui.jsx';

const px = (p) => (p == null ? '—' : (p / 10000).toFixed(4));
const TYPE = { TBILL: 'T-bill', CP: 'Commercial paper', BOND: 'Bond', POOL_NOTE: 'Pool note' };
const TONE = { FILLED: 'good', PARTIALLY_FILLED: 'warn', NOT_FILLED: 'danger', REJECTED: 'danger', CONFIRMED: 'info', SETTLED: 'good', APPROVED: 'good', PENDING: 'warn', SUSPENDED: 'danger', CANCELLED: '' };
const label = (s) => s.replace(/_/g, ' ').toLowerCase();

export default function Brokerage() {
  const { can } = useSession();
  const [tab, setTab] = useState('ticket');
  const mkt = useApi('/api/brokerage/market');
  const orders = useApi('/api/brokerage/orders');
  const trades = useApi('/api/brokerage/trades');
  const brokers = useApi('/api/brokerage/brokers');
  const comm = useApi('/api/brokerage/commissions');
  const reload = () => { mkt.reload(); orders.reload(); trades.reload(); brokers.reload(); comm.reload(); };
  useEffect(() => { const t = setInterval(() => mkt.reload(), 60_000); return () => clearInterval(t); }, []);
  const T = comm.data?.totals_usd;
  const unsettled = (trades.data ?? []).filter((t) => t.status === 'CONFIRMED').length;
  const tabs = [['ticket', 'Order ticket'], ['blotter', `Order blotter`], ['trades', `Trades${unsettled ? ` (${unsettled} to settle)` : ''}`], ['brokers', 'Brokers & introducers'], ['restricted', 'Securities & restricted list']];

  return (
    <>
      <div className="grid g6">
        <Kpi label="Trades" value={T ? T.trades : '—'} sub="Executions to date" />
        <Kpi label="Volume (USD eq.)" value={T ? moneyShort(T.principal) : '—'} sub="Principal traded" />
        <Kpi label="Commission (USD eq.)" value={T ? moneyShort(T.commission) : '—'} sub="Ledger account 4300" tone="good" />
        <Kpi label="Introducer rebates" value={T ? moneyShort(T.rebate) : '—'} sub="Ledger account 5100" />
        <Kpi label="Net brokerage revenue" value={T ? moneyShort(T.commission - T.rebate) : '—'} sub="Commission less rebates" tone="good" />
        <Kpi label="Awaiting settlement" value={unsettled} sub="Confirmed, not yet settled" tone={unsettled ? 'warn' : undefined} onClick={() => setTab('trades')} />
      </div>
      <div className="chips" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'ticket' && <Ticket mkt={mkt} brokers={brokers.data ?? []} onDone={() => { reload(); setTab('blotter'); }} canTrade={can('brokerage.trade')} />}
      {tab === 'blotter' && <Blotter orders={orders} />}
      {tab === 'trades' && <Trades trades={trades} comm={comm.data} canSettle={can('brokerage.settle')} reload={reload} />}
      {tab === 'brokers' && <Brokers brokers={brokers} canOnboard={can('brokerage.onboard')} canApprove={can('brokerage.approve')} reload={reload} />}
      {tab === 'restricted' && <Restricted mkt={mkt} canManage={can('brokerage.approve')} reload={reload} />}
    </>
  );
}

function Ticket({ mkt, brokers, onDone, canTrade }) {
  const { toast } = useUi();
  const investors = useApi('/api/investors');
  const [busy, run] = useAction();
  const [o, setO] = useState({ investor_id: '', instrument_id: '', introducer_id: '', side: 'BUY', quantity: '1000000', order_type: 'MARKET', limit_price: '' });
  const [result, setResult] = useState(null);
  const instruments = mkt.data?.instruments ?? [];
  const inst = instruments.find((i) => String(i.id) === String(o.instrument_id));
  const set = (k) => (e) => setO({ ...o, [k]: e.target.value });
  const qty = Number(String(o.quantity).replace(/,/g, '')) || 0;
  const refPx = inst ? (o.side === 'BUY' ? inst.best_ask : inst.best_bid) : null;
  const estimate = refPx ? Math.round((qty * 100 * refPx) / 1_000_000) : null;
  const submit = () => run(async () => {
    const r = await post('/api/brokerage/orders', {
      investor_id: Number(o.investor_id), instrument_id: Number(o.instrument_id), introducer_id: o.introducer_id ? Number(o.introducer_id) : undefined, side: o.side, quantity: qty, order_type: o.order_type,
      limit_price: o.order_type === 'LIMIT' ? Math.round(Number(o.limit_price) * 10000) : undefined,
    });
    setResult(r);
    toast(r.status === 'REJECTED' ? `Order ${r.ref} rejected by pre-trade checks` : `Order ${r.ref} ${label(r.status)} — ${r.trades.length} trade(s)`, r.status === 'REJECTED' ? 'error' : 'success');
  });
  return (
    <div className="grid g2">
      <Card title="New client order" subtitle="Pre-trade compliance runs before routing. Orders are routed to the venue with the best effective price (price plus venue fee).">
        {!canTrade && <div className="infobar">Only traders can enter orders. You can view live prices.</div>}
        <div className="grid g2">
          <Field label="Client"><select className="select" value={o.investor_id} onChange={set('investor_id')}><option value="">Select client…</option>{(investors.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}</select></Field>
          <Field label="Introducer (optional)"><select className="select" value={o.introducer_id} onChange={set('introducer_id')}><option value="">None</option>{brokers.filter((b) => b.kind === 'INTRODUCER').map((b) => <option key={b.id} value={b.id} disabled={b.status !== 'APPROVED'}>{b.code} · {b.name}{b.status !== 'APPROVED' ? ` (${label(b.status)})` : ''}</option>)}</select></Field>
          <Field label="Security" style={{ gridColumn: 'span 2' }}><select className="select" value={o.instrument_id} onChange={set('instrument_id')}><option value="">Select security…</option>{instruments.map((i) => <option key={i.id} value={i.id}>{i.isin} · {i.name} ({i.currency}){i.restricted ? ' — RESTRICTED' : ''}</option>)}</select></Field>
          <Field label="Side"><div className="chips">{['BUY', 'SELL'].map((s) => <button key={s} type="button" className={`chip ${o.side === s ? 'on' : ''}`} onClick={() => setO({ ...o, side: s })}>{s === 'BUY' ? 'Buy' : 'Sell'}</button>)}</div></Field>
          <Field label="Nominal (face value)" hint="Minimum 1,000"><input className="input" inputMode="numeric" value={o.quantity} onChange={set('quantity')} /></Field>
          <Field label="Order type"><select className="select" value={o.order_type} onChange={set('order_type')}><option value="MARKET">Market</option><option value="LIMIT">Limit</option></select></Field>
          {o.order_type === 'LIMIT' && <Field label="Limit price (per 100)" hint={refPx ? `Market ${px(refPx)}` : ''}><input className="input" inputMode="decimal" value={o.limit_price} onChange={set('limit_price')} placeholder="99.5000" /></Field>}
        </div>
        {inst && (
          <div className="infobar" style={{ marginTop: 12 }}>
            {TYPE[inst.type]} · matures {dateShort(inst.maturity_date)} · settles T+{inst.settlement_days} · best bid <b>{px(inst.best_bid)}</b> / best offer <b>{px(inst.best_ask)}</b>
            {estimate != null && <> · est. principal <b>{money(estimate, inst.currency)}</b></>}
            {inst.restricted ? <div className="t-red" style={{ marginTop: 4 }}>Restricted: {inst.restricted_reason}</div> : null}
          </div>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <Button variant="primary" disabled={busy || !canTrade || !o.investor_id || !o.instrument_id || qty < 1000 || (o.order_type === 'LIMIT' && !o.limit_price)} onClick={submit}>Submit order</Button>
        </div>
        {result && (
          <div style={{ marginTop: 14 }}>
            <div className="section-title">Order {result.ref} — <Pill tone={TONE[result.status]}>{label(result.status)}</Pill></div>
            <Checks checks={result.checks} />
            {result.best_ex && <p className="small muted">{result.best_ex}</p>}
            {result.trades?.length > 0 && <Button size="sm" onClick={onDone}>View in blotter</Button>}
          </div>
        )}
      </Card>
      <Card title="Live venue quotes" subtitle={mkt.data ? `Prices per 100 nominal · refreshed ${dateTime(mkt.data.ts)}` : ''} right={<Button size="sm" icon="refresh" onClick={mkt.reload}>Refresh</Button>}>
        <ErrorBox error={mkt.error} />
        {!mkt.data ? <Loading /> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Security</th><th>Venue</th><th className="r">Bid</th><th className="r">Offer</th><th className="r">Depth</th><th className="r">Fee</th></tr></thead>
            <tbody>{(inst ? [inst] : instruments).flatMap((i) => i.quotes.map((q, k) => (
              <tr key={i.id + q.venue} className={o.instrument_id === String(i.id) ? '' : 'selectable'} onClick={() => setO({ ...o, instrument_id: String(i.id) })}>
                <td className="strong">{k === 0 ? <>{i.isin}{i.restricted ? <Pill tone="danger">restricted</Pill> : null}</> : ''}</td><td>{q.venue}</td>
                <td className={`r ${q.bid === i.best_bid ? 't-green strong' : ''}`}>{px(q.bid)}</td><td className={`r ${q.ask === i.best_ask ? 't-green strong' : ''}`}>{px(q.ask)}</td>
                <td className="r">{(q.depth / 1e6).toFixed(0)}m</td><td className="r">{q.fee_bps} bps</td></tr>)))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

const Checks = ({ checks }) => (
  <div className="table-wrap"><table className="tbl"><tbody>{checks.map((c) => <tr key={c.check}><td><Icon name={c.ok ? 'check' : 'x'} size={14} className={c.ok ? 't-green' : 't-red'} /> {c.check}</td><td className="wrap small muted">{c.detail}</td></tr>)}</tbody></table></div>
);

function Blotter({ orders }) {
  const [open, setOpen] = useState(null);
  if (orders.error) return <ErrorBox error={orders.error} />;
  if (!orders.data) return <Loading />;
  return (
    <Card title="Order blotter" subtitle="Every order with its pre-trade checks and best-execution evidence. Click a row for details.">
      {!orders.data.length ? <Empty>No orders yet.</Empty> : (
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>Order</th><th>Time</th><th>Client</th><th>Side</th><th>Security</th><th className="r">Nominal</th><th className="r">Filled</th><th>Type</th><th>Introducer</th><th>Trader</th><th>Status</th></tr></thead>
          <tbody>{orders.data.map((o) => (
            <tr key={o.id} className="selectable" onClick={() => setOpen(o)}><td className="strong">{o.ref}</td><td>{dateTime(o.created_at)}</td><td>{o.investor_code}</td><td className={o.side === 'BUY' ? 't-green' : 't-red'}>{o.side}</td>
              <td>{o.isin}</td><td className="r">{o.quantity.toLocaleString('en-US')}</td><td className="r">{(o.filled_quantity ?? 0).toLocaleString('en-US')}</td><td>{o.order_type === 'LIMIT' ? `Limit ${px(o.limit_price)}` : 'Market'}</td>
              <td>{o.introducer_code ?? '—'}</td><td>{o.created_by}</td><td><Pill tone={TONE[o.status]}>{label(o.status)}</Pill></td></tr>))}</tbody>
        </table></div>
      )}
      {open && (
        <Modal title={`Order ${open.ref}`} subtitle={`${open.side} ${open.quantity.toLocaleString('en-US')} ${open.instrument} for ${open.investor_name}`} onClose={() => setOpen(null)}>
          <div className="section-title" style={{ marginTop: 0 }}>Pre-trade checks</div>
          <Checks checks={open.checks} />
          {open.reject_reason && <p className="t-red">Rejected: {open.reject_reason}</p>}
          {open.best_ex && (
            <>
              <div className="section-title">Best execution</div>
              <p className="small">{open.best_ex.rationale}</p>
              <div className="table-wrap"><table className="tbl"><thead><tr><th>Venue</th><th className="r">Bid</th><th className="r">Offer</th><th className="r">Depth</th><th className="r">Fee</th></tr></thead>
                <tbody>{open.best_ex.quotes.map((q) => <tr key={q.venue}><td>{q.venue_name}</td><td className="r">{px(q.bid)}</td><td className="r">{px(q.ask)}</td><td className="r">{(q.depth / 1e6).toFixed(0)}m</td><td className="r">{q.fee_bps} bps</td></tr>)}</tbody></table></div>
            </>
          )}
        </Modal>
      )}
    </Card>
  );
}

function Trades({ trades, comm, canSettle, reload }) {
  const { toast, fail, ask } = useUi();
  const [busy, run] = useAction();
  if (trades.error) return <ErrorBox error={trades.error} />;
  if (!trades.data) return <Loading />;
  const settle = (t) => ask({ title: `Settle ${t.ref}?`, message: `Confirms that ${money(t.net_cents, t.currency)} settled with the custodian and books the commission as collected (Dr 1000 Cash / Cr 1310).`, confirm: 'Settle trade' })
    .then((ok) => ok && run(async () => { await post(`/api/brokerage/trades/${t.id}/settle`); toast(`${t.ref} settled`, 'success'); reload(); }));
  return (
    <>
      <Card title="Trades" subtitle="Confirmed executions. Operations settles each trade on or after its settlement date — never the trader who placed it (SoD-12).">
        {!trades.data.length ? <Empty>No trades yet.</Empty> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Trade</th><th>Client</th><th>Side</th><th>Security</th><th>Venue</th><th className="r">Nominal</th><th className="r">Price</th><th className="r">Principal</th><th className="r">Accrued</th><th className="r">Commission</th><th className="r">Rebate</th><th className="r">Net amount</th><th>Settles</th><th>Status</th><th>Confirmation</th><th /></tr></thead>
            <tbody>{trades.data.map((t) => (
              <tr key={t.id}><td className="strong" title={`Order ${t.order_ref}`}>{t.ref}</td><td>{t.investor_code}</td><td className={t.side === 'BUY' ? 't-green' : 't-red'}>{t.side}</td><td>{t.isin}</td><td>{t.venue}</td>
                <td className="r">{t.quantity.toLocaleString('en-US')}</td><td className="r">{px(t.price)}</td><td className="r">{money(t.principal_cents, t.currency)}</td><td className="r">{money(t.accrued_cents, t.currency)}</td>
                <td className="r t-green" title={`${t.commission_bps} bps`}>{money(t.commission_cents, t.currency)}</td><td className="r">{t.rebate_cents ? money(t.rebate_cents, t.currency) : '—'}</td><td className="r strong">{money(t.net_cents, t.currency)}</td>
                <td>{dateShort(t.settlement_date)}</td><td><Pill tone={TONE[t.status]}>{label(t.status)}</Pill></td>
                <td>{t.confirmation_document_id ? <button className="file-link" onClick={() => download(`/api/documents/${t.confirmation_document_id}/file`, t.confirmation_filename).catch(fail)}><Icon name="file" size={14} />PDF</button> : '—'}</td>
                <td>{t.status === 'CONFIRMED' && canSettle && <Button size="sm" disabled={busy} onClick={() => settle(t)}>Settle</Button>}</td></tr>))}</tbody>
          </table></div>
        )}
      </Card>
      {comm && (
        <div className="grid g2">
          <Card title="Commission by currency">
            <div className="table-wrap"><table className="tbl"><thead><tr><th>Currency</th><th className="r">Trades</th><th className="r">Principal</th><th className="r">Commission</th><th className="r">Rebates</th><th className="r">Venue fees</th></tr></thead>
              <tbody>{comm.by_currency.map((r) => <tr key={r.currency}><td>{r.currency}</td><td className="r">{r.n}</td><td className="r">{money(r.principal, r.currency)}</td><td className="r t-green">{money(r.commission, r.currency)}</td><td className="r">{money(r.rebate, r.currency)}</td><td className="r">{money(r.fees, r.currency)}</td></tr>)}</tbody></table></div>
          </Card>
          <Card title="Commission schedule" subtitle="Tiered by nominal per execution, with a minimum charge.">
            <div className="table-wrap"><table className="tbl"><thead><tr><th>Nominal</th><th className="r">Rate</th></tr></thead>
              <tbody>{comm.schedule.map((s, i) => <tr key={i}><td>{s.up_to ? `Up to ${s.up_to.toLocaleString('en-US')}` : 'Above that'}</td><td className="r">{s.bps} bps</td></tr>)}<tr><td>Minimum per execution</td><td className="r">{money(comm.minimum_cents, 'USD')}</td></tr></tbody></table></div>
            <div className="section-title">Volume by venue</div>
            <div className="table-wrap"><table className="tbl"><tbody>{comm.by_venue.map((v) => <tr key={v.venue + v.currency}><td>{v.venue}</td><td className="r">{v.n} trade(s)</td><td className="r">{money(v.principal, v.currency)}</td></tr>)}</tbody></table></div>
          </Card>
        </div>
      )}
    </>
  );
}

function Brokers({ brokers, canOnboard, canApprove, reload }) {
  const { toast, ask } = useUi();
  const { me } = useSession();
  const [busy, run] = useAction();
  const [form, setForm] = useState(null);
  if (brokers.error) return <ErrorBox error={brokers.error} />;
  if (!brokers.data) return <Loading />;
  const decide = (b, status) => ask({ title: `${status === 'APPROVED' ? 'Approve' : status === 'REJECTED' ? 'Reject' : 'Suspend'} ${b.name}?`, message: `KYC: ${b.kyc_reference}`, confirm: status === 'APPROVED' ? 'Approve' : status === 'REJECTED' ? 'Reject' : 'Suspend' })
    .then((ok) => ok && run(async () => { await post(`/api/brokerage/brokers/${b.id}/decide`, { status }); toast(`${b.code} ${label(status)}`, 'success'); reload(); }));
  const save = () => run(async () => {
    const r = await post('/api/brokerage/brokers', { ...form, lei: form.lei || undefined, regulator: form.regulator || undefined, rebate_bps_of_commission: form.kind === 'INTRODUCER' ? Math.round(Number(form.rebate || 0) * 100) : 0 });
    toast(`${r.code} onboarded — awaiting Compliance approval`, 'success'); setForm(null); reload();
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Card title="Brokers and introducers" subtitle="Counterparties are screened (sanctions / PEP) at onboarding and approved by Compliance — never by the person who onboarded them (SoD-12)."
      right={canOnboard && <Button variant="primary" icon="plus" onClick={() => setForm({ kind: 'INTRODUCER', name: '', country: 'US', lei: '', regulator: '', rebate: '20' })}>Onboard</Button>}>
      <div className="table-wrap"><table className="tbl">
        <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Country</th><th>Regulator</th><th>LEI</th><th className="r">Rebate</th><th className="r">Orders</th><th className="r">Commission</th><th className="r">Rebates</th><th>Screening</th><th>Status</th><th /></tr></thead>
        <tbody>{brokers.data.map((b) => (
          <tr key={b.id}><td className="strong">{b.code}</td><td>{b.name}</td><td>{b.kind === 'BROKER' ? 'Broker' : 'Introducer'}</td><td>{b.country}</td><td>{b.regulator ?? '—'}</td><td className="small">{b.lei ?? '—'}</td>
            <td className="r">{b.kind === 'INTRODUCER' ? `${b.rebate_bps_of_commission / 100}% of comm.` : '—'}</td><td className="r">{b.orders}</td><td className="r">{money(b.commission_cents)}</td><td className="r">{money(b.rebate_cents)}</td>
            <td className="small muted">{b.kyc_reference}</td><td><Pill tone={TONE[b.status]}>{label(b.status)}</Pill></td>
            <td className="row">{canApprove && b.status === 'PENDING' && b.created_by !== me.username && <><Button size="sm" variant="primary" disabled={busy} onClick={() => decide(b, 'APPROVED')}>Approve</Button><Button size="sm" disabled={busy} onClick={() => decide(b, 'REJECTED')}>Reject</Button></>}
              {canApprove && b.status === 'APPROVED' && <Button size="sm" disabled={busy} onClick={() => decide(b, 'SUSPENDED')}>Suspend</Button>}</td></tr>))}</tbody>
      </table></div>
      {form && (
        <Modal title="Onboard broker or introducer" onClose={() => setForm(null)} width={560} footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" disabled={busy || !form.name.trim() || !/^[A-Z]{2}$/.test(form.country)} onClick={save}>Screen and submit</Button></>}>
          <div className="grid g2">
            <Field label="Type"><select className="select" value={form.kind} onChange={set('kind')}><option value="INTRODUCER">Introducer</option><option value="BROKER">Executing broker</option></select></Field>
            <Field label="Legal name"><input className="input" value={form.name} onChange={set('name')} /></Field>
            <Field label="Country (ISO)"><input className="input" maxLength={2} value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })} /></Field>
            <Field label="Regulator"><input className="input" value={form.regulator} onChange={set('regulator')} placeholder="FCA, FINRA, MAS…" /></Field>
            <Field label="LEI (20 characters)"><input className="input" maxLength={20} value={form.lei} onChange={(e) => setForm({ ...form, lei: e.target.value.toUpperCase() })} /></Field>
            {form.kind === 'INTRODUCER' && <Field label="Rebate (% of commission)"><input className="input" inputMode="decimal" value={form.rebate} onChange={set('rebate')} /></Field>}
          </div>
        </Modal>
      )}
    </Card>
  );
}

function Restricted({ mkt, canManage, reload }) {
  const { toast } = useUi();
  const [busy, run] = useAction();
  const [edit, setEdit] = useState(null);
  if (!mkt.data) return <Loading />;
  const save = () => run(async () => {
    await post(`/api/brokerage/instruments/${edit.id}/restricted`, { restricted: !edit.restricted, reason: edit.reason });
    toast(edit.restricted ? `${edit.isin} removed from restricted list` : `${edit.isin} added to restricted list`, 'success'); setEdit(null); reload();
  });
  return (
    <Card title="Securities master and restricted list" subtitle="Orders in restricted securities are blocked at pre-trade. Compliance maintains the list; every change is audited.">
      <div className="table-wrap"><table className="tbl">
        <thead><tr><th>ISIN</th><th>Name</th><th>Type</th><th>Issuer</th><th>Ccy</th><th className="r">Coupon</th><th>Maturity</th><th>Settles</th><th className="r">Fair value</th><th>Restricted</th><th /></tr></thead>
        <tbody>{mkt.data.instruments.map((i) => (
          <tr key={i.id}><td className="strong">{i.isin}</td><td>{i.name}</td><td>{TYPE[i.type]}</td><td>{i.issuer}</td><td>{i.currency}</td><td className="r">{i.coupon_bps ? `${(i.coupon_bps / 100).toFixed(2)}%` : '—'}</td>
            <td>{dateShort(i.maturity_date)}</td><td>T+{i.settlement_days}</td><td className="r">{px(i.fair)}</td>
            <td className="wrap">{i.restricted ? <><Pill tone="danger">restricted</Pill> <span className="small muted">{i.restricted_reason}</span></> : '—'}</td>
            <td>{canManage && <Button size="sm" onClick={() => setEdit({ ...i, reason: '' })}>{i.restricted ? 'Unrestrict' : 'Restrict'}</Button>}</td></tr>))}</tbody>
      </table></div>
      {edit && (
        <Modal title={`${edit.restricted ? 'Remove' : 'Add'} ${edit.isin} ${edit.restricted ? 'from' : 'to'} the restricted list`} onClose={() => setEdit(null)} width={520}
          footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" disabled={busy || (!edit.restricted && !edit.reason.trim())} onClick={save}>Confirm</Button></>}>
          <Field label={edit.restricted ? 'Note (optional)' : 'Reason'}><textarea className="textarea" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></Field>
        </Modal>
      )}
    </Card>
  );
}
