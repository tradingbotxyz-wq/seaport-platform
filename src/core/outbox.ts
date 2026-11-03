// Transactional outbox: domain events are written in the same DB transaction as the state
// change, then a dispatcher publishes them. Locally the "bus" is in-process subscribers;
// in AWS the dispatcher publishes to EventBridge instead. Consumers must be idempotent
// (notifications use UNIQUE(event_id) so a re-delivered event is ignored).

import type { Db } from '../lib/db.ts';
import { now } from './context.ts';

export type DomainEvent = { id: number; event_type: string; aggregate_type: string; aggregate_id: string; payload: any };
type Handler = (db: Db, event: DomainEvent) => void;

const handlers: Handler[] = [];

export function subscribe(handler: Handler) {
  handlers.push(handler);
}

export function emit(db: Db, eventType: string, aggregateType: string, aggregateId: string | number, payload: unknown) {
  db.run('INSERT INTO outbox (event_type, aggregate_type, aggregate_id, payload, created_at) VALUES (?,?,?,?,?)', [
    eventType, aggregateType, String(aggregateId), JSON.stringify(payload), now(),
  ]);
}

/** Publish pending events. Each event is handled and marked published atomically. */
export function dispatchPending(db: Db, limit = 100): number {
  const pending = db.all('SELECT * FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT ?', [limit]);
  let published = 0;
  for (const row of pending) {
    const event: DomainEvent = { ...row, payload: JSON.parse(row.payload) } as DomainEvent;
    try {
      db.tx(() => {
        for (const h of handlers) h(db, event);
        db.run('UPDATE outbox SET published_at = ?, attempts = attempts + 1 WHERE id = ?', [now(), row.id]);
      });
      published++;
    } catch (err) {
      db.run('UPDATE outbox SET attempts = attempts + 1 WHERE id = ?', [row.id]);
      console.error(`[outbox] event ${row.id} failed:`, (err as Error).message);
    }
  }
  return published;
}

export function startDispatcher(db: Db, intervalMs = 500): () => void {
  const timer = setInterval(() => dispatchPending(db), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// Default subscriber: turn notable events into in-app notifications.
const MESSAGES: Record<string, (p: any) => [string, string, string]> = {
  'invoice_import.uploaded': (p) => ['OPS_CHECKER', `${p.filename} uploaded for ${p.deal_name}: ${p.accepted} accepted, ${p.rejected} rejected - awaiting approval`, `/purchase-funding?import=${p.id}`],
  'funding.approved': (p) => ['OPS_MAKER', `Funding approved for ${p.filename}: ${p.loans} loans created`, `/purchase-funding?import=${p.id}`],
  'limit.breach': (p) => ['CREDIT', `Limit breach: ${p.obligor} at ${p.pct}% of limit`, `/master-table`],
  'settlement.uploaded': (p) => ['TREASURY', `Settlement advice ${p.filename}: ${p.matched} matched, ${p.unmatched} unmatched`, `/settlement?import=${p.id}`],
  'loan.settled': (p) => ['OPS_MAKER', `Loan ${p.loan_ref} settled (bank ref ${p.bank_reference})`, `/settlement`],
  'case.opened': (p) => ['OPS_MAKER', `Case ${p.ref} (${p.priority}): ${p.subject}`, `/servicing?case=${p.id}`],
  'recon.break': (p) => ['TREASURY', `Reconciliation break: ${p.reference} (${p.reason})`, `/reconciliation`],
};
subscribe((db, event) => {
  const make = MESSAGES[event.event_type];
  if (!make) return;
  const [audience, message, link] = make(event.payload);
  db.run('INSERT OR IGNORE INTO notifications (event_id, audience, message, link, created_at) VALUES (?,?,?,?,?)', [
    event.id, audience, message, link, now(),
  ]);
});
