import { useEffect, useRef, useState } from 'react';
import { useApi, post, fileToBase64, money, dateShort, dateTime, setQuery, useLocation } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Field, FileDrop, Button, Pill, Modal, ErrorBox, Loading, Empty, useUi, useAction } from '../ui.jsx';
import { programOption } from './shared.jsx';

export default function Reconciliation() {
  const { today, can, me, refreshBadges, openLoan } = useSession();
  const { toast, ask } = useUi();
  const { query } = useLocation();
  const selectedId = query.get('statement') ? Number(query.get('statement')) : null;
  const programs = useApi('/api/programs');
  const list = useApi('/api/bank-statements');
  const breaks = useApi('/api/recon/breaks');
  const view = useApi(selectedId ? `/api/bank-statements/${selectedId}` : null);
  const [programId, setProgramId] = useState('');
  const [date, setDate] = useState(today);
  const [file, setFile] = useState(null);
  const [matchLine, setMatchLine] = useState(null);
  const [busy, run] = useAction();
  const inputRef = useRef(null);
  const v = view.data && view.data.statement.id === selectedId ? view.data : null;

  useEffect(() => {
    if (!selectedId && list.data?.length) {
      const first = list.data.find((s) => s.matched > 0 || s.breaks > 0) ?? list.data[0];
      setQuery('statement', first.id);
    }
  }, [list.data, selectedId]);

  const reloadAll = () => { list.reload(); breaks.reload(); view.reload(); refreshBadges(); };

  const upload = () => run(async () => {
    const content_base64 = await fileToBase64(file);
    const r = await post('/api/bank-statements', { program_id: programId ? Number(programId) : undefined, statement_date: date, filename: file.name, content_base64 });
    setFile(null);
    toast(`${file.name}: ${r.MATCHED} matched, ${r.AMOUNT_MISMATCH + r.UNMATCHED} break(s)`, 'success');
    reloadAll();
    setQuery('statement', r.id);
  });

  const postCash = async () => {
    const lines = v.lines.filter((l) => l.match_status === 'MATCHED');
    const total = lines.reduce((a, l) => a + l.amount_cents, 0);
    const ok = await ask({ title: 'Post matched cash?', message: `Apply ${lines.length} matched receipt(s) totalling ${money(total)} to their loans. Fully paid loans are marked Settled and interest is recognised in the ledger.`, confirm: 'Post cash' });
    if (!ok) return;
    run(async () => {
      const r = await post(`/api/bank-statements/${v.statement.id}/post`, {}, { idempotent: true });
      toast(`${r.posted} receipt(s) posted · ${r.settled} loan(s) settled`, 'success');
      reloadAll();
    });
  };

  const resolve = async (line) => {
    const note = await ask({ title: 'Resolve break', message: `${line.reference} · ${money(line.amount_cents, line.currency)}. Record what was done (e.g. returned to remitter, booked as fee, chased client).`, input: 'Resolution note', required: true, confirm: 'Mark resolved' });
    if (!note) return;
    run(async () => { await post(`/api/bank-lines/${line.id}/resolve`, { note }); toast('Break resolved', 'success'); reloadAll(); });
  };

  const stmts = list.data ?? [];
  const totals = {
    matched: stmts.reduce((a, s) => a + s.matched, 0),
    breaks: (breaks.data ?? []).length,
    unapplied: (breaks.data ?? []).reduce((a, b) => a + (b.currency === 'USD' ? b.amount_cents : 0), 0),
    posted: stmts.reduce((a, s) => a + s.posted, 0),
  };
  const isUploader = v && v.statement.uploaded_by === me.username;
  const canPost = can('recon.post') && !isUploader;

  return (
    <>
      <div className="grid g4">
        <Kpi label="Matched, awaiting posting" value={totals.matched} sub="Receipts ready to apply" />
        <Kpi label="Open breaks" value={totals.breaks} sub="Unmatched or amount differences" tone={totals.breaks ? 'danger' : ''} />
        <Kpi label="Unapplied cash (USD)" value={money(totals.unapplied, 'USD')} sub="Sitting on open breaks" />
        <Kpi label="Receipts posted" value={totals.posted} sub="All statements" tone="good" />
      </div>

      <Card title="Bank statements" subtitle="Cash is applied to loans only from here. Matching order: loan ID → advised bank reference → invoice number." right={`${stmts.length} statements`}>
        <ErrorBox error={list.error} />
        {!list.data ? <Loading /> : !stmts.length ? <Empty>No bank statements uploaded yet.</Empty> : (
          <div className="table-wrap scroll">
            <table className="tbl">
              <thead><tr><th>File</th><th>Account / deal</th><th>Statement date</th><th className="r">Lines</th><th className="r">Matched</th><th className="r">Posted</th><th className="r">Breaks</th><th className="r">Total credits</th><th>Uploaded by</th></tr></thead>
              <tbody>
                {stmts.map((s) => (
                  <tr key={s.id} className={`selectable ${s.id === selectedId ? 'selected' : ''}`} onClick={() => setQuery('statement', s.id)}>
                    <td><span className="file-link">{s.filename}</span></td>
                    <td>{s.deal_name ?? 'All collection accounts'}</td>
                    <td>{dateShort(s.statement_date)}</td>
                    <td className="r">{s.lines}</td>
                    <td className="r t-brand">{s.matched}</td>
                    <td className="r t-green">{s.posted}</td>
                    <td className={`r ${s.breaks ? 't-red strong' : ''}`}>{s.breaks}</td>
                    <td className="r">{money(s.total_cents)}</td>
                    <td>{s.uploaded_by_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Upload bank statement" right="Columns detected automatically: value date, narrative/reference, amount, currency, bank reference">
        <div className="grid g3">
          <Field label="Collection account" hint="Limit matching to one deal, or match across all accounts.">
            <select className="select" value={programId} onChange={(e) => setProgramId(e.target.value)}>
              <option value="">All collection accounts</option>
              {(programs.data ?? []).map((p) => <option key={p.id} value={p.id}>{programOption(p)} · {p.collection_account}</option>)}
            </select>
          </Field>
          <Field label="Statement date"><input className="input" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Statement file"><FileDrop file={file} onFile={setFile} accept=".csv,.xlsx,.txt,.pdf" inputRef={inputRef} title="Drop a bank statement here" hint="CSV, XLSX, TXT or PDF export from the bank" /></Field>
        </div>
        <div className="divider" />
        <div className="row">
          <Button variant="primary" icon="upload" disabled={!file || busy || !can('recon.upload')} onClick={upload}>Upload statement</Button>
          {!can('recon.upload') && <span className="muted small">Only Treasury can upload bank statements.</span>}
        </div>
      </Card>

      {selectedId && !v && (view.error ? <ErrorBox error={view.error} /> : <Loading />)}
      {v && (
        <Card title={`Statement lines · ${v.statement.filename}`}
          subtitle={`${v.statement.deal_name ?? 'All collection accounts'} · uploaded by ${v.statement.uploaded_by_name} · ${dateTime(v.statement.uploaded_at)}`}
          right={<>
            <Button variant="primary" disabled={busy || !canPost || !v.lines.some((l) => l.match_status === 'MATCHED')} onClick={postCash}
              title={isUploader ? 'Four-eyes: a different treasury user must post this statement' : ''}>Post matched cash</Button>
          </>}>
          <div className="infobar">
            <span><b>Four-eyes:</b> cash must be posted by a different user than the statement uploader.</span>
            {isUploader && <span className="t-amber">You uploaded this statement, so posting is disabled for you.</span>}
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Value date</th><th>Reference / narrative</th><th>Bank ref</th><th className="r">Amount</th><th>Loan</th><th>Buyer</th><th>Status</th><th>Note</th><th>Journal</th><th /></tr></thead>
              <tbody>
                {v.lines.map((l) => (
                  <tr key={l.id} className={l.match_status === 'UNMATCHED' || l.match_status === 'AMOUNT_MISMATCH' ? 'held' : ''}>
                    <td className="nowrap">{dateShort(l.value_date)}</td>
                    <td>{l.reference}</td>
                    <td className="mono">{l.bank_reference ?? '—'}</td>
                    <td className="r">{money(l.amount_cents, l.currency)}</td>
                    <td>{l.loan_ref ? <a href="#" className="strong" onClick={(e) => { e.preventDefault(); openLoan(l.loan_id); }}>{l.loan_ref}</a> : '—'}</td>
                    <td>{l.buyer ?? '—'}</td>
                    <td><Pill status={l.match_status} /></td>
                    <td className="small muted wrap" style={{ minWidth: 240, maxWidth: 360 }}>{l.resolved_note ? `${l.match_note} · ${l.resolved_note}` : l.match_note}</td>
                    <td className="mono">{l.journal_ref ?? '—'}</td>
                    <td className="nowrap">
                      {['UNMATCHED', 'AMOUNT_MISMATCH'].includes(l.match_status) && can('recon.post') && (
                        <div className="row">
                          <Button size="sm" onClick={() => setMatchLine(l)}>Match…</Button>
                          <Button size="sm" onClick={() => resolve(l)}>Resolve…</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Open breaks (all statements)" right={`${(breaks.data ?? []).length} open`}>
        {!breaks.data ? <Loading /> : !breaks.data.length ? <Empty>No open breaks. Everything on the bank statements is matched or resolved.</Empty> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Statement</th><th>Value date</th><th>Reference</th><th className="r">Amount</th><th>Candidate loan</th><th>Status</th><th>Note</th></tr></thead>
              <tbody>{breaks.data.map((b) => (
                <tr key={b.id} className="selectable" onClick={() => setQuery('statement', b.statement_id)}>
                  <td>{b.filename}</td><td>{dateShort(b.value_date)}</td><td>{b.reference}</td><td className="r">{money(b.amount_cents, b.currency)}</td>
                  <td>{b.loan_ref ?? '—'}</td><td><Pill status={b.match_status} /></td><td className="small muted wrap">{b.match_note}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {matchLine && <MatchModal line={matchLine} onClose={() => setMatchLine(null)} onDone={() => { setMatchLine(null); reloadAll(); }} />}
    </>
  );
}

function MatchModal({ line, onClose, onDone }) {
  const { data: loans } = useApi('/api/loans/open');
  const { toast } = useUi();
  const [loanRef, setLoanRef] = useState(line.loan_ref ?? '');
  const [note, setNote] = useState('');
  const [busy, run] = useAction();
  const candidates = (loans ?? []).filter((l) => l.currency === line.currency).sort((a, b) => Math.abs(a.outstanding_cents - line.amount_cents) - Math.abs(b.outstanding_cents - line.amount_cents)).slice(0, 50);
  const submit = () => run(async () => {
    await post(`/api/bank-lines/${line.id}/match`, { loan_ref: loanRef, note });
    toast(`Matched to ${loanRef} - post the statement to apply the cash`, 'success');
    onDone();
  });
  return (
    <Modal title="Match bank line to a loan" subtitle={`${line.reference} · ${money(line.amount_cents, line.currency)}`} onClose={onClose} width={620}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!loanRef || !note.trim() || busy} onClick={submit}>Match</Button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="Loan" hint="Open loans in the same currency, closest outstanding amount first. Partial payments stay open until fully received.">
          <select className="select" value={loanRef} onChange={(e) => setLoanRef(e.target.value)}>
            <option value="">Choose a loan…</option>
            {candidates.map((l) => <option key={l.id} value={l.loan_ref}>{l.loan_ref} · {l.buyer} · outstanding {money(l.outstanding_cents, l.currency)} · due {dateShort(l.maturity_date)}</option>)}
          </select>
        </Field>
        <Field label="Reason for manual match"><textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Client confirmed by email that this remittance covers the invoice" /></Field>
      </div>
    </Modal>
  );
}
