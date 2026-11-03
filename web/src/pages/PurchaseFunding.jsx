import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi, post, fileToBase64, money, moneyShort, dateShort, dateLong, dateTime, pct, bps, advPct, setQuery, useLocation } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Kpi, Field, FileDrop, Button, Pill, UsageBar, ErrorBox, Loading, Empty, useUi, useAction } from '../ui.jsx';
import { ImportsTable, SkippedRows, earliestFunding, programOption, ACCEPT_INVOICES } from './shared.jsx';

const BLOCKER_LABEL = {
  LIMIT: 'limit breach', INVESTOR: 'investor untagged', FOUR_EYES: 'four-eyes', T_PLUS: 'before T+1', PAST_DATE: 'funding date passed',
  FIXING: 'no rate fixing', EMPTY: 'no eligible invoices', PROGRAM: 'program inactive', PRICING: 'unpriceable invoice',
};
const BUCKETS = ['1-30', '31-90', '91-180', '181+'];
const bucketLabel = (b) => (b ? b.replace('-', '–') : '—');

export default function PurchaseFunding() {
  const { today, can, refreshBadges } = useSession();
  const { toast, ask } = useUi();
  const { query } = useLocation();
  const selectedId = query.get('import') ? Number(query.get('import')) : null;
  const programs = useApi('/api/programs');
  const imports = useApi('/api/imports');
  const view = useApi(selectedId ? `/api/imports/${selectedId}` : null);
  const [programId, setProgramId] = useState('');
  const [fundingDate, setFundingDate] = useState('');
  const [file, setFile] = useState(null);
  const [uploadResult, setUploadResult] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [busy, run] = useAction();
  const inputRef = useRef(null);
  const active = (programs.data ?? []).filter((p) => p.status === 'ACTIVE');
  const program = (programs.data ?? []).find((p) => String(p.id) === String(programId));
  const v = view.data && view.data.import.id === selectedId ? view.data : null;
  const f = v?.import;
  const listRow = (imports.data ?? []).find((r) => r.id === selectedId);

  // Default selection: newest file awaiting approval.
  useEffect(() => {
    if (!selectedId && imports.data?.length) {
      const first = imports.data.find((r) => r.status === 'UPLOADED') ?? imports.data[0];
      setQuery('import', first.id);
    }
  }, [imports.data, selectedId]);
  useEffect(() => { if (!programId && active.length && !f) setProgramId(String(active[0].id)); }, [active.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (f) { setProgramId(String(f.program_id)); setFundingDate(f.funding_date); }
    setChecked(new Set());
  }, [f?.id, f?.funding_date]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadAll = () => { view.reload(); imports.reload(); refreshBadges(); };
  const editable = f?.status === 'UPLOADED' && can('invoices.review');
  const dateChanged = f && f.status === 'UPLOADED' && fundingDate && fundingDate !== f.funding_date && String(f.program_id) === String(programId);
  const minDate = program ? earliestFunding(today, program) : today;

  const load = () => run(async () => {
    if (file) {
      const content_base64 = await fileToBase64(file);
      const r = await post('/api/imports', { program_id: Number(programId), funding_date: fundingDate, filename: file.name, content_base64 });
      setFile(null);
      setUploadResult(r);
      imports.reload();
      refreshBadges();
      setQuery('import', r.import.id);
      toast(`${r.import.filename}: ${r.import.accepted} accepted, ${r.import.rejected} rejected`, 'success');
    } else if (dateChanged) {
      await post(`/api/imports/${f.id}/funding-date`, { funding_date: fundingDate });
      toast(`Funding date changed to ${dateShort(fundingDate)} - invoices repriced`, 'success');
      reloadAll();
    } else {
      view.reload();
    }
  });

  const clear = () => { setFile(null); setUploadResult(null); setQuery('import', null); };
  const ids = (statuses) => [...checked].filter((id) => statuses.includes(v.invoices.find((i) => i.id === id)?.status));

  const action = (path, body, message) => run(async () => {
    const r = await post(`/api/imports/${f.id}/${path}`, body);
    toast(typeof message === 'function' ? message(r) : message, 'success');
    setChecked(new Set());
    reloadAll();
  });

  const reject = async () => {
    const list = ids(['PENDING', 'HELD']);
    const reason = await ask({ title: `Reject ${list.length} invoice(s)?`, message: 'Rejected invoices are excluded from this funding. They can be restored until the funding is approved.', input: 'Reason', required: true, confirm: 'Reject', danger: true });
    if (reason) action('reject', { invoice_ids: list, reason }, (r) => `${r.changed} invoice(s) rejected`);
  };
  const tag = (invoiceIds, investorId) => action('investor', { invoice_ids: invoiceIds, investor_id: investorId ? Number(investorId) : null }, 'Investor updated');

  const approve = async () => {
    const k = v.kpis;
    const ok = await ask({
      title: 'Approve funding?',
      message: (
        <div className="stack">
          <span>Fund <b>{k.pending}</b> invoice(s) on <b>{dateLong(f.funding_date)}</b> for <b>{f.deal_name}</b>.</span>
          <dl className="dl" style={{ marginTop: 8 }}>
            <dt>Purchase price</dt><dd>{money(k.purchase_cents, f.currency)}</dd>
            <dt>Interest (discount)</dt><dd>{money(k.interest_cents, f.currency)}</dd>
            <dt>Paid to seller</dt><dd>{money(k.purchase_cents - k.interest_cents, f.currency)}</dd>
          </dl>
          <span className="muted small">Loans are created and posted to the ledger. This cannot be undone from the screen.</span>
        </div>
      ),
      confirm: 'Approve funding',
    });
    if (!ok) return;
    run(async () => {
      const r = await post(`/api/imports/${f.id}/approve`, {}, { idempotent: true });
      toast(`Funding approved: ${r.loans.length} loans created (${r.loans[0]}${r.loans.length > 1 ? ` … ${r.loans[r.loans.length - 1]}` : ''})`, 'success');
      reloadAll();
    });
  };

  const eligible = useMemo(() => (v ? v.invoices.filter((i) => i.status === 'PENDING' || i.status === 'FUNDED') : []), [v]);
  if (programs.error) return <ErrorBox error={programs.error} />;

  return (
    <>
      <Card title="File imports" subtitle="Select a row to load that funding below" right={`${imports.data?.length ?? 0} files loaded`}>
        <ErrorBox error={imports.error} />
        {imports.data ? <ImportsTable imports={imports.data} selectedId={selectedId} onSelect={(id) => setQuery('import', id)} /> : <Loading />}
      </Card>

      <Card title="Select funding and upload"
        right={program && <>Currency <b>{program.currency}</b> · rate basis <b>{program.rate_basis}</b> · funding <b>T+{program.funding_lag_days}</b> · accepted formats xls, xlsx, csv, pdf</>}>
        <div className="grid g3">
          <Field label="Deal name" hint="Sets currency, rate basis and advance rules.">
            <select className="select" value={programId} onChange={(e) => { setProgramId(e.target.value); setFundingDate(''); }}>
              {(f && !active.some((p) => p.id === f.program_id) ? [program, ...active] : active).filter(Boolean).map((p) => <option key={p.id} value={p.id}>{programOption(p)}</option>)}
            </select>
          </Field>
          <Field label="Funding date" hint={`T+${program?.funding_lag_days ?? 1} from upload. Same-day funding is not permitted.`}>
            <input className="input" type="date" min={file || !f ? minDate : today} value={fundingDate}
              disabled={!!f && f.status !== 'UPLOADED' && !file}
              onChange={(e) => setFundingDate(e.target.value)} />
          </Field>
          <Field label="Upload invoice file">
            <FileDrop file={file} onFile={setFile} accept={ACCEPT_INVOICES} inputRef={inputRef}
              title={file ? file.name : f ? f.filename : 'Drop an invoice file here'} hint="Drag a file here, or browse" />
            {f && !file && (
              <div className="meta-line">
                <span>Uploaded <b>{dateShort(f.uploaded_at)}</b></span>
                <span>Earliest funding <b>{dateShort(f.earliest_funding)}</b></span>
                <span>Rows read <b>{f.rows_read}</b></span>
                <span className="ok">Accepted <b>{f.accepted}</b></span>
                <span>Rejected <b>{f.rejected}</b></span>
                <span>Checksum <b>verified</b></span>
              </div>
            )}
          </Field>
        </div>
        <div className="divider" />
        <div className="between">
          <div className="row">
            <Button variant="primary" disabled={busy || (file ? !can('invoices.upload') || !fundingDate : !f) || (dateChanged && !can('invoices.upload'))} onClick={load}>
              {file ? 'Upload & load invoices' : dateChanged ? 'Apply funding date' : 'Load invoices'}
            </Button>
            <Button onClick={clear}>Clear</Button>
          </div>
          {f && <div className="muted small">Loading: <b>{f.deal_code}</b> · funding <b>{dateShort(f.funding_date)}</b> · <b>{v.kpis.total} invoices</b></div>}
        </div>
        {uploadResult && uploadResult.import.id === selectedId && <SkippedRows report={uploadResult.parse} />}
      </Card>

      {selectedId && !v && (view.error ? <ErrorBox error={view.error} /> : <Loading />)}
      {v && <FundingDetail v={v} listRow={listRow} checked={checked} setChecked={setChecked} editable={editable} busy={busy} eligible={eligible}
        onRecheck={() => action('recheck', {}, 'Limits and eligibility rechecked')}
        onReject={reject}
        onRestore={() => action('restore', { invoice_ids: ids(['REJECTED']) }, (r) => `${r.changed} invoice(s) restored${r.skipped?.length ? `; ${r.skipped.length} could not be restored` : ''}`)}
        onTag={tag} onApprove={approve} />}
    </>
  );
}

function FundingDetail({ v, listRow, checked, setChecked, editable, busy, eligible, onRecheck, onReject, onRestore, onTag, onApprove }) {
  const { can } = useSession();
  const f = v.import;
  const k = v.kpis;
  const ccy = f.currency;
  const L = v.limits;
  const funded = f.status === 'APPROVED';
  const toggle = (id) => setChecked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectable = v.invoices.filter((i) => ['PENDING', 'HELD', 'REJECTED'].includes(i.status));
  const allOn = editable && selectable.length > 0 && selectable.every((i) => checked.has(i.id));
  const nSel = (st) => [...checked].filter((id) => st.includes(v.invoices.find((i) => i.id === id)?.status)).length;
  const [bulkInvestor, setBulkInvestor] = useState('');
  const fx = v.fixing;
  const sum = (key) => eligible.reduce((a, i) => a + (i.pricing?.[key] ?? 0), 0);

  return (
    <>
      <div className="grid g6">
        <Kpi label="Invoices in batch" value={k.total} sub={funded ? `${k.funded} funded, ${k.rejected} rejected` : `${k.held} held, ${k.pending} eligible, ${k.rejected} rejected`} />
        <Kpi label="Total face value" value={moneyShort(k.face_cents, ccy)} sub={`Reported in ${ccy}`} />
        <Kpi label="Purchase price" value={moneyShort(k.purchase_cents, ccy)} sub="Eligible invoices only" />
        <Kpi label="Interest payable" value={moneyShort(k.interest_cents, ccy)} sub={`Investor ${moneyShort(k.investor_interest_cents, ccy)} · Seaport ${moneyShort(k.seaport_interest_cents, ccy)}`} />
        <Kpi label="Funding date" value={dateShort(f.funding_date)} sub="Accrual start" />
        <Kpi label="Weighted tenor" value={`${k.weighted_tenor_days} days`} sub="By purchase price" />
      </div>

      <Card title="Limit check for this funding" subtitle={`${ccy} · as of funding date ${dateShort(f.funding_date)}`}
        right={L.breaches ? <Pill tone="bad">{L.breaches} breach{L.breaches > 1 ? 'es' : ''}</Pill> : <Pill tone="good">Within limits</Pill>}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr>
              <th>Buyer / obligor</th><th className="r">Approved limit {ccy}</th><th className="r">Current utilization {ccy}</th><th className="r">Used %</th>
              <th className="r">Pipeline {ccy}</th><th className="r">Requirement this funding {ccy}</th><th className="r">Post-funding utilization {ccy}</th>
              <th className="r">Post %</th><th style={{ minWidth: 150 }}>Usage</th><th className="r">Headroom {ccy}</th><th>Status</th>
            </tr></thead>
            <tbody>
              {L.rows.map((r) => (
                <tr key={r.obligor_id}>
                  <td className="nowrap"><span className="rating">{r.rating}</span> &nbsp;{r.name}</td>
                  <td className="r">{money(r.limit_cents, ccy)}</td>
                  <td className="r">{money(r.current_cents, ccy)}</td>
                  <td className="r t-brand">{pct(r.current_pct)}</td>
                  <td className="r t-violet">{r.pipeline_cents ? money(r.pipeline_cents, ccy) : '—'}</td>
                  <td className="r t-green">{r.requirement_cents ? money(r.requirement_cents, ccy) : '—'}</td>
                  <td className="r">{money(r.post_cents, ccy)}</td>
                  <td className={`r strong ${r.status === 'Breach' ? 't-red' : ''}`}>{pct(r.post_pct)}</td>
                  <td><UsageBar currentPct={r.current_pct} requirementPct={r.limit_cents ? (r.requirement_cents * 100) / r.limit_cents : 0} status={r.status} /></td>
                  <td className={`r ${r.headroom_cents < 0 ? 't-red strong' : ''}`}>{money(r.headroom_cents, ccy)}</td>
                  <td><Pill status={r.status} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Program total</td>
                <td className="r">{money(L.totals.limit_cents, ccy)}</td>
                <td className="r">{money(L.totals.current_cents, ccy)}</td>
                <td className="r">{pct(L.totals.current_pct)}</td>
                <td className="r">{money(L.totals.pipeline_cents, ccy)}</td>
                <td className="r">{money(L.totals.requirement_cents, ccy)}</td>
                <td className="r">{money(L.totals.post_cents, ccy)}</td>
                <td className="r">{pct(L.totals.post_pct)}</td>
                <td />
                <td className="r">{money(L.totals.headroom_cents, ccy)}</td>
                <td>{L.breaches ? 'Breach at obligor level' : 'OK'}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="legend">
          <span><i style={{ background: 'var(--brand)' }} />Current utilization</span>
          <span><i style={{ background: 'repeating-linear-gradient(135deg, var(--violet) 0 2px, transparent 2px 4px)' }} />Requirement this funding</span>
          <span><i style={{ background: 'var(--red)' }} />Breach</span>
          <span>Requirement = purchase price of eligible invoices for that obligor in this funding</span>
          <span>Pipeline = uploaded but unreleased exposure; clears to zero on approval</span>
        </div>
      </Card>

      <Card title="Invoices in this funding"
        subtitle={fx ? `${ccy} · ${f.rate_basis} fixing ${dateLong(fx.fixing_date)} · ${BUCKETS.map((b) => `${bucketLabel(b)} ${bps(fx.rates[b])}`).join(' / ')} · ${f.day_count}` : `${ccy} · no ${f.rate_basis} fixing available`}
        right={funded ? <Pill tone="good">Funded · approved by {listRow?.approved_by_name ?? f.approved_by}</Pill> : (
          <>
            {editable && checked.size > 0 && (
              <select className="select sm" style={{ width: 200 }} value={bulkInvestor}
                onChange={(e) => { const value = e.target.value; setBulkInvestor(''); if (value) onTag([...checked].filter((id) => ['PENDING', 'HELD'].includes(v.invoices.find((i) => i.id === id)?.status)), value); }}>
                <option value="">Tag selected investor…</option>
                {v.investors.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}
              </select>
            )}
            <Button disabled={!editable || busy} onClick={onRecheck}>Recheck invoice</Button>
            <Button disabled={!editable || busy || !nSel(['PENDING', 'HELD'])} onClick={onReject}>Reject selected</Button>
            <Button disabled={!editable || busy || !nSel(['REJECTED'])} onClick={onRestore}>Restore</Button>
            {v.blockers.length > 0 && <span className="btn block-pill sm" title={v.blockers.map((b) => b.message).join('\n')}>Blocked — {BLOCKER_LABEL[v.blockers[0].code] ?? v.blockers[0].code}{v.blockers.length > 1 ? ` +${v.blockers.length - 1}` : ''}</span>}
            <Button variant="success" disabled={busy || v.blockers.length > 0 || !can('funding.approve')} onClick={onApprove}
              title={!can('funding.approve') ? 'Only an operations checker can approve funding' : ''}>Approve funding</Button>
          </>
        )}>
        <div className="infobar">
          <span>Uploaded by <b>{listRow?.uploaded_by_name ?? f.uploaded_by}</b> · {dateTime(f.uploaded_at)}</span>
          <span className="sep">|</span>
          <span>Approved by {funded ? <b>{listRow?.approved_by_name ?? f.approved_by} · {dateTime(f.approved_at)}</b> : <b className="t-amber">pending</b>}</span>
          <span className="sep">|</span>
          <span>Approver must differ from uploader (four-eyes).</span>
        </div>
        {!funded && v.blockers.length > 0 && (
          <div className="blockers"><b>Approval blocked:</b><ul>{v.blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul></div>
        )}
        {v.invoices.length === 0 ? <Empty>No invoices could be read from this file.</Empty> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr>
                <th className="c"><input type="checkbox" className="check" disabled={!editable || !selectable.length} checked={allOn}
                  onChange={() => setChecked(allOn ? new Set() : new Set(selectable.map((i) => i.id)))} aria-label="Select all" /></th>
                <th>Invoice</th><th>Buyer</th><th>Investor ID</th><th>Invoice date</th><th>Due date</th>
                <th className="r">Face amount {ccy}</th><th className="r">Adv %</th><th className="r">Purchase price {ccy}</th><th className="r">Tenor</th>
                <th>Rate bucket</th><th className="r">Base</th><th className="r">Investor margin</th><th className="r">SP spread</th><th className="r">All-in</th>
                <th className="r">Interest {ccy}</th><th className="r">To investor {ccy}</th><th>Status</th><th>Loan ID</th>
              </tr></thead>
              <tbody>
                {v.invoices.map((i) => {
                  const p = i.pricing;
                  const rowEditable = editable && ['PENDING', 'HELD'].includes(i.status);
                  return (
                    <tr key={i.id} className={i.status === 'HELD' ? 'held' : i.status === 'REJECTED' ? 'dim' : ''}>
                      <td className="c"><input type="checkbox" className="check" disabled={!editable || !['PENDING', 'HELD', 'REJECTED'].includes(i.status)} checked={checked.has(i.id)} onChange={() => toggle(i.id)} aria-label={`Select ${i.invoice_number}`} /></td>
                      <td className="nowrap"><b className="t-brand">{i.invoice_number}</b>{i.status_reason && <span className={`reason ${i.status === 'REJECTED' ? 'bad' : 'warn'}`}>{i.status_reason}</span>}</td>
                      <td className="nowrap">{i.buyer_name}</td>
                      <td>
                        {rowEditable ? (
                          <select className={`select sm ${!i.investor_id ? 'warn' : ''}`} style={{ width: 200 }} value={i.investor_id ?? ''} onChange={(e) => onTag([i.id], e.target.value)} disabled={busy}>
                            <option value="">Untagged</option>
                            {v.investors.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
                          </select>
                        ) : <span className="nowrap">{i.investor_code ? `${i.investor_code} · ${i.investor_name}` : '—'}</span>}
                      </td>
                      <td className="nowrap">{dateShort(i.invoice_date)}</td>
                      <td className="nowrap">{dateShort(i.due_date)}</td>
                      <td className="r">{money(i.face_cents, ccy)}</td>
                      <td className="r">{p ? advPct(p.adv_bps) : '—'}</td>
                      <td className="r">{p ? money(p.purchase_cents, ccy) : '—'}</td>
                      <td className="r">{p ? `${p.tenor_days}d` : '—'}</td>
                      <td className="t-violet">{bucketLabel(p?.bucket)}</td>
                      <td className="r">{bps(p?.base_bps)}</td>
                      <td className="r">{bps(p?.investor_margin_bps)}</td>
                      <td className="r">{bps(p?.sp_spread_bps)}</td>
                      <td className="r">{bps(p?.all_in_bps)}</td>
                      <td className="r t-green">{p ? money(p.interest_cents, ccy) : '—'}</td>
                      <td className="r">{p ? money(p.investor_interest_cents, ccy) : '—'}</td>
                      <td><Pill status={i.status} title={i.status_reason ?? ''} /></td>
                      <td className="nowrap">{i.loan_ref ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6}>Total — {eligible.length} eligible of {v.invoices.length}</td>
                  <td className="r">{money(k.eligible_face_cents, ccy)}</td>
                  <td />
                  <td className="r">{money(sum('purchase_cents'), ccy)}</td>
                  <td colSpan={6} />
                  <td className="r">{money(sum('interest_cents'), ccy)}</td>
                  <td className="r">{money(sum('investor_interest_cents'), ccy)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <div className="footnotes">
          <span>Purchase price = face amount × advance ratio</span>
          <span>Interest = purchase price × all-in rate × tenor ÷ day count</span>
          <span>All-in = benchmark + investor margin + SP spread, split per the master table</span>
          <span>Day count {f.day_count} for {ccy}</span>
        </div>
      </Card>
    </>
  );
}
