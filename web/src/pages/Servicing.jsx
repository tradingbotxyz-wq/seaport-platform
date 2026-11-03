import { useEffect, useState } from 'react';
import { useApi, post, put, money, moneyShort, dateShort, dateTime, bps, setQuery, useLocation } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Field, Button, Pill, Modal, ErrorBox, Loading, Empty, useUi, useAction } from '../ui.jsx';

const PRIORITY_TONE = { URGENT: 'bad', HIGH: 'warn', MEDIUM: 'info', LOW: '' };
const STATUS_TONE = { OPEN: 'info', IN_PROGRESS: 'violet', PENDING_APPROVAL: 'warn', RESOLVED: 'good', REJECTED: '' };
const CASE_TYPES = ['DELINQUENCY', 'MATURITY_EXTENSION', 'PAYMENT_QUERY', 'DISPUTE', 'DILUTION', 'INVESTOR_REQUEST', 'TRANSFER', 'REDEMPTION', 'RESTRUCTURE', 'KYC_REFRESH', 'GENERAL'];
const human = (s) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export default function Servicing() {
  const { can } = useSession();
  const { toast } = useUi();
  const { query } = useLocation();
  const caseId = query.get('case') ? Number(query.get('case')) : null;
  const summary = useApi('/api/servicing/summary');
  const del = useApi('/api/servicing/delinquency');
  const [filter, setFilter] = useState('open');
  const cases = useApi(`/api/cases?${filter === 'mine' ? 'status=open&mine=1' : filter === 'open' ? 'status=open' : ''}`);
  const [newCase, setNewCase] = useState(null);
  const [ledgerLoan, setLedgerLoan] = useState(null);
  const [workoutLoan, setWorkoutLoan] = useState(null);
  const [busy, run] = useAction();
  const reload = () => { summary.reload(); del.reload(); cases.reload(); };
  const s = summary.data;
  const d = del.data;

  return (
    <>
      <div className="grid g6">
        <Kpi label="Open cases" value={s?.open_cases ?? '—'} sub={`${s?.resolved_30d ?? 0} resolved in 30 days`} />
        <Kpi label="SLA breached" value={s?.sla_breached ?? '—'} sub="URGENT 4h · HIGH 24h · MEDIUM 72h · LOW 5d" tone={s?.sla_breached ? 'danger' : ''} />
        <Kpi label="Amendments to approve" value={s?.pending_amendments ?? '—'} sub="Four-eyes (SoD-11)" tone={s?.pending_amendments ? 'warn' : ''} />
        <Kpi label="Past-due loans" value={d?.loans.length ?? '—'} sub="Open loans beyond maturity" tone={d?.loans.length ? 'danger' : ''} />
        <Kpi label="Over 30 days" value={d ? d.loans.filter((l) => l.days_past_due > 30).length : '—'} sub="Delinquency case opened automatically" />
        <Kpi label="Late fees to post" value={d?.unposted_fees ?? '—'} sub="Accrued, not yet in the ledger" />
      </div>

      <Card title="Delinquency" subtitle={`Ageing of open loans as of ${d ? dateShort(d.as_of) : '—'}. Loans more than 30 days past due get a delinquency case automatically (hourly sweep).`}
        right={<>
          <Button disabled={busy} onClick={() => run(async () => { const r = await post('/api/servicing/sweep'); toast(r.opened ? `${r.opened} delinquency case(s) opened` : 'No new delinquency cases needed', 'success'); reload(); })}>Run sweep now</Button>
          {can('service.fees') && <Button variant="primary" disabled={busy || !d?.unposted_fees} onClick={() => run(async () => { const r = await post('/api/servicing/late-fees'); toast(`Late fees posted on ${r.posted} loan(s)`, 'success'); reload(); })}>Post late fees</Button>}
        </>}>
        <ErrorBox error={del.error} />
        {!d ? <Loading /> : (
          <>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', marginBottom: 14 }}>
              {d.buckets.map((b, i) => (
                <div key={b.bucket} className={`kpi ${i >= 2 && b.count ? 'danger' : ''}`} style={{ padding: 12 }}>
                  <div className="label">{b.bucket}</div>
                  <div className="value" style={{ fontSize: 22 }}>{b.count}</div>
                  <div className="sub">{b.by_currency.map((x) => moneyShort(x.cents, x.currency)).join(' · ') || '—'}</div>
                </div>
              ))}
            </div>
            {!d.loans.length ? <Empty>No past-due loans.</Empty> : (
              <div className="table-wrap scroll"><table className="tbl">
                <thead><tr><th>Loan</th><th>Buyer</th><th>Program</th><th>Maturity</th><th className="r">Days past due</th><th>Bucket</th><th className="r">Outstanding</th><th className="r">Late fee accrued</th><th className="r">Posted</th><th>Case</th><th /></tr></thead>
                <tbody>{d.loans.map((l) => (
                  <tr key={l.id}>
                    <td className="strong">{l.loan_ref}</td><td>{l.buyer}</td><td>{l.program_code}</td>
                    <td>{dateShort(l.maturity_date)}{l.original_maturity_date && <span className="reason">was {dateShort(l.original_maturity_date)}</span>}</td>
                    <td className="r t-red strong">{l.days_past_due}</td><td><Pill tone={l.days_past_due > 30 ? 'bad' : 'warn'}>{l.bucket}</Pill></td>
                    <td className="r">{money(l.outstanding_cents, l.currency)}</td><td className="r t-amber">{money(l.late_fee_accrued_cents, l.currency)}</td><td className="r">{money(l.late_fee_posted_cents, l.currency)}</td>
                    <td>{l.case_ref ? <Pill tone="info">{l.case_ref}</Pill> : '—'}</td>
                    <td><div className="row" style={{ flexWrap: 'nowrap' }}>
                      <Button size="sm" onClick={() => setLedgerLoan(l.id)}>Sub-ledger</Button>
                      {can('service.amend') && <Button size="sm" onClick={() => setWorkoutLoan(l)}>Workout</Button>}
                      {!l.case_ref && can('service.cases') && <Button size="sm" onClick={() => setNewCase({ case_type: 'DELINQUENCY', entity_type: 'loan', entity_id: l.id, subject: `${l.loan_ref} ${l.buyer} ${l.days_past_due} days past due`, priority: 'MEDIUM' })}>Open case</Button>}
                    </div></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </>
        )}
      </Card>

      <Card title="Cases" subtitle="Service requests, disputes, investor requests and delinquency follow-up, with SLA tracking and an append-only history."
        right={<>
          <div className="chips">{[['open', 'Open'], ['mine', 'Assigned to me'], ['all', 'All']].map(([k, l]) => <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}</div>
          {can('service.cases') && <Button variant="primary" icon="plus" onClick={() => setNewCase({})}>New case</Button>}
        </>}>
        {!cases.data ? <Loading /> : !cases.data.length ? <Empty>No cases in this view.</Empty> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Case</th><th>Type</th><th>Subject</th><th>Priority</th><th>Status</th><th>Assignee</th><th>SLA due</th><th>Source</th></tr></thead>
            <tbody>{cases.data.map((c) => (
              <tr key={c.id} className={`selectable ${c.id === caseId ? 'selected' : ''}`} onClick={() => setQuery('case', c.id)}>
                <td className="strong t-brand">{c.ref}</td><td>{human(c.case_type)}</td><td className="wrap" style={{ minWidth: 260 }}>{c.subject}{c.pending_amendments > 0 && <> <Pill tone="warn">amendment</Pill></>}</td>
                <td><Pill tone={PRIORITY_TONE[c.priority]}>{c.priority}</Pill></td><td><Pill tone={STATUS_TONE[c.status]}>{human(c.status)}</Pill></td>
                <td>{c.assignee_name ?? '—'}</td><td className={c.sla_breached ? 't-red strong' : ''}>{dateTime(c.sla_due_at)}{c.sla_breached ? ' · breached' : ''}</td><td className="small muted">{c.source.toLowerCase()}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {caseId && <CaseModal id={caseId} onClose={() => setQuery('case', null)} onChanged={reload} />}
      {newCase && <NewCaseModal initial={newCase} onClose={() => setNewCase(null)} onDone={(id) => { setNewCase(null); reload(); setQuery('case', id); }} />}
      {ledgerLoan && <SubledgerModal id={ledgerLoan} onClose={() => setLedgerLoan(null)} />}
      {workoutLoan && <WorkoutModal loan={workoutLoan} onClose={() => setWorkoutLoan(null)} onDone={(id) => { setWorkoutLoan(null); reload(); setQuery('case', id); }} />}
    </>
  );
}

function CaseModal({ id, onClose, onChanged }) {
  const { can } = useSession();
  const { toast, ask } = useUi();
  const { data: c, error, reload } = useApi(`/api/cases/${id}`);
  const users = useApi('/api/users');
  const [comment, setComment] = useState('');
  const [amend, setAmend] = useState(null);
  const [busy, run] = useAction();
  const done = () => { reload(); onChanged(); };
  const update = (body, msg) => run(async () => { await put(`/api/cases/${id}`, body); toast(msg, 'success'); setComment(''); done(); });
  const resolve = async (status) => {
    const resolution = await ask({ title: status === 'RESOLVED' ? 'Resolve case' : 'Reject case', input: 'Outcome', required: true, confirm: status === 'RESOLVED' ? 'Resolve' : 'Reject' });
    if (resolution) update({ status, resolution }, `Case ${status.toLowerCase()}`);
  };
  const decide = async (a, decision) => {
    const note = await ask({ title: decision === 'APPLY' ? 'Approve and apply amendment?' : 'Reject amendment', message: decision === 'APPLY' ? 'The change is applied immediately and posted to the ledger where relevant.' : '', input: decision === 'APPLY' ? 'Note (optional)' : 'Reason', required: decision === 'REJECT', confirm: decision === 'APPLY' ? 'Approve & apply' : 'Reject' });
    if (note === null) return;
    run(async () => { await post(`/api/amendments/${a.id}/decide`, { decision, note: typeof note === 'string' ? note : '' }, { idempotent: true }); toast(decision === 'APPLY' ? 'Amendment applied' : 'Amendment rejected', 'success'); done(); });
  };
  const closed = c && ['RESOLVED', 'REJECTED'].includes(c.status);
  return (
    <Modal title={c ? `${c.ref} · ${c.subject}` : 'Case'} subtitle={c ? `${human(c.case_type)} · opened ${dateTime(c.created_at)} by ${c.created_by}${c.entity ? ` · ${c.entity.label}` : ''}` : ''} onClose={onClose} width={1000}
      footer={c && !closed && can('service.cases') && <>
        <Button onClick={() => resolve('REJECTED')}>Reject</Button>
        <Button variant="success" onClick={() => resolve('RESOLVED')}>Resolve</Button>
      </>}>
      <ErrorBox error={error} />
      {!c ? <Loading /> : (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)' }}>
          <div>
            {c.description && <div className="infobar">{c.description}</div>}
            <div className="section-title" style={{ marginTop: 0 }}>History</div>
            <div className="stack" style={{ gap: 8 }}>
              {c.events.map((e) => (
                <div key={e.id} style={{ borderLeft: `3px solid ${e.kind === 'COMMENT' ? 'var(--brand)' : e.kind === 'AMENDMENT' ? 'var(--violet)' : 'var(--border-strong)'}`, paddingLeft: 10 }}>
                  <div className="small muted">{dateTime(e.at)} · {e.actor_name ?? e.actor} · {e.kind.toLowerCase()}</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{e.body}</div>
                </div>
              ))}
            </div>
            {!closed && can('service.cases') && (
              <div style={{ marginTop: 12 }}>
                <Field label="Add a note"><textarea className="textarea" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Call notes, decisions, next steps" /></Field>
                <div className="row" style={{ marginTop: 8 }}><Button size="sm" variant="primary" disabled={busy || !comment.trim()} onClick={() => update({ comment }, 'Note added')}>Add note</Button></div>
              </div>
            )}
          </div>
          <div>
            <dl className="dl">
              <dt>Status</dt><dd><Pill tone={STATUS_TONE[c.status]}>{human(c.status)}</Pill></dd>
              <dt>Priority</dt><dd>{!closed && can('service.cases') ? <select className="select sm" value={c.priority} onChange={(e) => update({ priority: e.target.value }, 'Priority updated')}>{['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => <option key={p}>{p}</option>)}</select> : c.priority}</dd>
              <dt>SLA due</dt><dd className={c.sla_breached ? 't-red strong' : ''}>{dateTime(c.sla_due_at)}{c.sla_breached ? ' (breached)' : ''}</dd>
              <dt>Assignee</dt><dd>{!closed && can('service.cases') ? <select className="select sm" value={c.assignee ?? ''} onChange={(e) => update({ assignee: e.target.value }, 'Reassigned')}><option value="">Unassigned</option>{(users.data ?? []).map((u) => <option key={u.username} value={u.username}>{u.name}</option>)}</select> : c.assignee_name ?? '—'}</dd>
              {c.entity && <><dt>Record</dt><dd>{c.entity.label}{c.entity.face_cents != null && <div className="small muted">due {money(c.entity.face_cents - c.entity.received_cents, c.entity.currency)} · matures {dateShort(c.entity.maturity_date)}</div>}</dd></>}
              {c.resolution && <><dt>Outcome</dt><dd>{c.resolution}</dd></>}
            </dl>
            <div className="section-title">Amendments</div>
            {c.amendments.map((a) => (
              <div key={a.id} className="card" style={{ boxShadow: 'none', padding: 12, marginBottom: 8 }}>
                <div className="between"><b>{human(a.amendment_type)}</b><Pill tone={a.status === 'APPLIED' ? 'good' : a.status === 'REJECTED' ? '' : 'warn'}>{a.status}</Pill></div>
                <AmendmentPreview a={a} />
                <div className="small muted">Requested by {a.requested_by} · {dateTime(a.requested_at)}{a.decided_by ? ` · decided by ${a.decided_by}` : ''}</div>
                {a.status === 'PROPOSED' && (a.can_decide
                  ? <div className="row" style={{ marginTop: 8 }}><Button size="sm" onClick={() => decide(a, 'REJECT')}>Reject</Button><Button size="sm" variant="success" disabled={busy} onClick={() => decide(a, 'APPLY')}>Approve & apply</Button></div>
                  : <div className="small t-amber" style={{ marginTop: 6 }}>Awaiting approval by an operations checker or credit (not the requester).</div>)}
              </div>
            ))}
            {!closed && can('service.amend') && !c.amendments.some((a) => a.status === 'PROPOSED') && (
              amend ? <AmendmentForm c={c} kind={amend} onCancel={() => setAmend(null)} onDone={() => { setAmend(null); done(); }} /> : (
                <div className="chips">
                  {c.entity_type === 'loan' && <button className="chip" onClick={() => setAmend('LOAN_EXTENSION')}>+ Maturity extension</button>}
                  {c.entity_type === 'commitment' && <><button className="chip" onClick={() => setAmend('COMMITMENT_TRANSFER')}>+ Transfer commitment</button><button className="chip" onClick={() => setAmend('REDEMPTION')}>+ Redemption</button></>}
                  {!c.entity_type && <span className="small muted">Link a loan or commitment to propose an amendment.</span>}
                </div>
              ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

function AmendmentPreview({ a }) {
  const p = a.preview ?? {};
  if (a.amendment_type === 'LOAN_EXTENSION') return <div className="small" style={{ margin: '6px 0' }}>{p.loan_ref}: {dateShort(p.from)} → <b>{dateShort(p.to)}</b> (+{p.extra_days} days) · extension fee <b>{money(p.extension_fee_cents, p.currency)}</b> at {bps(p.all_in_bps)} all-in</div>;
  if (a.amendment_type === 'COMMITMENT_TRANSFER') return <div className="small" style={{ margin: '6px 0' }}>{p.tranche} commitment {money(p.commitment_cents, p.currency)} from <b>{p.from}</b> to <b>{p.to}</b>; paid-in {money(p.paid_in_cents, p.currency)} reclassified</div>;
  if (a.amendment_type === 'REDEMPTION') return <div className="small" style={{ margin: '6px 0' }}>{p.investor} redeems <b>{money(p.amount_cents, p.currency)}</b> of {money(p.net_paid_in_cents, p.currency)} net paid-in{a.result?.distribution && ` → ${a.result.distribution}`}</div>;
  if (a.amendment_type === 'RESTRUCTURE') return <div className="small" style={{ margin: '6px 0' }}>{p.loan_ref}: {p.schedule?.length}-instalment plan to {dateShort(p.final_date)}, interest {money(p.total_interest_cents, p.currency)}</div>;
  return null;
}

function AmendmentForm({ c, kind, onCancel, onDone }) {
  const { toast } = useUi();
  const [busy, run] = useAction();
  const investors = useApi(kind === 'COMMITMENT_TRANSFER' ? '/api/investors' : null);
  const [v, setV] = useState({ new_maturity_date: c.entity?.maturity_date ? new Date(Date.parse(c.entity.maturity_date) + 30 * 864e5).toISOString().slice(0, 10) : '', to_investor_id: '', amount: '', payment_date: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) });
  const payload = kind === 'LOAN_EXTENSION' ? { loan_id: c.entity_id, new_maturity_date: v.new_maturity_date }
    : kind === 'COMMITMENT_TRANSFER' ? { commitment_id: c.entity_id, to_investor_id: Number(v.to_investor_id) }
      : { commitment_id: c.entity_id, amount_cents: Math.round(Number(String(v.amount).replace(/,/g, '')) * 100), payment_date: v.payment_date };
  const submit = () => run(async () => { await post(`/api/cases/${c.id}/amendments`, { amendment_type: kind, payload }); toast('Amendment proposed — awaiting approval', 'success'); onDone(); });
  return (
    <div className="card" style={{ boxShadow: 'none', padding: 12 }}>
      <b>{human(kind)}</b>
      <div className="stack" style={{ gap: 10, marginTop: 8 }}>
        {kind === 'LOAN_EXTENSION' && <Field label="New maturity date"><input className="input" type="date" value={v.new_maturity_date} onChange={(e) => setV({ ...v, new_maturity_date: e.target.value })} /></Field>}
        {kind === 'COMMITMENT_TRANSFER' && <Field label="Transfer to investor"><select className="select" value={v.to_investor_id} onChange={(e) => setV({ ...v, to_investor_id: e.target.value })}><option value="">Choose…</option>{(investors.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}</select></Field>}
        {kind === 'REDEMPTION' && <><Field label="Amount to redeem"><input className="input" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field><Field label="Payment date"><input className="input" type="date" value={v.payment_date} onChange={(e) => setV({ ...v, payment_date: e.target.value })} /></Field></>}
        <div className="row"><Button size="sm" onClick={onCancel}>Cancel</Button><Button size="sm" variant="primary" disabled={busy} onClick={submit}>Propose</Button></div>
      </div>
    </div>
  );
}

function NewCaseModal({ initial, onClose, onDone }) {
  const { toast } = useUi();
  const [busy, run] = useAction();
  const users = useApi('/api/users');
  const [f, setF] = useState({ case_type: initial.case_type ?? 'GENERAL', priority: initial.priority ?? 'MEDIUM', subject: initial.subject ?? '', description: '', assignee: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => run(async () => {
    const r = await post('/api/cases', { ...f, assignee: f.assignee || undefined, description: f.description || undefined, entity_type: initial.entity_type, entity_id: initial.entity_id });
    toast(`${r.ref} opened`, 'success');
    onDone(r.id);
  });
  return (
    <Modal title="New case" onClose={onClose} width={680} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.subject.trim()} onClick={save}>Open case</Button></>}>
      <div className="grid g2">
        <Field label="Type"><select className="select" value={f.case_type} onChange={set('case_type')}>{CASE_TYPES.map((t) => <option key={t} value={t}>{human(t)}</option>)}</select></Field>
        <Field label="Priority"><select className="select" value={f.priority} onChange={set('priority')}>{['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => <option key={p}>{p}</option>)}</select></Field>
        <Field label="Subject" style={{ gridColumn: 'span 2' }}><input className="input" value={f.subject} onChange={set('subject')} /></Field>
        <Field label="Description" style={{ gridColumn: 'span 2' }}><textarea className="textarea" value={f.description} onChange={set('description')} /></Field>
        <Field label="Assign to"><select className="select" value={f.assignee} onChange={set('assignee')}><option value="">Unassigned</option>{(users.data ?? []).map((u) => <option key={u.username} value={u.username}>{u.name}</option>)}</select></Field>
      </div>
    </Modal>
  );
}

function SubledgerModal({ id, onClose }) {
  const { data: s } = useApi(`/api/servicing/loans/${id}`);
  const ccy = s?.loan.currency;
  return (
    <Modal title={s ? `Sub-ledger · ${s.loan.loan_ref}` : 'Sub-ledger'} subtitle={s ? `${s.loan.buyer} · ${s.loan.invoice_number} · ${s.loan.program_code}` : ''} onClose={onClose} width={820}>
      {!s ? <Loading /> : (
        <>
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Component</th><th>Accounts</th><th className="r">Debits</th><th className="r">Credits</th><th className="r">Balance</th></tr></thead>
            <tbody>{s.components.map((c) => <tr key={c.label} className={c.debit_cents || c.credit_cents ? '' : 'dim'}><td>{c.label}</td><td className="mono">{c.accounts}</td><td className="r">{money(c.debit_cents, ccy)}</td><td className="r">{money(c.credit_cents, ccy)}</td><td className="r strong">{money(c.balance_cents, ccy)}</td></tr>)}</tbody>
          </table></div>
          {s.schedule && (
            <>
              <div className="section-title">Restructured instalment schedule</div>
              <div className="table-wrap scroll"><table className="tbl"><thead><tr><th>#</th><th>Due</th><th className="r">Rate</th><th className="r">Payment</th><th className="r">Interest</th><th className="r">Principal</th><th className="r">Balance</th></tr></thead>
                <tbody>{s.schedule.map((r) => <tr key={r.period}><td>{r.period}</td><td>{dateShort(r.due_date)}</td><td className="r">{bps(r.rate_bps)}</td><td className="r">{money(r.payment_cents, ccy)}</td><td className="r">{money(r.interest_cents, ccy)}</td><td className="r">{money(r.principal_cents, ccy)}</td><td className="r">{money(r.balance_cents, ccy)}</td></tr>)}</tbody></table></div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function WorkoutModal({ loan, onClose, onDone }) {
  const { toast } = useUi();
  const [busy, run] = useAction();
  const [a, setA] = useState({ recovery_rate: '0.55', recovery_months: '9', legal_cost_pct: '0.05', extension_days: '90', extension_default_prob: '0.25', months: '12', base: '4.35', margin: '3.00', step_period: '7', step_base: '4.85', mpd: '0.015', discount: '8.00' });
  const [res, setRes] = useState(null);
  const set = (k) => (e) => setA({ ...a, [k]: e.target.value });
  const ratePath = [{ from_period: 1, base_bps: Math.round(Number(a.base) * 100) }, ...(Number(a.step_period) > 1 && Number(a.step_period) <= Number(a.months) ? [{ from_period: Number(a.step_period), base_bps: Math.round(Number(a.step_base) * 100) }] : [])];
  const analyse = () => run(async () => setRes(await post('/api/servicing/workout', { loan_id: loan.id, assumptions: {
    recovery_rate: Number(a.recovery_rate), recovery_months: Number(a.recovery_months), legal_cost_pct: Number(a.legal_cost_pct), extension_days: Number(a.extension_days),
    extension_default_prob: Number(a.extension_default_prob), discount_rate_bps: Math.round(Number(a.discount) * 100),
    plan: { months: Number(a.months), rate_bps: Math.round((Number(a.base) + Number(a.margin)) * 100), monthly_default_prob: Number(a.mpd) },
  } })));
  const propose = () => run(async () => {
    const c = await post('/api/cases', { case_type: 'RESTRUCTURE', priority: 'HIGH', subject: `Restructure ${loan.loan_ref} (${loan.buyer}) into ${a.months} instalments`, entity_type: 'loan', entity_id: loan.id,
      description: res ? `Workout analysis recommends: ${res.recommendation}.` : undefined });
    await post(`/api/cases/${c.id}/amendments`, { amendment_type: 'RESTRUCTURE', payload: { loan_id: loan.id, periods: Number(a.months), margin_bps: Math.round(Number(a.margin) * 100), rate_path: ratePath } });
    toast(`${c.ref} opened with a restructure proposal — awaiting approval`, 'success');
    onDone(c.id);
  });
  useEffect(() => { analyse(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title={`Workout analysis · ${loan.loan_ref}`} subtitle={`${loan.buyer} · ${loan.days_past_due} days past due · outstanding ${money(loan.outstanding_cents, loan.currency)}`} onClose={onClose} width={1000}
      footer={<><Button onClick={onClose}>Close</Button><Button onClick={analyse} disabled={busy}>Re-run analysis</Button><Button variant="primary" disabled={busy} onClick={propose}>Propose instalment plan</Button></>}>
      <div className="grid g4">
        <Field label="Recovery rate (0–1)"><input className="input" value={a.recovery_rate} onChange={set('recovery_rate')} /></Field>
        <Field label="Months to recover"><input className="input" value={a.recovery_months} onChange={set('recovery_months')} /></Field>
        <Field label="Legal costs (0–1)"><input className="input" value={a.legal_cost_pct} onChange={set('legal_cost_pct')} /></Field>
        <Field label="Discount rate %"><input className="input" value={a.discount} onChange={set('discount')} /></Field>
        <Field label="Extension days"><input className="input" value={a.extension_days} onChange={set('extension_days')} /></Field>
        <Field label="Default prob. if extended"><input className="input" value={a.extension_default_prob} onChange={set('extension_default_prob')} /></Field>
        <Field label="Plan months"><input className="input" value={a.months} onChange={set('months')} /></Field>
        <Field label="Monthly default prob. on plan"><input className="input" value={a.mpd} onChange={set('mpd')} /></Field>
        <Field label="Benchmark % (start)"><input className="input" value={a.base} onChange={set('base')} /></Field>
        <Field label="Margin %"><input className="input" value={a.margin} onChange={set('margin')} /></Field>
        <Field label="Rate reset at instalment"><input className="input" value={a.step_period} onChange={set('step_period')} /></Field>
        <Field label="Benchmark % after reset"><input className="input" value={a.step_base} onChange={set('step_base')} /></Field>
      </div>
      {res && (
        <>
          <div className="section-title">Options (present value at {bps(res.discount_rate_bps)})</div>
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Option</th><th className="r">Expected cash</th><th className="r">NPV</th><th className="r">Expected loss</th><th className="r">Months</th><th>Assumptions</th></tr></thead>
            <tbody>{res.options.map((o) => (
              <tr key={o.option} className={o.recommended ? 'selected' : ''}><td className="strong">{o.option}{o.recommended && <> <Pill tone="good">recommended</Pill></>}</td>
                <td className="r">{money(o.expected_cash_cents, loan.currency)}</td><td className="r strong">{money(o.npv_cents, loan.currency)}</td><td className="r t-red">{money(o.expected_loss_cents, loan.currency)}</td>
                <td className="r">{o.timing_months}</td><td className="small muted wrap">{o.detail}</td></tr>
            ))}</tbody>
          </table></div>
          <div className="small muted" style={{ marginTop: 8 }}>The proposed instalment plan uses a variable rate: {ratePath.map((r) => `${bps(r.base_bps)} + ${a.margin}% from instalment ${r.from_period}`).join(', then ')}. Approval by a checker applies it and resets the maturity to the last instalment.</div>
        </>
      )}
    </Modal>
  );
}

