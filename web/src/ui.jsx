// Shared UI building blocks styled after the Seaport Global prototype.
import { createContext, useCallback, useContext, useEffect, useRef, useState, useId, cloneElement, isValidElement, Children } from 'react';
import { errorText } from './lib.js';

// ---------- Icons (feather-style, inline) ----------
const PATHS = {
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/>',
  file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><circle cx="18.5" cy="16.5" r="2.5"/><path d="M18.5 12.5v1.5M18.5 19v1.5M22.5 16.5H21M16 16.5h-1.5"/>',
  chart: '<line x1="4" y1="20" x2="20" y2="20"/><rect x="5" y="12" width="3" height="6"/><rect x="10.5" y="7" width="3" height="11"/><rect x="16" y="4" width="3" height="14"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  profile: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  left: '<polyline points="15 18 9 12 15 6"/>',
  right: '<polyline points="9 18 15 12 9 6"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  down: '<polyline points="6 9 12 15 18 9"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
};

export function Icon({ name, size = 18, className, strokeWidth = 1.8 }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] ?? '' }} />
  );
}

// ---------- Layout primitives ----------
export function Card({ title, subtitle, right, children, className = '', style }) {
  return (
    <section className={`card ${className}`} style={style}>
      {(title || right) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
          {right && <div className="right-slot">{right}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, sub, tone, onClick, title }) {
  return (
    <div className={`kpi ${tone ?? ''} ${onClick ? 'clickable' : ''}`} onClick={onClick} title={title} role={onClick ? 'button' : undefined}>
      <div className="label">{label}</div>
      <div className="value num">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

const TONES = {
  Good: 'good', Tight: 'warn', Breach: 'bad',
  PENDING: 'info', HELD: 'warn', REJECTED: 'bad', FUNDED: 'good', REMOVED: '',
  UPLOADED: 'warn', APPROVED: 'good',
  OPEN: 'info', SETTLED: 'good',
  MATCHED: 'info', POSTED: 'good', AMOUNT_MISMATCH: 'warn', UNMATCHED: 'bad', RESOLVED: '',
  RECEIVED: 'good', SHORT_PAID: 'bad',
  'Fully received': 'good', 'Partially received': 'bad', Pending: 'warn',
  'Auto-debit set': 'good', Expected: '', 'Past due': 'bad',
  ACTIVE: 'good', SUSPENDED: 'warn', CLOSED: '',
};
const LABELS = {
  PENDING: 'Eligible', HELD: 'Held - limit', REJECTED: 'Rejected', FUNDED: 'Funded', UPLOADED: 'Awaiting approval', APPROVED: 'Funded',
  MATCHED: 'Matched', POSTED: 'Posted', AMOUNT_MISMATCH: 'Amount break', UNMATCHED: 'Unmatched', RESOLVED: 'Resolved',
  RECEIVED: 'Payment received', SHORT_PAID: 'Short paid', OPEN: 'Open', SETTLED: 'Settled',
};
export function Pill({ tone, status, children, title }) {
  const t = tone ?? TONES[status] ?? '';
  return <span className={`pill ${t}`} title={title}>{children ?? LABELS[status] ?? status}</span>;
}

export function Button({ variant = '', size, icon, children, className = '', ...rest }) {
  return (
    <button type="button" className={`btn ${variant} ${size ?? ''} ${className}`} {...rest}>
      {icon && <Icon name={icon} size={15} />}
      {children}
    </button>
  );
}

/** Label + control. The label is linked to the first form control (id/htmlFor) and the hint via aria-describedby. */
export function Field({ label, hint, children, style, hideLabel }) {
  const auto = useId();
  const kids = Children.toArray(children);
  const first = kids[0];
  const isControl = isValidElement(first) && ['input', 'select', 'textarea'].includes(first.type);
  const id = isControl ? first.props.id ?? `f${auto.replace(/:/g, '')}` : undefined;
  const hintId = hint ? `h${auto.replace(/:/g, '')}` : undefined;
  if (isControl) kids[0] = cloneElement(first, { id, 'aria-describedby': hintId });
  return (
    <div className="field" style={style}>
      {label && (isControl ? <label htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>{label}</label> : <span className="field-label" id={`l${auto.replace(/:/g, '')}`}>{label}</span>)}
      {isControl ? kids : <div role="group" aria-labelledby={label ? `l${auto.replace(/:/g, '')}` : undefined}>{kids}</div>}
      {hint && <div className="hint" id={hintId}>{hint}</div>}
    </div>
  );
}

export function FileDrop({ file, onFile, accept, title = 'Drop any file here', hint = 'Drag & drop a file or click Browse', inputRef }) {
  const [over, setOver] = useState(false);
  const local = useRef(null);
  const ref = inputRef ?? local;
  return (
    <div
      className={`drop ${over ? 'over' : ''}`}
      onClick={() => ref.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); }}
    >
      <div className="dz-text">
        <b>{file ? file.name : title}</b>
        <span>{file ? `${(file.size / 1024).toFixed(1)} KB · drag another file to replace` : hint}</span>
      </div>
      <button type="button" className="btn" onClick={(e) => { e.stopPropagation(); ref.current?.click(); }}>Browse</button>
      <input ref={ref} type="file" accept={accept} hidden onChange={(e) => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ''; }} />
    </div>
  );
}

/** Limit usage bar: current utilisation (solid), requirement (hatched), 100% tick. Scale 0..max(110, post). */
export function UsageBar({ currentPct = 0, requirementPct = 0, status = 'Good', style }) {
  const scale = Math.max(110, currentPct + requirementPct);
  const w = (p) => `${Math.max(0, Math.min(100, (p / scale) * 100))}%`;
  return (
    <div className={`ubar ${status}`} style={style} title={`${currentPct.toFixed(1)}% current${requirementPct ? ` + ${requirementPct.toFixed(1)}% this funding` : ''}`}>
      <div className="seg cur" style={{ width: w(currentPct) }} />
      {requirementPct > 0 && <div className="seg req" style={{ left: w(currentPct), width: w(requirementPct) }} />}
      <div className="tick" style={{ left: w(100) }} />
    </div>
  );
}

export function Donut({ segments, size = 140, stroke = 16, center, caption }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={caption}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
      {segments.map((s, i) => {
        const len = (s.value / total) * c;
        const el = (
          <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={stroke}
            strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        );
        offset += len;
        return el;
      })}
      <text x="50%" y="48%" textAnchor="middle" fontFamily="var(--serif)" fontWeight="700" fontSize={size * 0.19} fill="var(--text)">{center}</text>
      <text x="50%" y="64%" textAnchor="middle" fontSize="12" fill="var(--muted)">{caption}</text>
    </svg>
  );
}

export function BarChart({ data, selected, onSelect, format }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className={`bars ${selected !== null && selected !== undefined ? 'has-sel' : ''}`}>
      {data.map((d, i) => (
        <button key={d.key ?? i} className={`b ${selected === i ? 'on' : ''} ${d.value ? '' : 'empty'}`}
          onClick={() => onSelect?.(selected === i ? null : i)} title={d.title}>
          <span className="val num">{format ? format(d.value) : d.value}</span>
          <span className="col" style={{ height: `${Math.max(2, (d.value / max) * 78)}%` }} />
          <span className="lab">{d.label}</span>
        </button>
      ))}
    </div>
  );
}

export const Empty = ({ children = 'Nothing to show yet.' }) => <div className="empty">{children}</div>;
export const Loading = () => <div className="loading">Loading…</div>;
export const ErrorBox = ({ error }) => (error ? <div className="error-box">{errorText(error)}</div> : null);

// ---------- Modal ----------
export function Modal({ open = true, title, subtitle, onClose, children, footer, width = 720 }) {
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => e.key === 'Escape' && onClose?.();
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ '--w': `${width}px` }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- App-wide services: toasts, prompts, confirmations ----------
const UiContext = createContext(null);
export const useUi = () => useContext(UiContext);

export function UiProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [text, setText] = useState('');

  const toast = useCallback((message, kind = 'info', list) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, kind, list }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4500);
  }, []);
  const fail = useCallback((err) => toast(err.message, 'error', Array.isArray(err.details) ? err.details : err.details && typeof err.details === 'object' ? Object.entries(err.details).map(([k, v]) => `${k} ${v}`) : null), [toast]);

  /** ask({ title, message, input: 'Reason', required, confirm, danger }) -> Promise<string | true | null> */
  const ask = useCallback((opts) => new Promise((resolve) => { setText(opts.initial ?? ''); setDialog({ ...opts, resolve }); }), []);
  const close = (value) => { dialog?.resolve(value); setDialog(null); };

  return (
    <UiContext.Provider value={{ toast, fail, ask }}>
      {children}
      {dialog && (
        <Modal title={dialog.title} onClose={() => close(null)} width={520}
          footer={<>
            <Button onClick={() => close(null)}>Cancel</Button>
            <Button variant={dialog.danger ? 'danger' : 'primary'} disabled={dialog.input && dialog.required && !text.trim()}
              onClick={() => close(dialog.input ? text.trim() : true)}>{dialog.confirm ?? 'Confirm'}</Button>
          </>}>
          {dialog.message && <div style={{ marginBottom: dialog.input ? 12 : 0 }}>{dialog.message}</div>}
          {dialog.input && (
            <Field label={dialog.input}>
              <textarea className="textarea" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={dialog.placeholder} />
            </Field>
          )}
        </Modal>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
            {t.list?.length ? <ul>{t.list.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
          </div>
        ))}
      </div>
    </UiContext.Provider>
  );
}

/** Wrap an async action: shows errors as toasts and tracks a busy flag. */
export function useAction() {
  const { fail } = useUi();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn) => {
    setBusy(true);
    try { return await fn(); } catch (e) { fail(e); return undefined; } finally { setBusy(false); }
  }, [fail]);
  return [busy, run];
}
