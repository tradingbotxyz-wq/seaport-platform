import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApi, symShort, money, dateShort, pct, navigate } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Pill, Donut, BarChart, Loading, ErrorBox, Empty, Button, Field } from '../ui.jsx';

const maturityLabel = (days) => (days === 0 ? 'Today' : `D+${days}`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;
const addMonths = (month, n) => {
  const t = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const band = (p) => (p > 100 ? 'b-red' : p >= 90 ? 'b-amber' : p >= 75 ? 'b-green' : 'b-blue');
const BUCKET_TONE = { '1-30': 'amber', '31-60': 'violet', '61-90': 'red', '90+': 'darkred' };
const etTime = (iso) => `${new Date(iso).toLocaleString('en-GB', { timeZone: 'America/New_York', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} ET`;

function presets(today) {
  const m = today.slice(0, 7);
  const q = addMonths(m, -((Number(m.slice(5, 7)) - 1) % 3));
  return [['MTD', m], ['QTD', q], ['YTD', `${m.slice(0, 4)}-01`], ['12M', addMonths(m, -11)], ['24M', addMonths(m, -23)], ['36M', addMonths(m, -35)]].map(([k, from]) => ({ k, from, to: m }));
}

export default function Dashboard() {
  const { openLoan, today } = useSession();
  const defaults = useMemo(() => ({ products: [], program_id: '', from: addMonths(today.slice(0, 7), -35), to: today.slice(0, 7) }), [today]);
  const [draft, setDraft] = useState(defaults);
  const [applied, setApplied] = useState(defaults);
  const qs = new URLSearchParams({ from: applied.from, to: applied.to });
  if (applied.products.length) qs.set('products', applied.products.join(','));
  if (applied.program_id) qs.set('program_id', applied.program_id);
  const { data: d, error, reload } = useApi(`/api/dashboard?${qs}`);
  const [day, setDay] = useState(null);
  const [bucket, setBucket] = useState(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { const t = setInterval(reload, 60_000); return () => clearInterval(t); }, [reload]);
  useEffect(() => { setDay(null); setBucket(null); }, [applied]);
  if (error && !d) return <ErrorBox error={error} />;
  if (!d) return <Loading />;

  const u = d.utilisation;
  const k = d.kpis;
  const buyers = showAll ? d.buyers : d.buyers.slice(0, 6);
  const loans = day === null ? d.due_loans : d.due_loans.filter((l) => l.maturity_date === d.next7[day].date);
  const pastLoans = bucket === null ? d.past_due.loans : d.past_due.loans.filter((l) => l.bucket === bucket);
  const programs = d.options.programs.filter((p) => !draft.products.length || draft.products.includes(p.program_type));
  const productLabel = applied.products.length ? d.options.products.filter((p) => applied.products.includes(p.code)).map((p) => p.label).join(', ') : 'all products';
  const dealLabel = applied.program_id ? d.options.programs.find((p) => String(p.id) === String(applied.program_id))?.deal_name : `${d.deals_in_scope} deal${d.deals_in_scope === 1 ? '' : 's'}`;
  const toggleProduct = (code) => setDraft((f) => {
    const products = f.products.includes(code) ? f.products.filter((c) => c !== code) : [...f.products, code];
    const keepDeal = !f.program_id || d.options.programs.some((p) => String(p.id) === String(f.program_id) && (!products.length || products.includes(p.program_type)));
    return { ...f, products, program_id: keepDeal ? f.program_id : '' };
  });

  return (
    <>
      <Card title="Filters" right={<span className="small muted"><span className="live-dot" />Live position · last refresh <b className="t-text">{etTime(d.refreshed_at)}</b></span>}>
        <div className="filters">
          <Field label="Product" hint="Multi-select. Narrows the deal list.">
            <div className="chips" role="group" aria-label="Product">
              {d.options.products.map((p) => (
                <button key={p.code} type="button" aria-pressed={draft.products.includes(p.code)} className={`chip outline ${draft.products.includes(p.code) ? 'on' : ''}`} onClick={() => toggleProduct(p.code)}>{p.label}</button>
              ))}
            </div>
          </Field>
          <Field label="Deal name" hint="Drives the buyer panel.">
            <select className="select" value={draft.program_id} onChange={(e) => setDraft({ ...draft, program_id: e.target.value })}>
              <option value="">All deals ({programs.length})</option>
              {programs.map((p) => <option key={p.id} value={p.id}>{p.deal_name}</option>)}
            </select>
          </Field>
          <div>
            <div className="date-range">
              <Field label="Date range"><input className="input" type="month" value={draft.from} max={draft.to} onChange={(e) => e.target.value && setDraft({ ...draft, from: e.target.value })} /></Field>
              <span className="muted small to">to</span>
              <Field label="To" hideLabel><input className="input" type="month" value={draft.to} min={draft.from} max={today.slice(0, 7)} onChange={(e) => e.target.value && setDraft({ ...draft, to: e.target.value })} /></Field>
            </div>
            <div className="chips" style={{ marginTop: 8 }}>
              {presets(today).map((p) => <button key={p.k} type="button" className={`chip xs ${draft.from === p.from && draft.to === p.to ? 'on' : ''}`} onClick={() => setDraft({ ...draft, from: p.from, to: p.to })}>{p.k}</button>)}
            </div>
          </div>
        </div>
        <div className="filters-foot">
          <div className="row">
            <Button variant="primary" onClick={() => setApplied(draft)}>Apply</Button>
            <Button onClick={() => { setDraft(defaults); setApplied(defaults); }}>Reset</Button>
          </div>
          <span className="small muted">Active: <b className="t-text">{productLabel}</b> · {dealLabel} · {monthLabel(applied.from)} – {monthLabel(applied.to)}</span>
        </div>
      </Card>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(340px, 1.15fr) repeat(3, minmax(0, 1fr))' }}>
        <div className="card" style={{ gridRow: 'span 2', display: 'flex', alignItems: 'center' }}>
          <div className="donut-wrap">
            <Donut center={pct(u.pct)} caption="utilized" size={150}
              segments={[
                { value: u.funded_usd_cents, color: 'var(--brand)' },
                { value: u.pipeline_usd_cents, color: 'var(--violet)' },
                { value: u.headroom_usd_cents, color: 'var(--surface-3)' },
              ]} />
            <div>
              <div className="muted small" style={{ marginBottom: 10 }}>Portfolio utilization</div>
              <div className="donut-legend">
                <i style={{ background: 'var(--brand)' }} /><span>Funded</span><span className="v num">{symShort(u.funded_usd_cents)}</span>
                <i className="hatch" /><span>Pipeline</span><span className="v num">{symShort(u.pipeline_usd_cents)}</span>
                <i style={{ background: 'var(--surface-3)', border: '1px solid var(--border-strong)' }} /><span>Headroom</span><span className="v num">{symShort(u.headroom_usd_cents)}</span>
              </div>
              <div className="muted small" style={{ marginTop: 12, maxWidth: 220 }}>Measured on finance amount, not invoice face value.</div>
            </div>
          </div>
        </div>
        <Kpi label="Approved limits" value={symShort(k.approved_limits_usd_cents)} sub={`${k.buyers_in_scope} buyers in scope`} />
        <Kpi label="Outstanding" value={symShort(k.outstanding_usd_cents)} sub="Funded principal" />
        <Kpi label="Pipeline" value={symShort(k.pipeline_usd_cents)} sub="Uploaded, not yet released" onClick={() => navigate('/purchase-funding')} />
        <Kpi label="Limit exceptions" value={`${k.limit_breaches} / ${k.limit_tight}`} sub="Breach / tight" tone={k.limit_breaches ? 'danger' : ''} onClick={() => navigate('/master-table')} />
        <Kpi label="Due next 7 days" value={symShort(k.due_7d_usd_cents)} sub={`${k.due_7d_count} loan IDs`} />
        <Kpi label="Past due" value={symShort(k.past_due_usd_cents)} sub={`${k.past_due_count} loan IDs`} tone={k.past_due_count ? 'danger' : ''}
          onClick={() => document.getElementById('past-due')?.scrollIntoView({ behavior: 'smooth' })} />
      </div>

      <div className="grid g2">
        <Card title="Buyer-wise limit vs usage" right="Funded + pipeline · by deal name">
          {!buyers.length ? <Empty>No buyers for this filter.</Empty> : buyers.map((b) => (
            <div className="buyer" key={b.id}>
              <div className="top">
                <span className="rating">{b.rating}</span>
                <span className="name">{b.name}</span>
                <span className="ctx">{b.role} · {b.deal_name}</span>
                <span className={`pct num ${b.status === 'Breach' ? 't-red' : b.status === 'Tight' ? 't-amber' : ''}`}>{pct(b.used_pct)}</span>
                <Pill status={b.status} />
              </div>
              <BandBar funded={b.funded_pct} pipeline={b.pipeline_pct} />
              <div className="bottom">
                <span className="num">{symShort(b.used_cents, b.currency)} / {symShort(b.limit_cents, b.currency)}</span>
                <span className={b.headroom_cents < 0 ? 't-red' : ''}>
                  {b.headroom_cents < 0 ? `${symShort(-b.headroom_cents, b.currency)} over limit` : `${symShort(b.headroom_cents, b.currency)} headroom`}
                </span>
              </div>
            </div>
          ))}
          {d.buyers.length > 6 && (
            <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setShowAll((s) => !s)}>{showAll ? 'Show fewer' : `Show all ${d.buyers.length} buyers`}</button>
          )}
          <div className="band-legend">
            <span><i className="b-blue" />&lt;75%</span><span><i className="b-green" />75–90%</span><span><i className="b-amber" />90–100%</span><span><i className="b-red" />&gt;100% breach</span><span><i className="hatch" />Pipeline — uploaded, not yet released</span>
          </div>
        </Card>

        <Card title="Outstanding in the next 7 days" right={day === null ? 'Rolling D+0 to D+7 · click a bar to filter' : <button className="btn sm" onClick={() => setDay(null)}>Clear filter: {d.next7[day].label}</button>}>
          <BarChart data={d.next7.map((x) => ({ key: x.date, label: x.label, value: x.amount_usd_cents, title: `${dateShort(x.date)} · ${x.count} loan(s)` }))}
            selected={day} onSelect={setDay} format={(v) => (v ? symShort(v) : '—')} />
          <div className="table-wrap scroll" style={{ marginTop: 16, maxHeight: 300 }}>
            {loans.length ? (
              <table className="tbl">
                <thead><tr><th>Loan ID</th><th>Buyer</th><th>Maturity</th><th className="r">Amount</th><th>State</th></tr></thead>
                <tbody>{loans.map((l) => (
                  <tr key={l.id} className="selectable" onClick={() => openLoan(l.id)}>
                    <td><a href="#" onClick={(e) => e.preventDefault()} className="strong">{l.loan_ref}</a></td><td>{l.buyer}</td><td>{maturityLabel(l.days)}</td>
                    <td className="r">{symShort(l.outstanding_cents, l.currency)}</td><td><Pill status={l.state} /></td>
                  </tr>))}</tbody>
              </table>
            ) : <Empty>No loans due {day === null ? 'in this window' : 'on this day'}.</Empty>}
          </div>
          {k.recon_breaks > 0 && <div className="muted small" style={{ marginTop: 10 }}>{k.recon_breaks} reconciliation break(s) open · <a href="/reconciliation" onClick={(e) => { e.preventDefault(); navigate('/reconciliation'); }}>review</a></div>}
        </Card>
      </div>

      <div id="past-due">
        <Card title="Past due by buyer and program" right={bucket === null ? 'Aged from adjusted maturity date · click a bucket to filter' : <button className="btn sm" onClick={() => setBucket(null)}>Clear filter: {d.past_due.buckets.find((b) => b.key === bucket).label}</button>}>
          <div className="grid g4">
            {d.past_due.buckets.map((b) => (
              <button key={b.key} type="button" className={`age-card ${BUCKET_TONE[b.key]} ${bucket === b.key ? 'on' : ''} ${bucket !== null && bucket !== b.key ? 'dim' : ''}`} onClick={() => setBucket(bucket === b.key ? null : b.key)}>
                <span className="label">{b.label}</span>
                <span className="value">{symShort(b.amount_usd_cents)}</span>
                <span className="sub">{b.count} loan ID{b.count === 1 ? '' : 's'}</span>
              </button>
            ))}
          </div>
          <div className="table-wrap scroll" style={{ marginTop: 16, maxHeight: 290 }}>
            {pastLoans.length ? (
              <table className="tbl">
                <thead><tr><th>Loan ID</th><th>Buyer</th><th>Deal / program</th><th className="r">Days past due</th><th className="r">Amount</th><th>Bucket</th><th>Last action</th></tr></thead>
                <tbody>{pastLoans.map((l) => (
                  <tr key={l.id} className="selectable" onClick={() => openLoan(l.id)}>
                    <td><a href="#" onClick={(e) => e.preventDefault()} className="strong">{l.loan_ref}</a></td><td>{l.buyer}</td><td>{l.deal_name}</td>
                    <td className="r t-red strong">{l.days_past_due}</td><td className="r">{symShort(l.outstanding_cents, l.currency)}</td>
                    <td><span className={`bucket-pill ${BUCKET_TONE[l.bucket]}`}>{l.bucket}</span></td>
                    <td className="wrap" title={l.last_action_at ? dateShort(l.last_action_at) : ''}>{l.last_action}</td>
                  </tr>))}</tbody>
              </table>
            ) : <Empty>No past-due loans{bucket ? ' in this bucket' : ''}.</Empty>}
          </div>
        </Card>
      </div>

      <Card title={`Historic program utilization — ${historyTitle(applied)}`} right="Month-end %">
        {d.history.points.length < 2 ? <Empty>Not enough month-end history for this range.</Empty> : <UtilisationChart points={d.history.points} threshold={d.history.threshold_pct} />}
        <div className="filters-foot" style={{ marginTop: 6 }}>
          <div className="band-legend" style={{ margin: 0 }}><span><i className="b-blue" />Month-end utilization</span><span><i className="b-red" />{d.history.threshold_pct}% line</span>{d.history.points.some((p) => p.live) && <span><i className="live" />Current month (live)</span>}</div>
          {d.history.peak != null && <span className="small">peak {Math.round(d.history.peak)}% · average {Math.round(d.history.average)}% · trough {Math.round(d.history.trough)}%</span>}
        </div>
      </Card>
      <div className="faint small">Headline figures in USD at master-table FX; table rows in each program's currency. As of {dateShort(d.as_of)} · {money(k.outstanding_usd_cents, 'USD')} outstanding.</div>
    </>
  );
}

function historyTitle({ from, to }) {
  const n = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
  return n % 12 === 0 ? `${n / 12} year${n === 12 ? '' : 's'}` : `${n} month${n === 1 ? '' : 's'}`;
}

/** Funded (solid, coloured by band) + pipeline (hatched); tick at 100%. */
function BandBar({ funded, pipeline }) {
  const total = funded + pipeline;
  const scale = Math.max(110, total);
  const w = (p) => `${Math.max(0, Math.min(100, (p / scale) * 100))}%`;
  return (
    <div className="bar-row">
      <div className="ubar" style={{ flex: 1 }} title={`${funded.toFixed(1)}% funded${pipeline ? ` + ${pipeline.toFixed(1)}% pipeline` : ''}`}>
        <div className={`seg cur ${band(total)}`} style={{ width: w(funded) }} />
        {pipeline > 0 && <div className="seg req" style={{ left: w(funded), width: w(pipeline) }} />}
        <div className="tick" style={{ left: w(100) }} />
      </div>
    </div>
  );
}

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(900);
  useLayoutEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function UtilisationChart({ points, threshold }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const H = 300, L = 52, R = 18, T = 14, B = 34;
  const max = Math.max(100, Math.ceil(Math.max(...points.map((p) => p.pct)) / 25) * 25);
  const x = (i) => L + (i * (width - L - R)) / Math.max(1, points.length - 1);
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.pct).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0)},${y(0)} Z`;
  const step = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor((width - L - R) / 90))));
  const ticks = points.map((p, i) => ({ p, i })).filter(({ i }) => (points.length - 1 - i) % step === 0);
  const last = points[points.length - 1];
  const h = hover !== null ? points[hover] : null;
  return (
    <div ref={ref} className="linechart">
      <svg width={width} height={H} role="img" aria-label={`Month-end utilization from ${monthLabel(points[0].month)} to ${monthLabel(last.month)}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.round(((e.clientX - r.left - L) / (width - L - R)) * (points.length - 1)); setHover(Math.max(0, Math.min(points.length - 1, i))); }}>
        <defs><linearGradient id="util-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--brand)" stopOpacity="0.28" /><stop offset="100%" stopColor="var(--brand)" stopOpacity="0.02" /></linearGradient></defs>
        {[0, 25, 50, 75, 100, 125].filter((v) => v <= max).map((v) => (
          <g key={v}><line x1={L} x2={width - R} y1={y(v)} y2={y(v)} stroke="var(--border)" /><text x={L - 10} y={y(v) + 4} textAnchor="end" fontSize="12" fill="var(--muted)">{v}%</text></g>
        ))}
        <path d={area} fill="url(#util-fill)" />
        <line x1={L} x2={width - R} y1={y(threshold)} y2={y(threshold)} stroke="var(--red)" strokeWidth="1.5" strokeDasharray="6 5" />
        <path d={line} fill="none" stroke="var(--brand)" strokeWidth="2.5" strokeLinejoin="round" />
        {ticks.map(({ p, i }) => <text key={p.month} x={x(i)} y={H - 10} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'} fontSize="12" fill="var(--muted)">{monthLabel(p.month)}</text>)}
        <circle cx={x(points.length - 1)} cy={y(last.pct)} r="4.5" fill={last.live ? 'var(--surface)' : 'var(--brand)'} stroke="var(--brand)" strokeWidth="2" />
        {h && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={y(0)} stroke="var(--border-strong)" />
            <circle cx={x(hover)} cy={y(h.pct)} r="4" fill="var(--brand)" />
            <g transform={`translate(${Math.min(x(hover) + 10, width - R - 150)},${Math.max(T, y(h.pct) - 46)})`}>
              <rect width="140" height="38" rx="6" fill="var(--surface)" stroke="var(--border)" />
              <text x="10" y="16" fontSize="11.5" fill="var(--muted)">{monthLabel(h.month)}{h.live ? ' · live' : ' · month-end'}</text>
              <text x="10" y="31" fontSize="13" fontWeight="700" fill="var(--text)">{h.pct.toFixed(1)}% utilized</text>
            </g>
          </g>
        )}
      </svg>
    </div>
  );
}
