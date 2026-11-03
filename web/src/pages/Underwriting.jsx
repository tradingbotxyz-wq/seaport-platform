import { useEffect, useMemo, useState } from 'react';
import { useApi, post, put, money, moneyShort, dateShort, dateTime, bps, pct, toBps, setQuery, useLocation, download } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Field, Button, Pill, Modal, Donut, ErrorBox, Loading, Empty, Icon, useUi, useAction } from '../ui.jsx';

const STATUS_TONE = { DRAFT: '', IN_REVIEW: 'info', REFERRED: 'warn', APPROVED: 'good', DECLINED: 'bad', WITHDRAWN: '' };
const STATUS_LABEL = { DRAFT: 'Draft', IN_REVIEW: 'In review', REFERRED: 'Referred', APPROVED: 'Approved', DECLINED: 'Declined', WITHDRAWN: 'Withdrawn' };
const OUTCOME_TONE = { APPROVE: 'good', REFER: 'warn', DECLINE: 'bad' };
const TYPE_LABEL = { NEW: 'New obligor', INCREASE: 'Limit increase', RENEWAL: 'Renewal' };
const FILTERS = [['open', 'Open', 'DRAFT,IN_REVIEW,REFERRED'], ['all', 'All', ''], ['APPROVED', 'Approved', 'APPROVED'], ['DECLINED', 'Declined', 'DECLINED,WITHDRAWN']];
const FIN_ROWS = [
  ['revenue_cents', 'Revenue'], ['ebitda_cents', 'EBITDA'], ['interest_expense_cents', 'Interest expense'], ['total_debt_cents', 'Total debt'],
  ['debt_service_cents', 'Annual debt service'], ['current_assets_cents', 'Current assets'], ['current_liabilities_cents', 'Current liabilities'], ['net_worth_cents', 'Net worth'],
];
const RATIO_ROWS = [['dscr', 'DSCR', 'x'], ['leverage', 'Debt / EBITDA', 'x'], ['interest_cover', 'Interest cover', 'x'], ['current_ratio', 'Current ratio', 'x'], ['ebitda_margin', 'EBITDA margin', '%'], ['revenue_growth', 'Revenue growth', '%']];
const RATINGS = ['A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'BB-', 'B+', 'B', 'CCC'];
const fmtRatio = (v, kind) => (v == null ? 'n/a' : kind === '%' ? `${(Number(v) * 100).toFixed(1)}%` : `${Number(v).toFixed(2)}x`);
const StatusPill = ({ s }) => <Pill tone={STATUS_TONE[s]}>{STATUS_LABEL[s] ?? s}</Pill>;

export default function Underwriting() {
  const { can } = useSession();
  const { query } = useLocation();
  const selectedId = query.get('app') ? Number(query.get('app')) : null;
  const [filter, setFilter] = useState('open');
  const statusParam = FILTERS.find((f) => f[0] === filter)[2];
  const list = useApi(`/api/underwriting${statusParam ? `?status=${statusParam}` : ''}`);
  const summary = useApi('/api/underwriting/summary');
  const [form, setForm] = useState(null); // {mode:'new'|'edit', app?, prefill?}
  const reload = () => { list.reload(); summary.reload(); };

  useEffect(() => {
    const pre = query.get('new');
    if (pre && can('underwrite.prepare')) { setForm({ mode: 'new', prefill: { obligor_id: Number(pre) } }); setQuery('new', null); }
  }, [query, can]);
  useEffect(() => { if (!selectedId && list.data?.length) setQuery('app', list.data[0].id); }, [list.data, selectedId]);

  const s = summary.data;
  return (
    <>
      <div className="grid g6">
        <Kpi label="Referred" value={s?.referred ?? '—'} sub="Need a credit decision with manual review" tone={s?.referred ? 'warn' : ''} onClick={() => setFilter('open')} />
        <Kpi label="In review" value={s?.in_review ?? '—'} sub="Engine recommends approval" />
        <Kpi label="Drafts" value={s?.drafts ?? '—'} sub="Being prepared" />
        <Kpi label="Approved (30 days)" value={s?.approved_30d ?? '—'} sub="Limits written to the Master Table" tone="good" onClick={() => setFilter('APPROVED')} />
        <Kpi label="Declined (30 days)" value={s?.declined_30d ?? '—'} sub="Including knock-outs" onClick={() => setFilter('DECLINED')} />
        <Kpi label="Overrides" value={s?.overrides ?? '—'} sub="Decisions against the engine" tone={s?.overrides ? 'danger' : ''} />
      </div>

      <Card title="Credit applications" subtitle="New obligors, limit increases and renewals. Scored by the Python engine; decided by Credit under maker-checker."
        right={<>
          <div className="chips">{FILTERS.map(([k, label]) => <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{label}</button>)}</div>
          {can('underwrite.prepare') && <Button variant="primary" icon="plus" onClick={() => setForm({ mode: 'new' })}>New credit application</Button>}
        </>}>
        <ErrorBox error={list.error} />
        {!list.data ? <Loading /> : !list.data.length ? <Empty>No applications in this view.</Empty> : (
          <div className="table-wrap scroll">
            <table className="tbl">
              <thead><tr><th>Ref</th><th>Obligor</th><th>Type</th><th>Program</th><th className="r">Current limit</th><th className="r">Requested</th><th className="r">Score</th><th>Rating</th><th>Engine</th><th>Status</th><th>Prepared by</th><th>Updated</th></tr></thead>
              <tbody>
                {list.data.map((a) => (
                  <tr key={a.id} className={`selectable ${a.id === selectedId ? 'selected' : ''}`} onClick={() => setQuery('app', a.id)}>
                    <td className="strong t-brand">{a.ref}</td>
                    <td className="strong">{a.obligor_name}</td>
                    <td>{TYPE_LABEL[a.application_type]}</td>
                    <td>{a.program_code}</td>
                    <td className="r">{a.current_limit_cents ? money(a.current_limit_cents, a.currency) : '—'}</td>
                    <td className="r">{money(a.requested_limit_cents, a.currency)}</td>
                    <td className="r">{a.score ?? '—'}</td>
                    <td>{a.rating ? <span className="rating">{a.rating}</span> : '—'}</td>
                    <td>{a.engine_outcome ? <Pill tone={OUTCOME_TONE[a.engine_outcome]}>{a.engine_outcome}</Pill> : '—'}</td>
                    <td><StatusPill s={a.status} />{a.override ? <> <Pill tone="violet">override</Pill></> : null}</td>
                    <td>{a.prepared_by_name}</td>
                    <td className="small muted">{dateShort(a.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedId && <ApplicationDetail id={selectedId} onChanged={reload} onEdit={(app) => setForm({ mode: 'edit', app })} />}
      <PolicyCard />
      {form && <ApplicationForm form={form} onClose={() => setForm(null)} onSaved={(id) => { setForm(null); reload(); setQuery('app', id); }} />}
    </>
  );
}

function ApplicationDetail({ id, onChanged, onEdit }) {
  const { refreshBadges } = useSession();
  const { toast, ask, fail } = useUi();
  const { data: a, error, reload } = useApi(`/api/underwriting/${id}`);
  const [busy, run] = useAction();
  const [deciding, setDeciding] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!a || a.id !== id) return <Loading />;
  const e = a.engine;
  const ccy = a.program.currency;
  const p = a.permissions;
  const done = () => { reload(); onChanged(); refreshBadges(); };

  const submit = (rescore) => run(async () => {
    const r = await post(`/api/underwriting/${id}/${rescore ? 'rescore' : 'submit'}`);
    toast(`Scored ${r.engine.score} · ${r.engine.rating} · engine ${r.engine.outcome}`, r.engine.outcome === 'APPROVE' ? 'success' : 'info');
    done();
  });
  const withNote = async (path, title, label, confirm) => {
    const note = await ask({ title, input: label, required: true, confirm });
    if (note) run(async () => { await post(`/api/underwriting/${id}/${path}`, { note }); toast(`${a.ref} updated`, 'success'); done(); });
  };

  return (
    <>
      <Card title={<span>{a.ref} · {a.obligor_name} &nbsp;<StatusPill s={a.status} />{a.override ? <> <Pill tone="violet">override</Pill></> : null}</span>}
        subtitle={`${TYPE_LABEL[a.application_type]} · ${a.program.deal_name} (${a.program.program_code}) · prepared by ${a.prepared_by_name}${a.submitted_at ? ` · submitted ${dateTime(a.submitted_at)}` : ''}`}
        right={<>
          {p.can_edit && <Button icon="edit" onClick={() => onEdit(a)}>Edit</Button>}
          {p.can_submit && <Button variant="primary" disabled={busy} onClick={() => submit(false)}>Submit for scoring</Button>}
          {['IN_REVIEW', 'REFERRED'].includes(a.status) && p.can_decide && <Button disabled={busy} icon="refresh" onClick={() => submit(true)}>Re-run checks</Button>}
          {p.can_return && <Button disabled={busy} onClick={() => withNote('return', 'Return to draft', 'What needs to change?', 'Return to draft')}>Return to draft</Button>}
          {['DRAFT', 'IN_REVIEW', 'REFERRED'].includes(a.status) && p.can_edit !== undefined && <Button disabled={busy} onClick={() => withNote('withdraw', 'Withdraw application', 'Reason', 'Withdraw')}>Withdraw</Button>}
          {['IN_REVIEW', 'REFERRED'].includes(a.status) && (
            <Button variant="success" disabled={!p.can_decide || busy} onClick={() => setDeciding(true)} title={p.decide_blockers.join('\n')}>Decide</Button>
          )}
        </>}>
        {['IN_REVIEW', 'REFERRED'].includes(a.status) && !p.can_decide && (
          <div className="infobar">{p.decide_blockers.map((b) => <span key={b}>{b}</span>)}</div>
        )}
        {a.status === 'DRAFT' && <div className="infobar">Draft — complete the details and financials, then <b>Submit for scoring</b>. Submission runs KYC/AML screening, the credit bureau check and the scorecard.</div>}
        {a.decision && (
          <div className="infobar" style={{ alignItems: 'flex-start' }}>
            <span><b>{a.decision === 'APPROVE' ? 'Approved' : 'Declined'}</b> by <b>{a.decided_by_name}</b> · {dateTime(a.decided_at)}</span>
            {a.decision === 'APPROVE' && <span>Limit <b>{money(a.approved_limit_cents, ccy)}</b> · rating <b>{a.approved_rating}</b> · next review <b>{dateShort(a.review_date)}</b></span>}
            <span style={{ flexBasis: '100%' }}>Reason: {a.decision_reason}</span>
            {a.conditions && <span style={{ flexBasis: '100%', whiteSpace: 'pre-line' }}>Conditions: {a.conditions}</span>}
          </div>
        )}
        <div className="grid g3">
          <div className="card" style={{ boxShadow: 'none' }}>
            <div className="muted small" style={{ marginBottom: 8 }}>Engine recommendation {a.scorecard_version ? `· scorecard v${a.scorecard_version}` : ''}</div>
            {!e ? <div className="muted">Not scored yet.</div> : (
              <div className="donut-wrap" style={{ gap: 18 }}>
                <Donut size={120} stroke={13} center={Number(e.score).toFixed(0)} caption="score"
                  segments={[{ value: Number(e.score), color: e.outcome === 'DECLINE' ? 'var(--red)' : e.outcome === 'REFER' ? 'var(--amber)' : 'var(--green)' }, { value: 100 - Number(e.score), color: 'var(--surface-3)' }]} />
                <div className="stack" style={{ gap: 8 }}>
                  <div><span className="muted small">Rating</span><div className="serif" style={{ fontSize: 26, fontWeight: 700 }}>{e.rating}</div></div>
                  <div><Pill tone={OUTCOME_TONE[e.outcome]}>{e.outcome}</Pill>{e.committee_required && <> <Pill tone="violet">committee</Pill></>}</div>
                </div>
              </div>
            )}
            {e && (e.knockouts.length > 0 || e.refers.length > 0) && (
              <ul style={{ margin: '12px 0 0', paddingLeft: 18 }} className="small">
                {e.knockouts.map((k) => <li key={k} className="t-red">{k}</li>)}
                {e.refers.map((r) => <li key={r} className="t-amber">{r}</li>)}
              </ul>
            )}
          </div>
          <div className="card" style={{ boxShadow: 'none' }}>
            <div className="muted small" style={{ marginBottom: 8 }}>Request</div>
            <dl className="dl">
              <dt>Current limit</dt><dd>{money(a.current_limit_cents, ccy)}</dd>
              <dt>Requested limit</dt><dd className="strong">{money(a.requested_limit_cents, ccy)}</dd>
              <dt>Advance rate</dt><dd>{bps(a.proposed_adv_bps)}</dd>
              <dt>Investor margin</dt><dd>{bps(a.proposed_margin_bps)}{e?.pricing_guidance && <span className="muted"> · guidance {bps(e.pricing_guidance.investor_margin_bps)}</span>}</dd>
              <dt>SP spread</dt><dd>{bps(a.proposed_spread_bps)}{e?.pricing_guidance && <span className="muted"> · guidance {bps(e.pricing_guidance.sp_spread_bps)}</span>}</dd>
              <dt>Max tenor</dt><dd>{a.max_tenor_days} days</dd>
              <dt>Collateral</dt><dd>{a.collateral_type ? `${a.collateral_type} · ${money(a.collateral_value_cents, ccy)}${e?.ltv ? ` · LTV ${pct(Number(e.ltv) * 100)}` : ''}` : 'None'}</dd>
            </dl>
            {a.rationale && <div className="small muted" style={{ marginTop: 10 }}>{a.rationale}</div>}
          </div>
          <div className="card" style={{ boxShadow: 'none' }}>
            <div className="muted small" style={{ marginBottom: 8 }}>Company & current exposure</div>
            <dl className="dl">
              <dt>Legal name</dt><dd>{a.legal_name}</dd>
              <dt>Registration</dt><dd>{a.registration_no ?? '—'}</dd>
              <dt>Country / industry</dt><dd>{a.country} · {a.industry ?? '—'}</dd>
              <dt>Years trading</dt><dd>{a.years_trading ?? '—'}</dd>
              {a.obligor && <><dt>Utilisation</dt><dd>{money(a.obligor.used_cents, ccy)} · {pct(a.obligor.used_pct)} <Pill status={a.obligor.status} /></dd></>}
            </dl>
          </div>
        </div>
      </Card>

      <div className="grid g2">
        <Card title="Financial spreading" subtitle={`${ccy} · ratios computed by the engine from the latest fiscal year`}>
          {!a.financials.length ? <Empty>No financials entered.</Empty> : (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th />{a.financials.map((f) => <th key={f.year} className="r">FY{f.year}</th>)}</tr></thead>
                <tbody>
                  {FIN_ROWS.map(([k, label]) => <tr key={k}><td>{label}</td>{a.financials.map((f) => <td key={f.year} className="r">{moneyShort(f[k])}</td>)}</tr>)}
                  {e && RATIO_ROWS.map(([k, label, kind]) => (
                    <tr key={k}><td className="strong">{label}</td>{e.spreads.map((sp) => <td key={sp.year} className="r strong">{fmtRatio(sp[k], kind)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Scorecard" subtitle="Points per factor (0–100) × weight. Bands are set in the credit policy below.">
          {!e ? <Empty>Submit the application to score it.</Empty> : (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Factor</th><th className="r">Value</th><th style={{ width: 120 }}>Points</th><th className="r">Weight</th><th className="r">Contribution</th></tr></thead>
                <tbody>{e.factors.map((f) => (
                  <tr key={f.key}>
                    <td>{f.label}</td>
                    <td className="r">{f.value == null ? 'n/a' : Number(f.value).toFixed(2)}</td>
                    <td><div className="row" style={{ flexWrap: 'nowrap' }}><span className="mini-bar" style={{ width: 70 }}><div style={{ width: `${f.points}%`, background: f.points >= 60 ? 'var(--green)' : f.points >= 30 ? 'var(--amber)' : 'var(--red)' }} /></span><span className="small">{f.points}</span></div></td>
                    <td className="r">{f.weight}%</td>
                    <td className="r">{Number(f.contribution).toFixed(2)}</td>
                  </tr>
                ))}</tbody>
                <tfoot><tr><td colSpan={4}>Total score</td><td className="r">{e.score}</td></tr></tfoot>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid g2">
        <Card title="KYC / AML and credit bureau" subtitle="Run on submission through the screening and bureau adapters (mock providers in this build).">
          {!a.screening ? <Empty>Screening runs when the application is submitted.</Empty> : (
            <>
              <div className="row" style={{ marginBottom: 10 }}>
                <Pill tone={a.screening.sanctions_hit ? 'bad' : 'good'}>{a.screening.sanctions_hit ? 'Sanctions match' : 'No sanctions match'}</Pill>
                <Pill tone={a.screening.pep_hit ? 'warn' : 'good'}>{a.screening.pep_hit ? 'PEP match' : 'No PEP'}</Pill>
                <Pill tone={a.screening.adverse_media ? 'warn' : 'good'}>{a.screening.adverse_media ? 'Adverse media' : 'No adverse media'}</Pill>
                {a.screening.high_risk_country && <Pill tone="warn">High-risk country</Pill>}
              </div>
              <dl className="dl">
                <dt>Screening</dt><dd>{a.screening.provider} · {a.screening.reference} · {dateTime(a.screening.checked_at)}</dd>
                <dt>Owners</dt><dd>{a.beneficial_owners.map((o) => `${o.name}${o.ownership_pct != null ? ` (${o.ownership_pct}%)` : ''}`).join(', ') || '—'}</dd>
                <dt>Bureau</dt><dd>{a.bureau.provider} · {a.bureau.reference}</dd>
                <dt>Bureau score</dt><dd className="strong">{a.bureau.bureau_score} / 100</dd>
                <dt>Days beyond terms</dt><dd>{a.bureau.payment_dbt}</dd>
                <dt>Public records</dt><dd>{a.bureau.public_records} · {a.bureau.trade_lines} trade lines</dd>
              </dl>
              {a.screening.matches.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 10 }}><table className="tbl"><thead><tr><th>List</th><th>Name</th><th>Detail</th></tr></thead>
                  <tbody>{a.screening.matches.map((m, i) => <tr key={i}><td className="t-red">{m.list}</td><td>{m.name}</td><td>{m.detail}</td></tr>)}</tbody></table></div>
              )}
            </>
          )}
        </Card>
        <Card title="Documents & history" right={a.engine && <Button size="sm" icon="refresh" onClick={() => run(async () => { await post(`/api/underwriting/${id}/memo`); toast('Credit memo regenerated', 'success'); reload(); })}>Regenerate credit memo</Button>}>
          {a.documents.length ? (
            <div className="table-wrap" style={{ marginBottom: 14 }}>
              <table className="tbl"><tbody>{a.documents.map((d) => (
                <tr key={d.id}>
                  <td><button className="file-link" onClick={() => download(`/api/documents/${d.id}/file`, d.filename).catch(fail)}><Icon name="file" size={15} />{d.filename}</button></td>
                  <td>{d.doc_type.replace('_', ' ').toLowerCase()} v{d.version}</td><td className="small muted">{dateTime(d.created_at)}</td>
                  <td><Button size="sm" icon="download" onClick={() => download(`/api/documents/${d.id}/file`, d.filename).catch(fail)}>PDF</Button></td>
                </tr>
              ))}</tbody></table>
            </div>
          ) : <div className="muted small" style={{ marginBottom: 14 }}>The credit memo is generated at decision time (or on demand once scored); the term sheet on approval.</div>}
          <div className="table-wrap scroll" style={{ maxHeight: 260 }}>
            <table className="tbl"><tbody>{a.history.slice().reverse().map((h, i) => (
              <tr key={i}><td className="small muted">{dateTime(h.ts)}</td><td>{h.actor}</td><td className="mono">{h.action.replace('credit_application.', '')}</td>
                <td className="small wrap">{h.details.outcome ? `${h.details.outcome} · ${h.details.rating} · ${h.details.score}` : h.details.decision ? `${h.details.decision}${h.details.override ? ' (override)' : ''}` : h.details.note ?? ''}</td></tr>
            ))}</tbody></table>
          </div>
        </Card>
      </div>
      {deciding && <DecisionModal a={a} onClose={() => setDeciding(false)} onDone={() => { setDeciding(false); done(); }} />}
    </>
  );
}

function DecisionModal({ a, onClose, onDone }) {
  const { toast } = useUi();
  const [busy, run] = useAction();
  const e = a.engine;
  const ccy = a.program.currency;
  const [d, setD] = useState({
    decision: e.outcome === 'DECLINE' ? 'DECLINE' : 'APPROVE',
    limit: String(a.requested_limit_cents / 100), rating: e.rating,
    margin: (a.proposed_margin_bps / 100).toFixed(2), spread: (a.proposed_spread_bps / 100).toFixed(2), adv: (a.proposed_adv_bps / 100).toFixed(2),
    conditions: '', review: '12', reason: '',
  });
  const set = (k) => (ev) => setD((x) => ({ ...x, [k]: ev.target.value }));
  const approve = d.decision === 'APPROVE';
  const override = (approve && e.outcome !== 'APPROVE') || (!approve && e.outcome === 'APPROVE');
  const limitCents = Math.round(Number(String(d.limit).replace(/,/g, '')) * 100);
  const needsCommittee = approve && (e.outcome === 'DECLINE' || a.permissions.committee_required);
  const blocked = needsCommittee && !a.permissions.is_committee;
  const reasonOk = d.reason.trim().length >= (override ? 20 : 5);
  const submit = () => run(async () => {
    const body = { decision: d.decision, reason: d.reason.trim() };
    if (approve) Object.assign(body, {
      approved_limit_cents: limitCents, approved_rating: d.rating, approved_margin_bps: toBps(d.margin), approved_spread_bps: toBps(d.spread),
      approved_adv_bps: toBps(d.adv), conditions: d.conditions.trim() || undefined, review_months: Number(d.review),
    });
    await post(`/api/underwriting/${a.id}/decide`, body, { idempotent: true });
    toast(approve ? `${a.obligor_name} approved at ${money(limitCents, ccy)} - Master Table updated, memo and term sheet generated` : `${a.ref} declined - credit memo generated`, 'success');
    onDone();
  });
  return (
    <Modal title={`Credit decision · ${a.ref}`} subtitle={`${a.obligor_name} · engine ${e.outcome} · score ${e.score} · ${e.rating}`} onClose={onClose} width={760}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={approve ? 'success' : 'danger'} disabled={busy || blocked || !reasonOk || (approve && !(limitCents > 0))} onClick={submit}>{approve ? 'Confirm approval' : 'Confirm decline'}</Button></>}>
      <div className="chips" style={{ marginBottom: 14 }}>
        <button className={`chip ${approve ? 'on' : ''}`} onClick={() => setD({ ...d, decision: 'APPROVE' })}>Approve</button>
        <button className={`chip ${!approve ? 'on' : ''}`} onClick={() => setD({ ...d, decision: 'DECLINE' })}>Decline</button>
      </div>
      {override && <div className="blockers" style={{ margin: '0 0 12px' }}><b>Override:</b> this decision goes against the engine recommendation ({e.outcome}). A reason of at least 20 characters is required and the override is flagged in reporting.</div>}
      {needsCommittee && <div className={blocked ? 'blockers' : 'infobar'} style={{ margin: '0 0 12px' }}>{e.outcome === 'DECLINE' ? 'Approving an engine knock-out' : 'This limit exceeds delegated authority'} requires the credit committee (administrator).{blocked ? ' You cannot approve it.' : ''}</div>}
      {approve && (
        <div className="grid g3" style={{ marginBottom: 12 }}>
          <Field label={`Approved limit (${ccy})`} hint={`Requested ${money(a.requested_limit_cents, ccy)}`}><input className="input" inputMode="decimal" value={d.limit} onChange={set('limit')} /></Field>
          <Field label="Risk rating" hint={`Engine: ${e.rating}`}><select className="select" value={d.rating} onChange={set('rating')}>{RATINGS.map((r) => <option key={r}>{r}</option>)}</select></Field>
          <Field label="Review in (months)"><input className="input" type="number" min="1" max="36" value={d.review} onChange={set('review')} /></Field>
          <Field label="Advance rate %"><input className="input" value={d.adv} onChange={set('adv')} /></Field>
          <Field label="Investor margin %" hint={e.pricing_guidance ? `Guidance ${bps(e.pricing_guidance.investor_margin_bps)}` : ''}><input className="input" value={d.margin} onChange={set('margin')} /></Field>
          <Field label="SP spread %" hint={e.pricing_guidance ? `Guidance ${bps(e.pricing_guidance.sp_spread_bps)}` : ''}><input className="input" value={d.spread} onChange={set('spread')} /></Field>
          <Field label="Conditions (one per line)" style={{ gridColumn: 'span 3' }}><textarea className="textarea" value={d.conditions} onChange={set('conditions')} placeholder="e.g. Parent guarantee from Harborview Foods Inc" /></Field>
        </div>
      )}
      <Field label="Decision reason"><textarea className="textarea" value={d.reason} onChange={set('reason')} placeholder="Why this decision; key risks and mitigants" /></Field>
    </Modal>
  );
}

const emptyYear = (year) => ({ year, ...Object.fromEntries(FIN_ROWS.map(([k]) => [k, ''])) });
const toMillions = (c) => (c === '' || c == null ? '' : String(Math.round(c / 1000) / 1000));
const fromMillions = (v) => { const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) && String(v).trim() !== '' ? Math.round(n * 100_000_000) : null; };

function ApplicationForm({ form, onClose, onSaved }) {
  const { toast } = useUi();
  const [busy, run] = useAction();
  const programs = useApi('/api/programs');
  const edit = form.mode === 'edit' ? form.app : null;
  const thisYear = new Date().getFullYear();
  const [f, setF] = useState(() => edit ? {
    program_id: String(edit.program_id), application_type: edit.application_type, obligor_id: edit.obligor_id ? String(edit.obligor_id) : '',
    obligor_name: edit.obligor_name, obligor_role: edit.obligor_role, legal_name: edit.legal_name, registration_no: edit.registration_no ?? '', country: edit.country,
    industry: edit.industry ?? '', years_trading: edit.years_trading ?? '', owners: edit.beneficial_owners.length ? edit.beneficial_owners : [{ name: '', ownership_pct: '' }],
    limit: String(edit.requested_limit_cents / 100), adv: (edit.proposed_adv_bps / 100).toFixed(2), margin: (edit.proposed_margin_bps / 100).toFixed(2), spread: (edit.proposed_spread_bps / 100).toFixed(2),
    tenor: String(edit.max_tenor_days), collateral_type: edit.collateral_type ?? '', collateral: edit.collateral_value_cents ? String(edit.collateral_value_cents / 100) : '',
    rationale: edit.rationale ?? '', years: edit.financials.length ? edit.financials.map((y) => ({ year: y.year, ...Object.fromEntries(FIN_ROWS.map(([k]) => [k, toMillions(y[k])])) })) : [emptyYear(thisYear - 1)],
  } : {
    program_id: '', application_type: form.prefill?.obligor_id ? 'INCREASE' : 'NEW', obligor_id: form.prefill?.obligor_id ? String(form.prefill.obligor_id) : '', obligor_name: '', obligor_role: 'Obligor',
    legal_name: '', registration_no: '', country: 'US', industry: '', years_trading: '', owners: [{ name: '', ownership_pct: '' }],
    limit: '', adv: '90.00', margin: '1.75', spread: '0.70', tenor: '120', collateral_type: '', collateral: '', rationale: '',
    years: [emptyYear(thisYear - 2), emptyYear(thisYear - 1)],
  });
  const progs = programs.data ?? [];
  useEffect(() => {
    if (!f.program_id && progs.length) {
      const pre = form.prefill?.obligor_id && progs.find((p) => p.obligors.some((o) => o.id === form.prefill.obligor_id));
      setF((x) => ({ ...x, program_id: String((pre ?? progs[0]).id) }));
    }
  }, [progs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const program = progs.find((p) => String(p.id) === f.program_id);
  const obligor = program?.obligors.find((o) => String(o.id) === f.obligor_id);
  useEffect(() => {
    if (obligor && !edit) setF((x) => ({ ...x, obligor_name: obligor.name, legal_name: x.legal_name || obligor.name, obligor_role: obligor.role, adv: (obligor.advance_rate_bps / 100).toFixed(2), margin: (obligor.investor_margin_bps / 100).toFixed(2), spread: (obligor.sp_spread_bps / 100).toFixed(2), limit: x.limit || String(obligor.limit_cents / 100) }));
  }, [obligor?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (ev) => setF((x) => ({ ...x, [k]: ev.target.value }));
  const setYear = (i, k, v) => setF((x) => ({ ...x, years: x.years.map((y, j) => (j === i ? { ...y, [k]: v } : y)) }));
  const setOwner = (i, k, v) => setF((x) => ({ ...x, owners: x.owners.map((o, j) => (j === i ? { ...o, [k]: v } : o)) }));

  const body = useMemo(() => ({
    program_id: Number(f.program_id), application_type: f.application_type, obligor_id: f.application_type === 'NEW' ? undefined : Number(f.obligor_id) || undefined,
    obligor_name: f.application_type === 'NEW' ? f.obligor_name : obligor?.name ?? f.obligor_name, obligor_role: f.obligor_role, legal_name: f.legal_name,
    registration_no: f.registration_no || undefined, country: f.country.toUpperCase(), industry: f.industry || undefined, years_trading: f.years_trading === '' ? undefined : Number(f.years_trading),
    beneficial_owners: f.owners.filter((o) => o.name.trim()).map((o) => ({ name: o.name.trim(), ownership_pct: o.ownership_pct === '' ? undefined : Number(o.ownership_pct) })),
    requested_limit_cents: Math.round(Number(String(f.limit).replace(/,/g, '')) * 100), proposed_adv_bps: toBps(f.adv), proposed_margin_bps: toBps(f.margin), proposed_spread_bps: toBps(f.spread),
    max_tenor_days: Number(f.tenor), collateral_type: f.collateral_type || undefined, collateral_value_cents: f.collateral ? Math.round(Number(String(f.collateral).replace(/,/g, '')) * 100) : undefined,
    rationale: f.rationale || undefined,
    financials: f.years.filter((y) => FIN_ROWS.some(([k]) => String(y[k]).trim() !== '')).map((y) => ({ year: Number(y.year), ...Object.fromEntries(FIN_ROWS.map(([k]) => [k, fromMillions(y[k]) ?? 0])) })),
  }), [f, obligor]);

  const save = () => run(async () => {
    if (edit) { await put(`/api/underwriting/${edit.id}`, body); toast(`${edit.ref} saved`, 'success'); onSaved(edit.id); }
    else { const r = await post('/api/underwriting', body); toast(`${r.ref} created as draft`, 'success'); onSaved(r.id); }
  });
  const ccy = program?.currency ?? '';
  return (
    <Modal title={edit ? `Edit ${edit.ref}` : 'New credit application'} subtitle="Saved as a draft; submit it from the application to run screening and scoring." onClose={onClose} width={1080}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !body.legal_name || !(body.requested_limit_cents > 0)} onClick={save}>Save draft</Button></>}>
      <div className="section-title" style={{ marginTop: 0 }}>Program and obligor</div>
      <div className="grid g4">
        <Field label="Program"><select className="select" value={f.program_id} disabled={!!edit} onChange={(e) => setF({ ...f, program_id: e.target.value, obligor_id: '' })}>{progs.map((p) => <option key={p.id} value={p.id}>{p.deal_name} ({p.currency})</option>)}</select></Field>
        <Field label="Application type"><select className="select" value={f.application_type} disabled={!!edit} onChange={set('application_type')}><option value="NEW">New obligor</option><option value="INCREASE">Limit increase</option><option value="RENEWAL">Renewal</option></select></Field>
        {f.application_type === 'NEW'
          ? <Field label="Obligor name (as used on invoices)"><input className="input" value={f.obligor_name} onChange={set('obligor_name')} /></Field>
          : <Field label="Existing obligor"><select className="select" value={f.obligor_id} disabled={!!edit} onChange={set('obligor_id')}><option value="">Choose…</option>{program?.obligors.map((o) => <option key={o.id} value={o.id}>{o.name} · limit {moneyShort(o.limit_cents, ccy)}</option>)}</select></Field>}
        <Field label="Role"><input className="input" value={f.obligor_role} onChange={set('obligor_role')} /></Field>
      </div>
      <div className="section-title">Company and KYC</div>
      <div className="grid g4">
        <Field label="Legal name"><input className="input" value={f.legal_name} onChange={set('legal_name')} /></Field>
        <Field label="Registration no."><input className="input" value={f.registration_no} onChange={set('registration_no')} /></Field>
        <Field label="Country (ISO)"><input className="input" maxLength={2} value={f.country} onChange={set('country')} /></Field>
        <Field label="Industry"><input className="input" value={f.industry} onChange={set('industry')} /></Field>
        <Field label="Years trading"><input className="input" type="number" min="0" value={f.years_trading} onChange={set('years_trading')} /></Field>
        <Field label="Beneficial owners / directors" style={{ gridColumn: 'span 3' }}>
          <div className="stack">
            {f.owners.map((o, i) => (
              <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
                <input className="input sm" placeholder="Name" value={o.name} onChange={(e) => setOwner(i, 'name', e.target.value)} />
                <input className="input sm" style={{ width: 110 }} placeholder="% owned" value={o.ownership_pct ?? ''} onChange={(e) => setOwner(i, 'ownership_pct', e.target.value)} />
                <button className="icon-btn" onClick={() => setF({ ...f, owners: f.owners.filter((_, j) => j !== i) })} aria-label="Remove owner"><Icon name="x" size={15} /></button>
              </div>
            ))}
            <Button size="sm" icon="plus" onClick={() => setF({ ...f, owners: [...f.owners, { name: '', ownership_pct: '' }] })}>Add owner</Button>
          </div>
        </Field>
      </div>
      <div className="section-title">Request ({ccy})</div>
      <div className="grid g4">
        <Field label="Requested limit" hint={obligor ? `Current ${money(obligor.limit_cents, ccy)}` : ''}><input className="input" inputMode="decimal" value={f.limit} onChange={set('limit')} /></Field>
        <Field label="Advance rate %"><input className="input" value={f.adv} onChange={set('adv')} /></Field>
        <Field label="Investor margin %"><input className="input" value={f.margin} onChange={set('margin')} /></Field>
        <Field label="SP spread %"><input className="input" value={f.spread} onChange={set('spread')} /></Field>
        <Field label="Max invoice tenor (days)"><input className="input" type="number" value={f.tenor} onChange={set('tenor')} /></Field>
        <Field label="Collateral / credit support"><input className="input" value={f.collateral_type} onChange={set('collateral_type')} placeholder="e.g. Credit insurance" /></Field>
        <Field label="Collateral value"><input className="input" inputMode="decimal" value={f.collateral} onChange={set('collateral')} /></Field>
        <Field label="Rationale"><input className="input" value={f.rationale} onChange={set('rationale')} /></Field>
      </div>
      <div className="between" style={{ marginTop: 18 }}>
        <div className="section-title" style={{ margin: 0 }}>Financials ({ccy} millions)</div>
        <div className="row">
          {f.years.length < 5 && <Button size="sm" icon="plus" onClick={() => setF({ ...f, years: [...f.years, emptyYear(Math.max(...f.years.map((y) => Number(y.year))) + 1)] })}>Add year</Button>}
        </div>
      </div>
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table className="tbl">
          <thead><tr><th>Line item</th>{f.years.map((y, i) => (
            <th key={i} className="r"><div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>FY<input className="input sm" style={{ width: 74 }} value={y.year} onChange={(e) => setYear(i, 'year', e.target.value)} />
              {f.years.length > 1 && <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => setF({ ...f, years: f.years.filter((_, j) => j !== i) })} aria-label="Remove year"><Icon name="x" size={13} /></button>}</div></th>
          ))}</tr></thead>
          <tbody>{FIN_ROWS.map(([k, label]) => (
            <tr key={k}><td>{label}</td>{f.years.map((y, i) => <td key={i} className="r"><input className="input sm" style={{ width: 120, textAlign: 'right', marginLeft: 'auto' }} inputMode="decimal" value={y[k]} onChange={(e) => setYear(i, k, e.target.value)} /></td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    </Modal>
  );
}

function PolicyCard() {
  const { can } = useSession();
  const { toast, ask } = useUi();
  const { data, reload } = useApi('/api/underwriting/scorecard');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [busy, run] = useAction();
  if (!data) return null;
  const m = data.current.model;
  const editing = !!draft;
  const start = () => setDraft(JSON.parse(JSON.stringify(m)));
  const weightSum = (draft ?? m).factors.reduce((a, f) => a + Number(f.weight), 0);
  const publish = () => run(async () => {
    const note = await ask({ title: `Publish scorecard v${data.current.version + 1}`, message: 'Applications scored from now on use the new version. Decided applications keep the version they were scored with.', input: 'What changed and why', required: true, confirm: 'Publish' });
    if (!note) return;
    await post('/api/underwriting/scorecard', { model: draft, note });
    toast('New scorecard version published', 'success');
    setDraft(null);
    reload();
  });
  const r = (draft ?? m).rules;
  const setRule = (k, v) => setDraft((d) => ({ ...d, rules: { ...d.rules, [k]: v } }));
  return (
    <Card title={`Credit policy · scorecard v${data.current.version}`} subtitle={`Published ${dateTime(data.current.created_at)} by ${data.current.created_by} · ${data.current.note ?? ''}. New versions apply to applications scored from then on; earlier decisions keep their version.`}
      right={<>
        <Button size="sm" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show policy'}</Button>
        {open && can('underwrite.policy') && !editing && <Button size="sm" icon="edit" onClick={start}>Edit</Button>}
        {editing && <><Button size="sm" onClick={() => setDraft(null)}>Cancel</Button><Button size="sm" variant="primary" disabled={busy || weightSum <= 0} onClick={publish}>Publish v{data.current.version + 1}</Button></>}
      </>}>
      {open && (
        <div className="grid g2">
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Factor</th><th className="r">Weight</th><th>Bands (threshold → points)</th></tr></thead>
              <tbody>{(draft ?? m).factors.map((f, i) => (
                <tr key={f.key}><td>{f.label}</td>
                  <td className="r">{editing ? <input className="input sm" style={{ width: 70, textAlign: 'right' }} value={f.weight} onChange={(e) => setDraft((d) => ({ ...d, factors: d.factors.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) || 0 } : x)) }))} /> : `${f.weight}%`}</td>
                  <td className="small muted wrap">{f.bands.map(([t, p]) => `${f.direction === 'lower' ? '≤' : '≥'}${t >= 1e8 ? '∞' : t} → ${p}`).join(' · ')}</td></tr>
              ))}</tbody>
              <tfoot><tr><td>Total weight</td><td className="r">{weightSum}</td><td /></tr></tfoot>
            </table>
          </div>
          <div>
            <div className="table-wrap">
              <table className="tbl"><tbody>
                {[['knockout_min_dscr', 'Knock-out: minimum DSCR'], ['knockout_max_leverage', 'Knock-out: maximum Debt/EBITDA'], ['knockout_min_bureau', 'Knock-out: minimum bureau score'],
                  ['refer_min_dscr', 'Refer below DSCR'], ['refer_max_ltv', 'Refer above LTV'], ['min_financial_years', 'Minimum years of financials']].map(([k, label]) => (
                  <tr key={k}><td>{label}</td><td className="r">{editing ? <input className="input sm" style={{ width: 90, textAlign: 'right' }} value={r[k]} onChange={(e) => setRule(k, Number(e.target.value))} /> : r[k]}</td></tr>
                ))}
                <tr><td>Refer if rating worse than</td><td className="r">{editing ? <select className="select sm" style={{ width: 90 }} value={r.refer_worst_rating} onChange={(e) => setRule('refer_worst_rating', e.target.value)}>{RATINGS.map((x) => <option key={x}>{x}</option>)}</select> : r.refer_worst_rating}</td></tr>
                <tr><td>Delegated authority (USD)</td><td className="r">{editing ? <input className="input sm" style={{ width: 130, textAlign: 'right' }} value={r.authority_limit_usd_cents / 100} onChange={(e) => setRule('authority_limit_usd_cents', Math.round(Number(e.target.value) * 100))} /> : money(r.authority_limit_usd_cents, 'USD')}</td></tr>
              </tbody></table>
            </div>
            <div className="small muted" style={{ marginTop: 10 }}>Rating scale: {(draft ?? m).rating_scale.map(([s, g]) => `${g} ≥ ${s}`).join(' · ')}</div>
          </div>
        </div>
      )}
    </Card>
  );
}
