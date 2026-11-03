import { useState } from 'react';
import { useApi, post, money, moneyShort, dateShort, dateTime, pct, download } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Field, Button, Pill, ErrorBox, Loading, Empty, Icon, useUi, useAction } from '../ui.jsx';

const cap = (s) => s[0] + s.slice(1).toLowerCase();

export default function Portal() {
  const { today } = useSession();
  const { toast, fail } = useUi();
  const { data: d, error, reload } = useApi('/api/portal');
  const reqs = useApi('/api/portal/requests');
  const [busy, run] = useAction();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [req, setReq] = useState({ kind: 'QUESTION', commitment_id: '', message: '' });
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Loading />;
  const get = (id, name) => download(`/api/documents/${id}/file`, name).catch(fail);
  const gen = (kind) => run(async () => {
    const r = kind === 'statement' ? await post('/api/portal/statements', { from, to }) : await post(`/api/portal/tax/${today.slice(0, 4)}`);
    await get(r.document_id, r.filename);
    toast(`${r.filename} ready`, 'success');
    reload();
  });
  const send = () => run(async () => {
    const r = await post('/api/portal/requests', { kind: req.kind, commitment_id: req.commitment_id ? Number(req.commitment_id) : undefined, message: req.message });
    toast(`Request ${r.ref} sent to Seaport Global`, 'success');
    setReq({ kind: 'QUESTION', commitment_id: '', message: '' });
    reqs.reload();
  });
  return (
    <>
      <div className="infobar" style={{ margin: 0 }}><b>{d.investor.name}</b> · investor ID {d.investor.code} · this portal shows only your own positions and documents.</div>
      {d.totals.map((t) => (
        <div key={t.currency} className="grid g6">
          <Kpi label={`Committed (${t.currency})`} value={moneyShort(t.committed, t.currency)} sub={`${d.positions.filter((p) => p.currency === t.currency).length} position(s)`} />
          <Kpi label="Paid in" value={moneyShort(t.paid_in, t.currency)} sub={`Called ${moneyShort(t.called, t.currency)}`} />
          <Kpi label="Unfunded" value={moneyShort(t.unfunded, t.currency)} sub="Remaining commitment" />
          <Kpi label="Income received" value={moneyShort(t.income, t.currency)} sub="Distributions to date" tone="good" />
          <Kpi label="Capital returned" value={moneyShort(t.returned, t.currency)} sub="Return of capital" />
          <Kpi label="Net capital invested" value={moneyShort(t.nav, t.currency)} sub={t.paid_in ? `Cash yield ${pct((t.income * 100) / t.paid_in, 2)} on paid-in` : ''} />
        </div>
      ))}
      <Card title="Positions">
        {!d.positions.length ? <Empty>No positions.</Empty> : (
          <div className="table-wrap"><table className="tbl"><thead><tr><th>Pool</th><th>Tranche</th><th className="r">Committed</th><th className="r">Called</th><th className="r">Paid in</th><th className="r">Income</th><th className="r">Unfunded</th><th>Since</th></tr></thead>
            <tbody>{d.positions.map((p) => <tr key={p.id}><td className="strong">{p.pool_ref} · {p.pool_name}</td><td>{cap(p.tranche)}</td><td className="r">{money(p.amount_cents, p.currency)}</td><td className="r">{money(p.called_cents, p.currency)}</td>
              <td className="r">{money(p.paid_in_cents, p.currency)}</td><td className="r t-green">{money(p.income_cents, p.currency)}</td><td className="r">{money(p.unfunded_cents, p.currency)}</td><td>{dateShort(p.signed_at)}</td></tr>)}</tbody></table></div>
        )}
      </Card>
      <div className="grid g2">
        <Card title="Capital calls">
          {!d.calls.length ? <Empty>No capital calls.</Empty> : (
            <div className="table-wrap"><table className="tbl"><thead><tr><th>Call</th><th>Pool</th><th className="r">Amount</th><th className="r">Paid</th><th>Due</th><th>Notice</th></tr></thead>
              <tbody>{d.calls.map((c) => <tr key={c.id}><td className="strong">{c.ref}</td><td>{c.pool_ref} · {cap(c.tranche)}</td><td className="r">{money(c.amount_cents, c.currency)}</td>
                <td className={`r ${c.received_cents >= c.amount_cents ? 't-green' : 't-amber'}`}>{money(c.received_cents, c.currency)}</td><td>{dateShort(c.due_date)}</td>
                <td>{c.notice_document_id ? <button className="file-link" onClick={() => get(c.notice_document_id, c.notice_filename)}><Icon name="file" size={14} />PDF</button> : '—'}</td></tr>)}</tbody></table></div>
          )}
        </Card>
        <Card title="Distributions">
          {!d.distributions.length ? <Empty>No distributions yet.</Empty> : (
            <div className="table-wrap"><table className="tbl"><thead><tr><th>Ref</th><th>Pool</th><th>Type</th><th className="r">Amount</th><th>Pay date</th><th>Status</th></tr></thead>
              <tbody>{d.distributions.map((x, i) => <tr key={i}><td className="strong">{x.ref}</td><td>{x.pool_ref}</td><td>{x.kind === 'INCOME' ? 'Income' : 'Return of capital'}</td><td className="r">{money(x.amount_cents, x.currency)}</td><td>{dateShort(x.payment_date)}</td><td><Pill tone={x.status === 'PAID' ? 'good' : 'info'}>{x.status}</Pill></td></tr>)}</tbody></table></div>
          )}
        </Card>
      </div>
      <div className="grid g2">
        <Card title="Statements and tax documents" right={<div className="row"><Field label="From"><input className="input sm" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To"><input className="input sm" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>}>
          <div className="row" style={{ marginBottom: 12 }}>
            <Button variant="primary" disabled={busy} onClick={() => gen('statement')}>Download capital account statement</Button>
            <Button disabled={busy} onClick={() => gen('tax')}>Tax summary {today.slice(0, 4)} (K-1 support)</Button>
          </div>
          {!d.documents.length ? <Empty>No documents yet.</Empty> : (
            <div className="table-wrap scroll"><table className="tbl"><tbody>{d.documents.map((x) => <tr key={x.id}><td><button className="file-link" onClick={() => get(x.id, x.filename)}><Icon name="file" size={14} />{x.filename}</button></td><td className="small muted">{x.doc_type.replace(/_/g, ' ').toLowerCase()}</td><td className="small muted">{dateTime(x.created_at)}</td></tr>)}</tbody></table></div>
          )}
        </Card>
        <Card title="Requests to Seaport Global" subtitle="Questions, document requests, redemption or transfer requests. Your relationship team responds here.">
          <div className="grid g2">
            <Field label="Request type"><select className="select" value={req.kind} onChange={(e) => setReq({ ...req, kind: e.target.value })}><option value="QUESTION">Question</option><option value="DOCUMENT">Document request</option><option value="REDEMPTION">Redemption request</option><option value="TRANSFER">Transfer request</option><option value="DETAILS_CHANGE">Change of contact / bank details</option></select></Field>
            <Field label="Position (optional)"><select className="select" value={req.commitment_id} onChange={(e) => setReq({ ...req, commitment_id: e.target.value })}><option value="">General</option>{d.positions.map((p) => <option key={p.id} value={p.id}>{p.pool_ref} · {cap(p.tranche)}</option>)}</select></Field>
            <Field label="Message" style={{ gridColumn: 'span 2' }}><textarea className="textarea" value={req.message} onChange={(e) => setReq({ ...req, message: e.target.value })} /></Field>
          </div>
          <div className="row" style={{ marginTop: 10 }}><Button variant="primary" disabled={busy || !req.message.trim()} onClick={send}>Send request</Button></div>
          {(reqs.data ?? []).length > 0 && (
            <div className="table-wrap" style={{ marginTop: 14 }}><table className="tbl"><tbody>{reqs.data.map((r) => <tr key={r.id}><td className="strong">{r.ref}</td><td className="wrap">{r.subject}</td><td><Pill tone={r.status === 'RESOLVED' ? 'good' : 'info'}>{r.status.replace('_', ' ').toLowerCase()}</Pill></td><td className="small muted">{dateShort(r.created_at)}</td></tr>)}</tbody></table></div>
          )}
        </Card>
      </div>
    </>
  );
}
