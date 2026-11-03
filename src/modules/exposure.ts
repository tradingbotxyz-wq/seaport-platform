// Exposure & limit calculations, shared by Purchase & Funding, Dashboard and Master Table.
// Utilisation is measured on the finance amount (purchase price), not invoice face value.

import type { Db } from '../lib/db.ts';

export const TIGHT_BPS = 9500; // >= 95% of limit after funding

export type LimitStatus = 'Good' | 'Tight' | 'Breach';

export function limitStatus(usedCents: number, limitCents: number): LimitStatus {
  if (limitCents <= 0) return usedCents > 0 ? 'Breach' : 'Good';
  if (usedCents > limitCents) return 'Breach';
  if (usedCents * 10000 >= limitCents * TIGHT_BPS) return 'Tight';
  return 'Good';
}

export const pct = (num: number, den: number) => (den > 0 ? Math.round((num * 1000) / den) / 10 : 0);

/** Purchase price = face x advance ratio, rounded half-up to the cent (matches the Python engine). */
export const purchasePrice = (faceCents: number, advBps: number) => Math.floor((faceCents * advBps + 5000) / 10000);

/** Finance amount outstanding on open loans (bank-confirmed receipts reduce principal first). */
export function currentUtilisation(db: Db, obligorId: number): number {
  return db.get<{ s: number }>(
    `SELECT COALESCE(SUM(CASE WHEN purchase_cents > received_cents THEN purchase_cents - received_cents ELSE 0 END), 0) s
     FROM loans WHERE obligor_id = ? AND status = 'OPEN'`, [obligorId])!.s;
}

/** Uploaded but unreleased exposure: purchase price of PENDING invoices in un-approved files. */
export function pipeline(db: Db, obligorId: number, onlyImportId?: number): number {
  const rows = db.all<{ face_cents: number; advance_rate_bps: number }>(
    `SELECT i.face_cents, o.advance_rate_bps FROM invoices i
     JOIN invoice_imports f ON f.id = i.import_id JOIN obligors o ON o.id = i.obligor_id
     WHERE i.obligor_id = ? AND i.status = 'PENDING' AND f.status = 'UPLOADED' ${onlyImportId ? 'AND i.import_id = ?' : ''}`,
    onlyImportId ? [obligorId, onlyImportId] : [obligorId]);
  return rows.reduce((a, r) => a + purchasePrice(r.face_cents, r.advance_rate_bps), 0);
}

export function fxToUsd(db: Db): (cents: number, currency: string) => number {
  const rates = new Map(db.all<{ currency: string; usd_rate: string }>('SELECT currency, usd_rate FROM fx_rates').map((r) => [r.currency, Number(r.usd_rate)]));
  return (cents, currency) => Math.round(cents * (rates.get(currency) ?? (currency === 'USD' ? 1 : NaN)));
}

/** One row per active obligor across active programs with limit usage (program currency). */
export function obligorUsage(db: Db) {
  const obligors = db.all(
    `SELECT o.*, p.deal_name, p.program_code, p.deal_code, p.currency, p.program_type
     FROM obligors o JOIN programs p ON p.id = o.program_id WHERE o.active = 1 AND p.status = 'ACTIVE'`);
  return obligors.map((o) => {
    const funded = currentUtilisation(db, o.id);
    const pipe = pipeline(db, o.id);
    const used = funded + pipe;
    return {
      ...o,
      funded_cents: funded,
      pipeline_cents: pipe,
      used_cents: used,
      used_pct: pct(used, o.limit_cents),
      headroom_cents: o.limit_cents - used,
      status: limitStatus(used, o.limit_cents),
    };
  });
}
