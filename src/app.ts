// Composition root: wires DB, engine and router into a request handler (used by server.ts and tests).

import { fileURLToPath } from 'node:url';
import { Db } from './lib/db.ts';
import { migrate } from './core/schema.ts';
import { createHandler } from './lib/http.ts';
import { buildRouter } from './routes.ts';
import type { EngineClient } from './integrations/engine.ts';
import type { Services } from './core/context.ts';
import { mockKyc, mockBureau } from './integrations/screening.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function createServices(opts: { dbPath: string; engine: EngineClient; filesDir: string; today?: () => string }): Services {
  const db = new Db(opts.dbPath);
  migrate(db);
  return { db, engine: opts.engine, kyc: mockKyc, bureau: mockBureau, filesDir: opts.filesDir, today: opts.today ?? (() => process.env.BUSINESS_DATE ?? localDate()) };
}

export function createApp(services: Services, opts: { log?: boolean } = {}) {
  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  return createHandler(buildRouter(), services, publicDir.replace(/[\\/]$/, ''), opts.log ?? true);
}

/** Today's date in the machine's local time zone (business date), as yyyy-mm-dd. */
export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
