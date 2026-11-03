import { useEffect, useRef, useState } from 'react';
import { useApi, post, fileToBase64, money, moneyShort, dateShort, dateTime, setQuery, useLocation, navigate } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Field, FileDrop, Button, Pill, ErrorBox, Loading, Empty, useUi, useAction } from '../ui.jsx';
import { currencyFooter, programOption, SkippedRows } from './shared.jsx';

const FILTERS = [['ALL', 'All'], ['RECEIVED', 'Received'], ['SHORT_PAID', 'Short paid'], ['PENDING', 'Pending']];

export default function Settlement() {
  const { today, can } = useSession();
  const { toast } = useUi();
  const { query } = useLocation();
  const selectedId = query.get('import') ? Number(query.get('import')) : null;
  const programs = useApi('/api/programs');
  const list = useApi('/api/settlements');
  const view = useApi(selectedId ? `/api/settlements/${selectedId}` : null);
  const [programId, setProgramId] = useState('');
  const [date, setDate] = useState(today);
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, run] = useAction();
  const inputRef = useRef(null);
  const program = (programs.data ?? []).find((p) => String(p.id) === String(programId));
  const v = view.data && view.data.settlement.id === selectedId ? view.data : null;

  useEffect(() => { if (!selectedId && list.data?.length) setQuery('import', list.data[0].id); }, [list.data, selectedId]);
  useEffect(() => { if (!programId && programs.data?.length) setProgramId(String(programs.data[0].id)); }, [programs.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (v) { setProgramId(String(v.settlement.program_id)); setDate(v.settlement.settlement_date); } }, [v?.settlement.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = () => run(async () => {
    if (!file) { view.reload(); return; }
    const content_base64 = await fileToBase64(file);
    const r = await post('/api/settlements', { program_id: Number(programId), settlement_date: date, filename: file.name, content_base64 });
    setResult(r);
    setFile(null);
    list.reload();
    setQuery('import', r.id);
    toast(`${file.name}: ${r.matched} matched, ${r.unmatched} unmatched`, r.unmatched ? 'info' : 'success');
  });

  const rows = list.data ?? [];
  const foot = currencyFooter(rows.map((r) => ({ ...r, currency: r.currency })), ['due_cents', 'received_cents', 'outstanding_cents']);

  return (
    <>
      <Card title="Settlement file imports" subtitle="Select a row to load that settlement below" right={`${rows.length} files loaded`}>
        <ErrorBox error={list.error} />
        {!list.data ? <Loading /> : !rows.length ? <Empty>No settlement files uploaded yet.</Empty> : (
          <div className="table-wrap scroll">
            <table className="tbl">
              <thead><tr><th>File</th><th>Program ID</th><th>Deal name</th><th>Settlement date</th><th>Currency</th><th className="r">Amount due</th><th className="r">Amount received</th><th className="r">Outstanding</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`selectable ${r.id === selectedId ? 'selected' : ''}`} onClick={() => setQuery('import', r.id)}>
                    <td><span className="file-link">{r.filename}</span></td>
                    <td>{r.program_code}</td>
                    <td>{r.deal_name}</td>
                    <td className="nowrap">{dateShort(r.settlement_date)}</td>
                    <td>{r.currency}</td>
                    <td className="r">{money(r.due_cents, r.currency)}</td>
                    <td className="r">{money(r.received_cents, r.currency)}</td>
                    <td className={`r ${r.outstanding_cents ? 't-red strong' : ''}`}>{money(r.outstanding_cents, r.currency)}</td>
                    <td><Pill status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr>
                <td colSpan={5}>{rows.length} files · USD subtotal ({foot.usdCount} files)</td>
                <td className="r">USD {money(foot.sums.due_cents)}</td>
                <td className="r">USD {money(foot.sums.received_cents)}</td>
                <td className="r">USD {money(foot.sums.outstanding_cents)}</td>
                <td className="muted" style={{ fontWeight: 400 }}>{foot.othersLabel}</td>
              </tr></tfoot>
            </table>
          </div>
        )}
      </Card>

      <Card title="Select settlement and upload" right={program && <>Currency <b>{program.currency}</b> · value date <b>{dateShort(date)}</b> · accepted formats xls, xlsx, csv, pdf</>}>
        <div className="grid g3">
          <Field label="Deal name" hint="Sets currency and collection account.">
            <select className="select" value={programId} onChange={(e) => setProgramId(e.target.value)}>
              {(programs.data ?? []).map((p) => <option key={p.id} value={p.id}>{programOption(p)}</option>)}
            </select>
          </Field>
          <Field label="Settlement date" hint="Value date of funds received.">
            <input className="input" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Upload settlement file">
            <FileDrop file={file} onFile={setFile} accept=".xlsx,.csv,.txt,.pdf" inputRef={inputRef}
              title={file ? file.name : v ? v.settlement.filename : 'Drop a settlement advice here'} hint="Drag a file here, or browse" />
            {v && !file && (
              <div className="meta-line">
                <span>File <b>{v.settlement.filename}</b></span>
                <span>Rows read <b>{v.settlement.rows_read}</b></span>
                <span className="ok">Matched <b>{v.settlement.matched}</b></span>
                <span>Unmatched <b className={v.settlement.unmatched ? 't-red' : ''}>{v.settlement.unmatched}</b></span>
                <span>Checksum <b>verified</b></span>
              </div>
            )}
          </Field>
        </div>
        <div className="divider" />
        <div className="between">
          <div className="row">
            <Button variant="primary" disabled={busy || (file && !can('settlement.upload')) || (!file && !v)} onClick={load}>{file ? 'Upload & load settlement' : 'Load settlement'}</Button>
            <Button onClick={() => { setFile(null); setResult(null); }}>Clear</Button>
          </div>
          {v && <div className="muted small">Loaded: <b>{v.settlement.deal_code}</b> · settlement <b>{dateShort(v.settlement.settlement_date)}</b> · <b>{v.kpis.loans} loan IDs</b></div>}
        </div>
        {result && result.id === selectedId && <SkippedRows report={{ skipped: result.skipped, warnings: result.warnings }} />}
      </Card>

      {selectedId && !v && (view.error ? <ErrorBox error={view.error} /> : <Loading />)}
      {v && <SettlementDetail v={v} />}
    </>
  );
}

function SettlementDetail({ v }) {
  const { openLoan } = useSession();
  const [filter, setFilter] = useState('ALL');
  const s = v.settlement;
  const k = v.kpis;
  const ccy = s.currency;
  const matched = v.advices.filter((a) => a.match_status === 'MATCHED');
  const unmatched = v.advices.filter((a) => a.match_status !== 'MATCHED');
  const shown = filter === 'ALL' ? matched : matched.filter((a) => a.advised_status === filter);
  const due = k.due_cents || 1;
  const recPct = (k.received_cents / due) * 100;
  const shortPct = (k.shortfall_cents / due) * 100;
  const pendPct = (k.pending_cents / due) * 100;
  const allSettled = k.loans > 0 && k.bank_settled === k.loans;
  const counts = { ALL: matched.length, RECEIVED: k.received, SHORT_PAID: k.short_paid, PENDING: k.pending };

  return (
    <>
      <div className="grid g4">
        <Kpi label="Loan IDs in file" value={k.loans} sub={`${k.received} received, ${k.pending} pending${k.short_paid ? `, ${k.short_paid} short paid` : ''}`} />
        <Kpi label="Amount due" value={moneyShort(k.due_cents, ccy)} sub={`Reported in ${ccy}`} />
        <Kpi label="Amount received" value={moneyShort(k.received_cents, ccy)} sub={`${Math.round(recPct)}% of due`} />
        <Kpi label="Outstanding" value={moneyShort(k.outstanding_cents, ccy)} sub="Stays open" tone={k.outstanding_cents ? 'danger' : ''} />
        <Kpi label="Late payment charges" value={moneyShort(k.late_charges_cents, ccy)} sub={k.late_charges_cents ? `Accrued to ${dateShort(v.late_charge_as_of)}` : 'Nothing past maturity'} tone={k.late_charges_cents ? 'warn' : ''} />
        <Kpi label="Short paid" value={k.short_paid} sub={k.short_paid ? `${money(k.shortfall_cents, ccy)} shortfall` : 'None'} tone={k.short_paid ? 'danger' : ''} />
        <Kpi label="Settlement date" value={dateShort(s.settlement_date)} sub="Value date" />
      </div>

      <Card title="Repayments in this settlement" subtitle={`${ccy} · collection account ${s.collection_account}`}
        right={allSettled ? <Pill tone="good">Settled — confirmed by bank</Pill> : <Pill tone="warn">Bank confirmed {k.bank_settled} of {k.loans}</Pill>}>
        <div className="infobar">
          <span>Uploaded by <b>{s.uploaded_by_name}</b> · {dateTime(s.uploaded_at)}</span>
          <span className="sep">|</span>
          <span>This screen records what the client or bank <b>advised</b>. It applies no cash and carries no approval. Settled status is written back automatically when the loan ID is matched on the bank statement (<a href="/reconciliation" onClick={(e) => { e.preventDefault(); navigate('/reconciliation'); }}>Reconciliation</a>).</span>
        </div>
        <div className="progress" aria-label="Received, short paid and pending">
          <div style={{ width: `${recPct}%`, background: 'var(--green)' }} />
          <div style={{ width: `${shortPct}%`, background: 'var(--red)' }} />
          <div style={{ width: `${pendPct}%`, background: 'var(--amber)' }} />
        </div>
        <div className="legend" style={{ marginBottom: 14 }}>
          <span><i style={{ background: 'var(--green)' }} />Received <b>{moneyShort(k.received_cents, ccy)}</b> · {Math.round(recPct)}%</span>
          <span><i style={{ background: 'var(--red)' }} />Short paid shortfall <b>{moneyShort(k.shortfall_cents, ccy)}</b> · {Math.round(shortPct)}%</span>
          <span><i style={{ background: 'var(--amber)' }} />Pending <b>{moneyShort(k.pending_cents, ccy)}</b> · {Math.round(pendPct)}%</span>
        </div>
        <div className="chips" style={{ marginBottom: 12 }}>
          {FILTERS.map(([key, label]) => <button key={key} className={`chip ${filter === key ? 'on' : ''}`} onClick={() => setFilter(key)}>{label}<span className="n">{counts[key]}</span></button>)}
        </div>
        {shown.length === 0 ? <Empty>No repayments in this view.</Empty> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr>
                <th>Loan ID</th><th>Invoice</th><th>Buyer</th><th>Maturity</th><th className="r">Amount due {ccy}</th><th className="r">Amount received {ccy}</th>
                <th className="r">Variance {ccy}</th><th>Received</th><th>Advised status</th><th>Value date</th><th className="r">Late charge</th><th>Uploaded by</th><th>Bank confirmation</th><th>Settled status</th>
              </tr></thead>
              <tbody>
                {shown.map((a) => (
                  <tr key={a.id}>
                    <td><a href="#" className="strong" onClick={(e) => { e.preventDefault(); openLoan(a.loan_id); }}>{a.loan_ref}</a></td>
                    <td className="t-brand strong">{a.invoice_number}</td>
                    <td className="nowrap">{a.buyer}</td>
                    <td className="nowrap">{dateShort(a.maturity_date)}</td>
                    <td className="r">{money(a.due_cents, ccy)}</td>
                    <td className={`r ${a.advised_status === 'RECEIVED' ? 't-green' : a.advised_status === 'SHORT_PAID' ? 't-red' : ''}`}>{money(Math.min(a.amount_cents, a.due_cents), ccy)}</td>
                    <td className={`r ${a.variance_cents ? 't-red' : ''}`}>{a.variance_cents ? money(a.variance_cents, ccy) : '—'}</td>
                    <td><span className={`mini-bar ${a.advised_status === 'SHORT_PAID' ? 'short' : ''}`}><div style={{ width: `${a.received_pct}%` }} /></span></td>
                    <td><Pill status={a.advised_status} /></td>
                    <td className="nowrap">{dateShort(a.value_date)}</td>
                    <td className="r">{a.late_charge?.charge_cents ? <span className="t-amber" title={`${a.late_charge.days_past_due} days past maturity`}>{money(a.late_charge.charge_cents, ccy)}</span> : '—'}</td>
                    <td>{s.uploaded_by_name}</td>
                    <td className="t-brand strong">{a.loan_status === 'SETTLED' ? a.bank_confirmation : '—'}</td>
                    <td>{a.loan_status === 'SETTLED' ? <Pill tone="good">Settled</Pill> : <Pill tone="">Awaiting bank</Pill>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr>
                <td colSpan={4}>Total — {k.received} received of {k.loans}</td>
                <td className="r">{money(k.due_cents, ccy)}</td>
                <td className="r">{money(k.received_cents, ccy)}</td>
                <td className="r">{money(k.outstanding_cents, ccy)}</td>
                <td colSpan={7}>{k.bank_settled} of {k.loans} settled on the bank statement</td>
              </tr></tfoot>
            </table>
          </div>
        )}
        {unmatched.length > 0 && (
          <>
            <div className="section-title t-red">Not matched to a funded loan ({unmatched.length})</div>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Loan ID in file</th><th>Invoice in file</th><th className="r">Amount</th><th>Bank ref</th><th>Reason</th></tr></thead>
                <tbody>{unmatched.map((a) => <tr key={a.id}><td>{a.loan_ref_raw ?? '—'}</td><td>{a.invoice_number_raw ?? '—'}</td><td className="r">{money(a.amount_cents, ccy)}</td><td>{a.bank_reference ?? '—'}</td><td className="t-red wrap">{a.match_note}</td></tr>)}</tbody>
              </table>
            </div>
          </>
        )}
        <div className="footnotes">
          <span>Variance = amount due − amount received, as advised</span>
          <span>Settled status is set by the bank statement on Reconciliation — it cannot be set here</span>
          <span>Short paid and pending items stay open and age into the past due view on the dashboard</span>
          <span>Late charge = shortfall × (base + {(s.late_margin_bps / 100).toFixed(2)}%) × days past maturity to {dateShort(v.late_charge_as_of)} ÷ day count</span>
        </div>
      </Card>
    </>
  );
}
