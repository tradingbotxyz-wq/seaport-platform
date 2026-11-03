// Approvals inbox: maker-checker for master data, rates, bank details and user access.
import { useState } from 'react';
import { useApi, post, dateTime } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Button, Pill, Modal, Field, Loading, ErrorBox, Empty, Kpi, useUi, useAction } from '../ui.jsx';

const KIND_LABEL = {
  PROGRAM_CREATE: 'New program', PROGRAM_UPDATE: 'Program change', OBLIGOR_CREATE: 'New obligor / limit', OBLIGOR_UPDATE: 'Obligor / limit change',
  FX_RATE: 'FX rate', RATE_FIXING: 'Benchmark fixing', BANK_ACCOUNT_CREATE: 'New bank account', BANK_ACCOUNT_UPDATE: 'Bank account change',
  USER_CREATE: 'New user', USER_UPDATE: 'User access change', USER_RESET_PASSWORD: 'Password reset', USER_RESET_MFA: 'MFA reset',
};
const STATUS_TONE = { PENDING: 'warn', APPLIED: 'good', REJECTED: 'bad', CANCELLED: '' };
const TABS = [['PENDING', 'Waiting'], ['ALL', 'History']];

const show = (v) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const fieldLabel = (k) => k.replace(/_cents$/, '').replace(/_bps$/, ' (bps)').replace(/_/g, ' ');
const BOOL = new Set(['active', 'auto_debit']);
const fmtVal = (k, v) => (k.endsWith('_cents') && Number.isFinite(v) ? (v / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })
  : BOOL.has(k) && (v === 0 || v === 1 || typeof v === 'boolean') ? (v ? 'Yes' : 'No') : show(v));

function Diff({ before, payload }) {
  const keys = [...new Set([...Object.keys(payload ?? {}), ...Object.keys(before ?? {})])].filter((k) => typeof (payload?.[k] ?? before?.[k]) !== 'object' || k === 'rates');
  const all = keys.map((k) => [k, before?.[k], payload?.[k]]);
  // For a change, show what moves; unchanged fields would only hide it.
  const rows = before ? all.filter(([, b, a]) => show(b) !== show(a)) : all;
  return (
    <div className="table-wrap"><table className="tbl">
      <thead><tr><th>Field</th>{before && <th>Now</th>}<th>{before ? 'Proposed' : 'Value'}</th></tr></thead>
      <tbody>{rows.map(([k, b, a]) => {
        const changed = before && show(b) !== show(a);
        return <tr key={k} className={changed ? 'changed' : ''}><td className="muted">{fieldLabel(k)}</td>{before && <td>{fmtVal(k, b)}</td>}<td className={changed ? 'strong' : ''}>{fmtVal(k, a)}</td></tr>;
      })}</tbody>
    </table></div>
  );
}

export default function Approvals() {
  const { me, refreshBadges } = useSession();
  const { toast } = useUi();
  const [tab, setTab] = useState('PENDING');
  const { data, error, reload } = useApi(`/api/approvals?status=${tab}`);
  const [open, setOpen] = useState(null);
  const [note, setNote] = useState('');
  const [temp, setTemp] = useState(null);
  const [busy, run] = useAction();
  if (error) return <ErrorBox error={error} />;
  const mine = (data ?? []).filter((c) => c.status === 'PENDING' && c.can_approve);
  const decide = (decision) => run(async () => {
    const r = await post(`/api/approvals/${open.id}/decide`, { decision, note: note || undefined });
    if (r?.result?.temporary_password) setTemp({ user: open.entity_id, password: r.result.temporary_password });
    toast(decision === 'APPROVE' ? `${open.ref} approved and applied` : `${open.ref} rejected`, decision === 'APPROVE' ? 'success' : 'info');
    setOpen(null); setNote(''); reload(); refreshBadges?.();
  });
  const cancel = (c) => run(async () => { await post(`/api/approvals/${c.id}/cancel`); toast(`${c.ref} withdrawn`, 'info'); reload(); refreshBadges?.(); });

  return (
    <>
      <div className="grid g3">
        <Kpi label="Waiting for you" value={tab === 'PENDING' ? mine.length : '—'} sub="Changes you are allowed to approve" tone={mine.length ? 'warn' : ''} />
        <Kpi label="Your own requests" value={(data ?? []).filter((c) => c.requested_by === me.username && c.status === 'PENDING').length} sub="Waiting for someone else" />
        <Kpi label="Rule" value="Four eyes" sub="Nobody approves their own change. Limits above authority need the credit committee." />
      </div>
      <Card title="Change requests" subtitle="Reference data that drives money takes effect only when a second authorised person approves it."
        right={<div className="chips">{TABS.map(([k, l]) => <button key={k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>}>
        {!data ? <Loading /> : !data.length ? <Empty>{tab === 'PENDING' ? 'Nothing is waiting for approval.' : 'No change requests yet.'}</Empty> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Ref</th><th>Type</th><th>Change</th><th>Requested by</th><th>When</th><th>Status</th><th /></tr></thead>
            <tbody>{data.map((c) => (
              <tr key={c.id} className="selectable" onClick={() => { setOpen(c); setNote(''); }}>
                <td className="strong">{c.ref}</td>
                <td>{KIND_LABEL[c.kind] ?? c.kind}{c.requires_role === 'ADMIN' && <Pill tone="bad">Committee</Pill>}</td>
                <td className="wrap">{c.summary}</td>
                <td>{c.requested_by_name ?? c.requested_by}</td>
                <td className="small muted">{dateTime(c.requested_at)}</td>
                <td><Pill tone={STATUS_TONE[c.status]}>{c.status.toLowerCase()}</Pill></td>
                <td>{c.can_approve ? <Button size="sm" variant="primary" onClick={(e) => { e.stopPropagation(); setOpen(c); }}>Review</Button>
                  : c.can_cancel ? <Button size="sm" disabled={busy} onClick={(e) => { e.stopPropagation(); cancel(c); }}>Withdraw</Button> : null}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Card>
      {open && (
        <Modal title={`${open.ref} · ${KIND_LABEL[open.kind] ?? open.kind}`} subtitle={open.summary} onClose={() => setOpen(null)} width={720}
          footer={open.can_approve ? <>
            <Button disabled={busy || !note.trim()} onClick={() => decide('REJECT')} title={!note.trim() ? 'Give a reason to reject' : ''}>Reject</Button>
            <Button variant="primary" disabled={busy} onClick={() => decide('APPROVE')}>Approve and apply</Button>
          </> : <Button onClick={() => setOpen(null)}>Close</Button>}>
          <dl className="dl">
            <dt>Requested by</dt><dd>{open.requested_by_name ?? open.requested_by} · {dateTime(open.requested_at)}</dd>
            {open.reason && <><dt>Reason</dt><dd>{open.reason}</dd></>}
            {open.decided_by && <><dt>Decided by</dt><dd>{open.decided_by_name ?? open.decided_by} · {dateTime(open.decided_at)}{open.decision_note ? ` — ${open.decision_note}` : ''}</dd></>}
            {open.requires_role === 'ADMIN' && <><dt>Authority</dt><dd className="t-red">Above delegated credit authority: credit committee approval required</dd></>}
          </dl>
          {open.kind === 'USER_RESET_PASSWORD' || open.kind === 'USER_RESET_MFA' ? (
            <div className="infobar" style={{ marginTop: 12 }}>
              {open.kind === 'USER_RESET_PASSWORD'
                ? 'Approving shows you a one-time password. Give it to the user yourself, by phone or in person. The requester never sees it.'
                : 'Confirm the person\'s identity (for example on a video call) before approving. They set up a new authenticator at their next sign-in.'}
              {' '}After a reset the account cannot approve anything for 24 hours.
            </div>
          ) : <>
            <div className="section-title">What changes</div>
            <Diff before={open.before} payload={open.payload} />
          </>}
          {open.can_approve && (
            <Field label="Note (required to reject)" style={{ marginTop: 12 }}><textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Verified by call-back to the account holder" /></Field>
          )}
          {!open.can_approve && open.status === 'PENDING' && <div className="infobar" style={{ marginTop: 12 }}>{open.requested_by === me.username ? 'You raised this request, so someone else must approve it.'
            : open.requires_role === 'ADMIN' ? 'This change is above delegated credit authority. Only the credit committee (administrator) can approve it; you can still see it here.'
            : 'Your role cannot approve this type of change.'}</div>}
        </Modal>
      )}
      {temp && (
        <Modal title={`One-time password for ${temp.user}`} onClose={() => setTemp(null)} width={520} footer={<Button variant="primary" onClick={() => setTemp(null)}>Done</Button>}>
          <p>Give this to <b>{temp.user}</b> yourself, by phone or in person. It is shown only once. They must choose their own password and keep their two-step verification.</p>
          <div className="temp-pw"><code>{temp.password}</code><Button size="sm" onClick={() => navigator.clipboard?.writeText(temp.password)}>Copy</Button></div>
        </Modal>
      )}
    </>
  );
}
