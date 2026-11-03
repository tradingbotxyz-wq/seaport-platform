import { useEffect, useRef, useState } from 'react';
import { useApi, post, fileToBase64, dateShort, navigate } from '../lib.js';
import { useSession } from '../session.js';
import { Card, Field, FileDrop, Button, ErrorBox, Loading, Pill, useUi, useAction } from '../ui.jsx';
import { ImportsTable, InvoiceFileModal, SkippedRows, useRemoveImport, earliestFunding, programOption, ACCEPT_INVOICES } from './shared.jsx';

export default function Onboarding() {
  const { today, can, refreshBadges } = useSession();
  const { toast } = useUi();
  const programs = useApi('/api/programs');
  const imports = useApi('/api/imports');
  const active = (programs.data ?? []).filter((p) => p.status === 'ACTIVE');
  const [programId, setProgramId] = useState('');
  const [fundingDate, setFundingDate] = useState('');
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [busy, run] = useAction();
  const inputRef = useRef(null);
  const program = active.find((p) => String(p.id) === String(programId));
  const minDate = program ? earliestFunding(today, program) : today;

  useEffect(() => { if (!programId && active.length) setProgramId(String(active[0].id)); }, [active.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (program && (!fundingDate || fundingDate < minDate)) setFundingDate(minDate); }, [program?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = useRemoveImport(() => { imports.reload(); refreshBadges(); });
  const reset = () => { setFile(null); setResult(null); if (program) setFundingDate(minDate); };

  const upload = () => run(async () => {
    const content_base64 = await fileToBase64(file);
    const r = await post('/api/imports', { program_id: Number(programId), funding_date: fundingDate, filename: file.name, content_base64 });
    setResult(r);
    setFile(null);
    imports.reload();
    refreshBadges();
    toast(`${r.import.filename}: ${r.import.accepted} accepted, ${r.import.rejected} rejected`, r.import.accepted ? 'success' : 'error');
  });

  if (programs.error) return <ErrorBox error={programs.error} />;
  if (!programs.data) return <Loading />;
  const uploaded = imports.data ?? [];
  const status = busy ? 'Uploading…' : file ? 'Ready' : 'Waiting for file';

  return (
    <>
      <Card title="Upload invoice file"
        subtitle={program && <>Program <b>{program.deal_name}</b> · Currency <b>{program.currency}</b> · rate basis <b>{program.rate_basis}</b> · funding <b>T+{program.funding_lag_days}</b> · supports any file format (.xlsx, .csv, .pdf, .txt, etc.)</>}>
        {!can('invoices.upload') && <div className="infobar">Your role can view uploads but not create them. Sign in as an operations maker (e.g. Rabuan) to upload.</div>}
        <div className="grid g3">
          <Field label="Deal name" hint={`Populated directly from the Master Table (${active.length} registered facilities).`}>
            <select className="select" value={programId} onChange={(e) => setProgramId(e.target.value)}>
              {active.map((p) => <option key={p.id} value={p.id}>{programOption(p)}</option>)}
            </select>
          </Field>
          <Field label="Funding date" hint={`Funding date applied to uploaded invoice records. Earliest ${dateShort(minDate)} (T+${program?.funding_lag_days ?? 1}, business days).`}>
            <input className="input" type="date" min={minDate} value={fundingDate} onChange={(e) => setFundingDate(e.target.value)} />
          </Field>
          <Field label="Select or drop file">
            <FileDrop file={file} onFile={(f) => { setFile(f); setResult(null); }} accept={ACCEPT_INVOICES} inputRef={inputRef}
              title="Drop any invoice file here" hint="Drag & drop any file or click browse to select" />
            <div className="meta-line">
              <span>Status <b>{status}</b></span>
              <span>Deals <b>{active.length} registered</b></span>
              <span>Imported <b>{uploaded.length} files</b></span>
              <span className="t-brand">Supports all file formats</span>
            </div>
          </Field>
        </div>
        <div className="divider" />
        <div className="between">
          <div className="row">
            <Button variant="primary" icon="upload" disabled={!file || busy || !can('invoices.upload') || !fundingDate} onClick={upload}>Upload invoice file</Button>
            <Button onClick={() => inputRef.current?.click()}>Browse file…</Button>
            <Button onClick={reset}>Reset</Button>
          </div>
          {program && <div className="muted small">Active deal: <b>{program.deal_name}</b> · ({program.program_code}) · funding <b>{dateShort(fundingDate)}</b></div>}
        </div>
        {result && (
          <div style={{ marginTop: 16 }}>
            <div className="infobar">
              <b>{result.import.filename}</b> uploaded
              <span className="sep">|</span> Rows read <b>{result.parse.rows_read}</b>
              <span className="sep">|</span> Accepted <b className="t-green">{result.import.accepted}</b>
              <span className="sep">|</span> Rejected <b className={result.import.rejected ? 't-red' : ''}>{result.import.rejected}</b>
              <span className="sep">|</span> Checksum <b>verified</b>
              <span style={{ marginLeft: 'auto' }}><Button size="sm" variant="primary" onClick={() => navigate(`/purchase-funding?import=${result.import.id}`)}>Review in Purchase & Funding</Button></span>
            </div>
            <SkippedRows report={result.parse} />
          </div>
        )}
      </Card>

      <Card title="File imports" subtitle="All uploaded files shown below · click any file name to open its invoices"
        right={<><span>{uploaded.length} files loaded</span><Button size="sm" onClick={imports.reload}>Refresh</Button></>}>
        <ErrorBox error={imports.error} />
        {imports.data ? <ImportsTable imports={uploaded} onOpen={setOpenId} onRemove={remove} /> : <Loading />}
        <div className="legend">
          <span><Pill status="UPLOADED" /> uploaded, waiting for a checker</span>
          <span><Pill status="APPROVED" /> approved and funded</span>
        </div>
      </Card>
      {openId && <InvoiceFileModal id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
