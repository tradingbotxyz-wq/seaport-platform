// Pieces shared by Client Onboarding and Purchase & Funding.
import { useState } from 'react';
import { useApi, post, money, dateShort, dateTime, download, navigate, addBusinessDaysIso } from '../lib.js';
import { useSession } from '../session.js';
import { Icon, Pill, Modal, Loading, ErrorBox, Button, Empty, useUi } from '../ui.jsx';

export const ACCEPT_INVOICES = '.xlsx,.csv,.txt,.tsv,.pdf';

export function earliestFunding(today, program) {
  return addBusinessDaysIso(today, program?.funding_lag_days ?? 1);
}

export function programOption(p) {
  return `${p.deal_name} — ${p.deal_code}`;
}

/** Footer subtotal: USD summed, other currencies listed as "not summed". */
export function currencyFooter(rows, keys) {
  const usd = rows.filter((r) => r.currency === 'USD');
  const others = [...new Set(rows.map((r) => r.currency).filter((c) => c !== 'USD'))];
  const sums = Object.fromEntries(keys.map((k) => [k, usd.reduce((a, r) => a + (r[k] ?? 0), 0)]));
  return { usdCount: usd.length, others, sums, othersLabel: others.length ? `${others.join(' and ')} not summed` : '' };
}

export function ImportsTable({ imports, selectedId, onSelect, onOpen, onRemove, scroll = true }) {
  const { can } = useSession();
  const f = currencyFooter(imports, ['purchase_cents', 'face_cents', 'discount_cents']);
  if (!imports.length) return <Empty>No invoice files uploaded yet.</Empty>;
  return (
    <div className={`table-wrap ${scroll ? 'scroll' : ''}`} style={{ maxHeight: 420 }}>
      <table className="tbl">
        <thead>
          <tr>
            <th>File</th><th>Program ID</th><th>Deal name</th><th>Purchase date</th><th>Currency</th>
            <th className="r">Purchase amount</th><th className="r">Original invoice amount</th><th className="r">Discount</th>
            <th>Status</th>{onRemove && <th className="c">Action</th>}
          </tr>
        </thead>
        <tbody>
          {imports.map((r) => (
            <tr key={r.id} className={`${onSelect ? 'selectable' : ''} ${selectedId === r.id ? 'selected' : ''}`} onClick={() => onSelect?.(r.id)}>
              <td>
                <button className="file-link" onClick={(e) => { e.stopPropagation(); (onOpen ?? onSelect)?.(r.id); }}>
                  <Icon name="file" size={15} />{r.filename}
                </button>
              </td>
              <td className="strong">{r.program_code}</td>
              <td>{r.deal_name}</td>
              <td className="nowrap">{dateShort(r.funding_date)}</td>
              <td>{r.currency}</td>
              <td className="r">{money(r.purchase_cents, r.currency)}</td>
              <td className="r">{money(r.face_cents, r.currency)}</td>
              <td className="r muted">{money(r.discount_cents, r.currency)}</td>
              <td><Pill status={r.status} /></td>
              {onRemove && (
                <td className="c">
                  {r.status === 'UPLOADED' && can('invoices.upload') ? (
                    <button className="icon-btn" title="Remove file" aria-label={`Remove ${r.filename}`} onClick={(e) => { e.stopPropagation(); onRemove(r); }}>
                      <Icon name="trash" size={16} />
                    </button>
                  ) : <span className="faint">—</span>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={5}>{imports.length} imports · USD subtotal ({f.usdCount} files)</td>
            <td className="r">USD {money(f.sums.purchase_cents)}</td>
            <td className="r">USD {money(f.sums.face_cents)}</td>
            <td className="r muted" colSpan={onRemove ? 3 : 2} style={{ fontWeight: 400 }}>{f.othersLabel}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Read-only invoice list for one uploaded file. */
export function InvoiceFileModal({ id, onClose }) {
  const { data: v, error } = useApi(`/api/imports/${id}`);
  const { fail } = useUi();
  const f = v?.import;
  return (
    <Modal title={f ? f.filename : 'Invoice file'} width={1000} onClose={onClose}
      subtitle={f ? `${f.program_code} · ${f.deal_name} · funding ${dateShort(f.funding_date)} · uploaded ${dateTime(f.uploaded_at)} by ${f.uploaded_by}` : ''}
      footer={f && <>
        <Button icon="download" onClick={() => download(`/api/imports/${id}/file`, f.filename).catch(fail)}>Download original</Button>
        <Button variant="primary" onClick={() => { onClose(); navigate(`/purchase-funding?import=${id}`); }}>Open in Purchase & Funding</Button>
      </>}>
      <ErrorBox error={error} />
      {!v && !error && <Loading />}
      {v && (
        <>
          <div className="meta-line" style={{ marginTop: 0, marginBottom: 12 }}>
            <span>Format <b>{f.file_format.toUpperCase()}</b></span>
            <span>Rows read <b>{f.rows_read}</b></span>
            <span className="ok">Accepted <b>{f.accepted}</b></span>
            <span>Rejected <b>{f.rejected}</b></span>
            <span>Checksum <b className="mono" title={f.sha256}>{f.sha256.slice(0, 12)}…</b></span>
            <span>Status <Pill status={f.status} /></span>
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Invoice</th><th>Buyer</th><th>Invoice date</th><th>Due date</th><th className="r">Face amount</th><th>Status</th><th>Loan</th></tr></thead>
              <tbody>
                {v.invoices.map((i) => (
                  <tr key={i.id} className={i.status === 'REJECTED' ? 'dim' : i.status === 'HELD' ? 'held' : ''}>
                    <td className="strong">{i.invoice_number}{i.status_reason && <span className={`reason ${i.status === 'REJECTED' ? 'bad' : 'warn'}`}>{i.status_reason}</span>}</td>
                    <td>{i.buyer_name}</td>
                    <td>{dateShort(i.invoice_date)}</td>
                    <td>{dateShort(i.due_date)}</td>
                    <td className="r">{money(i.face_cents, i.currency)}</td>
                    <td><Pill status={i.status} /></td>
                    <td>{i.loan_ref ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <SkippedRows report={f.parse_report} />
        </>
      )}
    </Modal>
  );
}

export function SkippedRows({ report }) {
  if (!report?.skipped?.length && !report?.warnings?.length) return null;
  return (
    <>
      <div className="section-title">Rows the parser could not read ({report.skipped.length})</div>
      {report.warnings?.map((w, i) => <div key={i} className="error-box small" style={{ marginBottom: 8 }}>{w}</div>)}
      {report.skipped.length > 0 && (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Line</th><th>Problem</th><th>Raw values</th></tr></thead>
            <tbody>{report.skipped.map((s) => <tr key={s.line}><td>{s.line}</td><td className="t-red wrap">{s.reasons.join('; ')}</td><td className="mono faint">{s.raw.join(' | ')}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function useRemoveImport(reload) {
  const { ask, toast, fail } = useUi();
  return async (r) => {
    const reason = await ask({ title: `Remove ${r.filename}?`, message: 'The file and its invoices are withdrawn from the pipeline. This is recorded in the audit trail.', input: 'Reason', required: true, confirm: 'Remove file', danger: true });
    if (!reason) return;
    try {
      await post(`/api/imports/${r.id}/remove`, { reason });
      toast(`${r.filename} removed`, 'success');
      reload();
    } catch (e) { fail(e); }
  };
}

export function useUploadState() {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  return { file, setFile, result, setResult };
}
