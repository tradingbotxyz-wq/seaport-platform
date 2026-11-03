// Tamper-evident audit trail: every record carries the SHA-256 of the previous record,
// so altering or removing any row breaks the chain (see verify()). The table is also
// protected by append-only triggers. In AWS this is complemented by S3 Object Lock exports.

import { createHash } from 'node:crypto';
import type { Db } from '../lib/db.ts';
import type { User } from './context.ts';
import { now } from './context.ts';

const GENESIS = '0'.repeat(64);

function digest(prev: string, ts: string, actor: string, action: string, entityType: string, entityId: string | null, details: string) {
  return createHash('sha256').update([prev, ts, actor, action, entityType, entityId ?? '', details].join('|')).digest('hex');
}

export function record(db: Db, user: User, action: string, entityType: string, entityId: string | number | null, details: unknown = {}) {
  const prev = db.get<{ hash: string }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')?.hash ?? GENESIS;
  const ts = now();
  const id = entityId === null ? null : String(entityId);
  const json = JSON.stringify(details);
  const hash = digest(prev, ts, user.username, action, entityType, id, json);
  db.run(
    'INSERT INTO audit_log (ts, actor, role, action, entity_type, entity_id, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)',
    [ts, user.username, user.role, action, entityType, id, json, prev, hash],
  );
}

export function verify(db: Db): { valid: boolean; checked: number; brokenAt?: number } {
  let prev = GENESIS;
  let checked = 0;
  for (const r of db.all('SELECT * FROM audit_log ORDER BY id')) {
    const expected = digest(prev, r.ts, r.actor, r.action, r.entity_type, r.entity_id, r.details);
    if (r.prev_hash !== prev || r.hash !== expected) return { valid: false, checked, brokenAt: r.id };
    prev = r.hash;
    checked++;
  }
  return { valid: true, checked };
}
