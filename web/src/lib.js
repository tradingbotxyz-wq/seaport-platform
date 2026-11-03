// API client, formatting helpers and small hooks shared by every screen.
import { useEffect, useState, useCallback, useRef } from 'react';

// ---------- API ----------
// Demo mode only: the picked user travels in X-User. With password sign-in the session is an
// HttpOnly cookie the browser sends itself; scripts never see it.
let currentUser = '';
export const setApiUser = (u) => { currentUser = u || ''; };
let lastActivity = Date.now();
export const lastApiActivity = () => lastActivity;

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export async function api(path, { method = 'GET', body, idempotent = false } = {}) {
  const headers = { 'X-Requested-With': 'seaport' }; // CSRF guard: cross-site forms cannot send custom headers
  if (currentUser) headers['X-User'] = currentUser;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotent) headers['Idempotency-Key'] = uuid();
  let res;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, { error: { message: 'Cannot reach the server. Check your connection and try again.' } });
  }
  lastActivity = Date.now();
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    if ((res.status === 401 && !path.startsWith('/api/auth/')) || (res.status === 403 && json?.error?.code === 'session_incomplete')) {
      window.dispatchEvent(new CustomEvent('sg:signed-out', { detail: { reason: res.status === 401 ? 'expired' : 'incomplete' } }));
    }
    throw new ApiError(res.status, json);
  }
  return json;
}
export const get = (p) => api(p);
export const post = (p, body = {}, opts = {}) => api(p, { method: 'POST', body, ...opts });
export const put = (p, body = {}) => api(p, { method: 'PUT', body });

/** Changes to reference data, bank details and access come back as "submitted for approval" (HTTP 202). */
export const isPending = (r) => !!r?.pending_approval;
export const doneMessage = (r, saved) => (isPending(r) ? r.message : saved);

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export async function download(path, filename) {
  const res = await fetch(path, { headers: { 'X-User': currentUser } });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Fetch `path` (null = skip). Keeps the previous data while reloading. */
export function useApi(path) {
  const [state, setState] = useState({ data: null, error: null, loading: !!path });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) { setState({ data: null, error: null, loading: false }); return undefined; }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    get(path).then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error) => live && setState((s) => ({ data: s.data, error, loading: false })),
    );
    return () => { live = false; };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function useOutsideClick(onOutside) {
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onOutside(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onOutside]);
  return ref;
}

// ---------- Routing (History API) ----------
export function navigate(to, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', to); else history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
}

export function useLocation() {
  const read = () => ({ path: location.pathname, query: new URLSearchParams(location.search) });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const h = () => setLoc(read());
    addEventListener('popstate', h);
    return () => removeEventListener('popstate', h);
  }, []);
  return loc;
}

export function setQuery(key, value) {
  const q = new URLSearchParams(location.search);
  if (value === null || value === undefined || value === '') q.delete(key); else q.set(key, value);
  const s = q.toString();
  navigate(location.pathname + (s ? `?${s}` : ''), { replace: true });
}

// ---------- Formatting ----------
const n0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const n2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "USD 3,332,000" (whole units, as on the prototype screens). */
export function money(cents, ccy) {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  return `${ccy ? ccy + ' ' : ''}${sign}${n0.format(Math.round(Math.abs(cents) / 100))}`;
}
export const moneyExact = (cents, ccy) => (cents == null ? '—' : `${ccy ? ccy + ' ' : ''}${cents < 0 ? '-' : ''}${n2.format(Math.abs(cents) / 100)}`);

/** "USD 4.2m" / "USD 44k". */
export function moneyShort(cents, ccy) {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  const v = Math.abs(cents) / 100;
  const sign = cents < 0 ? '-' : '';
  let t;
  if (v >= 1e9) t = `${(v / 1e9).toFixed(1)}bn`;
  else if (v >= 1e6) t = `${(v / 1e6).toFixed(1)}m`;
  else if (v >= 1e3) t = `${Math.round(v / 1e3)}k`;
  else t = n0.format(v);
  return `${ccy ? ccy + ' ' : ''}${sign}${t}`;
}
const SYMBOL = { USD: '$', EUR: '€', GBP: '£' };
/** "$239.0m" */
export function symShort(cents, ccy = 'USD') {
  const s = moneyShort(Math.abs(cents ?? 0));
  return `${(cents ?? 0) < 0 ? '-' : ''}${SYMBOL[ccy] ?? ccy + ' '}${s}`;
}

/** "21 Sep 26" */
export function dateShort(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${String(y).slice(2)}`;
}
/** "21 Sep 2026" */
export function dateLong(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
/** "21 Sep 2026, 09:14" in the viewer's local time. */
export function dateTime(iso) {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}, ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}
export const pct = (x, digits = 1) => (x === null || x === undefined ? '—' : `${Number(x).toFixed(digits)}%`);
export const bps = (b) => (b === null || b === undefined ? '—' : `${(b / 100).toFixed(2)}%`);
export const advPct = (b) => (b === null || b === undefined ? '—' : `${Math.round(b / 100)}%`);

/** Parse "1,250,000.50" -> cents (integer), or null. */
export function toCents(text) {
  const s = String(text ?? '').replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d{0,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}
/** Parse "4.35" (percent) -> bps, or null. */
export function toBps(text) {
  const s = String(text ?? '').trim().replace('%', '');
  if (!/^-?\d+(\.\d{0,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

export function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function addBusinessDaysIso(iso, days) {
  let d = iso;
  let left = days;
  while (left > 0) {
    d = addDaysIso(d, 1);
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}
export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('') || '?';

export function errorText(err) {
  if (!err) return '';
  const d = err.details;
  if (Array.isArray(d) && d.length) return `${err.message}: ${d.join('; ')}`;
  if (d && typeof d === 'object') return `${err.message}: ${Object.entries(d).map(([k, v]) => `${k} ${v}`).join('; ')}`;
  return err.message;
}
