import { useState, Fragment } from 'react';
import { useApi, money, moneyExact, symShort, dateShort } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, BarChart, Pill, ErrorBox, Loading, Empty } from '../ui.jsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5)) - 1]} ${ym.slice(2, 4)}`;

export default function Revenue() {
  const { openLoan } = useSession();
  const { data: r, error } = useApi('/api/revenue');
  const tb = useApi('/api/ledger/trial-balance');
  const entries = useApi('/api/ledger/entries');
  const [ccy, setCcy] = useState('USD');
  const [openEntry, setOpenEntry] = useState(null);
  if (error) return <ErrorBox error={error} />;
  if (!r) return <Loading />;
  const t = r.totals_usd_cents;
  const currencies = [...new Set(r.monthly_booked.map((m) => m.currency))];
  const booked = r.monthly_booked.filter((m) => m.currency === ccy);

  return (
    <>
      <div className="grid g6">
        <Kpi label="Interest booked" value={symShort(t.interest)} sub="All fundings, USD equivalent" />
        <Kpi label="Payable to investors" value={symShort(t.investor)} sub="Base + investor margin" />
        <Kpi label="Seaport spread earned" value={symShort(t.earned)} sub="Recognised on settled loans" tone="good" />
        <Kpi label="Seaport spread unearned" value={symShort(t.unearned)} sub="On open loans, until settlement" />
        <Kpi label="Late charges accrued" value={symShort(t.late)} sub={`Memo, to ${dateShort(r.as_of)}`} tone={t.late ? 'warn' : ''} />
        <Kpi label="Seaport share of interest" value={t.interest ? `${(((t.interest - t.investor) / t.interest) * 100).toFixed(1)}%` : '—'} sub="Spread ÷ total interest" />
      </div>

      <div className="grid g2">
        <Card title="Seaport spread booked by funding month" subtitle="Interest minus investor share, by month of funding"
          right={<div className="chips">{currencies.map((c) => <button key={c} className={`chip ${c === ccy ? 'on' : ''}`} onClick={() => setCcy(c)}>{c}</button>)}</div>}>
          {booked.length ? (
            <BarChart data={booked.map((m) => ({ key: m.month, label: monthLabel(m.month), value: m.interest_cents - m.investor_cents, title: `${money(m.interest_cents, ccy)} interest` }))}
              format={(v) => symShort(v, ccy)} />
          ) : <Empty>No fundings in {ccy}.</Empty>}
        </Card>
        <Card title="Trial balance" subtitle="Double-entry ledger, per currency. Debits must equal credits."
          right={tb.data && Object.entries(tb.data.totals).map(([c, x]) => <Pill key={c} tone={x.balanced ? 'good' : 'bad'}>{c} {x.balanced ? 'balanced' : 'OUT OF BALANCE'}</Pill>)}>
          {!tb.data ? <Loading /> : (
            <div className="table-wrap scroll">
              <table className="tbl">
                <thead><tr><th>Ccy</th><th>Account</th><th>Type</th><th className="r">Debits</th><th className="r">Credits</th><th className="r">Balance</th></tr></thead>
                <tbody>{tb.data.accounts.map((a) => (
                  <tr key={a.currency + a.code}><td>{a.currency}</td><td>{a.code} {a.name}</td><td className="small muted">{a.account_type}</td>
                    <td className="r">{money(a.debit_cents)}</td><td className="r">{money(a.credit_cents)}</td><td className={`r strong ${a.balance_cents < 0 ? 'muted' : ''}`}>{money(a.balance_cents)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title="Revenue by program" subtitle="Interest is split at funding: investor share (base + investor margin) and Seaport spread. Seaport spread is recognised when the bank confirms settlement.">
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Program</th><th>Deal name</th><th>Ccy</th><th className="r">Loans</th><th className="r">Purchased</th><th className="r">Interest booked</th><th className="r">To investors</th><th className="r">Seaport earned</th><th className="r">Seaport unearned</th><th className="r">Late charges accrued</th></tr></thead>
            <tbody>{r.programs.map((p) => (
              <tr key={p.program_id}>
                <td className="strong">{p.program_code}</td><td>{p.deal_name}</td><td>{p.currency}</td><td className="r">{p.loans}</td>
                <td className="r">{money(p.purchased_cents, p.currency)}</td><td className="r">{money(p.interest_cents, p.currency)}</td><td className="r">{money(p.investor_cents, p.currency)}</td>
                <td className="r t-green">{money(p.earned_cents, p.currency)}</td><td className="r">{money(p.unearned_cents, p.currency)}</td>
                <td className={`r ${p.late_accrued_cents ? 't-amber' : ''}`}>{money(p.late_accrued_cents, p.currency)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>

      <Card title="Recent journal entries" subtitle="Append-only. Corrections are posted as reversing entries.">
        {!entries.data ? <Loading /> : (
          <div className="table-wrap scroll" style={{ maxHeight: 460 }}>
            <table className="tbl">
              <thead><tr><th>Entry</th><th>Date</th><th>Type</th><th>Description</th><th>Ccy</th><th className="r">Amount</th><th>By</th></tr></thead>
              <tbody>{entries.data.slice(0, 80).map((e) => {
                const total = e.lines.reduce((a, l) => a + l.debit_cents, 0);
                const loanId = e.lines.find((l) => l.loan_id)?.loan_id;
                return (
                  <Fragment key={e.id}>
                    <tr className="selectable" onClick={() => setOpenEntry(openEntry === e.id ? null : e.id)}>
                      <td className="mono">{e.ref}</td><td>{dateShort(e.entry_date)}</td><td><Pill tone="info">{e.source_type.replace('_', ' ').toLowerCase()}</Pill></td>
                      <td className="wrap">{e.description}{loanId && <> · <a href="#" onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); openLoan(loanId); }}>loan</a></>}</td>
                      <td>{e.currency}</td><td className="r">{moneyExact(total)}</td><td>{e.created_by}</td>
                    </tr>
                    {openEntry === e.id && e.lines.map((l) => (
                      <tr key={`${e.id}-${l.id}`} className="dim"><td /><td colSpan={3} className="small">{l.account_code} {l.account_name}</td><td /><td className="r small">{l.debit_cents ? `Dr ${moneyExact(l.debit_cents)}` : `Cr ${moneyExact(l.credit_cents)}`}</td><td /></tr>
                    ))}
                  </Fragment>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
