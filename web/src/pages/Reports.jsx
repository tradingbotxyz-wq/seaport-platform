import { useEffect, useState } from 'react';
import { useApi, post, symShort, dateShort, dateTime, pct, bps, download } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Field, Button, BarChart, ErrorBox, Loading, Empty, Icon, useUi, useAction } from '../ui.jsx';

const TABS = [['exec', 'Executive dashboard'], ['builder', 'Report builder'], ['regulatory', 'Regulatory & audit exports'], ['investors', 'Investor statements']];
const OPS = [['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['contains', 'contains'], ['in', 'in list']];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function Reports() {
  const { can } = useSession();
  const tabs = TABS.filter(([k]) => (k === 'regulatory' ? can('reports.regulatory') : k === 'investors' ? can('portal.statements') : true));
  const [tab, setTab] = useState('exec');
  return (
    <>
      <div className="chips">{tabs.map(([k, l]) => <button key={k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'exec' && <Executive />}
      {tab === 'builder' && <Builder />}
      {tab === 'regulatory' && <Regulatory />}
      {tab === 'investors' && <InvestorStatements />}
    </>
  );
}

function Executive() {
  const { data: d, error } = useApi('/api/reports/executive');
  const [metric, setMetric] = useState('funded');
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Loading />;
  const k = d.kpis;
  const label = (m) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(2, 4)}`;
  const series = d.trend.map((t) => ({ key: t.month, label: label(t.month), value: metric === 'funded' ? t.funded_usd_cents : metric === 'collected' ? t.collected_usd_cents : (t.wa_yield_bps ?? 0) }));
  const Mix = ({ title, rows }) => (
    <Card title={title}>
      <div className="stack" style={{ gap: 9 }}>{rows.map((r) => (
        <div key={r.label}><div className="between small"><span className="strong">{r.label}</span><span className="muted">{symShort(r.usd_cents)} · {pct(r.pct)}</span></div>
          <div className="progress" style={{ height: 7, marginTop: 3 }}><div style={{ width: `${r.pct}%`, background: 'var(--brand)' }} /></div></div>
      ))}</div>
    </Card>
  );
  return (
    <>
      <div className="grid g6">
        <Kpi label="Portfolio yield" value={bps(k.portfolio_yield_bps)} sub={`All-in, principal weighted · ${k.loans} open loans`} />
        <Kpi label="Outstanding" value={symShort(k.outstanding_usd_cents)} sub={`WA ${k.wa_days_remaining} days remaining`} />
        <Kpi label="Non-performing (90+ days)" value={pct(k.npl_ratio_pct, 2)} sub={`30+ days ${pct(k.delinquency_30_pct, 2)} · any past due ${pct(k.past_due_pct, 2)}`} tone={k.npl_ratio_pct > 2 ? 'danger' : 'good'} />
        <Kpi label="LTV (secured obligors)" value={k.ltv_pct == null ? 'n/a' : pct(k.ltv_pct)} sub={`${k.ltv_coverage_obligors} obligor(s) with collateral / insurance`} />
        <Kpi label="Revenue, last 90 days" value={symShort(k.revenue_90d_usd_cents)} sub="Seaport spread + fees recognised" tone="good" />
        <Kpi label="Delinquency 30+" value={pct(k.delinquency_30_pct, 2)} sub="Share of principal" tone={k.delinquency_30_pct > 5 ? 'danger' : ''} />
      </div>
      <Card title="12-month trend" subtitle="USD equivalent at reference FX" right={<div className="chips">{[['funded', 'Fundings'], ['collected', 'Collections'], ['yield', 'Funding yield']].map(([m, l]) => <button key={m} className={`chip ${metric === m ? 'on' : ''}`} onClick={() => setMetric(m)}>{l}</button>)}</div>}>
        <BarChart data={series} format={(v) => (metric === 'yield' ? (v ? bps(v) : '') : v ? symShort(v) : '')} />
      </Card>
      <div className="grid g3">
        <Mix title="Top 10 obligor exposures" rows={d.top_obligors} />
        <Mix title="By risk rating" rows={d.by_rating} />
        <Mix title="By program" rows={d.by_program} />
      </div>
    </>
  );
}

function Builder() {
  const { toast, fail } = useUi();
  const ds = useApi('/api/reports/datasets');
  const saved = useApi('/api/reports/saved');
  const [def, setDef] = useState({ dataset: 'loans', columns: [], filters: [], group_by: [], aggregates: [], sort: null, limit: 1000 });
  const [result, setResult] = useState(null);
  const [title, setTitle] = useState('');
  const [busy, run] = useAction();
  const dataset = (ds.data ?? []).find((d) => d.key === def.dataset);
  useEffect(() => { if (dataset && !def.columns.length) setDef((d) => ({ ...d, columns: dataset.columns.slice(0, 8).map((c) => c.key) })); }, [dataset?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const cols = dataset?.columns ?? [];
  const numeric = cols.filter((c) => c.type !== 'text' && c.type !== 'date');
  const toggle = (k) => setDef((d) => ({ ...d, columns: d.columns.includes(k) ? d.columns.filter((x) => x !== k) : [...d.columns, k] }));
  const runIt = () => run(async () => setResult(await post('/api/reports/run', def)));
  const exp = (format) => run(async () => { const r = await post('/api/reports/export', { definition: def, title: title || dataset?.label, format }); await download(`/api/documents/${r.document_id}/file`, r.filename).catch(fail); toast(`${r.filename} exported`, 'success'); });
  const save = () => run(async () => { await post('/api/reports/saved', { name: title || `${dataset.label} report`, definition: def, shared: true }); toast('Report saved', 'success'); saved.reload(); });
  const fmt = (v, t) => (v == null ? '—' : t === 'money' ? Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : t === 'percent' ? `${(Number(v) * 100).toFixed(2)}%` : t === 'number' ? Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v));
  if (!ds.data) return <Loading />;
  return (
    <>
      <Card title="Report builder" subtitle="Pick a dataset, columns and filters; optionally group and aggregate. Runs read-only, parameterised queries over whitelisted fields."
        right={(saved.data ?? []).length > 0 && (
          <select className="select sm" style={{ width: 240 }} value="" onChange={(e) => { const r = saved.data.find((x) => String(x.id) === e.target.value); if (r) { setDef(r.definition); setTitle(r.name); setResult(null); } }} aria-label="Open saved report">
            <option value="">Open saved report…</option>{saved.data.map((r) => <option key={r.id} value={r.id}>{r.name}{r.mine ? '' : ' (shared)'}</option>)}
          </select>
        )}>
        <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)' }}>
          <div className="stack" style={{ gap: 12 }}>
            <Field label="Dataset"><select className="select" value={def.dataset} onChange={(e) => { setDef({ dataset: e.target.value, columns: [], filters: [], group_by: [], aggregates: [], sort: null, limit: 1000 }); setResult(null); }}>{ds.data.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></Field>
            <div className="small muted">{dataset?.description}</div>
            <Field label="Report title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={dataset?.label} /></Field>
            <Field label="Group by (optional)"><select className="select" value={def.group_by[0] ?? ''} onChange={(e) => setDef({ ...def, group_by: e.target.value ? [e.target.value] : [], aggregates: e.target.value && !def.aggregates.length && numeric[0] ? [{ column: numeric[0].key, fn: 'sum' }] : def.aggregates })}>
              <option value="">No grouping</option>{cols.filter((c) => c.type === 'text' || c.type === 'date').map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></Field>
            {def.group_by.length > 0 && (
              <Field label="Aggregates">
                <div className="stack">
                  {def.aggregates.map((a, i) => (
                    <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
                      <select className="select sm" value={a.fn} onChange={(e) => setDef({ ...def, aggregates: def.aggregates.map((x, j) => (j === i ? { ...x, fn: e.target.value } : x)) })}>{['sum', 'avg', 'min', 'max', 'count'].map((f) => <option key={f}>{f}</option>)}</select>
                      <select className="select sm" value={a.column} onChange={(e) => setDef({ ...def, aggregates: def.aggregates.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })}>{(a.fn === 'count' ? cols : numeric).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
                      <button className="icon-btn" onClick={() => setDef({ ...def, aggregates: def.aggregates.filter((_, j) => j !== i) })} aria-label="Remove aggregate"><Icon name="x" size={14} /></button>
                    </div>
                  ))}
                  <Button size="sm" icon="plus" onClick={() => setDef({ ...def, aggregates: [...def.aggregates, { column: numeric[0]?.key, fn: 'sum' }] })}>Add aggregate</Button>
                </div>
              </Field>
            )}
            <Field label="Filters">
              <div className="stack">
                {def.filters.map((f, i) => (
                  <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
                    <select className="select sm" value={f.column} onChange={(e) => setDef({ ...def, filters: def.filters.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })}>{cols.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
                    <select className="select sm" style={{ width: 100 }} value={f.op} onChange={(e) => setDef({ ...def, filters: def.filters.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) })}>{OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                    <input className="input sm" value={f.value} onChange={(e) => setDef({ ...def, filters: def.filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} aria-label="Filter value" />
                    <button className="icon-btn" onClick={() => setDef({ ...def, filters: def.filters.filter((_, j) => j !== i) })} aria-label="Remove filter"><Icon name="x" size={14} /></button>
                  </div>
                ))}
                <Button size="sm" icon="plus" onClick={() => setDef({ ...def, filters: [...def.filters, { column: cols[0].key, op: 'eq', value: '' }] })}>Add filter</Button>
              </div>
            </Field>
          </div>
          <div>
            {!def.group_by.length && (
              <Field label="Columns">
                <div className="chips">{cols.map((c) => <button key={c.key} className={`chip ${def.columns.includes(c.key) ? 'on' : ''}`} onClick={() => toggle(c.key)}>{c.label}</button>)}</div>
              </Field>
            )}
            <div className="row" style={{ marginTop: 14 }}>
              <Button variant="primary" disabled={busy} onClick={runIt}>Run report</Button>
              <Button icon="download" disabled={busy} onClick={() => exp('xlsx')}>Excel</Button>
              <Button icon="download" disabled={busy} onClick={() => exp('pdf')}>PDF</Button>
              <Button icon="download" disabled={busy} onClick={() => exp('csv')}>CSV</Button>
              <Button disabled={busy} onClick={save}>Save report</Button>
            </div>
          </div>
        </div>
      </Card>
      {result && (
        <Card title={`${title || result.dataset} · ${result.rows.length} rows${result.truncated ? ' (limit reached)' : ''}`}>
          {!result.rows.length ? <Empty>No rows match.</Empty> : (
            <div className="table-wrap scroll" style={{ maxHeight: 520 }}><table className="tbl">
              <thead><tr>{result.columns.map((c) => (
                <th key={c.key} className={['money', 'number', 'percent'].includes(c.type) ? 'r' : ''} style={{ cursor: 'pointer' }}
                  onClick={() => { const dir = def.sort?.column === c.key && def.sort.dir === 'asc' ? 'desc' : 'asc'; const nd = { ...def, sort: { column: c.key, dir } }; setDef(nd); run(async () => setResult(await post('/api/reports/run', nd))); }}>
                  {c.label}{def.sort?.column === c.key ? (def.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>
              ))}</tr></thead>
              <tbody>{result.rows.map((r, i) => <tr key={i}>{result.columns.map((c) => <td key={c.key} className={['money', 'number', 'percent'].includes(c.type) ? 'r' : ''}>{fmt(r[c.key], c.type)}</td>)}</tr>)}</tbody>
            </table></div>
          )}
        </Card>
      )}
    </>
  );
}

function Regulatory() {
  const { today } = useSession();
  const { toast, fail } = useUi();
  const list = useApi('/api/reports/regulatory');
  const history = useApi('/api/reports/history');
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [year, setYear] = useState(today.slice(0, 4));
  const [busy, run] = useAction();
  const go = (key, format) => run(async () => {
    const r = await post(`/api/reports/regulatory/${key}`, { from, to, year: Number(year), format });
    await download(`/api/documents/${r.document_id}/file`, r.filename).catch(fail);
    toast(`${r.filename} generated and logged`, 'success');
    history.reload();
  });
  return (
    <>
      <Card title="Regulatory and audit exports" subtitle="Each export is generated from the system of record, stored in the document store and recorded in the audit trail."
        right={<div className="row"><Field label="From"><input className="input sm" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To"><input className="input sm" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field><Field label="Tax year"><input className="input sm" style={{ width: 90 }} value={year} onChange={(e) => setYear(e.target.value)} /></Field></div>}>
        {!list.data ? <Loading /> : (
          <div className="table-wrap"><table className="tbl">
            <tbody>{list.data.map((x) => (
              <tr key={x.key}><td className="strong">{x.label}</td><td className="wrap small muted">{x.description}</td>
                <td className="r"><div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                  <Button size="sm" icon="download" disabled={busy} onClick={() => go(x.key, 'xlsx')}>Excel</Button>
                  <Button size="sm" icon="download" disabled={busy} onClick={() => go(x.key, 'csv')}>CSV</Button>
                  <Button size="sm" icon="download" disabled={busy} onClick={() => go(x.key, 'pdf')}>PDF</Button>
                </div></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Card title="Export history">
        {!history.data ? <Loading /> : !history.data.length ? <Empty>No exports yet.</Empty> : (
          <div className="table-wrap scroll"><table className="tbl"><thead><tr><th>File</th><th>Size</th><th>By</th><th>When</th><th /></tr></thead>
            <tbody>{history.data.map((h) => <tr key={h.id}><td className="strong">{h.filename}</td><td>{Math.ceil(h.size_bytes / 1024)} KB</td><td>{h.created_by}</td><td>{dateTime(h.created_at)}</td>
              <td><Button size="sm" icon="download" onClick={() => download(`/api/documents/${h.id}/file`, h.filename).catch(fail)}>Download</Button></td></tr>)}</tbody></table></div>
        )}
      </Card>
    </>
  );
}

function InvestorStatements() {
  const { today } = useSession();
  const { toast, fail } = useUi();
  const investors = useApi('/api/investors');
  const [busy, run] = useAction();
  const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  const [from, setFrom] = useState(`${today.slice(0, 4)}-${String(q * 3 + 1).padStart(2, '0')}-01`);
  const [to, setTo] = useState(today);
  const gen = (id, kind) => run(async () => {
    const r = kind === 'statement' ? await post(`/api/reports/investors/${id}/statement`, { from, to }) : await post(`/api/reports/investors/${id}/tax/${today.slice(0, 4)}`);
    await download(`/api/documents/${r.document_id}/file`, r.filename).catch(fail);
    toast(`${r.filename} generated — also visible in the investor's portal`, 'success');
  });
  return (
    <Card title="Investor statements and tax summaries" subtitle="Generated PDFs are published to each investor's portal."
      right={<div className="row"><Field label="Period from"><input className="input sm" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="to"><input className="input sm" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>}>
      {!investors.data ? <Loading /> : (
        <div className="table-wrap"><table className="tbl"><thead><tr><th>Investor</th><th className="r">Loans funded</th><th /></tr></thead>
          <tbody>{investors.data.map((i) => (
            <tr key={i.id}><td className="strong">{i.code} · {i.name}</td><td className="r">{i.loans}</td>
              <td className="r"><div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}><Button size="sm" disabled={busy} onClick={() => gen(i.id, 'statement')}>Capital statement</Button><Button size="sm" disabled={busy} onClick={() => gen(i.id, 'tax')}>Tax summary {today.slice(0, 4)}</Button></div></td></tr>
          ))}</tbody></table></div>
      )}
    </Card>
  );
}

