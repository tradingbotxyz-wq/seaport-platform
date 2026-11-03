// Entry point: starts the Python analytics engine, then the Node API + React UI on one port.
//   PORT        (default 3000)   web/API port
//   ENGINE_PORT (default 8001)   Python engine port (local only)
//   ENGINE_URL  optional         use an already-running engine instead of launching one
//   DB_PATH     (default data/seaport.db)
//   FILES_DIR   (default data/files)          uploaded and generated documents
//   HOST        (default 127.0.0.1)           0.0.0.0 inside a container / behind a load balancer
//   NODE_ENV=production                       strict defaults: MFA required, secure cookies, no demo data unless SEED_DEMO=true
//   AUTH_MODE   password (default) | demo     demo = user picker, development only
//   APP_SECRET  32-byte key (hex/base64)      otherwise data/app.key is created (0600)
//   ENGINE_TOKEN                              shared secret for the engine (derived from the app key if unset)
//   MFA_REQUIRED, COOKIE_SECURE, TRUST_PROXY, SESSION_IDLE_MINUTES, SESSION_MAX_HOURS

import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApp, createServices, ROOT } from './app.ts';
import { httpEngine, launchEngine } from './integrations/engine.ts';
import { loadAppKey, hmac } from './core/security.ts';
import { startDispatcher } from './core/outbox.ts';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const enginePort = Number(process.env.ENGINE_PORT ?? 8001);

const production = process.env.NODE_ENV === 'production';
const dbPath = process.env.DB_PATH ?? join(ROOT, 'data', 'seaport.db');
// A stable token lets a restarted API reuse its own engine; a foreign process on the port is refused.
const engineToken = process.env.ENGINE_TOKEN ?? hmac(loadAppKey(dbPath), 'engine-token');

let engineChild: { kill: () => void } | null = null;
let engine;
if (process.env.ENGINE_URL) {
  engine = httpEngine(process.env.ENGINE_URL, engineToken);
} else {
  try {
    const launched = await launchEngine(enginePort, engineToken);
    engine = launched.client;
    engineChild = launched.child;
  } catch (err) {
    console.error(`\n[api] ${(err as Error).message}\n`);
    process.exit(1);
  }
}

const services = createServices({
  dbPath,
  engine,
  filesDir: process.env.FILES_DIR ?? join(ROOT, 'data', 'files'),
});

const count = services.db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n;
const demoData = !production || /^(1|true|yes)$/i.test(process.env.SEED_DEMO ?? '');
if (!count && demoData) {
  console.log('[api] Empty database - loading demo data (run "npm run reset" to reload it later)');
  const { seed } = await import('./seed.ts');
  seed(services);
}
if (!count && !demoData) {
  console.log('[api] Empty production database. Create the first administrator:  npm run admin -- create-user <username> ADMIN "<Full Name>" <email>');
}
if (demoData) {
  const { seedModules } = await import('./seed-modules.ts');
  if (services.db.get('SELECT 1 FROM programs LIMIT 1')) await seedModules(services);
}
if (services.auth.mode === 'password') {
  const { ensurePasswords, demoPassword } = await import('./modules/auth.ts');
  // Only the built-in demo users ever get a generated password, and only when demo data is in use.
  // Real users get a one-time password through an approved reset or the admin CLI.
  const { DEMO_USERNAMES } = await import('./seed-modules.ts');
  const issued = demoData ? await ensurePasswords(services, DEMO_USERNAMES) : [];
  if (issued.length && !production) console.log(`[auth] Demo users can sign in with the password "${demoPassword()}"${services.auth.mfaRequired ? ' and must set up MFA' : ''}.`);
  if (issued.length && production) {
    console.log('[auth] One-time passwords issued (users must change them at first sign-in):');
    for (const i of issued) console.log(`        ${i.username}  ${i.password}`);
  }
} else {
  console.warn('[auth] DEMO MODE: anyone can act as any user. Never expose this to a network.');
}

const stopDispatcher = startDispatcher(services.db);
// Automated delinquency tracking: open cases for loans > 30 days past due (startup, then hourly).
const { sweep } = await import('./modules/service.ts');
const { snapshotMonthEnds } = await import('./modules/dashboard.ts');
const runSweep = () => { try { snapshotMonthEnds(services); } catch (e: any) { console.error('[month-end] snapshot failed:', e.message); } return sweep(services).then((r) => r.opened && console.log(`[servicing] ${r.opened} delinquency case(s) opened`)).catch((e) => console.error('[servicing] sweep failed:', e.message)); };
await runSweep();
setInterval(runSweep, 3600e3).unref();
const server = createServer(createApp(services));
server.listen(port, host, () => {
  console.log(`\n  Seaport Global - Working Capital platform`);
  console.log(`  Open http://localhost:${port}   (business date ${services.today()})\n`);
});

function shutdown() {
  stopDispatcher();
  server.close();
  engineChild?.kill();
  services.db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
