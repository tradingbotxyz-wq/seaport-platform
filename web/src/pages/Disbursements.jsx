import { useState } from 'react';
import { useApi, post, put, money, dateShort, dateTime, download, addBusinessDaysIso, doneMessage, isPending } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Field, Button, Pill, Modal, ErrorBox, Loading, Empty, Icon, useUi, useAction } from '../ui.jsx';

const RAILS = { USD: [['ACH', 'ACH (NACHA, next-day)'], ['FEDWIRE', 'Fedwire (same-day, high value)']], OTHER: [['PAIN001', 'ISO 20022 pain.001 (SEPA / bank portal)'], ['SWIFT_MT103', 'SWIFT MT103 (cross-border)']] };
const STATUS_TONE = { DRAFT: 'warn', APPROVED: 'info', SENT: 'good', CANCELLED: '' };

export default function Disbursements() {
  const { can, today } = useSession();
  const { toast } = useUi();
  const queue = useApi('/api/payments/queue');
  const batches = useApi('/api/payment-batches');
  const accounts = useApi('/api/bank-accounts');
  const [checked, setChecked] = useState(() => new Set());
  const [rail, setRail] = useState('');
  const [valueDate, setValueDate] = useState(addBusinessDaysIso(today, 1));
  const [openBatch, setOpenBatch] = useState(null);
  const [editAcct, setEditAcct] = useState(null);
  const [busy, run] = useAction();
  const reload = () => { queue.reload(); batches.reload(); accounts.reload(); setChecked(new Set()); };
  const q = queue.data ?? [];
  const sel = q.filter((p) => checked.has(p.id));
  const ccy = sel[0]?.currency;
  const mixed = new Set(sel.map((p) => p.currency)).size > 1;
  const rails = ccy === 'USD' ? RAILS.USD : RAILS.OTHER;
  const create = () => run(async () => {
    const r = await post('/api/payment-batches', { payment_ids: sel.map((p) => p.id), rail: rail || rails[0][0], value_date: valueDate });
    toast(`${r.ref} prepared — needs approval by a second treasury user`, 'success');
    reload();
    setOpenBatch(r.id);
  });
  const totalBy = (list) => Object.entries(list.reduce((a, p) => ({ ...a, [p.currency]: (a[p.currency] ?? 0) + p.amount_cents }), {}));

  return (
    <>
      <div className="grid g4">
        <Kpi label="Payments queued" value={q.length} sub={totalBy(q).map(([c, v]) => money(v, c)).join(' · ') || 'Nothing to pay'} />
        <Kpi label="Batches awaiting approval" value={(batches.data ?? []).filter((b) => b.status === 'DRAFT').length} sub="Four-eyes (SoD-10)" />
        <Kpi label="Approved, not sent" value={(batches.data ?? []).filter((b) => b.status === 'APPROVED').length} sub="File generated, ready to transmit" />
        <Kpi label="Missing bank details" value={q.filter((p) => !p.beneficiary_account_id).length} sub="Beneficiaries without an account" tone={q.some((p) => !p.beneficiary_account_id) ? 'danger' : ''} />
      </div>

      <Card title="Payment queue" subtitle="Seller payments from approved fundings and investor payments from approved distributions. Select payments in one currency to build a batch."
        right={can('payments.prepare') && sel.length > 0 && <>
          <select className="select sm" style={{ width: 260 }} value={rail || rails[0][0]} onChange={(e) => setRail(e.target.value)} aria-label="Payment rail">{rails.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <input className="input sm" type="date" style={{ width: 150 }} value={valueDate} min={today} onChange={(e) => setValueDate(e.target.value)} aria-label="Value date" />
          <Button variant="primary" disabled={busy || mixed} onClick={create} title={mixed ? 'Select one currency' : ''}>Create batch ({sel.length})</Button>
        </>}>
        <ErrorBox error={queue.error} />
        {!queue.data ? <Loading /> : !q.length ? <Empty>No payments waiting. Approving a funding or a distribution queues payments here.</Empty> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th /><th>Purpose</th><th>Beneficiary</th><th>Bank</th><th>Account</th><th className="r">Amount</th><th>Due</th><th>Reference</th></tr></thead>
            <tbody>{q.map((p) => (
              <tr key={p.id} className={!p.beneficiary_account_id ? 'held' : ''}>
                <td><input type="checkbox" className="check" checked={checked.has(p.id)} onChange={() => setChecked((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })} aria-label={`Select payment to ${p.beneficiary_name}`} /></td>
                <td><Pill tone={p.purpose === 'FUNDING' ? 'info' : 'violet'}>{p.purpose === 'FUNDING' ? 'Seller funding' : 'Distribution'}</Pill></td>
                <td className="strong">{p.account_name ?? p.beneficiary_name}</td><td>{p.bank_name ?? <span className="t-red">No account on file</span>}</td>
                <td className="mono">{p.iban_masked ?? (p.account_number_masked ? `${p.routing_number_masked} / ${p.account_number_masked}` : "—")}</td>
                <td className="r">{money(p.amount_cents, p.currency)}</td><td>{dateShort(p.due_date)}</td><td className="small muted">{p.reference}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      <Card title="Disbursement batches" subtitle="Approve generates and validates the bank file (routing / IBAN / BIC checks). Release posts the cash to the ledger once the file is sent to the bank.">
        {!batches.data ? <Loading /> : !batches.data.length ? <Empty>No batches yet.</Empty> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Batch</th><th>Rail</th><th>Currency</th><th className="r">Payments</th><th className="r">Total</th><th>Value date</th><th>Status</th><th>Prepared</th><th>Approved</th><th>File</th></tr></thead>
            <tbody>{batches.data.map((b) => (
              <tr key={b.id} className="selectable" onClick={() => setOpenBatch(b.id)}><td className="strong t-brand">{b.ref}</td><td>{b.rail}</td><td>{b.currency}</td><td className="r">{b.payments}</td>
                <td className="r">{money(b.total_cents, b.currency)}</td><td>{dateShort(b.value_date)}</td><td><Pill tone={STATUS_TONE[b.status]}>{b.status}</Pill></td>
                <td>{b.created_by}</td><td>{b.approved_by ?? '—'}</td><td className="small">{b.file_name ?? '—'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      <Card title="Beneficiary bank accounts" subtitle="Validated on entry (ABA checksum, IBAN mod-97, BIC). Account numbers are masked. Whoever changes an account cannot approve batches paying it."
        right={can('payments.accounts') && <Button icon="plus" onClick={() => setEditAcct({})}>Add account</Button>}>
        {!accounts.data ? <Loading /> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Owner</th><th>Account name</th><th>Bank</th><th>Routing / BIC</th><th>Account / IBAN</th><th>Ccy</th><th>Country</th><th>Changed by</th><th /></tr></thead>
            <tbody>{accounts.data.map((a) => (
              <tr key={a.id} className={a.active ? '' : 'dim'}><td>{a.owner_name}</td><td className="strong">{a.account_name}</td><td>{a.bank_name}</td><td className="mono">{a.routing_number_masked ?? a.bic}</td>
                <td className="mono">{a.iban_masked ?? a.account_number_masked}</td><td>{a.currency}</td><td>{a.country}</td><td>{a.updated_by} · {dateShort(a.updated_at)}</td>
                <td>{can('payments.accounts') && <Button size="sm" icon="edit" onClick={() => setEditAcct(a)}>Edit</Button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {openBatch && <BatchModal id={openBatch} onClose={() => setOpenBatch(null)} onChanged={reload} />}
      {editAcct && <AccountModal account={editAcct.id ? editAcct : null} onClose={() => setEditAcct(null)} onDone={() => { setEditAcct(null); reload(); }} />}
    </>
  );
}

function BatchModal({ id, onClose, onChanged }) {
  const { can, me } = useSession();
  const { toast, ask, fail } = useUi();
  const { data: b, reload } = useApi(`/api/payment-batches/${id}`);
  const preview = useApi(b && b.status === 'DRAFT' ? `/api/payment-batches/${id}/preview` : null);
  const [busy, run] = useAction();
  const done = () => { reload(); onChanged(); };
  const release = async () => {
    if (!(await ask({ title: `Release ${b.ref}?`, message: 'Confirm the file has been transmitted to the bank. Cash is posted out of the operating account and the payments are marked sent.', confirm: 'Mark as sent' }))) return;
    run(async () => { await post(`/api/payment-batches/${id}/release`, {}, { idempotent: true }); toast(`${b.ref} released`, 'success'); done(); });
  };
  return (
    <Modal title={b ? `Disbursement batch ${b.ref}` : 'Batch'} subtitle={b ? `${b.rail} · ${b.currency} · value date ${dateShort(b.value_date)} · prepared by ${b.created_by}` : ''} onClose={onClose} width={1000}
      footer={b && <>
        {['DRAFT', 'APPROVED'].includes(b.status) && can('payments.prepare') && <Button onClick={() => run(async () => { await post(`/api/payment-batches/${id}/cancel`); toast('Batch cancelled — payments back in the queue', 'success'); done(); })}>Cancel batch</Button>}
        {b.file_document_id && <Button icon="download" onClick={() => download(`/api/documents/${b.file_document_id}/file`, b.file_name).catch(fail)}>Download bank file</Button>}
        {b.status === 'DRAFT' && can('payments.approve') && <Button variant="success" disabled={busy || b.created_by === me.username || preview.data?.errors.length > 0} title={b.created_by === me.username ? 'Four-eyes: another treasury user must approve' : ''}
          onClick={() => run(async () => { const r = await post(`/api/payment-batches/${id}/approve`, {}, { idempotent: true }); toast(`${b.ref} approved — ${r.file} generated`, 'success'); done(); })}>Approve & generate file</Button>}
        {b.status === 'APPROVED' && can('payments.approve') && <Button variant="primary" disabled={busy} onClick={release}>Mark as sent to bank</Button>}
      </>}>
      {!b ? <Loading /> : (
        <>
          <div className="row" style={{ marginBottom: 12 }}><Pill tone={STATUS_TONE[b.status]}>{b.status}</Pill>{b.approved_by && <span className="small muted">Approved by {b.approved_by} · {dateTime(b.approved_at)}</span>}{b.sent_at && <span className="small muted">Sent {dateTime(b.sent_at)}</span>}</div>
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Beneficiary</th><th>Bank</th><th>Account</th><th className="r">Amount</th><th>Reference</th><th>Status</th></tr></thead>
            <tbody>{b.payments.map((p) => <tr key={p.id}><td className="strong">{p.account_name}</td><td>{p.bank_name}</td><td className="mono">{p.iban_masked ?? `${p.routing_number_masked} / ${p.account_number_masked}`}</td><td className="r">{money(p.amount_cents, p.currency)}</td><td className="small">{p.reference}</td><td><Pill status={p.status === 'SENT' ? 'SETTLED' : 'OPEN'}>{p.status}</Pill></td></tr>)}</tbody>
            <tfoot><tr><td colSpan={3}>{b.payments.length} payments</td><td className="r">{money(b.payments.reduce((a, p) => a + p.amount_cents, 0), b.currency)}</td><td colSpan={2} /></tr></tfoot>
          </table></div>
          {preview.data && (
            <>
              <div className="section-title">Bank file validation {preview.data.errors.length ? <Pill tone="bad">{preview.data.errors.length} error(s)</Pill> : <Pill tone="good">passes</Pill>}</div>
              {preview.data.errors.length > 0 && <div className="blockers"><ul>{preview.data.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}
              {preview.data.preview && <pre className="mono" style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 10, overflow: 'auto', maxHeight: 240, fontSize: 11 }}>{preview.data.preview}</pre>}
            </>
          )}
          {b.sagas.length > 0 && (
            <>
              <div className="section-title">Process log (saga)</div>
              {b.sagas.map((s) => (
                <div key={s.id} className="infobar"><Pill tone={s.status === 'COMPLETED' ? 'good' : 'bad'}>{s.status}</Pill><span className="mono">{s.saga}</span>
                  <span>{s.steps.map((st) => `${st.status === 'DONE' ? '✓' : st.status === 'COMPENSATED' ? '↺' : '✗'} ${st.name}`).join('  →  ')}</span>{s.error && <span className="t-red">{s.error}</span>}</div>
              ))}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function AccountModal({ account, onClose, onDone }) {
  const { toast } = useUi();
  const [busy, run] = useAction();
  const programs = useApi('/api/programs');
  const investors = useApi('/api/investors');
  const a = account ?? {};
  const [f, setF] = useState({ owner_type: a.owner_type ?? 'PROGRAM', owner_id: a.owner_id ? String(a.owner_id) : '', account_name: a.account_name ?? '', bank_name: a.bank_name ?? '',
    routing_number: '', account_number: '', bic: a.bic ?? '', iban: '', currency: a.currency ?? 'USD', country: a.country ?? 'US', active: a.active === undefined ? true : !!a.active });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const us = f.currency === 'USD' && f.country === 'US';
  const owners = f.owner_type === 'PROGRAM' ? (programs.data ?? []).map((p) => [p.id, `${p.client_name} (${p.program_code})`]) : f.owner_type === 'INVESTOR' ? (investors.data ?? []).map((i) => [i.id, `${i.code} · ${i.name}`]) : [];
  const save = () => run(async () => {
    const body = { owner_type: f.owner_type, owner_id: f.owner_type === 'SEAPORT' ? undefined : Number(f.owner_id), account_name: f.account_name, bank_name: f.bank_name, currency: f.currency.toUpperCase(), country: f.country.toUpperCase(), active: f.active,
      ...(us ? { routing_number: f.routing_number || undefined, account_number: f.account_number || undefined } : { bic: f.bic.toUpperCase(), iban: f.iban || undefined }) };
    const r = account ? await put(`/api/bank-accounts/${account.id}`, body) : await post('/api/bank-accounts', body);
    toast(doneMessage(r, 'Bank account saved'), isPending(r) ? 'info' : 'success');
    onDone();
  });
  return (
    <Modal title={account ? `Edit ${account.account_name}` : 'Add beneficiary bank account'} subtitle={account ? `Current ${account.iban_masked ? `IBAN ${account.iban_masked}` : `account ${account.account_number_masked ?? ''}`}. Leave the number blank to keep it. Changes take effect after a second person approves them.` : 'The account becomes usable after a second person approves it.'} onClose={onClose} width={720}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.account_name || (!account && (us ? !f.account_number : !f.iban))} onClick={save}>Submit for approval</Button></>}>
      <div className="grid g2">
        <Field label="Owner type"><select className="select" value={f.owner_type} disabled={!!account} onChange={set('owner_type')}><option value="PROGRAM">Seller (program)</option><option value="INVESTOR">Investor</option><option value="SEAPORT">Seaport (originator)</option></select></Field>
        {f.owner_type !== 'SEAPORT' ? <Field label="Owner"><select className="select" value={f.owner_id} disabled={!!account} onChange={set('owner_id')}><option value="">Choose…</option>{owners.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select></Field> : <div />}
        <Field label="Account name (beneficiary)"><input className="input" value={f.account_name} onChange={set('account_name')} /></Field>
        <Field label="Bank name"><input className="input" value={f.bank_name} onChange={set('bank_name')} /></Field>
        <Field label="Currency"><input className="input" maxLength={3} value={f.currency} onChange={set('currency')} /></Field>
        <Field label="Bank country"><input className="input" maxLength={2} value={f.country} onChange={set('country')} /></Field>
        {us ? <>
          <Field label="ABA routing number" hint={account?.routing_number_masked ? `Now ${account.routing_number_masked}; leave blank to keep` : '9 digits, checksum validated'}><input className="input" value={f.routing_number} onChange={set('routing_number')} autoComplete="off" /></Field>
          <Field label="Account number"><input className="input" value={f.account_number} onChange={set('account_number')} autoComplete="off" /></Field>
        </> : <>
          <Field label="BIC / SWIFT"><input className="input" value={f.bic} onChange={set('bic')} /></Field>
          <Field label="IBAN" hint="Validated with the mod-97 check"><input className="input" value={f.iban} onChange={set('iban')} autoComplete="off" /></Field>
        </>}
        <label className="row"><input type="checkbox" className="check" checked={f.active} onChange={set('active')} /> Active</label>
      </div>
    </Modal>
  );
}
