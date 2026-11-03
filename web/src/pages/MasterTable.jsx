import { useState, Fragment } from 'react';
import { useApi, post, put, navigate, money, moneyShort, pct, bps, advPct, dateShort, toCents, toBps, doneMessage, isPending } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Field, Button, Pill, Modal, UsageBar, ErrorBox, Loading, Icon, useUi, useAction } from '../ui.jsx';

const BUCKETS = ['1-30', '31-90', '91-180', '181+'];
const TYPES = { SCF: 'Supply chain finance', IF: 'Invoice finance', RPA: 'Receivables purchase', LC_BACKED: 'LC-backed', INSURED_AR: 'Insured receivables' };

export default function MasterTable() {
  const { can } = useSession();
  const programs = useApi('/api/programs');
  const fixings = useApi('/api/fixings');
  const investors = useApi('/api/investors');
  const fx = useApi('/api/fx');
  const [open, setOpen] = useState(() => new Set());
  const [editOb, setEditOb] = useState(null);
  const [newOb, setNewOb] = useState(null);
  const [newProgram, setNewProgram] = useState(false);
  const [newFixing, setNewFixing] = useState(false);
  if (programs.error) return <ErrorBox error={programs.error} />;
  if (!programs.data) return <Loading />;
  const list = programs.data;
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const obligors = list.flatMap((p) => p.obligors);
  const latest = latestFixings(fixings.data ?? []);

  return (
    <>
      <div className="grid g4">
        <Kpi label="Programs" value={list.length} sub={`${list.filter((p) => p.status === 'ACTIVE').length} active`} />
        <Kpi label="Obligors" value={obligors.length} sub={`${obligors.filter((o) => o.active).length} active`} />
        <Kpi label="Limit exceptions" value={`${obligors.filter((o) => o.status === 'Breach').length} / ${obligors.filter((o) => o.status === 'Tight').length}`} sub="Breach / tight" tone={obligors.some((o) => o.status === 'Breach') ? 'danger' : ''} />
        <Kpi label="Investors" value={investors.data?.length ?? '—'} sub="Funding partners" />
      </div>

      <Card title="Programs" subtitle="Deals, obligors, limits and pricing. Changes are restricted to Credit and recorded in the audit trail with before / after values."
        right={can('master.edit') && <Button size="sm" icon="plus" onClick={() => setNewProgram(true)}>New program</Button>}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr>
              <th /><th>Program ID</th><th>Deal code</th><th>Deal name</th><th>Client</th><th>Type</th><th>Ccy</th><th>Rate basis</th><th>Day count</th><th>Funding</th>
              <th className="r">Limits</th><th className="r">Funded</th><th className="r">Pipeline</th><th style={{ minWidth: 130 }}>Utilisation</th><th className="r">Open loans</th><th>Status</th>
            </tr></thead>
            <tbody>
              {list.map((p) => {
                const util = p.limit_cents ? ((p.funded_cents + p.pipeline_cents) * 100) / p.limit_cents : 0;
                const isOpen = open.has(p.id);
                return (
                  <Fragment key={p.id}>
                    <tr className="selectable" onClick={() => toggle(p.id)}>
                      <td><Icon name={isOpen ? 'down' : 'right'} size={15} /></td>
                      <td className="strong">{p.program_code}</td>
                      <td className="mono">{p.deal_code}</td>
                      <td>{p.deal_name}</td>
                      <td>{p.client_name}</td>
                      <td title={TYPES[p.program_type]}>{p.program_type.replace('_', '-')}</td>
                      <td>{p.currency}</td>
                      <td>{p.rate_basis}</td>
                      <td>{p.day_count}</td>
                      <td>T+{p.funding_lag_days}</td>
                      <td className="r">{moneyShort(p.limit_cents, p.currency)}</td>
                      <td className="r">{moneyShort(p.funded_cents, p.currency)}</td>
                      <td className="r t-violet">{moneyShort(p.pipeline_cents, p.currency)}</td>
                      <td><div className="row" style={{ flexWrap: 'nowrap' }}><UsageBar currentPct={util} status={util > 100 ? 'Breach' : util >= 95 ? 'Tight' : 'Good'} style={{ flex: 1 }} /><span className="small num">{pct(util)}</span></div></td>
                      <td className="r">{p.open_loans}</td>
                      <td><Pill status={p.status} /></td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={16} style={{ background: 'var(--surface-2)', padding: 14 }}>
                          <div className="between" style={{ marginBottom: 10 }}>
                            <span className="muted small">Collection account <b>{p.collection_account}</b> · late charge margin <b>{bps(p.late_margin_bps)}</b> over base</span>
                            <div className="row">{can('underwrite.prepare') && <Button size="sm" icon="shield" onClick={() => navigate('/underwriting')}>New obligor via underwriting</Button>}{can('master.edit') && <Button size="sm" icon="plus" onClick={() => setNewOb(p)}>Add obligor directly</Button>}</div>
                          </div>
                          <div className="table-wrap">
                            <table className="tbl">
                              <thead><tr>
                                <th>Obligor</th><th>Rating</th><th>Role</th><th className="r">Limit</th><th className="r">Advance</th><th className="r">Investor margin</th><th className="r">SP spread</th>
                                <th className="r">Funded</th><th className="r">Pipeline</th><th className="r">Used</th><th>Status</th><th>Auto-debit</th><th>Active</th><th />
                              </tr></thead>
                              <tbody>
                                {p.obligors.map((o) => (
                                  <tr key={o.id} className={o.active ? '' : 'dim'}>
                                    <td className="strong">{o.name}</td>
                                    <td><span className="rating">{o.rating}</span></td>
                                    <td>{o.role}</td>
                                    <td className="r">{money(o.limit_cents, p.currency)}</td>
                                    <td className="r">{advPct(o.advance_rate_bps)}</td>
                                    <td className="r">{bps(o.investor_margin_bps)}</td>
                                    <td className="r">{bps(o.sp_spread_bps)}</td>
                                    <td className="r">{money(o.funded_cents, p.currency)}</td>
                                    <td className="r t-violet">{money(o.pipeline_cents, p.currency)}</td>
                                    <td className={`r strong ${o.status === 'Breach' ? 't-red' : o.status === 'Tight' ? 't-amber' : ''}`}>{pct(o.used_pct)}</td>
                                    <td><Pill status={o.status} /></td>
                                    <td>{o.auto_debit ? 'Yes' : 'No'}</td>
                                    <td>{o.active ? 'Yes' : 'No'}</td>
                                    <td><div className="row" style={{ flexWrap: 'nowrap' }}>{can('underwrite.prepare') && <Button size="sm" icon="shield" onClick={() => navigate(`/underwriting?new=${o.id}`)} title="Start a credit application (limit increase / renewal)">Credit review</Button>}{can('master.edit') && <Button size="sm" icon="edit" onClick={() => setEditOb({ ...o, program: p })}>Edit</Button>}</div></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid g2">
        <Card title="Benchmark fixings" subtitle="Latest fixing per benchmark and tenor bucket. Funding uses the latest fixing on or before the funding date."
          right={can('master.rates') && <Button size="sm" icon="plus" onClick={() => setNewFixing(true)}>Add fixing</Button>}>
          {!fixings.data ? <Loading /> : (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Benchmark</th><th>Fixing date</th>{BUCKETS.map((b) => <th key={b} className="r">{b.replace('-', '–')} days</th>)}</tr></thead>
                <tbody>{latest.map((r) => <tr key={r.benchmark}><td className="strong">{r.benchmark}</td><td>{dateShort(r.fixing_date)}</td>{BUCKETS.map((b) => <td key={b} className="r">{bps(r.rates[b])}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="stack" style={{ gap: 16 }}>
          <InvestorsCard investors={investors} />
          <FxCard fx={fx} />
        </div>
      </div>

      {editOb && <ObligorModal obligor={editOb} program={editOb.program} onClose={() => setEditOb(null)} onSaved={() => { setEditOb(null); programs.reload(); }} />}
      {newOb && <ObligorModal program={newOb} onClose={() => setNewOb(null)} onSaved={() => { setNewOb(null); programs.reload(); }} />}
      {newProgram && <ProgramModal onClose={() => setNewProgram(false)} onSaved={() => { setNewProgram(false); programs.reload(); }} />}
      {newFixing && <FixingModal onClose={() => setNewFixing(false)} onSaved={() => { setNewFixing(false); fixings.reload(); }} latest={latest} />}
    </>
  );
}

function latestFixings(rows) {
  const by = {};
  for (const r of rows) {
    const cur = by[r.benchmark];
    if (!cur || r.fixing_date > cur.fixing_date) by[r.benchmark] = { benchmark: r.benchmark, fixing_date: r.fixing_date, rates: {} };
  }
  for (const r of rows) if (by[r.benchmark].fixing_date === r.fixing_date) by[r.benchmark].rates[r.bucket] = r.rate_bps;
  return Object.values(by).sort((a, b) => a.benchmark.localeCompare(b.benchmark));
}

function ObligorModal({ obligor, program, onClose, onSaved }) {
  const { toast } = useUi();
  const [busy, run] = useAction();
  const o = obligor ?? {};
  const [form, setForm] = useState({
    name: o.name ?? '', rating: o.rating ?? 'BBB', role: o.role ?? 'Obligor',
    limit: o.limit_cents !== undefined ? String(o.limit_cents / 100) : '',
    adv: o.advance_rate_bps !== undefined ? String(o.advance_rate_bps / 100) : '90',
    margin: o.investor_margin_bps !== undefined ? (o.investor_margin_bps / 100).toFixed(2) : '1.75',
    spread: o.sp_spread_bps !== undefined ? (o.sp_spread_bps / 100).toFixed(2) : '0.70',
    auto_debit: !!o.auto_debit, active: o.active === undefined ? true : !!o.active,
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const body = {
    name: form.name, rating: form.rating.trim().toUpperCase(), role: form.role,
    limit_cents: toCents(form.limit), advance_rate_bps: toBps(form.adv), investor_margin_bps: toBps(form.margin), sp_spread_bps: toBps(form.spread),
    auto_debit: form.auto_debit, active: form.active,
  };
  const invalid = !form.name.trim() || [body.limit_cents, body.advance_rate_bps, body.investor_margin_bps, body.sp_spread_bps].some((x) => x === null);
  const save = () => run(async () => {
    const r = obligor ? await put(`/api/obligors/${obligor.id}`, body) : await post(`/api/programs/${program.id}/obligors`, body);
    toast(doneMessage(r, obligor ? `${form.name} updated` : `${form.name} added to ${program.program_code}`), isPending(r) ? 'info' : 'success');
    onSaved();
  });
  return (
    <Modal title={obligor ? `Edit ${obligor.name}` : `Add obligor to ${program.program_code}`} subtitle={`${program.deal_name} · ${program.currency}`} onClose={onClose} width={640}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={invalid || busy} onClick={save}>Save</Button></>}>
      <div className="grid g2">
        <Field label="Obligor name"><input className="input" value={form.name} onChange={set('name')} /></Field>
        <Field label="Role"><input className="input" value={form.role} onChange={set('role')} placeholder="Obligor, Subsidiary, Distributor…" /></Field>
        <Field label="Rating" hint="e.g. BBB, BB+, B+"><input className="input" value={form.rating} onChange={set('rating')} /></Field>
        <Field label={`Approved limit (${program.currency})`}><input className="input" inputMode="decimal" value={form.limit} onChange={set('limit')} /></Field>
        <Field label="Advance rate %"><input className="input" inputMode="decimal" value={form.adv} onChange={set('adv')} /></Field>
        <Field label="Investor margin %"><input className="input" inputMode="decimal" value={form.margin} onChange={set('margin')} /></Field>
        <Field label="Seaport (SP) spread %"><input className="input" inputMode="decimal" value={form.spread} onChange={set('spread')} /></Field>
        <div className="stack" style={{ justifyContent: 'flex-end', gap: 10 }}>
          <label className="row"><input type="checkbox" className="check" checked={form.auto_debit} onChange={set('auto_debit')} /> Auto-debit mandate in place</label>
          <label className="row"><input type="checkbox" className="check" checked={form.active} onChange={set('active')} /> Active (eligible for new fundings)</label>
        </div>
      </div>
      {obligor && <div className="muted small" style={{ marginTop: 12 }}>Changing the limit takes effect immediately for limit checks; pricing changes apply to invoices not yet approved.</div>}
    </Modal>
  );
}

function ProgramModal({ onClose, onSaved }) {
  const { toast } = useUi();
  const [busy, run] = useAction();
  const [f, setF] = useState({ program_code: 'PRG-', deal_code: 'SG-WC-', deal_name: '', client_name: '', program_type: 'SCF', currency: 'USD', rate_basis: 'SOFR', day_count: 'ACT/360', funding_lag_days: '1', late_margin: '3.00', collection_account: 'VA-' });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = () => run(async () => {
    const r = await post('/api/programs', { ...f, funding_lag_days: Number(f.funding_lag_days), late_margin_bps: toBps(f.late_margin), late_margin: undefined, currency: f.currency.toUpperCase() });
    toast(doneMessage(r, `${f.deal_name} created`), isPending(r) ? 'info' : 'success');
    onSaved();
  });
  return (
    <Modal title="New program" onClose={onClose} width={720} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.deal_name} onClick={save}>Create program</Button></>}>
      <div className="grid g3">
        <Field label="Program ID" hint="PRG-1234"><input className="input" value={f.program_code} onChange={set('program_code')} /></Field>
        <Field label="Deal code" hint="SG-WC-1234"><input className="input" value={f.deal_code} onChange={set('deal_code')} /></Field>
        <Field label="Program type"><select className="select" value={f.program_type} onChange={set('program_type')}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Deal name" style={{ gridColumn: 'span 2' }}><input className="input" value={f.deal_name} onChange={set('deal_name')} placeholder="Harborview Foods SCF 2026-1" /></Field>
        <Field label="Client / seller"><input className="input" value={f.client_name} onChange={set('client_name')} /></Field>
        <Field label="Currency"><input className="input" value={f.currency} maxLength={3} onChange={set('currency')} /></Field>
        <Field label="Rate basis"><select className="select" value={f.rate_basis} onChange={set('rate_basis')}>{['SOFR', 'SONIA', 'ESTR'].map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Day count"><select className="select" value={f.day_count} onChange={set('day_count')}><option>ACT/360</option><option>ACT/365</option></select></Field>
        <Field label="Funding lag (business days)"><input className="input" type="number" min="1" max="10" value={f.funding_lag_days} onChange={set('funding_lag_days')} /></Field>
        <Field label="Late charge margin %"><input className="input" value={f.late_margin} onChange={set('late_margin')} /></Field>
        <Field label="Collection account"><input className="input" value={f.collection_account} onChange={set('collection_account')} /></Field>
      </div>
    </Modal>
  );
}

function FixingModal({ onClose, onSaved, latest }) {
  const { today } = useSession();
  const { toast } = useUi();
  const [busy, run] = useAction();
  const [benchmark, setBenchmark] = useState(latest[0]?.benchmark ?? 'SOFR');
  const base = latest.find((l) => l.benchmark === benchmark);
  const [date, setDate] = useState(today);
  const [rates, setRates] = useState(() => Object.fromEntries(BUCKETS.map((b) => [b, base ? (base.rates[b] / 100).toFixed(2) : ''])));
  const parsed = Object.fromEntries(BUCKETS.map((b) => [b, toBps(rates[b])]));
  const save = () => run(async () => {
    const r = await post('/api/fixings', { benchmark, fixing_date: date, rates: parsed });
    toast(doneMessage(r, `${benchmark} fixing saved for ${dateShort(date)}`), isPending(r) ? 'info' : 'success');
    onSaved();
  });
  return (
    <Modal title="Add benchmark fixing" onClose={onClose} width={620}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || Object.values(parsed).some((x) => x === null)} onClick={save}>Save fixing</Button></>}>
      <div className="grid g2">
        <Field label="Benchmark"><select className="select" value={benchmark} onChange={(e) => {
          setBenchmark(e.target.value);
          const b = latest.find((l) => l.benchmark === e.target.value);
          if (b) setRates(Object.fromEntries(BUCKETS.map((k) => [k, (b.rates[k] / 100).toFixed(2)])));
        }}>{['SOFR', 'SONIA', 'ESTR'].map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Fixing date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        {BUCKETS.map((b) => (
          <Field key={b} label={`${b.replace('-', '–')} days (%)`}><input className="input" inputMode="decimal" value={rates[b]} onChange={(e) => setRates((r) => ({ ...r, [b]: e.target.value }))} /></Field>
        ))}
      </div>
    </Modal>
  );
}

function InvestorsCard({ investors }) {
  const { can } = useSession();
  const { toast } = useUi();
  const [busy, run] = useAction();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const add = () => run(async () => { await post('/api/investors', { code, name }); toast(`${name} added`, 'success'); setCode(''); setName(''); investors.reload(); });
  return (
    <Card title="Investors" subtitle="Tagged per invoice at funding; they receive base + investor margin.">
      {!investors.data ? <Loading /> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Investor ID</th><th>Name</th><th className="r">Loans funded</th></tr></thead>
            <tbody>{investors.data.map((i) => <tr key={i.id}><td className="strong">{i.code}</td><td>{i.name}</td><td className="r">{i.loans}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {can('master.edit') && (
        <div className="row" style={{ marginTop: 12, flexWrap: 'nowrap' }}>
          <input className="input sm" style={{ width: 120 }} placeholder="INV-0004" value={code} onChange={(e) => setCode(e.target.value)} />
          <input className="input sm" placeholder="Investor name" value={name} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" disabled={busy || !/^INV-\d{4}$/.test(code) || !name.trim()} onClick={add}>Add</Button>
        </div>
      )}
    </Card>
  );
}

function FxCard({ fx }) {
  const { can } = useSession();
  const { toast } = useUi();
  const [busy, run] = useAction();
  const [edit, setEdit] = useState({});
  const save = (ccy) => run(async () => { const r = await post('/api/fx', { currency: ccy, usd_rate: edit[ccy] }); toast(doneMessage(r, `${ccy} rate saved`), isPending(r) ? 'info' : 'success'); setEdit((e) => ({ ...e, [ccy]: undefined })); fx.reload(); });
  return (
    <Card title="Reference FX" subtitle="Used only to show portfolio totals in USD. Fundings and settlements stay in program currency.">
      {!fx.data ? <Loading /> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Currency</th><th className="r">USD per unit</th><th>As of</th><th /></tr></thead>
            <tbody>{fx.data.map((r) => (
              <tr key={r.currency}>
                <td className="strong">{r.currency}</td>
                <td className="r">{edit[r.currency] !== undefined ? <input className="input sm" style={{ width: 110, textAlign: 'right' }} value={edit[r.currency]} onChange={(e) => setEdit((x) => ({ ...x, [r.currency]: e.target.value }))} /> : r.usd_rate}</td>
                <td>{dateShort(r.as_of)}</td>
                <td className="r">{can('master.rates') && r.currency !== 'USD' && (edit[r.currency] !== undefined
                  ? <Button size="sm" variant="primary" disabled={busy} onClick={() => save(r.currency)}>Save</Button>
                  : <Button size="sm" onClick={() => setEdit((x) => ({ ...x, [r.currency]: r.usd_rate }))}>Edit</Button>)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
