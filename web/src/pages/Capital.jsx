import { useState } from 'react';
import { useApi, post, money, moneyShort, dateShort, dateTime, pct, download } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Field, Button, Pill, Modal, BarChart, ErrorBox, Loading, Empty, Icon, useUi, useAction } from '../ui.jsx';

const TRANCHES = ['SENIOR', 'MEZZANINE', 'EQUITY'];
const cap = (s) => s[0] + s.slice(1).toLowerCase();
const STATUS_TONE = { DRAFT: 'warn', ISSUED: 'info', SETTLED: 'good', CANCELLED: '', APPROVED: 'info', PAID: 'good' };

export default function Capital() {
  const { can } = useSession();
  const liq = useApi('/api/liquidity');
  const commitments = useApi('/api/commitments');
  const calls = useApi('/api/capital-calls');
  const dists = useApi('/api/distributions');
  const [ccy, setCcy] = useState('USD');
  const [modal, setModal] = useState(null);
  const [openCall, setOpenCall] = useState(null);
  const reload = () => { liq.reload(); commitments.reload(); calls.reload(); dists.reload(); };
  const L = (liq.data ?? []).find((x) => x.currency === ccy);

  return (
    <>
      <Card title="Liquidity and dry powder" subtitle="Cash (ledger account 1000) plus capital still callable from investors, less queued disbursements and fundings awaiting approval."
        right={<div className="chips">{(liq.data ?? []).map((x) => <button key={x.currency} className={`chip ${x.currency === ccy ? 'on' : ''}`} onClick={() => setCcy(x.currency)}>{x.currency}</button>)}</div>}>
        <ErrorBox error={liq.error} />
        {!L ? <Loading /> : (
          <>
            <div className="grid g6">
              <Kpi label="Dry powder" value={moneyShort(L.dry_powder_cents, ccy)} sub="Available to fund new receivables" tone={L.dry_powder_cents < 0 ? 'danger' : 'good'} />
              <Kpi label="Cash" value={moneyShort(L.cash_cents, ccy)} sub="Operating accounts (ledger)" />
              <Kpi label="Unfunded commitments" value={moneyShort(L.unfunded_commitments_cents, ccy)} sub={`Calls outstanding ${moneyShort(L.capital_calls_outstanding_cents, ccy)}`} />
              <Kpi label="Queued disbursements" value={moneyShort(L.pending_payments_cents, ccy)} sub="Approved, not yet paid" />
              <Kpi label="Funding pipeline" value={moneyShort(L.funding_pipeline_cents, ccy)} sub="Invoice files awaiting approval" />
              <Kpi label="Warehouse facility drawn" value={moneyShort(L.facility_drawn_cents, ccy)} sub={`Past-due collections ${moneyShort(L.past_due_collections_cents, ccy)}`} />
            </div>
            <div className="grid g2" style={{ marginTop: 16 }}>
              <div>
                <div className="section-title" style={{ marginTop: 0 }}>Projected closing cash by week</div>
                <BarChart data={L.weeks.map((w) => ({ key: w.week, label: `W${w.week}`, value: Math.max(0, w.closing_cents), title: `${dateShort(w.from)}–${dateShort(w.to)}` }))} format={(v) => moneyShort(v)} />
              </div>
              <div className="table-wrap" style={{ alignSelf: 'start' }}>
                <table className="tbl">
                  <thead><tr><th>Week</th><th className="r">Inflows</th><th className="r">Outflows</th><th className="r">Closing cash</th></tr></thead>
                  <tbody>{L.weeks.map((w) => <tr key={w.week}><td>{dateShort(w.from)} – {dateShort(w.to)}</td><td className="r t-green">{money(w.inflow_cents)}</td><td className="r t-red">{money(w.outflow_cents)}</td><td className={`r strong ${w.closing_cents < 0 ? 't-red' : ''}`}>{money(w.closing_cents)}</td></tr>)}</tbody>
                </table>
                <div className="small muted" style={{ padding: '8px 12px' }}>Inflows: loan maturities and capital-call receipts. Outflows: queued payments and the funding pipeline (week 1).</div>
              </div>
            </div>
          </>
        )}
      </Card>

      <Card title="Investor commitments" subtitle="Commitments to pool tranches. Called and paid-in amounts come from capital calls; returned capital from distributions."
        right={can('fund.commit') && <Button variant="primary" icon="plus" onClick={() => setModal('commitment')}>New commitment</Button>}>
        {!commitments.data ? <Loading /> : !commitments.data.length ? <Empty>No commitments yet.</Empty> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Investor</th><th>Pool</th><th>Tranche</th><th className="r">Committed</th><th className="r">Called</th><th className="r">Paid in</th><th className="r">Unfunded</th><th style={{ minWidth: 120 }}>Drawn</th><th className="r">Income distributed</th><th>Signed</th></tr></thead>
            <tbody>{commitments.data.map((c) => (
              <tr key={c.id}><td className="strong">{c.investor_code} · {c.investor_name}</td><td>{c.pool_ref}</td><td>{cap(c.tranche)}</td>
                <td className="r">{money(c.amount_cents, c.currency)}</td><td className="r">{money(c.called_cents, c.currency)}</td><td className="r">{money(c.paid_in_cents, c.currency)}</td>
                <td className="r t-brand">{money(c.unfunded_cents, c.currency)}</td>
                <td><div className="row" style={{ flexWrap: 'nowrap' }}><span className="mini-bar" style={{ width: 80 }}><div style={{ width: `${(c.called_cents * 100) / c.amount_cents}%`, background: 'var(--brand)' }} /></span><span className="small">{pct((c.called_cents * 100) / c.amount_cents, 0)}</span></div></td>
                <td className="r">{money(c.income_cents, c.currency)}</td><td>{dateShort(c.signed_at)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      <div className="grid g2">
        <Card title="Capital calls" subtitle="Allocated pro rata to commitments in the tranche. Issued through a saga: approve → post receivable → notices → notify."
          right={can('fund.call') && <Button icon="plus" onClick={() => setModal('call')}>New capital call</Button>}>
          {!calls.data ? <Loading /> : !calls.data.length ? <Empty>No capital calls.</Empty> : (
            <div className="table-wrap"><table className="tbl">
              <thead><tr><th>Call</th><th>Pool / tranche</th><th className="r">Amount</th><th className="r">Received</th><th>Due</th><th>Status</th></tr></thead>
              <tbody>{calls.data.map((c) => (
                <tr key={c.id} className="selectable" onClick={() => setOpenCall(c.id)}><td className="strong t-brand">{c.ref}</td><td>{c.pool_ref} · {cap(c.tranche)}</td><td className="r">{money(c.amount_cents, c.currency)}</td>
                  <td className="r">{money(c.received_cents, c.currency)}</td><td>{dateShort(c.due_date)}</td><td><Pill tone={STATUS_TONE[c.status]}>{c.status}</Pill></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <Distributions dists={dists} onChanged={reload} onNew={() => setModal('dist')} />
      </div>
      {modal === 'commitment' && <CommitmentModal onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === 'call' && <CallModal onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === 'dist' && <DistributionModal onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {openCall && <CallDetail id={openCall} onClose={() => setOpenCall(null)} onChanged={reload} />}
    </>
  );
}

function Distributions({ dists, onChanged, onNew }) {
  const { can, me } = useSession();
  const { toast } = useUi();
  const [busy, run] = useAction();
  return (
    <Card title="Distributions" subtitle="Income or return of capital, pro rata to net paid-in capital. Approval queues investor payments for disbursement."
      right={can('fund.call') && <Button icon="plus" onClick={onNew}>New distribution</Button>}>
      {!dists.data ? <Loading /> : !dists.data.length ? <Empty>No distributions.</Empty> : (
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>Ref</th><th>Pool / tranche</th><th>Type</th><th className="r">Amount</th><th>Pay date</th><th>Status</th><th /></tr></thead>
          <tbody>{dists.data.map((d) => (
            <tr key={d.id}><td className="strong">{d.ref}</td><td>{d.pool_ref} · {cap(d.tranche)}</td><td>{d.kind === 'INCOME' ? 'Income' : 'Return of capital'}</td><td className="r">{money(d.amount_cents, d.currency)}</td>
              <td>{dateShort(d.payment_date)}</td><td><Pill tone={STATUS_TONE[d.status]}>{d.status}</Pill></td>
              <td>{d.status === 'DRAFT' && can('fund.approve') && <Button size="sm" variant="success" disabled={busy || d.created_by === me.username} title={d.created_by === me.username ? 'Four-eyes: another user must approve (SoD-9)' : ''}
                onClick={() => run(async () => { await post(`/api/distributions/${d.id}/approve`); toast(`${d.ref} approved — payments queued`, 'success'); onChanged(); })}>Approve</Button>}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </Card>
  );
}

function CallDetail({ id, onClose, onChanged }) {
  const { can, me } = useSession();
  const { toast, fail } = useUi();
  const { data: c, reload } = useApi(`/api/capital-calls/${id}`);
  const [busy, run] = useAction();
  const done = () => { reload(); onChanged(); };
  return (
    <Modal title={c ? `Capital call ${c.ref}` : 'Capital call'} subtitle={c ? `${c.pool_ref} ${c.pool_name} · ${cap(c.tranche)} · due ${dateShort(c.due_date)} · ${c.purpose}` : ''} onClose={onClose} width={980}
      footer={c && <>
        {c.status === 'DRAFT' && can('fund.call') && <Button onClick={() => run(async () => { await post(`/api/capital-calls/${id}/cancel`); toast('Call cancelled', 'success'); done(); })}>Cancel call</Button>}
        {c.status === 'DRAFT' && can('fund.approve') && <Button variant="success" disabled={busy || c.created_by === me.username} title={c.created_by === me.username ? 'Four-eyes: another user must approve (SoD-9)' : ''}
          onClick={() => run(async () => { await post(`/api/capital-calls/${id}/issue`, {}, { idempotent: true }); toast(`${c.ref} issued — notices generated`, 'success'); done(); })}>Approve & issue</Button>}
      </>}>
      {!c ? <Loading /> : (
        <>
          <div className="row" style={{ marginBottom: 12 }}><Pill tone={STATUS_TONE[c.status]}>{c.status}</Pill><span className="muted small">Prepared by {c.created_by}{c.approved_by ? ` · approved by ${c.approved_by} ${dateTime(c.issued_at)}` : ''}</span></div>
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Investor</th><th className="r">Commitment</th><th className="r">Called</th><th className="r">Received</th><th>Notice</th><th /></tr></thead>
            <tbody>{c.lines.map((l) => (
              <tr key={l.id}><td className="strong">{l.investor_code} · {l.investor_name}</td><td className="r">{money(l.commitment_cents, c.currency)}</td><td className="r">{money(l.amount_cents, c.currency)}</td>
                <td className={`r ${l.received_cents >= l.amount_cents ? 't-green' : ''}`}>{money(l.received_cents, c.currency)}</td>
                <td>{l.notice_document_id ? <button className="file-link" onClick={() => download(`/api/documents/${l.notice_document_id}/file`, l.notice_filename).catch(fail)}><Icon name="file" size={14} />PDF</button> : '—'}</td>
                <td>{c.status === 'ISSUED' && can('fund.receive') && l.received_cents < l.amount_cents && (
                  <Button size="sm" disabled={busy} onClick={() => run(async () => { await post(`/api/capital-calls/${id}/receipt`, { line_id: l.id, amount_cents: l.amount_cents - l.received_cents, received_at: new Date().toISOString().slice(0, 10) }); toast(`Receipt recorded for ${l.investor_code}`, 'success'); done(); })}>Record receipt of {moneyShort(l.amount_cents - l.received_cents)}</Button>
                )}</td></tr>
            ))}</tbody>
          </table></div>
          {c.sagas.length > 0 && (
            <>
              <div className="section-title">Process log (saga)</div>
              {c.sagas.map((s) => (
                <div key={s.id} className="infobar" style={{ alignItems: 'flex-start' }}>
                  <Pill tone={s.status === 'COMPLETED' ? 'good' : s.status === 'RUNNING' ? 'info' : 'bad'}>{s.status}</Pill>
                  <span className="mono">{s.saga}</span><span>{dateTime(s.started_at)} by {s.started_by}</span>
                  <span style={{ flexBasis: '100%' }}>{s.steps.map((st) => `${st.status === 'DONE' ? '✓' : st.status === 'COMPENSATED' ? '↺' : '✗'} ${st.name}`).join('  →  ')}</span>
                  {s.error && <span className="t-red" style={{ flexBasis: '100%' }}>{s.error}</span>}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function usePoolsAndInvestors() {
  const pools = useApi('/api/pools');
  const investors = useApi('/api/investors');
  return { pools: (pools.data ?? []).filter((p) => p.status !== 'CLOSED'), investors: investors.data ?? [] };
}

function CommitmentModal({ onClose, onDone }) {
  const { pools, investors } = usePoolsAndInvestors();
  const { toast } = useUi();
  const [busy, run] = useAction();
  const [f, setF] = useState({ investor_id: '', pool_id: '', tranche: 'SENIOR', amount: '', signed_at: new Date().toISOString().slice(0, 10) });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const pool = pools.find((p) => String(p.id) === f.pool_id);
  const save = () => run(async () => {
    await post('/api/commitments', { investor_id: Number(f.investor_id), pool_id: Number(f.pool_id), tranche: f.tranche, amount_cents: Math.round(Number(f.amount.replace(/,/g, '')) * 100), signed_at: f.signed_at });
    toast('Commitment recorded', 'success');
    onDone();
  });
  return (
    <Modal title="New investor commitment" onClose={onClose} width={640} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.investor_id || !f.pool_id || !f.amount} onClick={save}>Save</Button></>}>
      <div className="grid g2">
        <Field label="Investor"><select className="select" value={f.investor_id} onChange={set('investor_id')}><option value="">Choose…</option>{investors.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}</select></Field>
        <Field label="Pool"><select className="select" value={f.pool_id} onChange={set('pool_id')}><option value="">Choose…</option>{pools.map((p) => <option key={p.id} value={p.id}>{p.ref} · {p.name}</option>)}</select></Field>
        <Field label="Tranche"><select className="select" value={f.tranche} onChange={set('tranche')}>{(pool?.tranches.map((t) => t.name) ?? TRANCHES).map((t) => <option key={t} value={t}>{cap(t)}</option>)}</select></Field>
        <Field label={`Amount${pool ? ` (${pool.currency})` : ''}`}><input className="input" inputMode="decimal" value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Subscription signed"><input className="input" type="date" value={f.signed_at} onChange={set('signed_at')} /></Field>
      </div>
    </Modal>
  );
}

function CallModal({ onClose, onDone }) {
  const { pools } = usePoolsAndInvestors();
  const { toast } = useUi();
  const [busy, run] = useAction();
  const [f, setF] = useState({ pool_id: '', tranche: 'SENIOR', amount: '', purpose: '', due_date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10) });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const active = pools.filter((p) => p.status === 'ACTIVE');
  const save = () => run(async () => {
    const r = await post('/api/capital-calls', { pool_id: Number(f.pool_id), tranche: f.tranche, amount_cents: Math.round(Number(f.amount.replace(/,/g, '')) * 100), purpose: f.purpose, due_date: f.due_date });
    toast(`${r.ref} prepared — awaiting approval`, 'success');
    onDone();
  });
  return (
    <Modal title="New capital call" subtitle="Allocated pro rata to each investor's commitment in the tranche; needs approval by a second person." onClose={onClose} width={640}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.pool_id || !f.amount || !f.purpose} onClick={save}>Prepare call</Button></>}>
      <div className="grid g2">
        <Field label="Pool (active)"><select className="select" value={f.pool_id} onChange={set('pool_id')}><option value="">Choose…</option>{active.map((p) => <option key={p.id} value={p.id}>{p.ref} · {p.name}</option>)}</select></Field>
        <Field label="Tranche"><select className="select" value={f.tranche} onChange={set('tranche')}>{TRANCHES.map((t) => <option key={t} value={t}>{cap(t)}</option>)}</select></Field>
        <Field label="Amount"><input className="input" inputMode="decimal" value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Due date"><input className="input" type="date" value={f.due_date} onChange={set('due_date')} /></Field>
        <Field label="Purpose" style={{ gridColumn: 'span 2' }}><input className="input" value={f.purpose} onChange={set('purpose')} placeholder="e.g. Fund ramp-up of new receivables" /></Field>
      </div>
    </Modal>
  );
}

function DistributionModal({ onClose, onDone }) {
  const { pools } = usePoolsAndInvestors();
  const { toast } = useUi();
  const [busy, run] = useAction();
  const [f, setF] = useState({ pool_id: '', tranche: 'SENIOR', kind: 'INCOME', amount: '', payment_date: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => run(async () => {
    const r = await post('/api/distributions', { pool_id: Number(f.pool_id), tranche: f.tranche, kind: f.kind, amount_cents: Math.round(Number(f.amount.replace(/,/g, '')) * 100), payment_date: f.payment_date });
    toast(`${r.ref} prepared — awaiting approval`, 'success');
    onDone();
  });
  return (
    <Modal title="New distribution" onClose={onClose} width={640} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.pool_id || !f.amount} onClick={save}>Prepare distribution</Button></>}>
      <div className="grid g2">
        <Field label="Pool"><select className="select" value={f.pool_id} onChange={set('pool_id')}><option value="">Choose…</option>{pools.map((p) => <option key={p.id} value={p.id}>{p.ref} · {p.name}</option>)}</select></Field>
        <Field label="Tranche"><select className="select" value={f.tranche} onChange={set('tranche')}>{TRANCHES.map((t) => <option key={t} value={t}>{cap(t)}</option>)}</select></Field>
        <Field label="Type"><select className="select" value={f.kind} onChange={set('kind')}><option value="INCOME">Income (coupon / yield)</option><option value="CAPITAL">Return of capital</option></select></Field>
        <Field label="Amount"><input className="input" inputMode="decimal" value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Payment date"><input className="input" type="date" value={f.payment_date} onChange={set('payment_date')} /></Field>
      </div>
    </Modal>
  );
}
