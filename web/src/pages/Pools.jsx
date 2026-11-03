import { useEffect, useState } from 'react';
import { useApi, post, put, money, moneyShort, dateShort, dateTime, bps, pct, setQuery, useLocation } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Field, Button, Pill, Modal, BarChart, ErrorBox, Loading, Empty, useUi, useAction } from '../ui.jsx';

const GROUPS = [['yield', 'Yield'], ['maturity', 'Maturity'], ['country', 'Geography'], ['rating', 'Risk rating'], ['obligor', 'Obligor'], ['program', 'Program']];
const RATINGS = ['A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'BB-', 'B+', 'B', 'CCC'];
const STATUS_TONE = { DRAFT: 'warn', ACTIVE: 'good', CLOSED: '' };
const DEFAULT_SCENARIOS = [
  { name: 'Base', pd_mult: 1, lgd: 0.45, dilution: 0.005, delay_days: 5, past_due_pd: 0.25 },
  { name: 'Moderate stress', pd_mult: 3, lgd: 0.55, dilution: 0.01, delay_days: 15, past_due_pd: 0.4 },
  { name: 'Severe stress', pd_mult: 8, lgd: 0.65, dilution: 0.02, delay_days: 30, past_due_pd: 0.6 },
  { name: 'Top 3 obligors default', top_n_default: 3, pd_mult: 1, lgd: 0.6, dilution: 0.005, delay_days: 5, past_due_pd: 0.25 },
];

export default function Pools() {
  const { can } = useSession();
  const { query } = useLocation();
  const selectedId = query.get('pool') ? Number(query.get('pool')) : null;
  const list = useApi('/api/pools');
  const [form, setForm] = useState(null);
  useEffect(() => { if (!selectedId && list.data?.length) setQuery('pool', list.data[0].id); }, [list.data, selectedId]);
  const pools = list.data ?? [];
  const active = pools.filter((p) => p.status === 'ACTIVE');

  return (
    <>
      <div className="grid g4">
        <Kpi label="Active pools" value={active.length} sub={`${pools.filter((p) => p.status === 'DRAFT').length} in structuring`} />
        <Kpi label="Loans pooled" value={pools.reduce((a, p) => a + p.open_loans, 0)} sub="Open loans in draft and active pools" />
        <Kpi label="Concentration exceptions" value={pools.filter((p) => p.concentration_status === 'Breach').length} sub={`${pools.filter((p) => p.concentration_status === 'Tight').length} tight`} tone={pools.some((p) => p.concentration_status === 'Breach') ? 'danger' : ''} />
        <Kpi label="Past due in pools" value={pools.reduce((a, p) => a + (p.past_due_cents > 0 ? 1 : 0), 0)} sub="Pools holding past-due loans" />
      </div>

      <Card title="Pools" subtitle="Funded loans grouped for funding or securitisation, with concentration limits and Senior / Mezzanine / Equity tranches."
        right={can('pool.manage') && <Button variant="primary" icon="plus" onClick={() => setForm({})}>New pool</Button>}>
        <ErrorBox error={list.error} />
        {!list.data ? <Loading /> : !pools.length ? <Empty>No pools yet.</Empty> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Pool</th><th>Name</th><th>Ccy</th><th>Status</th><th className="r">Principal</th><th className="r">Target</th><th style={{ minWidth: 120 }}>Ramp-up</th><th className="r">Loans</th><th className="r">WA yield</th><th className="r">WA days</th><th>WA rating</th><th>Tranches</th><th>Concentration</th></tr></thead>
              <tbody>{pools.map((p) => {
                const ramp = p.target_size_cents ? (p.principal_cents * 100) / p.target_size_cents : 0;
                return (
                  <tr key={p.id} className={`selectable ${p.id === selectedId ? 'selected' : ''}`} onClick={() => setQuery('pool', p.id)}>
                    <td className="strong t-brand">{p.ref}</td><td className="strong">{p.name}</td><td>{p.currency}</td><td><Pill tone={STATUS_TONE[p.status]}>{p.status}</Pill></td>
                    <td className="r">{money(p.principal_cents, p.currency)}</td><td className="r muted">{moneyShort(p.target_size_cents, p.currency)}</td>
                    <td><div className="row" style={{ flexWrap: 'nowrap' }}><span className="mini-bar" style={{ width: 80 }}><div style={{ width: `${Math.min(ramp, 100)}%`, background: 'var(--brand)' }} /></span><span className="small">{pct(ramp, 0)}</span></div></td>
                    <td className="r">{p.open_loans}</td><td className="r">{bps(p.wa_yield_bps)}</td><td className="r">{p.wa_days}</td><td>{p.wa_rating ? <span className="rating">{p.wa_rating}</span> : '—'}</td>
                    <td className="small">{p.tranches.map((t) => `${t.name[0]} ${t.pct_bps / 100}%`).join(' · ') || '—'}</td>
                    <td><Pill status={p.concentration_status} /></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </Card>
      {selectedId && <PoolDetail id={selectedId} onChanged={list.reload} onEdit={(p) => setForm(p)} />}
      {form && <PoolForm pool={form.id ? form : null} onClose={() => setForm(null)} onSaved={(id) => { setForm(null); list.reload(); if (id) setQuery('pool', id); }} />}
    </>
  );
}

function PoolDetail({ id, onChanged, onEdit }) {
  const { can, me, openLoan } = useSession();
  const { toast, ask } = useUi();
  const { data: p, error, reload } = useApi(`/api/pools/${id}`);
  const eligible = useApi(p && p.status !== 'CLOSED' ? `/api/pools/${id}/eligible?v=${p.metrics.loans}` : null);
  const [groupBy, setGroupBy] = useState('yield');
  const [checked, setChecked] = useState(() => new Set());
  const [proposal, setProposal] = useState(null);
  const [busy, run] = useAction();
  if (error) return <ErrorBox error={error} />;
  if (!p || p.id !== id) return <Loading />;
  const ccy = p.currency;
  const m = p.metrics;
  const done = () => { reload(); onChanged(); setChecked(new Set()); setProposal(null); };
  const manage = can('pool.manage') && p.status !== 'CLOSED';
  const add = (ids) => run(async () => {
    const r = await post(`/api/pools/${id}/loans`, { loan_ids: ids });
    toast(`${r.added} loan(s) added to ${p.ref}`, 'success');
    done();
  });
  const preview = () => run(async () => setProposal(await post(`/api/pools/${id}/auto-build`, { apply: false })));
  const applyBuild = () => run(async () => { const r = await post(`/api/pools/${id}/auto-build`, { apply: true }); toast(`${r.selected.length} loan(s) added by auto-build`, 'success'); done(); });
  const activate = async () => {
    if (!(await ask({ title: `Activate ${p.ref}?`, message: 'The pool is locked for funding. Loans can no longer be removed, and investors can commit to its tranches.', confirm: 'Activate pool' }))) return;
    run(async () => { await post(`/api/pools/${id}/activate`); toast(`${p.ref} is active`, 'success'); done(); });
  };
  const close = async () => {
    const note = await ask({ title: `Close ${p.ref}?`, message: m.open_loans ? `${m.open_loans} open loan(s) will be released from the pool.` : 'All loans are repaid.', input: 'Reason', required: true, confirm: 'Close pool', danger: true });
    if (note) run(async () => { await post(`/api/pools/${id}/close`, { note, release_open_loans: true }); toast(`${p.ref} closed`, 'success'); done(); });
  };
  const groups = m.groups[groupBy];
  const maxG = Math.max(...groups.map((g) => g.amount_cents), 1);

  return (
    <>
      <Card title={<span>{p.ref} · {p.name} &nbsp;<Pill tone={STATUS_TONE[p.status]}>{p.status}</Pill></span>}
        subtitle={`${ccy} · built by ${p.created_by}${p.activated_at ? ` · activated by ${p.activated_by} ${dateTime(p.activated_at)}` : ''}${p.strategy ? ` · ${p.strategy}` : ''}`}
        right={<>
          {p.status === 'DRAFT' && can('pool.manage') && <Button icon="edit" onClick={() => onEdit(p)}>Edit structure</Button>}
          {p.status === 'DRAFT' && can('pool.activate') && <Button variant="success" disabled={busy || p.created_by === me.username} title={p.created_by === me.username ? 'Four-eyes: another user must activate (SoD-8)' : ''} onClick={activate}>Activate pool</Button>}
          {p.status === 'ACTIVE' && can('pool.activate') && <Button disabled={busy} onClick={close}>Close pool</Button>}
        </>}>
        <div className="grid g6">
          <Kpi label="Principal" value={moneyShort(m.principal_cents, ccy)} sub={`Target ${moneyShort(p.target_size_cents, ccy)} · ${pct((m.principal_cents * 100) / p.target_size_cents, 0)}`} />
          <Kpi label="Amount due" value={moneyShort(m.outstanding_cents, ccy)} sub={`${m.open_loans} open loans · ${m.obligors} obligors`} />
          <Kpi label="WA yield" value={bps(m.wa_yield_bps)} sub="All-in, by principal" />
          <Kpi label="WA remaining" value={`${m.wa_days} days`} sub="Weighted average life" />
          <Kpi label="WA rating" value={m.wa_rating ?? '—'} sub="Principal weighted" />
          <Kpi label="Ledger reconciliation" value={p.reconciliation.reconciled ? 'Matched' : money(p.reconciliation.difference_cents, ccy)} sub={`Account 1200 ${moneyShort(p.reconciliation.ledger_principal_cents, ccy)}`} tone={p.reconciliation.reconciled ? 'good' : 'danger'} />
        </div>
      </Card>

      <div className="grid g2">
        <Card title="Concentration limits" subtitle={`Measured on principal against the larger of target size and current size. Eligibility: ${p.criteria.min_rating ? `rating ${p.criteria.min_rating} or better` : 'any rating'}, ${p.criteria.min_remaining_days ?? 1}${p.criteria.max_remaining_days ? `–${p.criteria.max_remaining_days}` : '+'} days remaining${p.criteria.programs?.length ? `, programs ${p.criteria.programs.join(', ')}` : ''}.`}>
          {!p.concentration.length ? <Empty>No limits set.</Empty> : (
            <div className="table-wrap"><table className="tbl">
              <thead><tr><th>Limit</th><th>Largest</th><th className="r">Share / limit</th><th>Usage</th><th>Status</th></tr></thead>
              <tbody>{p.concentration.map((c) => (
                <tr key={c.key}><td className="wrap">{c.label}</td><td className="strong" title={moneyShort(c.amount_cents, ccy)}>{c.largest}</td><td className="r">{pct(c.bps / 100)} / {pct(c.limit_bps / 100, 0)}</td>
                  <td><span className="mini-bar" style={{ width: 80 }}><div style={{ width: `${Math.min(100, (c.bps * 100) / c.limit_bps)}%`, background: c.status === 'Breach' ? 'var(--red)' : c.status === 'Tight' ? 'var(--amber)' : 'var(--brand)' }} /></span></td>
                  <td><Pill status={c.status} /></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <Card title="Asset grouping" right={<div className="chips">{GROUPS.map(([k, l]) => <button key={k} className={`chip ${groupBy === k ? 'on' : ''}`} onClick={() => setGroupBy(k)}>{l}</button>)}</div>}>
          {!groups.length ? <Empty>No open loans.</Empty> : (
            <div className="stack" style={{ gap: 10 }}>
              {groups.map((g) => (
                <div key={g.label}>
                  <div className="between small"><span className="strong">{g.label}</span><span className="muted">{g.count} loans · {moneyShort(g.amount_cents, ccy)} · {pct(g.pct)}</span></div>
                  <div className="progress" style={{ height: 8, marginTop: 4 }}><div style={{ width: `${(g.amount_cents * 100) / maxG}%`, background: 'var(--brand)' }} /></div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="Tranche structure" subtitle="Losses hit Equity first, then Mezzanine, then Senior. Coupons are paid from the pool's discount income; Equity keeps the excess spread.">
        {!p.tranches.length ? <Empty>No tranches defined — edit the structure.</Empty> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Tranche</th><th className="r">Share</th><th className="r">Size ({ccy})</th><th className="r">Attachment</th><th className="r">Detachment</th><th className="r">Credit enhancement</th><th className="r">Coupon</th></tr></thead>
            <tbody>{p.tranches.map((t) => (
              <tr key={t.name}><td className="strong">{t.name[0] + t.name.slice(1).toLowerCase()}</td><td className="r">{pct(t.pct_bps / 100)}</td><td className="r">{money(t.size_cents, ccy)}</td>
                <td className="r">{pct(t.attach_pct)}</td><td className="r">{pct(t.detach_pct)}</td><td className="r">{pct(t.attach_pct)}</td><td className="r">{t.name === 'EQUITY' ? 'Residual' : bps(t.coupon_bps)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      <StressCard pool={p} onRan={reload} />

      <Card title={`Loans in pool (${m.loans})`} right={manage && p.status === 'DRAFT' && checked.size > 0 && <Button onClick={() => run(async () => { await post(`/api/pools/${id}/remove-loans`, { loan_ids: [...checked] }); toast('Loans removed', 'success'); done(); })}>Remove selected ({checked.size})</Button>}>
        {!p.loans.length ? <Empty>No loans yet — add eligible loans below or use auto-build.</Empty> : (
          <div className="table-wrap scroll" style={{ maxHeight: 380 }}><table className="tbl">
            <thead><tr>{p.status === 'DRAFT' && manage && <th />}<th>Loan</th><th>Obligor</th><th>Program</th><th>Country</th><th>Rating</th><th className="r">Principal</th><th className="r">Due</th><th className="r">Yield</th><th>Maturity</th><th className="r">Days</th><th>Status</th></tr></thead>
            <tbody>{p.loans.map((l) => (
              <tr key={l.id} className={l.status !== 'OPEN' ? 'dim' : l.days < 0 ? 'held' : ''}>
                {p.status === 'DRAFT' && manage && <td><input type="checkbox" className="check" checked={checked.has(l.id)} onChange={() => setChecked((s) => { const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n; })} aria-label={`Select ${l.loan_ref}`} /></td>}
                <td><a href="#" className="strong" onClick={(e) => { e.preventDefault(); openLoan(l.id); }}>{l.loan_ref}</a></td><td>{l.obligor}</td><td>{l.program}</td><td>{l.country}</td><td><span className="rating">{l.rating}</span></td>
                <td className="r">{money(l.principal_cents, ccy)}</td><td className="r">{money(l.outstanding_cents, ccy)}</td><td className="r">{bps(l.yield_bps)}</td><td>{dateShort(l.maturity_date)}</td>
                <td className={`r ${l.days < 0 ? 't-red' : ''}`}>{l.days}</td><td><Pill status={l.status} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      {manage && (
        <Card title={`Eligible loans (${eligible.data?.length ?? p.eligible_count})`} subtitle="Open loans in the pool currency, not in another pool, that meet the eligibility criteria. Adding is blocked if it would breach a concentration limit."
          right={<>
            <Button disabled={busy} onClick={preview}>Preview auto-build</Button>
            {proposal?.selected.length > 0 && <Button variant="primary" disabled={busy} onClick={applyBuild}>Add {proposal.selected.length} proposed loans</Button>}
            {!proposal && <Button variant="primary" disabled={busy || ![...checked].length} onClick={() => add([...checked])}>Add selected</Button>}
          </>}>
          {proposal && (
            <div className="infobar">
              Auto-build (highest yield first, within target and every limit): <b>{proposal.selected.length}</b> loans, taking principal to <b>{money(proposal.size_cents, ccy)}</b>.
              {proposal.skipped.length > 0 && <span> {proposal.skipped.length} skipped — e.g. {proposal.skipped.slice(0, 3).map((s) => `${s.loan_ref}: ${s.reason}`).join('; ')}.</span>}
              <Button size="sm" onClick={() => setProposal(null)}>Dismiss</Button>
            </div>
          )}
          {!eligible.data ? <Loading /> : !eligible.data.length ? <Empty>No eligible loans available.</Empty> : (
            <div className="table-wrap scroll" style={{ maxHeight: 340 }}><table className="tbl">
              <thead><tr><th /><th>Loan</th><th>Obligor</th><th>Program</th><th>Rating</th><th className="r">Principal</th><th className="r">Yield</th><th className="r">Days</th></tr></thead>
              <tbody>{eligible.data.map((l) => {
                const proposed = proposal?.selected.some((x) => x.id === l.id);
                return (
                  <tr key={l.id} className={proposed ? 'selected' : ''}>
                    <td><input type="checkbox" className="check" disabled={!!proposal} checked={checked.has(l.id) || proposed} onChange={() => setChecked((s) => { const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n; })} aria-label={`Select ${l.loan_ref}`} /></td>
                    <td className="strong">{l.loan_ref}</td><td>{l.obligor}</td><td>{l.program}</td><td><span className="rating">{l.rating}</span></td>
                    <td className="r">{money(l.principal_cents, ccy)}</td><td className="r">{bps(l.yield_bps)}</td><td className="r">{l.days}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
        </Card>
      )}
    </>
  );
}

function StressCard({ pool, onRan }) {
  const { can } = useSession();
  const { toast } = useUi();
  const [busy, run] = useAction();
  const [scenarios, setScenarios] = useState(() => pool.last_stress?.results?.results?.map((r) => r.scenario) ?? DEFAULT_SCENARIOS);
  const [result, setResult] = useState(pool.last_stress?.results ?? null);
  const ccy = pool.currency;
  const setSc = (i, k, v) => setScenarios((s) => s.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const runIt = () => run(async () => {
    const clean = scenarios.map((s) => ({ ...s, pd_mult: Number(s.pd_mult), lgd: Number(s.lgd), dilution: Number(s.dilution), delay_days: Number(s.delay_days), past_due_pd: Number(s.past_due_pd), top_n_default: s.top_n_default ? Number(s.top_n_default) : undefined }));
    const r = await post(`/api/pools/${pool.id}/stress`, { scenarios: clean });
    setResult(r);
    toast('Stress test complete', 'success');
    onRan();
  });
  const cf = result?.cashflows;
  return (
    <Card title="Cash-flow model and stress testing" subtitle="Python engine: rating-based default probability × scenario multiplier over remaining life, loss given default, dilution and collection delay; tranche waterfall and break-even."
      right={<>
        {pool.last_stress && <span>Last run {dateTime(pool.last_stress.run_at)} by {pool.last_stress.run_by}</span>}
        <Button size="sm" onClick={() => setScenarios(DEFAULT_SCENARIOS)}>Reset scenarios</Button>
        <Button variant="primary" disabled={busy || !can('pool.stress') || !pool.metrics.open_loans} onClick={runIt}>Run stress test</Button>
      </>}>
      <div className="table-wrap" style={{ marginBottom: 14 }}><table className="tbl">
        <thead><tr><th>Scenario</th><th className="r">PD multiple</th><th className="r">LGD</th><th className="r">Dilution</th><th className="r">Delay (days)</th><th className="r">Past-due PD</th><th className="r">Top-N default</th></tr></thead>
        <tbody>{scenarios.map((s, i) => (
          <tr key={i}><td><input className="input sm" value={s.name} onChange={(e) => setSc(i, 'name', e.target.value)} /></td>
            {['pd_mult', 'lgd', 'dilution', 'delay_days', 'past_due_pd', 'top_n_default'].map((k) => <td key={k} className="r"><input className="input sm" style={{ width: 80, textAlign: 'right', marginLeft: 'auto' }} value={s[k] ?? ''} onChange={(e) => setSc(i, k, e.target.value)} aria-label={`${s.name} ${k}`} /></td>)}</tr>
        ))}</tbody>
      </table></div>
      {result && (
        <>
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Scenario</th><th className="r">Pool loss</th><th className="r">Loss %</th><th className="r">Excess spread</th>{result.results[0].tranches.map((t) => <th key={t.name} className="r">{t.name[0] + t.name.slice(1).toLowerCase()} loss</th>)}</tr></thead>
            <tbody>{result.results.map((r) => (
              <tr key={r.scenario.name}><td className="strong">{r.scenario.name}</td><td className="r">{money(r.pool.loss_cents, ccy)}</td><td className="r">{pct(r.pool.loss_pct, 2)}</td><td className="r">{money(r.pool.excess_spread_cents, ccy)}</td>
                {r.tranches.map((t) => <td key={t.name} className={`r ${t.impaired ? (t.name === 'EQUITY' ? 't-amber' : 't-red strong') : 't-green'}`}>{t.impaired ? pct(t.loss_pct, 1) : 'None'}</td>)}</tr>
            ))}</tbody>
          </table></div>
          <div className="grid g2" style={{ marginTop: 14 }}>
            <div>
              <div className="section-title" style={{ marginTop: 0 }}>Break-even (base LGD)</div>
              <dl className="dl">{Object.entries(result.breakeven_pd_multiple).flatMap(([k, v]) => [<dt key={k}>{k[0] + k.slice(1).toLowerCase()} first loss at</dt>, <dd key={`${k}v`}>{v == null ? 'not reached at 1000× PD' : `${v}× base default rates`}</dd>])}</dl>
              <div className="small muted" style={{ marginTop: 8 }}>The multiple of rating-implied default rates the pool can absorb before the tranche loses principal.</div>
            </div>
            <div>
              <div className="section-title" style={{ marginTop: 0 }}>Expected collections, base case (weekly)</div>
              {cf && <BarChart data={cf.buckets.slice(0, 16).map((b) => ({ key: b.week, label: `W${b.week}`, value: b.amount_cents }))} format={(v) => (v ? moneyShort(v) : '')} />}
              {cf && (cf.overdue_cents > 0 || cf.beyond_cents > 0) && <div className="small muted">Past due: {money(cf.overdue_cents, ccy)}{cf.beyond_cents ? ` · after week 26: ${money(cf.beyond_cents, ccy)}` : ''}</div>}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function PoolForm({ pool, onClose, onSaved }) {
  const { toast } = useUi();
  const [busy, run] = useAction();
  const programs = useApi('/api/programs');
  const [f, setF] = useState(() => ({
    name: pool?.name ?? '', currency: pool?.currency ?? 'USD', strategy: pool?.strategy ?? '', target: pool ? String(pool.target_size_cents / 100) : '50000000',
    programs: pool?.criteria.programs ?? [], min_rating: pool?.criteria.min_rating ?? 'B+', min_days: String(pool?.criteria.min_remaining_days ?? 5), max_days: pool?.criteria.max_remaining_days ? String(pool.criteria.max_remaining_days) : '180',
    max_obligor: String((pool?.limits.max_obligor_bps ?? 2000) / 100), max_program: String((pool?.limits.max_program_bps ?? 5000) / 100), max_country: String((pool?.limits.max_country_bps ?? 9000) / 100), max_sub_ig: String((pool?.limits.max_sub_ig_bps ?? 5500) / 100),
    tranches: pool?.tranches.length ? pool.tranches.map((t) => ({ name: t.name, pct: String(t.pct_bps / 100), coupon: (t.coupon_bps / 100).toFixed(2) })) : [{ name: 'SENIOR', pct: '80', coupon: '5.20' }, { name: 'MEZZANINE', pct: '12', coupon: '7.80' }, { name: 'EQUITY', pct: '8', coupon: '0' }],
  }));
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const bp = (v) => Math.round(Number(v) * 100);
  const total = f.tranches.reduce((a, t) => a + (Number(t.pct) || 0), 0);
  const body = {
    name: f.name, currency: f.currency.toUpperCase(), strategy: f.strategy || undefined, target_size_cents: Math.round(Number(f.target.replace(/,/g, '')) * 100),
    criteria: { programs: f.programs, min_rating: f.min_rating || null, min_remaining_days: Number(f.min_days) || 1, max_remaining_days: f.max_days ? Number(f.max_days) : null },
    limits: { max_obligor_bps: bp(f.max_obligor), max_program_bps: bp(f.max_program), max_country_bps: bp(f.max_country), max_sub_ig_bps: bp(f.max_sub_ig) },
    tranches: f.tranches.filter((t) => Number(t.pct) > 0).map((t) => ({ name: t.name, pct_bps: bp(t.pct), coupon_bps: bp(t.coupon || 0) })),
  };
  const save = () => run(async () => {
    if (pool) { await put(`/api/pools/${pool.id}`, body); toast(`${pool.ref} updated`, 'success'); onSaved(pool.id); }
    else { const r = await post('/api/pools', body); toast(`${r.ref} created`, 'success'); onSaved(r.id); }
  });
  const progs = (programs.data ?? []).filter((p) => p.currency === f.currency.toUpperCase());
  return (
    <Modal title={pool ? `Edit ${pool.ref}` : 'New pool'} onClose={onClose} width={900}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.name || Math.round(total * 100) !== 10000} onClick={save}>{pool ? 'Save structure' : 'Create pool'}</Button></>}>
      <div className="grid g3">
        <Field label="Pool name" style={{ gridColumn: 'span 2' }}><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Currency"><input className="input" maxLength={3} value={f.currency} disabled={!!pool} onChange={set('currency')} /></Field>
        <Field label="Target size"><input className="input" inputMode="decimal" value={f.target} onChange={set('target')} /></Field>
        <Field label="Strategy" style={{ gridColumn: 'span 2' }}><input className="input" value={f.strategy} onChange={set('strategy')} /></Field>
      </div>
      <div className="section-title">Eligibility</div>
      <div className="grid g4">
        <Field label="Minimum rating"><select className="select" value={f.min_rating} onChange={set('min_rating')}><option value="">Any</option>{RATINGS.map((r) => <option key={r}>{r}</option>)}</select></Field>
        <Field label="Min remaining days"><input className="input" value={f.min_days} onChange={set('min_days')} /></Field>
        <Field label="Max remaining days"><input className="input" value={f.max_days} onChange={set('max_days')} /></Field>
        <Field label="Programs" hint="None selected = all programs in this currency">
          <div className="chips">{progs.map((p) => {
            const on = f.programs.includes(p.program_code);
            return <button key={p.id} className={`chip ${on ? 'on' : ''}`} onClick={() => setF((x) => ({ ...x, programs: on ? x.programs.filter((c) => c !== p.program_code) : [...x.programs, p.program_code] }))}>{p.program_code}</button>;
          })}</div>
        </Field>
      </div>
      <div className="section-title">Concentration limits (% of pool)</div>
      <div className="grid g4">
        <Field label="Single obligor"><input className="input" value={f.max_obligor} onChange={set('max_obligor')} /></Field>
        <Field label="Single program"><input className="input" value={f.max_program} onChange={set('max_program')} /></Field>
        <Field label="Single country"><input className="input" value={f.max_country} onChange={set('max_country')} /></Field>
        <Field label="Sub-investment grade"><input className="input" value={f.max_sub_ig} onChange={set('max_sub_ig')} /></Field>
      </div>
      <div className="section-title">Tranches {Math.round(total * 100) !== 10000 && <span className="t-red">(total {total}% — must be 100%)</span>}</div>
      <div className="table-wrap"><table className="tbl">
        <thead><tr><th>Tranche</th><th className="r">Share %</th><th className="r">Coupon %</th></tr></thead>
        <tbody>{['SENIOR', 'MEZZANINE', 'EQUITY'].map((name) => {
          const t = f.tranches.find((x) => x.name === name) ?? { name, pct: '', coupon: '' };
          const upd = (k, v) => setF((x) => ({ ...x, tranches: [...x.tranches.filter((y) => y.name !== name), { ...t, [k]: v }].sort((a, b) => ['SENIOR', 'MEZZANINE', 'EQUITY'].indexOf(a.name) - ['SENIOR', 'MEZZANINE', 'EQUITY'].indexOf(b.name)) }));
          return (
            <tr key={name}><td className="strong">{name[0] + name.slice(1).toLowerCase()}</td>
              <td className="r"><input className="input sm" style={{ width: 90, textAlign: 'right', marginLeft: 'auto' }} value={t.pct} onChange={(e) => upd('pct', e.target.value)} aria-label={`${name} share`} /></td>
              <td className="r">{name === 'EQUITY' ? <span className="muted">Residual</span> : <input className="input sm" style={{ width: 90, textAlign: 'right', marginLeft: 'auto' }} value={t.coupon} onChange={(e) => upd('coupon', e.target.value)} aria-label={`${name} coupon`} />}</td></tr>
          );
        })}</tbody>
      </table></div>
    </Modal>
  );
}
