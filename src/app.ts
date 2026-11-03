// Composition root: wires DB, engine and router into a request handler (used by server.ts and tests).

import { fileURLToPath } from 'node:url';
import { Db } from './lib/db.ts';
import { migrate } from './core/schema.ts';
import { createHandler } from './lib/http.ts';
import { buildRouter } from './routes.ts';
import type { EngineClient } from './integrations/engine.ts';
import type { Services } from './core/context.ts';
import { mockKyc, mockBureau } from './integrations/screening.ts';
import { loadAppKey } from './core/security.ts';
import { setAuditKey, ensureAnchor } from './core/audit.ts';
import type { AuthConfig } from './core/context.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function createServices(opts: { dbPath: string; engine: EngineClient; filesDir: string; today?: () => string; auth?: Partial<AuthConfig> }): Services {
  const appKey = loadAppKey(opts.dbPath);
  setAuditKey(appKey);
  const db = new Db(opts.dbPath);
  migrate(db);
  ensureAnchor(db);
  return { db, engine: opts.engine, kyc: mockKyc, bureau: mockBureau, filesDir: opts.filesDir, today: opts.today ?? (() => process.env.BUSINESS_DATE ?? localDate()), appKey, auth: authConfig(opts.auth) };
}

const flag = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));

/** Authentication settings from the environment. Production defaults are the strict ones. */
export function authConfig(over: Partial<AuthConfig> = {}): AuthConfig {
  const production = process.env.NODE_ENV === 'production';
  const mode = (over.mode ?? (process.env.AUTH_MODE === 'demo' ? 'demo' : 'password')) as AuthConfig['mode'];
  if (mode === 'demo' && production) throw new Error('AUTH_MODE=demo is not allowed when NODE_ENV=production');
  return {
    mode,
    mfaRequired: over.mfaRequired ?? flag(process.env.MFA_REQUIRED, production),
    secureCookies: over.secureCookies ?? flag(process.env.COOKIE_SECURE, production),
    trustProxy: over.trustProxy ?? flag(process.env.TRUST_PROXY, production),
    idleMinutes: over.idleMinutes ?? Number(process.env.SESSION_IDLE_MINUTES ?? 30),
    absoluteHours: over.absoluteHours ?? Number(process.env.SESSION_MAX_HOURS ?? 12),
  };
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
