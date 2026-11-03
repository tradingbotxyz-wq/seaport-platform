// Document management: one store for uploaded and generated documents of any entity.
// Files are content-addressed (sha256) under data/files/documents; metadata is append-only.
// In AWS the bytes go to S3 (versioning + Object Lock); the metadata row stays in the database.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Services, User } from '../core/context.ts';
import { now } from '../core/context.ts';
import * as audit from '../core/audit.ts';
import { notFound } from '../lib/errors.ts';

export interface StoredDocument {
  id: number; entity_type: string; entity_id: number; doc_type: string; filename: string;
  content_type: string; size_bytes: number; sha256: string; generated: number; version: number; created_by: string; created_at: string;
}

/** Write bytes to storage. Call before the DB transaction; then call recordDocument inside it. */
export async function storeBytes(svc: Services, bytes: Buffer): Promise<{ sha256: string; storage_key: string; size: number }> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const storage_key = `documents/${sha256}`;
  await mkdir(join(svc.filesDir, 'documents'), { recursive: true });
  await writeFile(join(svc.filesDir, storage_key), bytes);
  return { sha256, storage_key, size: bytes.length };
}

export function recordDocument(svc: Services, user: User, d: {
  entity_type: string; entity_id: number; doc_type: string; filename: string; content_type: string;
  stored: { sha256: string; storage_key: string; size: number }; generated?: boolean;
}): number {
  const prev = svc.db.get<{ v: number }>('SELECT MAX(version) v FROM documents WHERE entity_type = ? AND entity_id = ? AND doc_type = ?', [d.entity_type, d.entity_id, d.doc_type]);
  const version = (prev?.v ?? 0) + 1;
  const { id } = svc.db.run(
    `INSERT INTO documents (entity_type, entity_id, doc_type, filename, content_type, size_bytes, sha256, storage_key, generated, version, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [d.entity_type, d.entity_id, d.doc_type, d.filename, d.content_type, d.stored.size, d.stored.sha256, d.stored.storage_key, d.generated ? 1 : 0, version, user.username, now()],
  );
  audit.record(svc.db, user, d.generated ? 'document.generated' : 'document.uploaded', d.entity_type, d.entity_id, { document_id: id, doc_type: d.doc_type, filename: d.filename, sha256: d.stored.sha256, version });
  return id;
}

/** Generate a PDF through the Python engine and store it (no DB transaction needed). */
export async function generatePdf(svc: Services, user: User, entity_type: string, entity_id: number, doc_type: string, filename: string, spec: Record<string, unknown>) {
  const pdf = await svc.engine.pdf(spec);
  const stored = await storeBytes(svc, Buffer.from(pdf.content_base64, 'base64'));
  return svc.db.tx(() => recordDocument(svc, user, { entity_type, entity_id, doc_type, filename, content_type: 'application/pdf', stored, generated: true }));
}

export function listDocuments(svc: Services, entity_type: string, entity_id: number): StoredDocument[] {
  return svc.db.all<StoredDocument>(
    'SELECT id, entity_type, entity_id, doc_type, filename, content_type, size_bytes, sha256, generated, version, created_by, created_at FROM documents WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC',
    [entity_type, entity_id]);
}

export async function downloadDocument(svc: Services, id: number, user?: User) {
  const d = svc.db.get('SELECT * FROM documents WHERE id = ?', [id]);
  if (!d) throw notFound('Document');
  if (user?.role === 'INVESTOR') {
    const { canInvestorSee } = await import('./portal.ts');
    if (!canInvestorSee(svc, user, d)) throw notFound('Document');
  }
  const bytes = await readFile(join(svc.filesDir, d.storage_key));
  return { text: bytes as any, contentType: d.content_type, filename: d.filename };
}
