// Tamper-evident audit trail: every record carries a hash over the previous record's hash,
// so altering or removing any row breaks the chain (see verify()). Since migration 9 the hash
// is an HMAC keyed with the application key and covers the role too ('hmac-v2'), so someone
// with database access but without the key cannot rebuild a valid chain. Older rows keep
// their SHA-256 ('sha256'). The table is also protected by append-only triggers. In AWS this
// is complemented by S3 Object Lock exports.

import { createHash, createHmac } from 'node:crypto';
import type { Db } from '../lib/db.ts';
import type { User } from './context.ts';
import { now } from './context.ts';

const GENESIS = '0'.repeat(64);

let auditKey: Buffer | null = null;
/** Set once at start-up from the application key. */
export function setAuditKey(key: Buffer) { auditKey = key; }

function digest(prev: string, ts: string, actor: string, action: string, entityType: string, entityId: string | null, details: string) {
  return createHash('sha256').update([prev, ts, actor, action, entityType, entityId ?? '', details].join('|')).digest('hex');
}
function digestV2(prev: string, ts: string, actor: string, role: string, action: string, entityType: string, entityId: string | null, details: string) {
  if (!auditKey) throw new Error('Audit key not configured');
  return createHmac('sha256', auditKey).update([prev, ts, actor, role, action, entityType, entityId ?? '', details].join('|')).digest('hex');
}

/** Create the keyed anchor once (first start after migration 9). */
export function ensureAnchor(db: Db) {
  if (!auditKey || db.get('SELECT 1 FROM audit_anchor')) return;
  const until = db.get<{ m: number | null }>("SELECT MAX(id) m FROM audit_log WHERE hash_alg = 'sha256'")!.m ?? 0;
  db.run('INSERT INTO audit_anchor (id, legacy_until, mac) VALUES (1, ?, ?)', [until, createHmac('sha256', auditKey).update(`audit-anchor:${until}`).digest('hex')]);
}

export function record(db: Db, user: User, action: string, entityType: string, entityId: string | number | null, details: unknown = {}) {
  const prev = db.get<{ hash: string }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')?.hash ?? GENESIS;
  const ts = now();
  const id = entityId === null ? null : String(entityId);
  const json = JSON.stringify(details);
  const hash = digestV2(prev, ts, user.username, user.role, action, entityType, id, json);
  db.run(
    "INSERT INTO audit_log (ts, actor, role, action, entity_type, entity_id, details, prev_hash, hash, hash_alg) VALUES (?,?,?,?,?,?,?,?,?, 'hmac-v2')",
    [ts, user.username, user.role, action, entityType, id, json, prev, hash],
  );
}

export function verify(db: Db): { valid: boolean; checked: number; brokenAt?: number; reason?: string } {
  let prev = GENESIS;
  let checked = 0;
  const anchor = db.get<{ legacy_until: number; mac: string }>('SELECT legacy_until, mac FROM audit_anchor WHERE id = 1');
  if (!anchor || !auditKey || createHmac('sha256', auditKey).update(`audit-anchor:${anchor.legacy_until}`).digest('hex') !== anchor.mac) {
    return { valid: false, checked: 0, reason: 'Audit anchor missing or altered' };
  }
  for (const r of db.all('SELECT * FROM audit_log ORDER BY id')) {
    if (r.id > anchor.legacy_until && r.hash_alg !== 'hmac-v2') return { valid: false, checked, brokenAt: r.id, reason: 'Unkeyed record after the keyed boundary' };
    const expected = r.hash_alg === 'hmac-v2'
      ? digestV2(prev, r.ts, r.actor, r.role, r.action, r.entity_type, r.entity_id, r.details)
      : digest(prev, r.ts, r.actor, r.action, r.entity_type, r.entity_id, r.details);
    if (r.prev_hash !== prev || r.hash !== expected) return { valid: false, checked, brokenAt: r.id };
    prev = r.hash;
    checked++;
  }
  return { valid: true, checked };
}
